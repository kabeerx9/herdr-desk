"""Durable, provider-neutral runtime state for the Desk.

The UI talks to ``team``; this module deliberately has no Herdr dependency so
its state transitions can be tested without touching a user's terminals.
"""
import calendar
import glob
import json
import os
import re
import tempfile
import time
import subprocess
import uuid
import fcntl
from contextlib import contextmanager

import desk_adapters

# Moved to desk_adapters (docs/plans/2026-11-07-adapter-layer.md); re-exported so callers keep working.
from desk_adapters.pricing import (PRICES, call_cost)
from desk_adapters.claude_transcript import (transcript_usage, last_tool_at, turn_started, TAIL_BYTES, JOB_TAIL, SUBAGENT_TAIL, CONTEXT_MAX, CONTEXT_MAX_1M, CATEGORIES, TOOL_CATEGORY, SAFE_ID, projects_root, find_transcript, read_tail, ts_ms, _content, is_prompt, step_text, PHRASES, FIRST_ON_TIES, tools_summary, _first_line, _result_text, _subagent_metas, _subagent_progress, context_max, _subagents, NOTIFICATION, OUTPUT_FILE, transcript_jobs, transcript_timeline, TRANSCRIPT_TURNS, HC_WRAP, DESK_KABEER, DIGEST, COMMAND, COMMAND_ARGS, PASTED, TYPED_COMMAND, prompt_text, classify_prompt, transcript_turns, transcript_title, cleared_transcript)
from desk_adapters.codex_transcript import (codex_usage, codex_sessions_root, _rollout_meta, find_codex_rollout, _item_text, CODEX_TAIL_BYTES, CODEX_STEP, codex_turns)
from desk_adapters.launch import (LAUNCH_FAILURES, classify_launch_failure)
from desk_adapters.screen import (RULE, TOP_BORDER, DIALOG_KEYS, OPTION_CURSOR, CHOICE_KEYS, CODEX_PLACEHOLDERS, NO_INPUT, PROMPTS, CHROME, DIALOG_TABS, DIALOG_OPEN, _hinted, _lines, prompt_box, codex_input, screen_state, _dedent, command_result, PERMISSION_QUESTION, OPTION, BOX_EDGE, FRAME, _unbox, option_kind, permission_dialog, _squash, dialog_matches, pick_option)


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
    aliases = desk_adapters.process_aliases()
    if expected_cli: return bool(candidates & aliases.get(expected_cli, {expected_cli}))
    return bool(candidates & set().union(*aliases.values()))


def closed_after_done(session, terminal):
    """Killed after reporting done, with no prompt since: the work ended on purpose. A crash, or a
    kill during later work, stays a loss."""
    done = session.get("evidence_at")
    return bool(done and terminal and terminal.get("state") == "finished" and terminal.get("reason") == "killed"
                and done >= (session.get("prompt_at") or 0))


def session_view(session, terminals):
    terminal = terminals.get(session.get("address"))
    live = bool(terminal and terminal.get("state") == "live" and foreground_agent(terminal, session.get("executable") or session.get("cli")))
    state = "active" if live else ("finished" if session.get("finished") or closed_after_done(session, terminal) else "recovering" if session.get("recovering") else "disconnected")
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


# ── Triage: settle / snooze ──────────────────────────────────────────────────

TRIAGE = {"settled_at": ("settled_at", "settled_turn"), "snoozed_until": ("snoozed_at", "snoozed_turn")}


def triage_clear(session, terminal, chats, now):
    """Which of settled_at / snoozed_until no longer hold. An agent comes back when its status
    changed to working or blocked after it was put away, when it reports done after that, or
    (snooze) when the time is up. Status that was already working when settled doesn't count."""
    terminal = terminal or {}
    state = (terminal.get("status") or {}).get("state")
    changed, turn = terminal.get("status_ms"), terminal.get("turn")
    out = []
    for key, (mark_key, turn_key) in TRIAGE.items():
        if session.get(key) is None:
            continue
        mark = session.get(mark_key) or session.get(key) or 0
        woke = state in ("working", "blocked") and (
            (isinstance(changed, (int, float)) and changed > mark)
            or (isinstance(turn, int) and isinstance(session.get(turn_key), int) and turn > session[turn_key]))
        reported = any(c.get("kind") == "done" and c.get("address") == session.get("address")
                       and c.get("task") in (None, session.get("task")) and (c.get("at") or 0) > mark for c in chats)
        expired = key == "snoozed_until" and now >= session[key]
        if woke or reported or expired:
            out.append(key)
    return out


