"""Durable, provider-neutral runtime state for the Desk.

The UI talks to ``team``; this module deliberately has no Herdr dependency so
its state transitions can be tested without touching a user's terminals.
"""
import json
import os
import tempfile
import time
import uuid
import fcntl
from contextlib import contextmanager


def now_ms():
    return int(time.time() * 1000)


class RuntimeError(ValueError):
    pass


class Store:
    def __init__(self, directory, clock=now_ms):
        self.directory, self.clock = directory, clock
        self.path = os.path.join(directory, ".runtime.json")

    def _read(self):
        try:
            with open(self.path) as f:
                value = json.load(f)
        except FileNotFoundError:
            return {"version": 1, "sessions": [], "queue": [], "dismissed": []}
        except (OSError, ValueError) as exc:
            raise RuntimeError("Desk runtime state is unreadable; it was not changed: %s" % exc)
        if not isinstance(value, dict) or value.get("version") != 1:
            raise RuntimeError("Desk runtime state has an unsupported format")
        value.setdefault("sessions", []); value.setdefault("queue", []); value.setdefault("dismissed", [])
        return value

    def _write(self, value):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix=".runtime-", dir=self.directory)
        try:
            with os.fdopen(fd, "w") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(value, f, separators=(",", ":"), sort_keys=True)
                f.flush(); os.fsync(f.fileno())
            os.replace(path, self.path)
        finally:
            if os.path.exists(path): os.unlink(path)

    def _lock(self):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        lock = open(os.path.join(self.directory, ".runtime.lock"), "a+")
        os.chmod(lock.name, 0o600); fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return lock

    def load(self):
        lock = self._lock()
        try: return self._read()
        finally: lock.close()

    def save(self, value):
        lock = self._lock()
        try: self._write(value)
        finally: lock.close()

    def mutate(self, fn):
        lock = self._lock()
        try:
            value = self._read(); result = fn(value); self._write(value); return result
        finally: lock.close()

    @contextmanager
    def dispatch_lock(self):
        """Serialize terminal delivery, not just registry writes.

        Holding this across the terminal send means a second watcher snapshots
        after ``awaiting`` is set, so it cannot send the next queue item into
        the same idle turn.
        """
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        lock = open(os.path.join(self.directory, ".dispatch.lock"), "a+")
        os.chmod(lock.name, 0o600); fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try: yield
        finally: lock.close()

    @contextmanager
    def watch_lock(self):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        lock = open(os.path.join(self.directory, ".watch.lock"), "a+")
        os.chmod(lock.name, 0o600)
        acquired = False
        try:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                pass
            yield acquired
        finally:
            lock.close()


def adapter(cli, configured=None):
    """Capabilities are intentionally explicit; providers may be added here."""
    value = dict({"claude": {"resume": True, "fork": True},
                  "codex": {"resume": False, "fork": False}}.get(cli or "claude", {"resume": False, "fork": False}))
    if isinstance(configured, dict): value.update({k: bool(v) for k, v in configured.items() if k in ("resume", "fork")})
    return value


def foreground_agent(terminal, expected_cli=None):
    """Only deliver to a real agent foreground process, never a recovered shell.

    Herdr may use the CLI's version as foreground.name, so argv[0] and
    status.app are the stable identity fields rather than the display name.
    """
    terminal = terminal or {}; foreground = terminal.get("foreground") or {}; status = terminal.get("status") or {}
    name = os.path.basename(str(foreground.get("name") or "")); argv = foreground.get("argv") or []
    executable = os.path.basename(str(argv[0])) if argv else ""
    app = str(status.get("app") or "")
    if executable in ("zsh", "bash", "sh", "fish", "nu") or name in ("zsh", "bash", "sh", "fish", "nu"): return False
    candidates = {name, executable, app}
    aliases = {"claude": {"claude", "claude-code"}, "codex": {"codex", "codex-cli"}, "muse": {"muse", "muse-code"}}
    if expected_cli: return bool(candidates & aliases.get(expected_cli, {expected_cli}))
    return bool(candidates & set().union(*aliases.values()))


def session_view(session, terminals):
    terminal = terminals.get(session.get("address"))
    live = bool(terminal and terminal.get("state") == "live" and foreground_agent(terminal, session.get("executable") or session.get("cli")))
    state = "active" if live else ("finished" if session.get("finished") else "recovering" if session.get("recovering") else "disconnected")
    caps = adapter(session.get("cli"), session.get("capabilities"))
    reason = None; fork_reason = None
    if state == "disconnected":
        if not session.get("conversation"):
            reason = "This session has no saved conversation identity. Start a new role session."
        elif not caps["resume"]:
            reason = "%s does not declare resume support yet." % (session.get("cli") or "This agent")
    if not session.get("conversation"):
        fork_reason = "Wait for this CLI to save a conversation identity before forking."
    if "git_root" in session and not session.get("git_root"):
        fork_reason = "Fork needs a Git repository so its edits can have a separate worktree."
    if not caps["fork"]:
        fork_reason = "%s does not declare an isolated context fork yet." % (session.get("cli") or "This agent")
    public = {k: v for k, v in session.items() if k not in ("role_config",)}
    return dict(public, state=state, can_resume=state == "disconnected" and bool(session.get("conversation")) and caps["resume"],
                can_fork=state == "active" and bool(session.get("conversation")) and caps["fork"] and not fork_reason, recovery_reason=reason,
                reason=reason, resume_reason=reason, fork_reason=fork_reason)


