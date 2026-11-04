#!/usr/bin/env python3
"""Read-only, bounded Git review data for the Desk review pane."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

MAX_DIFF = 120_000
TURN_REF = "refs/worktree/desk/turn-base"


def git(root: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", *args],
        cwd=root, capture_output=True, text=True, errors="replace",
        env={**os.environ, **env} if env else None,
    )


@contextmanager
def private_index(root: str):
    """A throwaway copy of this worktree's index, so `git add -A` never touches the real one."""
    index = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")
    gitdir = git(root, "rev-parse", "--path-format=absolute", "--git-dir")
    if index.returncode or gitdir.returncode:
        raise ValueError("Not a git repository")
    fd, path = tempfile.mkstemp(prefix="desk-index-", dir=gitdir.stdout.strip())
    os.close(fd)
    try:
        real = index.stdout.strip()
        if os.path.exists(real):
            shutil.copyfile(real, path)
        else:
            os.unlink(path)  # git creates a fresh index here
        yield {"GIT_INDEX_FILE": path}
    finally:
        for leftover in (path, path + ".lock"):
            if os.path.exists(leftover):
                os.unlink(leftover)


def worktree_tree(root: str) -> str:
    """The tree of the working tree as it is now (tracked and untracked, minus ignored files).
    Writes blob/tree objects only; the index, HEAD and the files are left alone."""
    with private_index(root) as env:
        added = git(root, "add", "-A", env=env)
        if added.returncode:
            raise ValueError(added.stderr.strip() or "Couldn't snapshot the worktree")
        tree = git(root, "write-tree", env=env)
        if tree.returncode:
            raise ValueError(tree.stderr.strip() or "Couldn't write the snapshot tree")
        return tree.stdout.strip()


def snapshot_turn(repo: str) -> dict[str, str]:
    """Remember the worktree at the start of an agent's turn, for the Last turn review."""
    root = top(repo)
    tree = worktree_tree(root)
    ref = git(root, "update-ref", TURN_REF, tree)
    if ref.returncode:
        raise ValueError(ref.stderr.strip() or "Couldn't record the turn snapshot")
    return {"root": root, "ref": TURN_REF, "tree": tree}


def turn_base(root: str) -> str:
    base = git(root, "rev-parse", "--verify", "--quiet", TURN_REF + "^{tree}")
    if base.returncode or not base.stdout.strip():
        raise ValueError("No turn snapshot yet: it is taken when the agent's next turn starts")
    return base.stdout.strip()


def top(repo: str) -> str:
    result = git(repo, "rev-parse", "--show-toplevel")
    if result.returncode:
        raise ValueError("Not a git repository")
    return os.path.realpath(result.stdout.strip())


def status(root: str) -> list[dict[str, object]]:
    result = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Couldn't read Git status")
    records = result.stdout.split("\0")
    files: list[dict[str, object]] = []
    index = 0
    while index < len(records):
        entry = records[index]
        index += 1
        if not entry:
            continue
        code, path = entry[:2], entry[3:]
        # Rename/copy entries contain the source path as the next NUL record.
        if code[0] in "RC" or code[1] in "RC":
            if index < len(records):
                index += 1
        label = "untracked" if code == "??" else "deleted" if "D" in code else "added" if "A" in code else "modified"
        files.append({"path": path, "status": label, "code": code, "added": 0, "removed": 0, "binary": False})
    return files


def permitted_path(path: str, files: list[dict[str, object]]) -> str | None:
    if not path:
        return None
    if path.startswith("/") or "\0" in path or any(part == ".." for part in Path(path).parts):
        raise ValueError("Path must be a changed repository-relative file")
    changed = {str(item["path"]) for item in files}
    if path not in changed:
        raise ValueError("Path is not in this review")
    return path