def triage_apply(session, keys):
    for key in keys:
        session.pop(key, None)
        for extra in TRIAGE[key]:
            session.pop(extra, None)


# ── Task contracts (briefs) and done-report criteria ─────────────────────────

def _section(name):
    name = re.sub(r"[`*_]", "", name).strip().lower()
    if name.startswith("acceptance"):
        return "acceptance"
    if name in ("owns", "files it owns", "files owned", "ownership", "files"):
        return "owns"
    if re.fullmatch(r"must[\s_-]?run|checks|checks to run|verify with", name):
        return "must_run"
    return None


def parse_contract(text):
    """`## Acceptance` (- A1: text), `## Owns` (- path), `## Must run` (- `command`) sections of a
    brief. Returns None when the brief has none of them."""
    out = {"acceptance": [], "owns": [], "must_run": []}
    current = None
    for line in (text or "").splitlines():
        heading = re.match(r"^\s*#{1,6}\s+(.*?)\s*:?\s*$", line)
        if heading:
            current = _section(heading.group(1))
            continue
        item = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$", line) if current else None
        if not item:
            continue
        value = item.group(1)
        if current == "acceptance":
            m = re.match(r"^(?:\*\*|\[|`)?([A-Za-z]{1,3}\d{1,3})(?:\*\*|\]|`)?\s*[:.)\u2013\u2014-]?\s+(.+)$", value)
            ident, said = (m.group(1).upper(), m.group(2).strip()) if m else (None, value)
            taken = {x["id"] for x in out["acceptance"]}
            if not ident or ident in taken:
                n = len(out["acceptance"]) + 1
                while "A%d" % n in taken:
                    n += 1
                ident = "A%d" % n
            out["acceptance"].append({"id": ident, "text": said})
        else:
            value = value.strip()
            if len(value) > 1 and value[0] == value[-1] == "`":
                value = value[1:-1]
            out[current].append(value)
    return out if any(out.values()) else None


def parse_criteria(raw, contract=None):
    """`{"A1": "pass: note", "A2": "fail: why", "A3": "n/a"}` -> list of {id, result, note, text}.
    With a contract, every acceptance id must be answered and no others."""
    try:
        data = json.loads(raw)
    except ValueError:
        raise RuntimeError('--criteria must be JSON like {"A1":"pass: note"}')
    if not isinstance(data, dict) or not data:
        raise RuntimeError('--criteria must be a non-empty JSON object like {"A1":"pass: note"}')
    known = {x["id"]: x["text"] for x in ((contract or {}).get("acceptance") or [])}
    items = []
    for key, value in data.items():
        ident = str(key).strip().upper()
        m = re.match(r"^\s*(pass|fail|n/?a)\b\s*[:\u2013\u2014-]?\s*(.*)$", value, re.I | re.S) if isinstance(value, str) else None
        if not m:
            raise RuntimeError("Criterion %s must start with pass, fail or n/a (then ': note')" % ident)
        if known and ident not in known:
            raise RuntimeError("Criterion %s isn't in the brief (its ids: %s)" % (ident, ", ".join(known)))
        result = "n/a" if m.group(1).lower() in ("na", "n/a") else m.group(1).lower()
        items.append({"id": ident, "result": result, "note": m.group(2).strip()[:500], "text": known.get(ident)})
    missing = [k for k in known if k not in {x["id"] for x in items}]
    if missing:
        raise RuntimeError("Report every acceptance criterion; missing: " + ", ".join(missing))
    return items


# ── Merge gate ───────────────────────────────────────────────────────────────

MAX_REVIEW_ROUNDS = 3


def session_cli(session):
    return ((session or {}).get("role_config") or {}).get("cli") or (session or {}).get("cli") or "claude"