def upsert_session(data, record):
    sessions = data["sessions"]
    prior = next((x for x in sessions if x.get("address") == record.get("address")), None)
    if prior:
        prior.update({k: v for k, v in record.items() if v is not None})
        return prior
    record = dict(record); record.setdefault("id", "session-" + uuid.uuid4().hex); sessions.append(record)
    return record


def queue_item(data, task, text, targets, clock=now_ms):
    if not task or not text.strip() or not targets:
        raise RuntimeError("Queue needs a desk, text, and at least one recipient")
    item = {"id": "queue-" + uuid.uuid4().hex, "task": task, "text": text.strip(), "targets": targets,
            "state": "pending", "position": len(data["queue"]), "at": clock(), "error": None}
    data["queue"].append(item); return item


def find_queue(data, item_id):
    item = next((x for x in data["queue"] if x["id"] == item_id), None)
    if not item: raise RuntimeError("That queued message no longer exists")
    return item


def reorder(data):
    active = sorted([x for x in data["queue"] if x["state"] == "pending"], key=lambda x: x.get("position", 0))
    for n, item in enumerate(active): item["position"] = n


def attention(data, terminals, chats):
    dismissed = set(data.get("dismissed", [])); items = []
    for session in data["sessions"]:
        view = session_view(session, terminals)
        if view["state"] == "disconnected":
            item = {"id": "session:" + view["id"], "task": view.get("task"), "address": view.get("address"), "kind": "disconnected",
                    "title": "%s disconnected" % view.get("role", "Agent"), "text": view.get("recovery_reason") or "Resume this conversation.", "at": view.get("at", 0)}
            if item["id"] not in dismissed: items.append(item)
    for item in data["queue"]:
        if item["state"] in ("failed", "uncertain"):
            note = {"id": "queue:" + item["id"], "task": item["task"], "address": None, "kind": item["state"],
                    "title": "Queued message needs review", "text": item.get("error") or item["text"], "at": item["at"]}
            if note["id"] not in dismissed: items.append(note)
    resolved_permissions = {(x.get("task"), str(x.get("re"))) for x in chats if x.get("kind") == "permission-done"}
    answered = {(x.get("task"), str(x.get("re"))) for x in chats if x.get("kind") == "answer"}
    latest = {}
    for event in chats:
        if event.get("kind") in ("done", "blocked", "flag", "finish"):
            latest[(event.get("task"), event.get("address") or event.get("from"))] = event
    for event in chats:
        kind = event.get("kind"); task = event.get("task", "")
        key = str(event.get("id") or event.get("at"))
        terminal = terminals.get(event.get("address")) or {}
        permission = (kind == "permission" and (task, str(event.get("id"))) not in resolved_permissions
            and now_ms() - event.get("at", 0) < 540000 and terminal.get("state") == "live"
            and (terminal.get("status") or {}).get("state") == "blocked")
        report = kind in ("done", "blocked", "flag") and latest.get((task, event.get("address") or event.get("from"))) is event
        question = kind == "ask" and "kabeer" in (event.get("to") or []) and (task, key) not in answered
        if permission or report or question or bool(event.get("failed")):
            titles = {"permission": " asks permission", "done": " finished work", "blocked": " is blocked", "ask": " has a question"}
            item = {"id": "chat:" + task + ":" + key, "task": task, "address": event.get("address"),
                    "kind": kind or "delivery", "desk_name": event.get("desk_name"), "title": event.get("from", "Agent") + titles.get(kind, " needs attention"),
                    "text": event.get("text") or event.get("detail") or "", "at": event.get("at", 0)}
            if item["id"] not in dismissed: items.append(item)
    return sorted(items, key=lambda x: x["at"], reverse=True)


def dispatch(data, terminals, deliver):
    """Attempt exactly one complete queued item. Never retry ambiguous sends."""
    item = next((x for x in sorted(data["queue"], key=lambda q: q.get("position", 0)) if x["state"] == "pending"), None)
    if not item: return None
    for target in item["targets"]:
        terminal = terminals.get(target["address"])
        if not terminal or terminal.get("state") != "live" or not foreground_agent(terminal, target.get("cli")):
            item.update(state="failed", error="Recipient is not a live agent; message was not sent")
            return item
        status = ((terminal.get("status") or {}).get("state"))
        if status in ("working", "blocked") or (terminal.get("labels") or {}).get("awaiting"):
            return None
    for target in item["targets"]:
        outcome = deliver(target["address"], item["text"])
        if outcome is None:
            continue
        item.update(state="uncertain", error=str(outcome))
        return item
    item["state"] = "delivered"; return item


def recover_interrupted_claims(data):
    """Never duplicate a send after a crash between terminal input and final state."""
    for item in data["queue"]:
        if item.get("state") == "dispatching":
            item.update(state="uncertain", error="Delivery was interrupted after it was claimed; review before retrying")