def numstat(root: str, mode: str, base: str | None, env: dict[str, str] | None = None) -> dict[str, tuple[int, int, bool]]:
    args = ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"]
    if mode == "staged":
        args.append("--cached")
    elif mode == "branch" and base:
        args.extend([base, "HEAD"])
    elif mode == "working":
        args.append("HEAD")
    elif mode == "turn":
        args.extend(["--cached", str(base)])
    result = git(root, *args, env=env)
    values: dict[str, tuple[int, int, bool]] = {}
    parts = result.stdout.split("\0")
    index = 0
    while index < len(parts):
        part = parts[index]
        index += 1
        if not part:
            continue
        fields = part.split("\t", 2)
        if len(fields) != 3:
            continue
        added, removed, path = fields
        if not path and index + 1 < len(parts):
            index += 1  # old name
            path = parts[index]
            index += 1  # new name
        values[path] = (0 if added == "-" else int(added), 0 if removed == "-" else int(removed), added == "-" or removed == "-")
    return values


def diff_paths(root: str, mode: str, base: str | None, env: dict[str, str] | None = None) -> dict[str, str]:
    args = ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z"]
    if mode == "staged":
        args.append("--cached")
    elif mode == "branch" and base:
        args.extend([base, "HEAD"])
    elif mode == "working":
        args.append("HEAD")
    elif mode == "turn":
        args.extend(["--cached", str(base)])
    result = git(root, *args, env=env)
    values: dict[str, str] = {}
    parts = result.stdout.split("\0")
    index = 0
    while index < len(parts):
        code = parts[index]
        index += 1
        if not code or index >= len(parts):
            continue
        path = parts[index]
        index += 1
        # git writes old then new name after an R/C status.
        if code[:1] in "RC" and index < len(parts):
            path = parts[index]
            index += 1
        values[path] = {"A": "added", "D": "deleted"}.get(code[:1], "modified")
    return values


def branch_base(root: str) -> str | None:
    head = git(root, "rev-parse", "HEAD").stdout.strip()
    # Prefer an integration branch. A feature's own tracking branch points to HEAD after push,
    # which would produce an empty review and hide all of the feature's changes.
    for candidate in ("origin/HEAD", "origin/main", "origin/master", "main", "master"):
        merge = git(root, "merge-base", "HEAD", candidate)
        if merge.returncode == 0 and merge.stdout.strip() != head:
            return merge.stdout.strip()
    upstream = git(root, "rev-parse", "--abbrev-ref", "@{upstream}")
    target = upstream.stdout.strip() if upstream.returncode == 0 else ""
    if target:
        merge = git(root, "merge-base", "HEAD", target)
        if merge.returncode == 0 and merge.stdout.strip() != head:
            return merge.stdout.strip()
    return None


def bounded_file(path: str) -> tuple[bytes, bool] | None:
    try:
        stat = os.lstat(path)
    except OSError:
        return None
    if not os.path.isfile(path) or os.path.islink(path):
        return None
    with open(path, "rb") as source:
        data = source.read(MAX_DIFF + 1)
    return data[:MAX_DIFF], len(data) > MAX_DIFF or stat.st_size > MAX_DIFF


def untracked_diff(root: str, path: str | None) -> str:
    untracked = {str(f["path"]) for f in status(root) if f["status"] == "untracked"}
    candidates = [path] if path in untracked else sorted(untracked) if path is None else []
    chunks: list[str] = []
    for candidate in candidates:
        if not candidate:
            continue
        full = os.path.join(root, candidate)
        content = bounded_file(full)
        if content is None:
            continue
        data, was_truncated = content
        if b"\0" in data:
            chunks.append(f"Binary untracked file: {candidate}\n")
            continue
        shown = data[:MAX_DIFF].decode("utf-8", "replace")
        suffix = "… untracked file truncated …\n" if was_truncated else ""
        chunks.append(f"diff --git a/{candidate} b/{candidate}\nnew file mode 100644\n--- /dev/null\n+++ b/{candidate}\n" + "".join(f"+{line}\n" for line in shown.splitlines()) + suffix)
    return "".join(chunks)