def gate_verdict(engineer, sessions, chats, head, dirty=False, max_rounds=MAX_REVIEW_ROUNDS):
    """Can the CTO integrate this engineer's branch? Only once a Reviewer on another CLI reported
    done, with zero blocking findings, for the branch's current HEAD. Each Reviewer done report for
    this engineer is a round; past max_rounds without a clean one it goes to Kabeer."""
    by_address = {}
    for s in sessions:
        if s.get("address"):
            by_address.setdefault(s["address"], []).append(s)
    eng_cli = session_cli(engineer)
    reviews = []
    for c in chats:
        if c.get("kind") != "done" or c.get("task") not in (None, engineer.get("task")):
            continue
        candidates = [s for s in by_address.get(c.get("address"), []) if s.get("role") == "reviewer"]
        rev = next((s for s in candidates if s.get("task") == engineer.get("task")), candidates[0] if candidates else None)
        if not rev:
            continue
        if rev.get("parent") != engineer.get("address") and not (rev.get("cwd") and rev.get("cwd") == engineer.get("cwd")):
            continue
        reviews.append({"address": c.get("address"), "cli": session_cli(rev), "head": c.get("head"),
                        "blocking": c.get("blocking"), "at": c.get("at"), "text": (c.get("text") or "")[:300]})
    reasons = []
    if not head:
        reasons.append("couldn't read the branch's HEAD")
    if dirty:
        reasons.append("the worktree has uncommitted changes; commit them so the review covers them")
    # Rounds run from the last clean review: new work after a pass starts a new count.
    clean = max((i for i, r in enumerate(reviews) if r["blocking"] == 0), default=-1)
    rounds = len(reviews) - clean - 1
    fit = [r for r in reviews if r["head"] and head and r["head"] == head and r["cli"] != eng_cli]
    chosen = fit[-1] if fit else (reviews[-1] if reviews else None)
    if not reviews:
        reasons.append("no Reviewer has reported done on this branch yet")
    elif chosen:
        if chosen["cli"] == eng_cli:
            reasons.append("the latest review ran on %s, the engineer's own CLI; it needs a Reviewer on another CLI" % eng_cli)
        if not chosen["head"] or chosen["head"] != head:
            reasons.append("the latest review is for %s but the branch is at %s" % ((chosen["head"] or "an unknown commit")[:10], (head or "?")[:10]))
        if chosen["blocking"] is None:
            reasons.append("the review didn't state its blocking findings (team report done --blocking N)")
        elif chosen["blocking"] > 0:
            reasons.append("the review has %d blocking finding%s" % (chosen["blocking"], "" if chosen["blocking"] == 1 else "s"))
    verdict = "pass" if not reasons else "fail"
    if verdict == "fail" and rounds >= max_rounds:
        verdict = "escalate"
        reasons.append("%d review rounds without a clean review: stop and ask Kabeer" % rounds)
    return {"verdict": verdict, "head": head, "engineer_cli": eng_cli, "rounds": rounds, "max_rounds": max_rounds,
            "review": chosen, "reasons": reasons}


# A mechanical job's lighter gate: the CTO reads the diff, no Reviewer starts. Refused for paths where a
# wrong change costs more than a review. Matching on paths over-fires by design: a false hit just
# means a normal Reviewer round.
RISKY_PATH = re.compile(r"(auth|login|session|token|password|secret|credential|permission|rbac|payment|billing|invoice|"
                        r"stripe|checkout|migrat|schema|\.sql$|\.env|deploy|\.github/)", re.I)


def light_gate_verdict(engineer, head, dirty, files, note, allowed):
    """The merge gate for a role with light_review, when the CTO has read the diff itself."""
    reasons = []
    if not allowed:
        reasons.append("%s has no light review; it needs a Reviewer" % (engineer.get("role") or "this role"))
    if not head:
        reasons.append("couldn't read the branch's HEAD")
    if dirty:
        reasons.append("the worktree has uncommitted changes; commit them first")
    if files is None:
        reasons.append("couldn't list the branch's changed files; it needs a Reviewer")
    elif not files:
        reasons.append("the branch has no changes against its base")
    risky = [f for f in files or [] if RISKY_PATH.search(f)]
    if risky:
        reasons.append("risky paths need a Reviewer: " + ", ".join(risky[:5]))
    if not (note or "").strip():
        reasons.append("say what you checked in the diff (--light \"...\")")
    return {"verdict": "fail" if reasons else "pass", "head": head, "engineer_cli": session_cli(engineer), "rounds": 0,
            "max_rounds": 0, "review": {"kind": "cto", "note": (note or "").strip()}, "reasons": reasons}


# ── Cost ─────────────────────────────────────────────────────────────────────

# Dollars per million tokens: input, output, cache read. A cache write costs 2x input for the 1h
# cache and 1.25x for 5m. On a subscription this is an API-rate estimate that compares roles; it
# isn't a bill. Haiku 5.5's prices rise 5x for prompts past 100K tokens.
def findings_listed(text):
    """How many list lines a review report holds: one for each finding."""
    return sum(1 for line in str(text or "").splitlines() if re.match(r"\s*([-*]|\d+[.)])\s+\S", line))


