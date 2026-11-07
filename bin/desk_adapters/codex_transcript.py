"""Codex rollouts (~/.codex/sessions/.../rollout-*.jsonl): usage and turns.
Tested against codex-cli 0.167.0."""
import glob
import json
import os
import time
from .claude_transcript import CATEGORIES, SAFE_ID, TRANSCRIPT_TURNS, classify_prompt, read_tail, tools_summary, ts_ms


def codex_usage(lines):
    """Token totals of a Codex rollout: its last token_count holds the running totals. No dollars:
    these models have no price table here."""
    total, calls = None, 0
    for line in lines:
        if '"token_count"' not in line:
            continue
        try:
            payload = json.loads(line).get("payload") or {}
        except ValueError:
            continue
        info = payload.get("info") if payload.get("type") == "token_count" else None
        if info and info.get("total_token_usage"):
            total = info["total_token_usage"]
            calls += 1
    if not total:
        return None
    cached = total.get("cached_input_tokens") or 0
    return {"calls": calls, "input": (total.get("input_tokens") or 0) - cached, "cache_write": 0, "cache_read": cached,
            "output": total.get("output_tokens") or 0, "cost": None, "models": [], "priced": False}


def codex_sessions_root():
    return os.environ.get("TEAM_CODEX_SESSIONS") or os.path.expanduser("~/.codex/sessions")


def _rollout_meta(path):
    """A rollout's first line: (session id, cwd, start in ms), or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            first = json.loads(f.readline())
    except (OSError, ValueError):
        return None
    meta = first.get("payload") if isinstance(first, dict) and first.get("type") == "session_meta" else None
    return (meta.get("id"), meta.get("cwd"), ts_ms(meta.get("timestamp"))) if isinstance(meta, dict) else None


def find_codex_rollout(session, root=None):
    """A Codex session's log. Codex tells us no session id at launch, so a saved session is matched
    to the first rollout that began in its folder after it started."""
    root = root or codex_sessions_root()
    conversation = session.get("conversation")
    if conversation and SAFE_ID.match(str(conversation)):
        hits = glob.glob(os.path.join(root, "*", "*", "*", "*%s.jsonl" % conversation))
        return max(hits, key=os.path.getmtime) if hits else None
    start, cwd = session.get("at"), session.get("cwd")
    if not start or not cwd:
        return None
    best = None
    for days in (0, 1):  # The dated folders use local time; a session can start just before midnight.
        day = time.strftime("%Y/%m/%d", time.localtime(start / 1000 + days * 86400))
        for path in glob.glob(os.path.join(root, day, "rollout-*.jsonl")):
            meta = _rollout_meta(path)
            if meta and meta[1] == cwd and meta[2] and meta[2] >= start - 5000 and (best is None or meta[2] < best[0]):
                best = (meta[2], path)
    return best[1] if best else None


def _item_text(item):
    return "\n".join(str(c.get("text") or "") for c in item.get("content") or [] if isinstance(c, dict)).strip()


CODEX_TAIL_BYTES = 8 * 1024 * 1024
CODEX_STEP = {"read": "read", "list_files": "read", "search": "search"}


def codex_turns(path, limit=None, tail=None):
    """A Codex member's own conversation, in the same shape as transcript_turns, from the finished
    items in its rollout. Nothing here calls a model: it reads the file Codex already wrote."""
    limit = TRANSCRIPT_TURNS if limit is None else limit
    # A rollout repeats each command's output, so it needs a longer tail than a Claude transcript.
    lines, cut = read_tail(path, tail or CODEX_TAIL_BYTES)
    turns, run = [], None

    def close(text, at):
        nonlocal run
        r, run = run, None
        tools = {"summary": tools_summary(r["counts"], r["failed"]), "counts": r["counts"], "failed": r["failed"]} if r else None
        turns.append({"who": "agent", "text": text, "at": at if at is not None else (r or {}).get("at"), "tools": tools, "subagents": []})

    for line in lines:
        if '"item_completed"' not in line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        payload = entry.get("payload") or {}
        item = payload.get("item") if payload.get("type") == "item_completed" else None
        if not isinstance(item, dict):
            continue
        kind, at = item.get("type"), ts_ms(entry.get("timestamp"))
        if kind == "UserMessage":
            if run:
                close("", at)
            turns.append({**classify_prompt(_item_text(item)), "at": at, "tools": None, "subagents": []})
        elif kind == "AgentMessage":
            text = _item_text(item)
            if text:
                close(text, at)
        elif kind != "Reasoning":
            if run is None:
                run = {"counts": {k: 0 for k in CATEGORIES}, "failed": 0, "at": at}
            if kind == "CommandExecution":
                parsed = item.get("parsed_cmd") or [{}]
                run["counts"][CODEX_STEP.get(parsed[0].get("type"), "command")] += 1
                run["failed"] += 1 if item.get("exit_code") not in (None, 0) else 0
            else:
                run["counts"]["edit" if "File" in str(kind) else "web" if "Web" in str(kind) else "other"] += 1
    if run:
        close("", None)
    return {"supported": True, "turns": turns[-limit:] if limit else turns, "partial": bool(cut or len(turns) > limit)}