def review(repo: str, mode: str, path: str | None = None) -> dict[str, object]:
    if mode == "turn":
        return turn_review(repo, path)
    root = top(repo)
    files = status(root)
    if path and (path.startswith("/") or "\0" in path or any(part == ".." for part in Path(path).parts)):
        raise ValueError("Path must be a changed repository-relative file")
    base = branch_base(root) if mode == "branch" else None
    if mode == "branch" and not base:
        raise ValueError("No branch base is available yet")
    stats = numstat(root, mode, base)
    changed = diff_paths(root, mode, base)
    status_by_path = {str(item["path"]): item for item in files}
    selected_files: list[dict[str, object]] = []
    for path_name, state in changed.items():
        item = status_by_path.get(path_name, {"path": path_name, "status": state, "code": "", "added": 0, "removed": 0, "binary": False})
        stat = stats.get(str(item["path"]))
        if stat:
            item["added"], item["removed"], item["binary"] = stat
        selected_files.append(item)
    if mode == "working":
        for item in files:
            if item["status"] != "untracked":
                continue
            content = bounded_file(os.path.join(root, str(item["path"])))
            item["binary"] = bool(content and b"\0" in content[0])
            selected_files.append(item)
    path = permitted_path(path, selected_files)
    args = ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-color"]
    if mode == "staged":
        args.append("--cached")
    elif mode == "branch":
        args.extend([base, "HEAD"])
    elif mode == "working":
        args.append("HEAD")
    if path:
        args.extend(["--", path])
    result = git(root, *args)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Couldn't read diff")
    text = result.stdout
    if mode == "working":
        text += untracked_diff(root, path)
    truncated = len(text.encode("utf-8")) > MAX_DIFF
    if truncated:
        text = text.encode("utf-8")[:MAX_DIFF].decode("utf-8", "ignore") + "\n… diff truncated …\n"
    return {"root": root, "mode": mode, "base": base, "files": selected_files, "diff": text, "truncated": truncated,
            "binary": "Binary files differ" in text or any(bool(item["binary"]) for item in selected_files)}


def turn_review(repo: str, path: str | None = None) -> dict[str, object]:
    """What changed since the agent's turn started: the turn-base tree against a private-index
    snapshot of the worktree now, so untracked text is included. Same caps as the other modes."""
    root = top(repo)
    if path and (path.startswith("/") or "\0" in path or any(part == ".." for part in Path(path).parts)):
        raise ValueError("Path must be a changed repository-relative file")
    base = turn_base(root)
    with private_index(root) as env:
        added = git(root, "add", "-A", env=env)
        if added.returncode:
            raise ValueError(added.stderr.strip() or "Couldn't read the worktree")
        stats = numstat(root, "turn", base, env)
        changed = diff_paths(root, "turn", base, env)
        files: list[dict[str, object]] = []
        for path_name, state in changed.items():
            add, rem, binary = stats.get(path_name, (0, 0, False))
            files.append({"path": path_name, "status": state, "code": "", "added": add, "removed": rem, "binary": binary})
        path = permitted_path(path, files)
        args = ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-color", "--cached", base]
        if path:
            args.extend(["--", path])
        result = git(root, *args, env=env)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Couldn't read diff")
    text = result.stdout
    truncated = len(text.encode("utf-8")) > MAX_DIFF
    if truncated:
        text = text.encode("utf-8")[:MAX_DIFF].decode("utf-8", "ignore") + "\n… diff truncated …\n"
    return {"root": root, "mode": "turn", "base": base, "files": files, "diff": text, "truncated": truncated,
            "binary": "Binary files differ" in text or any(bool(item["binary"]) for item in files)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--mode", choices=("working", "staged", "branch", "turn"), default="working")
    parser.add_argument("--path")
    parser.add_argument("--snapshot", action="store_true", help="record the turn-base snapshot instead of reviewing")
    args = parser.parse_args()
    try:
        if args.snapshot:
            print(json.dumps(snapshot_turn(args.repo)))
            return 0
        print(json.dumps(review(args.repo, args.mode, args.path), ensure_ascii=False))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