def gate_line(name, verdict):
    """The gate's result as one line for Kabeer's chat."""
    head = (verdict.get("head") or "")[:8]
    if verdict["verdict"] == "pass":
        how = "the CTO read the diff, no Reviewer" if (verdict.get("review") or {}).get("kind") == "cto" else "review is clean"
        return "Gate passed for %s at `%s`: %s." % (name, head, how)
    word = "needs you" if verdict["verdict"] == "escalate" else "not passed"
    return "Gate %s for %s at `%s`: %s." % (word, name, head, "; ".join(verdict.get("reasons") or []))


TEST_RUNNER = re.compile(r"(^|[\s/])(jest|vitest)(\s|$)")
AGENT_CLI = re.compile(r"^(\S*/)?(codex|claude)(\s|$)")


def leftover_tests(table, me):
    """Test runs still alive under this agent. table: {pid: (ppid, command)}. `team report done` is
    the agent saying it has finished, so a test run still going is one that never exited. Only test
    runners count: a dev server or a simulator can be left up on purpose."""
    chain, pid = [], me
    while pid in table and pid not in chain:
        chain.append(pid)
        pid = table[pid][0]
    agent = next((p for p in chain if AGENT_CLI.search(table[p][1])), None)
    if agent is None:
        return []
    children = {}
    for child, (parent, _) in table.items():
        children.setdefault(parent, []).append(child)
    found, todo = [], list(children.get(agent, []))
    while todo:
        pid = todo.pop()
        todo.extend(children.get(pid, []))
        if pid not in chain and TEST_RUNNER.search(table[pid][1]):
            found.append(pid)
    return sorted(found)


# ── Runner fallback ──────────────────────────────────────────────────────────

def runner_variants(role):
    """A role's launch options in order: its `runners` list ({cli, model, effort}), else itself.
    Each variant is a whole role config with that runner pinned (and no further fallback)."""
    runners = role.get("runners")
    if not isinstance(runners, list) or not runners:
        return [role]
    out = []
    for index, runner in enumerate(runners):
        if not isinstance(runner, dict) or not runner.get("cli"):
            continue
        variant = {k: v for k, v in role.items() if k != "runners"}
        variant.update(cli=runner["cli"], model=runner.get("model"), effort=runner.get("effort"),
                       runner={"index": index, "cli": runner["cli"], "model": runner.get("model"), "effort": runner.get("effort")})
        if runner.get("label"):
            variant["label"] = runner["label"]
        if runner.get("argv"):
            variant["argv"] = runner["argv"]
        elif runner["cli"] != role.get("cli"):
            variant.pop("argv", None); variant.pop("adapter", None)
        out.append(variant)
    return out or [role]


# Phrases the CLIs print when a launch can't run at all. Kept narrow (whole phrases, error codes)
# because the screen also shows the task text, which the caller removes before matching.
def nearest_base(out, branch):
    """The base this branch left: of the default branch and the usual integration branches, the one
    it's fewest commits ahead of. A branch cut from dev is 1 commit ahead of dev and 106 ahead of
    main, and comparing with main shows everything dev hasn't released. Ties go to the default.
    `out` runs git and gives its stdout, or None on failure."""
    head = out("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    names = [b for b in BASE_BRANCHES if b != branch]
    refs = ([head] if head and head.split("/")[-1] != branch else []) + [f"origin/{b}" for b in names] + names
    best = None
    for ref in dict.fromkeys(refs):
        ahead = out("rev-list", "--count", f"{ref}..HEAD")
        if ahead is not None and ahead.isdigit() and (best is None or int(ahead) < best[0]):
            best = (int(ahead), ref)
    return best and best[1]


def task_line(task, brief_text=None, width=120):
    """What a member was brought in to do, in one line: its brief's title (its first heading, else
    its first line), else the first sentence of the task it was given. None when there is neither."""
    for source in (brief_text, task):
        lines = [x.strip() for x in str(source or "").splitlines() if x.strip()]
        if not lines:
            continue
        heading = next((re.sub(r"^#{1,6}\s+", "", x) for x in lines if re.match(r"^#{1,6}\s+\S", x)), None) if source is brief_text else None
        text = heading or lines[0]
        text = re.sub(r"^(?:brief|task)\s*[:—-]\s*", "", re.sub(r"[*_`]+", "", text), flags=re.I).strip()
        if source is task:
            text = re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]
        if text:
            return text if len(text) <= width else text[:width - 1].rstrip() + "…"
    return None


BASES = ("main", "master", "trunk")
BASE_BRANCHES = ("dev", "develop", "main", "master", "trunk")


def diff_stat(cwd, run=None):
    """A branch's change against where it left its base, working tree included:
    {"added", "removed", "files", "branch", "base"}; None on the base itself, outside git, or with
    nothing changed."""
    if not cwd or (run is None and not os.path.isdir(cwd)):
        return None
    run = run or (lambda args: subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True))

    def out(*args):
        try:
            r = run(list(args))
        except OSError:
            return None
        return r.stdout.strip() if r.returncode == 0 else None

    branch = out("rev-parse", "--abbrev-ref", "HEAD")
    if not branch or branch == "HEAD" or branch in BASES:
        return None
    base = nearest_base(out, branch)
    fork = base and out("merge-base", "HEAD", base)
    if not fork:
        return None
    added = removed = files = 0
    for line in (out("diff", "--numstat", fork) or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        added += int(parts[0]) if parts[0].isdigit() else 0
        removed += int(parts[1]) if parts[1].isdigit() else 0
    if not files:
        return None
    return {"added": added, "removed": removed, "files": files, "branch": branch, "base": base.split("/")[-1]}


# The Architect's plan review: an engineer who builds with design judgment (an editing role that is
# neither light_review nor on_request: Frontend, Backend) starts only once the Architect has reviewed
# the desk's plan. Kabeer starting one from the Desk is his call and skips it, and so does a desk
# with no architect role configured.
PLAN_RECORD = re.compile(r"^\d+-plan\.md$")


def plan_review_required(role, roles, by, reviewed):
    if by == "desk" or reviewed:
        return False
    if not any(r.get("id") == "architect" for r in roles):
        return False
    return bool(role.get("worktree")) and not role.get("light_review") and not role.get("on_request")


def next_record(names, kind):
    """The next decision record's file name in an architecture folder: NN-<kind>.md, numbered after
    the highest NN already there. kind: "plan", or a short topic slug."""
    numbers = [int(m.group(1)) for n in names for m in [re.match(r"^(\d+)-", n)] if m]
    kind = re.sub(r"[^a-z0-9]+", "-", (kind or "").lower()).strip("-")[:40].rstrip("-") or "decision"
    return f"{max(numbers, default=0) + 1:02d}-{kind}.md"


def has_plan_record(names):
    return any(PLAN_RECORD.match(n) for n in names)


# Registry size. A session keeps its role's settings for resume, but not the prompt text (about 17k
# characters each): the prompt files are the source, and only the part this launch added (the desk
# note, a fork's note) is stored. Sessions of deleted desks are dropped; nothing can resume them.
def slim_role_config(role_config, base_prompt):
    if not isinstance(role_config, dict) or "promptText" not in role_config:
        return role_config
    text = role_config.get("promptText") or ""
    slim = {k: v for k, v in role_config.items() if k != "promptText"}
    if base_prompt and text.startswith(base_prompt):
        slim["prompt_extra"] = text[len(base_prompt):]
    else:
        slim["promptText"] = text  # not built from the current files: keep it whole
    return slim


def full_role_config(role_config, base_prompt):
    if not isinstance(role_config, dict) or "prompt_extra" not in role_config:
        return role_config
    full = {k: v for k, v in role_config.items() if k != "prompt_extra"}
    full["promptText"] = (base_prompt or "") + role_config["prompt_extra"]
    return full


PRUNE_GRACE_MS = 10 * 60 * 1000  # a desk's chat file is written just after its first session is recorded


def prune_sessions(data, desk_exists, clock=now_ms):
    """Drops sessions (and finished queue items) whose desk is gone. Returns how many sessions went."""
    recent = clock() - PRUNE_GRACE_MS
    keep = [s for s in data.get("sessions", []) if not s.get("task") or desk_exists(s["task"]) or (s.get("at") or 0) > recent]
    gone = len(data.get("sessions", [])) - len(keep)
    data["sessions"] = keep
    data["queue"] = [q for q in data.get("queue", []) if q.get("state") in ("pending", "dispatching") or desk_exists(q.get("task"))]
    return gone
