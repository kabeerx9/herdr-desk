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
    if verdict == "fail" and len(reviews) >= max_rounds:
        verdict = "escalate"
        reasons.append("%d review rounds without a clean review: stop and ask Kabeer" % len(reviews))
    return {"verdict": verdict, "head": head, "engineer_cli": eng_cli, "rounds": len(reviews), "max_rounds": max_rounds,
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
PRICES = {"claude-fable-5-1": (10.0, 50.0, 0.25), "claude-opus-5-5": (4.0, 20.0, 0.20),
          "claude-sonnet-5-5": (2.0, 10.0, 0.20), "claude-haiku-5-5": (0.10, 0.50, 0.01)}


def call_cost(model, usage):
    """API-rate dollars for one model call, or None for a model with no known price."""
    price = PRICES.get(model)
    if not price:
        return None
    inp, out, read = price
    fresh = usage.get("input_tokens") or 0
    cached = usage.get("cache_read_input_tokens") or 0
    written = usage.get("cache_creation_input_tokens") or 0
    parts = usage.get("cache_creation") or {}
    hour = parts.get("ephemeral_1h_input_tokens") or 0
    five = parts.get("ephemeral_5m_input_tokens") or 0
    if not hour and not five:
        five = written
    scale = 5 if model == "claude-haiku-5-5" and fresh + cached + written > 100000 else 1
    return scale * (fresh * inp + hour * inp * 2 + five * inp * 1.25 + cached * read
                    + (usage.get("output_tokens") or 0) * out) / 1e6


def transcript_usage(lines):
    """Token totals and cost of a Claude transcript. A reply's usage repeats on each of its content
    lines, so each message id counts once; the last line for an id has the final count."""
    calls = {}
    for line in lines:
        if '"usage"' not in line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("message") or {}
        if rec.get("type") == "assistant" and msg.get("usage") and msg.get("model") != "<synthetic>":
            calls[msg.get("id") or id(rec)] = msg
    out = {"calls": len(calls), "input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "cost": 0.0, "models": [], "priced": True}
    for msg in calls.values():
        usage, model = msg["usage"], msg.get("model")
        out["input"] += usage.get("input_tokens") or 0
        out["cache_write"] += usage.get("cache_creation_input_tokens") or 0
        out["cache_read"] += usage.get("cache_read_input_tokens") or 0
        out["output"] += usage.get("output_tokens") or 0
        cost = call_cost(model, usage)
        out["priced"] = out["priced"] and cost is not None
        out["cost"] += cost or 0
        if model not in out["models"]:
            out["models"].append(model)
    return out


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
LAUNCH_FAILURES = (
    ("usage_limit", r"usage limit reached|you(?:'|\u2019)ve hit your (?:usage )?limit|limit will reset|"
                    r"\b\d+-hour limit reached|weekly limit reached|rate_limit_error|insufficient_quota|"
                    r"credit balance is too low|out of extra usage"),
    ("auth", r"invalid api key|please run /login|oauth token has expired|authentication_error|"
             r"api error: 401|not logged in|codex login|please log in"),
)


def classify_launch_failure(text, task=None):
    """usage_limit | auth | None for a just-launched CLI's screen (or stderr)."""
    text = text or ""
    if task:
        text = text.replace(task, " ")
    flat = " ".join(text.split()).lower()
    for kind, pattern in LAUNCH_FAILURES:
        if re.search(pattern, flat):
            return kind
    return None


# ── Claude transcripts: timeline and title ──────────────────────────────────

TAIL_BYTES = 512 * 1024
SUBAGENT_TAIL = 64 * 1024
CONTEXT_MAX, CONTEXT_MAX_1M = 200_000, 1_000_000
CATEGORIES = ("read", "search", "command", "edit", "web", "agent", "other")
TOOL_CATEGORY = {"Read": "read", "NotebookRead": "read", "LS": "read", "Glob": "search", "Grep": "search",
                 "Bash": "command", "Edit": "edit", "Write": "edit", "MultiEdit": "edit", "NotebookEdit": "edit",
                 "WebFetch": "web", "WebSearch": "web", "Task": "agent", "Agent": "agent"}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def projects_root():
    return os.environ.get("TEAM_CLAUDE_PROJECTS") or os.path.expanduser("~/.claude/projects")


def find_transcript(conversation, root=None):
    if not conversation or not SAFE_ID.match(str(conversation)):
        return None
    hits = glob.glob(os.path.join(root or projects_root(), "*", str(conversation) + ".jsonl"))
    if not hits:
        return None
    return max(hits, key=lambda p: os.stat(p).st_mtime)


def read_tail(path, limit=TAIL_BYTES):
    """Whole lines from the last `limit` bytes: (lines, cut) where cut says older lines exist."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        start = max(0, size - limit)
        f.seek(start)
        data = f.read(limit)
    if start:
        nl = data.find(b"\n")
        data = data[nl + 1:] if nl >= 0 else b""
    return data.decode("utf-8", "replace").splitlines(), start > 0


def ts_ms(value):
    m = re.match(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(?:Z|[+-]00:?00)?$", str(value or ""))
    if not m:
        return None
    return calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S")) * 1000 + int((m.group(2) or "0")[:3].ljust(3, "0"))


def _content(entry):
    content = (entry.get("message") or {}).get("content")
    return content if isinstance(content, list) else ([{"type": "text", "text": content}] if isinstance(content, str) else [])


def is_prompt(entry):
    """A real user prompt: not a tool result, meta line, compaction summary or injected notice."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain") or entry.get("isCompactSummary"):
        return False
    origin = entry.get("origin")
    if isinstance(origin, dict) and origin.get("kind") not in (None, "human"):
        return False
    blocks = _content(entry)
    if not blocks or any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
        return False
    first = next((b.get("text") for b in blocks if isinstance(b, dict) and b.get("type") == "text"), "") or ""
    return not first.lstrip().startswith(("<task-notification>", "<local-command-", "<system-reminder>"))


def step_text(name, inp):
    """One short line for a tool call, the way a person would say it."""
    inp = inp if isinstance(inp, dict) else {}
    base = lambda v: os.path.basename(str(v or "").rstrip("/")) or str(v or "")
    if name == "Bash":
        return (inp.get("description") or " ".join((inp.get("command") or "").split())[:90] or "Run a command")
    if name in ("Read", "Edit", "Write", "MultiEdit", "NotebookEdit"):
        verb = {"Read": "Read", "Edit": "Edit", "MultiEdit": "Edit", "Write": "Write", "NotebookEdit": "Edit"}[name]
        return f"{verb} {base(inp.get('file_path') or inp.get('notebook_path'))}"
    if name == "Glob":
        return f"Find files {inp.get('pattern') or ''}".strip()
    if name == "Grep":
        return f"Search for {inp.get('pattern') or ''}".strip()
    if name == "WebFetch":
        host = re.sub(r"^https?://([^/]+).*$", r"\1", inp.get("url") or "")
        return f"Fetch {host}"
    if name == "WebSearch":
        return f"Search the web: {inp.get('query') or ''}"
    if name == "TodoWrite":
        return "Update the plan"
    if name in ("Task", "Agent"):
        return f"Start a sub-agent: {inp.get('description') or ''}".strip(": ")
    if name.startswith("mcp__"):
        return name.split("__")[-1].replace("_", " ").capitalize()
    return name


PHRASES = {"read": ("read %d file", "read %d files"), "search": ("ran %d search", "ran %d searches"),
           "command": ("ran %d command", "ran %d commands"), "edit": ("made %d edit", "made %d edits"),
           "web": ("made %d web request", "made %d web requests"), "agent": ("started %d agent", "started %d agents"),
           "other": ("used %d other tool", "used %d other tools")}
FIRST_ON_TIES = {"command": 0, "edit": 1, "agent": 2}


def tools_summary(counts, failed=0):
    """The two biggest categories ("Read 4 files, ran 2 commands"); commands, edits and agents win ties."""
    ranked = sorted((k for k in CATEGORIES if counts.get(k)), key=lambda k: (-counts[k], FIRST_ON_TIES.get(k, 9), CATEGORIES.index(k)))
    parts = [PHRASES[k][counts[k] != 1] % counts[k] for k in ranked[:2]]
    if failed:
        parts.append("%d failed" % failed)
    text = ", ".join(parts)
    return text[:1].upper() + text[1:] if text else ""


def _first_line(text, width=140):
    for line in str(text or "").splitlines():
        line = line.strip()
        if line:
            return line[:width]
    return None


def _result_text(block):
    content = block.get("content")
    if isinstance(content, list):
        content = "\n".join(str(x.get("text") or "") for x in content if isinstance(x, dict))
    return content if isinstance(content, str) else ""


def _subagent_metas(path):
    folder = os.path.join(path[:-len(".jsonl")], "subagents")
    metas = {}
    try:
        names = sorted(glob.glob(os.path.join(folder, "agent-*.meta.json")), key=os.path.getmtime, reverse=True)[:64]
    except OSError:
        return metas
    for name in names:
        try:
            with open(name) as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict) and meta.get("toolUseId"):
            metas[meta["toolUseId"]] = {**meta, "_file": name[:-len(".meta.json")] + ".jsonl",
                                        "_id": os.path.basename(name)[:-len(".meta.json")]}
    return metas


def _subagent_progress(path):
    """(latest step or text line, last entry ms) of a subagent's own transcript."""
    try:
        lines, _ = read_tail(path, SUBAGENT_TAIL)
    except OSError:
        return None, None
    last_ms = None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        last_ms = last_ms or ts_ms(entry.get("timestamp"))
        if entry.get("type") != "assistant":
            continue
        for block in reversed(_content(entry)):
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                return step_text(block.get("name") or "", block.get("input"))[:140], last_ms
            if block.get("type") == "text" and _first_line(block.get("text")):
                return _first_line(block.get("text")), last_ms
    return None, last_ms


def context_max(model):
    return CONTEXT_MAX_1M if re.search(r"\[1m\]|[-_]1m\b", str(model or ""), re.I) else CONTEXT_MAX


def _subagents(path, calls, results, metas=None):
    """Task/Agent calls with their results and subagents/ files: one row each (see team timeline)."""
    metas = _subagent_metas(path) if calls and metas is None else (metas or {})
    subagents = []
    for call in calls[-20:]:
        res, meta = results.get(call["tool_id"]), metas.get(call["tool_id"])
        async_launch = bool(res and res["meta"].get("status") == "async_launched")
        agent_id = (meta or {}).get("_id") or ("agent-" + res["meta"]["agentId"] if res and res["meta"].get("agentId") else None)
        if res and res["error"]:
            status = "failed"
        elif meta is not None and "finished" in meta:
            status = "done" if meta.get("finished") else "running"
        else:
            status = "done" if res and not async_launch else "running"
        line, last = (None, None)
        sub_file = (meta or {}).get("_file") or (os.path.join(path[:-len(".jsonl")], "subagents", agent_id + ".jsonl") if agent_id else None)
        if sub_file and (status == "running" or async_launch):
            line, last = _subagent_progress(sub_file)
        if status in ("done", "failed") and res and not async_launch:
            line = _first_line(res["text"]) or line
        ended_ms = None
        if status in ("done", "failed"):
            ended_ms = res["at"] if res and not async_launch else last
        subagents.append({"id": agent_id or call["tool_id"], "title": call["input"].get("description") or (meta or {}).get("description"),
                          "type": call["input"].get("subagent_type") or (meta or {}).get("agentType") or "general-purpose",
                          "status": status, "started_ms": call["at"], "ended_ms": ended_ms, "line": (line or None) and line[:140]})
    return subagents


def transcript_timeline(path, since_ms=None, limit=TAIL_BYTES):
    """What a Claude agent did this turn, from the transcript's tail only (see team timeline)."""
    lines, _cut = read_tail(path, limit)
    turn, started, title, context = [], None, None, None
    in_turn = True
    for line in reversed(lines):
        want_title = title is None and '"ai-title"' in line
        want_usage = context is None and '"usage"' in line
        if not (in_turn or want_title or want_usage or (context is None and '"compact_boundary"' in line)):
            if title is not None and context is not None:
                break
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        kind = entry.get("type")
        if kind == "ai-title" and title is None and entry.get("aiTitle"):
            title = str(entry["aiTitle"])
        if context is None and kind == "system" and entry.get("subtype") == "compact_boundary":
            context = {"tokens": None, "max": CONTEXT_MAX}
        if context is None and kind == "assistant" and not entry.get("isSidechain"):
            message = entry.get("message") or {}
            usage = message.get("usage")
            if isinstance(usage, dict):
                tokens = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                context = {"tokens": tokens or None, "max": context_max(entry.get("requestedModel") or message.get("model"))}
        if in_turn:
            at = ts_ms(entry.get("timestamp"))
            if since_ms is not None:
                if at is not None and at < since_ms:
                    in_turn = False
                    continue
            elif is_prompt(entry):
                started = at
                in_turn = False
                continue
            turn.append(entry)
    turn.reverse()
    partial = bool(in_turn and _cut)  # the turn began before the tail we read
    if since_ms is not None:
        started = since_ms
    elif started is None:
        started = next((ts_ms(e.get("timestamp")) for e in turn if e.get("timestamp")), None)

    counts = {k: 0 for k in CATEGORIES}
    failed, calls, results, thought, ended = 0, [], {}, None, False
    for entry in turn:
        if entry.get("isSidechain"):
            continue
        at = ts_ms(entry.get("timestamp"))
        kind = entry.get("type")
        if kind == "system" and entry.get("subtype") in ("turn_duration", "stop_hook_summary"):
            ended = True
        elif kind == "assistant":
            ended = False
            for block in _content(entry):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    name = block.get("name") or ""
                    counts[TOOL_CATEGORY.get(name, "other")] += 1
                    if name in ("Task", "Agent"):
                        calls.append({"tool_id": block.get("id"), "input": block.get("input") or {}, "at": at})
                elif block.get("type") == "thinking" and str(block.get("thinking") or "").strip():
                    thought = {"text": str(block["thinking"]).strip(), "at": at, "source": "thinking"}
                elif block.get("type") == "text" and str(block.get("text") or "").strip() and (not thought or thought["source"] == "text"):
                    thought = {"text": str(block["text"]).strip(), "at": at, "source": "text"}
        elif kind == "user":
            for block in _content(entry):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    if block.get("is_error"):
                        failed += 1
                    results[block.get("tool_use_id")] = {"error": bool(block.get("is_error")), "at": at, "text": _result_text(block),
                                                         "meta": entry.get("toolUseResult") if isinstance(entry.get("toolUseResult"), dict) else {}}
    if thought:
        heading = re.search(r"\*\*([^*\n]{1,160})\*\*", thought["text"])
        thought = {"text": thought["text"][:400], "heading": heading.group(1).strip() if heading else None,
                   "at": thought["at"], "source": thought["source"]}

    subagents = _subagents(path, calls, results)
    return {"supported": True, "turn": {"started_ms": started, "working": bool(turn) and not ended, "partial": partial},
            "thought": thought, "tools": {"summary": tools_summary(counts, failed), "counts": counts, "failed": failed},
            "subagents": subagents, "context": context, "title": title}


TRANSCRIPT_TURNS = 120
HC_WRAP = re.compile(r'^\s*<hc from="([^"]*)"[^>]*>(.*)</hc>\s*$', re.S)
DESK_KABEER = re.compile(r'^\[desk chat\] Kabeer(?: \((?:to|via) [^)]*\))?: ', re.S)
DIGEST = "\n\nAlso new in the chat"
COMMAND = re.compile(r"<command-name>\s*(/[^<\s]+)\s*</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
PASTED = re.compile(r'<pasted_content id="([^"]*)">\n?(.*?)\n?</pasted_content(?: id="\1")?>', re.S)
TYPED_COMMAND = re.compile(r"^/[A-Za-z][\w:-]*(?: [^\n]*)?$")


def prompt_text(entry):
    """A prompt's text, with pastes (hc send's bracketed paste, `<pasted_content>`) unwrapped."""
    text = "\n".join(str(b.get("text") or "") for b in _content(entry) if isinstance(b, dict) and b.get("type") == "text")
    return PASTED.sub(lambda m: m.group(2), text).strip()


def classify_prompt(text):
    """Who a prompt in a member's transcript came from, and what they said, without the Desk's wrapping.
    kabeer: a desk-chat delivery ("[desk chat] Kabeer: ...") or typed in its terminal;
    desk: the Desk's own notices ("[desk] ...", other agents' asks/answers relayed by the chat, the brief);
    parent: another agent's message (`<hc from=...>`), e.g. the CTO directing it or a child's report."""
    text = str(text or "").strip()
    sender = None
    wrapped = HC_WRAP.match(text)
    if wrapped:
        sender, text = wrapped.group(1).split(" ")[0] or None, wrapped.group(2).strip()
    m = DESK_KABEER.match(text)
    if m:
        body = text[m.end():]
        cut = body.find(DIGEST)
        return {"who": "kabeer", "text": (body[:cut] if cut >= 0 else body).strip(), "via": "chat"}
    if text.startswith("[desk chat] ") or text.startswith("[desk] "):
        body = text.split("] ", 1)[1]
        cut = body.find(DIGEST)
        return {"who": "desk", "text": (body[:cut] if cut >= 0 else body).strip()}
    if sender:
        return {"who": "parent", "text": text, "from": sender}
    if "(Team task: " in text:
        return {"who": "desk", "text": text}
    return {"who": "kabeer", "text": text}


def transcript_turns(path, limit=TRANSCRIPT_TURNS, tail=TAIL_BYTES):
    """A member's own conversation, from the transcript's tail (see team transcript): prompts by who sent
    them, the agent's replies, and the tool runs before each reply folded into it as a summary."""
    lines, cut = read_tail(path, tail)
    entries = []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and not entry.get("isSidechain"):
            entries.append(entry)
    turns, results = [], {}
    run = None  # the agent's work since its last text: {counts, failed, calls, at}

    def work():
        nonlocal run
        if run is None:
            run = {"counts": {k: 0 for k in CATEGORIES}, "failed": 0, "calls": [], "ids": set(), "at": None}
        return run

    def close(text, at):
        """The reply text (or "" for work that's still going) closes the run before it into one entry."""
        nonlocal run
        r, run = run, None
        tools = None
        subs = []
        if r:
            failed = sum(1 for i in r["ids"] if (results.get(i) or {}).get("error"))
            if any(r["counts"].values()):
                tools = {"summary": tools_summary(r["counts"], failed), "counts": r["counts"], "failed": failed}
            subs = r["calls"]
        last = turns[-1] if turns else None
        if text and not tools and not subs and last and last["who"] == "agent" and last.get("text") and not last.get("_open"):
            last["text"] += "\n\n" + text
            return
        turns.append({"who": "agent", "text": text, "at": at if at is not None else (r or {}).get("at"),
                      "tools": tools, "subagents": subs, **({"_open": True} if not text else {})})

    for entry in entries:
        kind, at = entry.get("type"), ts_ms(entry.get("timestamp"))
        if kind == "system" and entry.get("subtype") == "compact_boundary":
            if run:
                close("", at)
            turns.append({"who": "desk", "kind": "event", "text": "Conversation compacted", "at": at, "tools": None, "subagents": []})
            continue
        if kind == "assistant":
            for block in _content(entry):
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    r = work()
                    r["at"] = r["at"] or at
                    name = block.get("name") or ""
                    r["counts"][TOOL_CATEGORY.get(name, "other")] += 1
                    r["ids"].add(block.get("id"))
                    if name in ("Task", "Agent"):
                        r["calls"].append({"tool_id": block.get("id"), "input": block.get("input") or {}, "at": at})
                elif block.get("type") == "text" and str(block.get("text") or "").strip():
                    close(str(block["text"]).strip(), at)
            continue
        if kind != "user":
            continue
        blocks = _content(entry)
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results[b.get("tool_use_id")] = {"error": bool(b.get("is_error")), "at": at, "text": _result_text(b),
                                                    "meta": entry.get("toolUseResult") if isinstance(entry.get("toolUseResult"), dict) else {}}
            continue
        if entry.get("isMeta") or entry.get("isCompactSummary"):
            continue
        raw = prompt_text(entry)
        command = COMMAND.search(raw)
        if command:
            if run:
                close("", at)
            args = COMMAND_ARGS.search(raw)
            text = (command.group(1) + (" " + args.group(1).strip() if args and args.group(1).strip() else "")).strip()
            # Claude logs a typed command twice: as typed, then as <command-name>. Keep one.
            dup = next((x for x in reversed(turns[-3:]) if x.get("kind") == "command" and x["text"] == text), None)
            if dup is None:
                turns.append({"who": "kabeer", "kind": "command", "text": text, "at": at, "tools": None, "subagents": []})
            continue
        if not is_prompt(entry):
            continue
        if run:
            close("", at)
        said = classify_prompt(raw)
        if said["who"] == "kabeer" and "via" not in said and TYPED_COMMAND.match(said["text"]):
            said["kind"] = "command"
        turns.append({**said, "at": at, "tools": None, "subagents": []})
    if run:
        close("", None)
    # Subagents need the results, which can land after the call: resolve them once, at the end.
    metas = None
    for turn in turns:
        calls = turn.get("subagents") or []
        if calls and isinstance(calls[0], dict) and "tool_id" in calls[0]:
            if metas is None:
                metas = _subagent_metas(path)
            turn["subagents"] = _subagents(path, calls, results, metas)
        turn.pop("_open", None)
    partial = cut or len(turns) > limit
    return {"supported": True, "turns": turns[-limit:] if limit else turns, "partial": bool(partial)}



def transcript_title(path, cache_path=None, max_scan=8 * 1024 * 1024):
    """Claude's latest ai-title for a transcript, cached by (mtime, size) in cache_path."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    stamp = [st.st_mtime_ns, st.st_size]
    cache = {}
    if cache_path:
        try:
            with open(cache_path) as f:
                cache = json.load(f)
        except (OSError, ValueError):
            cache = {}
        hit = cache.get(path) if isinstance(cache, dict) else None
        if isinstance(hit, dict) and hit.get("stamp") == stamp:
            return hit.get("title")
    title, scanned = None, 0
    try:
        with open(path, "rb") as f:
            end = st.st_size
            carry = b""
            while end > 0 and scanned < max_scan and title is None:
                start = max(0, end - TAIL_BYTES)
                f.seek(start)
                chunk = f.read(end - start) + carry
                scanned += end - start
                lines = chunk.split(b"\n")
                carry = lines.pop(0) if start else b""
                for raw in reversed(lines):
                    if b'"ai-title"' not in raw:
                        continue
                    try:
                        entry = json.loads(raw.decode("utf-8", "replace"))
                    except ValueError:
                        continue
                    if isinstance(entry, dict) and entry.get("type") == "ai-title" and entry.get("aiTitle"):
                        title = str(entry["aiTitle"])
                        break
                end = start
    except OSError:
        return None
    if cache_path:
        if not isinstance(cache, dict):
            cache = {}
        cache[path] = {"stamp": stamp, "title": title}
        if len(cache) > 300:
            cache = dict(list(cache.items())[-200:])
        try:
            os.makedirs(os.path.dirname(cache_path), mode=0o700, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix=".titles-", dir=os.path.dirname(cache_path))
            with os.fdopen(fd, "w") as f:
                json.dump(cache, f)
            os.replace(tmp, cache_path)
        except OSError:
            pass
    return title


# ── slash commands: reading an agent's screen ────────────────────────────────
# What the Desk types into an agent depends on what its terminal shows right now. Claude draws
# its input box as "❯ text" between two "─" rules; its dialogs (/status, /cost, pickers,
# permission prompts) replace that box, open with a "▔" border or name their keys ("Esc to
# cancel"). Codex draws its input as a "›" line near the bottom with only its footer (model,
# context left) below; its dialogs (hooks review, approvals, /model, folder trust) take that
# place and end in key hints, often terse ("t trust all · enter review · esc close"). A dialog
# takes every key typed into it, so nothing is typed while one is open.

RULE = re.compile(r"^[─━]{20,}\s*$")
TOP_BORDER = re.compile(r"^\s*[▔]{20,}\s*$")
# A key named with what it does, in either CLI's wording: "Esc to cancel", "Enter to confirm",
# "enter review", "esc close", "Press enter to continue", "↑/↓ to navigate". Not "esc to
# interrupt" (a working agent) or "esc again to edit" (Codex's shortcut help): those leave the
# input usable.
DIALOG_KEYS = re.compile(r"\b(?:esc|enter|return|space)\s+(?:to\s+)?(?:cancel|close|exit|go back|back|dismiss|confirm|select|choose"
                         r"|continue|accept|review|submit|skip|toggle)\b|\bpress (?:enter|esc|return|any key)\b|[↑↓]\s*/\s*[↑↓]|↑↓", re.I)
# A list's focused option ("› 1. Yes, proceed") or a choice's key ("Yes (y)", "[y/n]").
OPTION_CURSOR = re.compile(r"^\s*[›❯>▶]\s*\d{1,2}[.)]\s+\S")
CHOICE_KEYS = re.compile(r"\((?:y|n|a|esc)\)|\[y/n\]", re.I)
# What Codex shows, dimmed, in an empty input (plain text can't tell dim from typed).
CODEX_PLACEHOLDERS = {"ask codex to do anything", "explain this codebase", "summarize recent commits", "implement {feature}",
                      "find and fix a bug in @filename", "write tests for @filename", "improve documentation in @filename",
                      "run /review on my current changes", "use /skills to list available skills"}
NO_INPUT = "no input line"   # Codex showing something other than its input: a weak sign, see screen_state
PROMPTS = ("❯", "›")
CHROME = re.compile(r"^\s*(?:[─━▔▁]{6,}|⏵⏵ .*|◐ .*· /effort|\? for shortcuts.*)\s*$|\besc to (?:cancel|close|exit|go back)\b", re.I)
DIALOG_TABS = re.compile(r"^\s*Settings\s+Status\s+Config\b")
DIALOG_OPEN = "has a dialog open in its terminal"


def _hinted(line):
    return bool(DIALOG_KEYS.search(line) or OPTION_CURSOR.match(line) or CHOICE_KEYS.search(line))


def _lines(screen):
    # Claude draws its prompt as "❯" + a no-break space.
    return str(screen or "").replace("\r", "").replace("\xa0", " ").split("\n")


def prompt_box(lines):
    """Claude's input box: (top rule, first input line, bottom rule) indices, or None. The last
    "❯" line at column 0 with a rule above it; the box can grow to a few input lines."""
    for i in range(len(lines) - 1, 0, -1):
        if not lines[i].startswith("❯") or not RULE.match(lines[i - 1]):
            continue
        for j in range(i + 1, min(i + 12, len(lines))):
            if RULE.match(lines[j]):
                return i - 1, i, j
        return None
    return None


def codex_input(lines):
    """Codex's input line: the index of the last "›" line at column 0 in the bottom rows with only
    its footer below (a few lines, no key hints, no options), or None. A "›" that marks a list's
    focused option, or sits above a dialog's key hints, is not it."""
    for i in range(len(lines) - 1, max(-1, len(lines) - 16), -1):
        if not lines[i].startswith("›"):
            continue
        if OPTION_CURSOR.match(lines[i]) or CHOICE_KEYS.search(lines[i]):
            return None
        below = [x for x in lines[i + 1:] if x.strip()]
        return None if len(below) > 6 or any(_hinted(x) for x in below) else i
    return None


def screen_state(screen, cli="claude"):
    """What an agent's visible screen shows: {"state": "prompt"|"dialog"|"unknown", "input": the
    text sitting in its input box (prompt only), "why": what gave a dialog away}. "unknown" (still
    starting, a CLI drawn differently) is neither: callers keep their old behaviour for it.
    A Codex screen with content but no input line is a dialog ("why": NO_INPUT), so a dialog
    the Desk has never seen is still not typed into."""
    lines = [x.rstrip() for x in _lines(screen)]
    while lines and not lines[-1].strip():
        lines.pop()
    tail = lines[-24:]
    if cli == "codex":
        i = codex_input(tail)
        if i is not None:
            text = tail[i][1:].strip()
            return {"state": "prompt", "input": "" if text.lower() in CODEX_PLACEHOLDERS else text, "why": None}
    else:
        box = prompt_box(lines)
        if box:
            top, first, bottom = box
            text = "\n".join(lines[first:bottom])
            return {"state": "prompt", "input": text[1:].strip() if text.startswith("❯") else text.strip(), "why": None}
    for line in lines:
        if TOP_BORDER.match(line):
            return {"state": "dialog", "input": None, "why": "a full-screen dialog"}
    for line in tail:
        m = DIALOG_KEYS.search(line)
        if m:
            return {"state": "dialog", "input": None, "why": m.group(0)}
    if any(OPTION_CURSOR.match(x) or CHOICE_KEYS.search(x) for x in tail):
        return {"state": "dialog", "input": None, "why": "options to choose from"}
    if cli == "codex" and sum(1 for x in tail if x.strip()) >= 3:
        return {"state": "dialog", "input": None, "why": NO_INPUT}
    return {"state": "unknown", "input": None, "why": None}


def _dedent(lines):
    pad = min((len(x) - len(x.lstrip()) for x in lines if x.strip()), default=0)
    return [x[pad:] for x in lines]


def command_result(screen, command, max_lines=200):
    """What a command printed, from the screen (with history) after it settled: below its echoed
    "❯ /cmd" line (inline output) or the dialog's top border, above Claude's input box; the box,
    rules, footers and key hints are chrome and go. None when nothing was found."""
    lines = [x.rstrip() for x in _lines(screen)]
    box = prompt_box(lines)
    end = box[0] if box else len(lines)
    start, name = None, str(command).strip()
    # The nearest one wins: an older dialog's border can still sit in the history above.
    for i in range(end - 1, -1, -1):
        text = lines[i].strip()
        if TOP_BORDER.match(lines[i]) or any(text == g + " " + name or text.startswith(g + " " + name + " ") for g in PROMPTS):
            start = i + 1; break
    if start is None:
        return None
    body = [x for x in lines[start:end] if not CHROME.search(x) and not DIALOG_TABS.match(x)]
    body = [re.sub(r"\s+[↓↑]$", "", x) for x in body]
    if body and body[0].lstrip().startswith("⎿"):
        body[0] = body[0].replace("⎿", " ", 1)
    while body and not body[0].strip():
        body.pop(0)
    while body and not body[-1].strip():
        body.pop()
    body = _dedent(body)
    if len(body) > max_lines:
        body = body[:max_lines] + ["…"]
    return "\n".join(body) or None


def cleared_transcript(folder, old, since_ms):
    """The conversation a /clear started, for a session whose SessionStart hook didn't record it:
    the newest transcript in the old one's project folder, written since the clear, that begins
    with Claude's own "/clear" record. None when there isn't exactly a fresh one yet."""
    best = None
    try:
        names = os.listdir(folder)
    except OSError:
        return None
    for name in names:
        if not name.endswith(".jsonl") or name[:-6] == old:
            continue
        path = os.path.join(folder, name)
        try:
            stamp = os.stat(path).st_mtime * 1000
            if stamp < since_ms - 1000:
                continue
            with open(path, "rb") as f:
                head = f.read(256 * 1024)
        except OSError:
            continue
        if b"<command-name>/clear</command-name>" not in head:
            continue
        if not best or stamp > best[0]:
            best = (stamp, name[:-6])
    return best[1] if best else None


# ── permission prompts: answering Claude's "Do you want to proceed?" from the Desk ──────────────
# Claude draws a permission prompt as a titled block ("Bash command", "Edit file", ...) above a
# rule, the thing asked about, a question ("Do you want to proceed?", "Do you want to make this
# edit to x.ts?") and numbered options, the focused one marked "❯". Its key hints ("Esc to
# cancel") make screen_state call it a dialog. Options are read off the screen, never assumed by
# position: their wording and order vary by tool and version.

PERMISSION_QUESTION = re.compile(r"^\s*Do you want to (?:proceed|make this edit to|create|allow|run|delete|overwrite|insert|fetch|use)\b.*\?\s*$")
OPTION = re.compile(r"^\s*(?:❯\s*)?(\d{1,2})\.\s+(.+?)\s*$")
BOX_EDGE = re.compile(r"^\s*[│┃]\s?|\s?[│┃]\s*$")
FRAME = re.compile(r"^\s*(?:[─━]{20,}|[╭╰][─━]{10,}[╮╯])\s*$")


def _unbox(line):
    return BOX_EDGE.sub("", line.rstrip())


def option_kind(label):
    """allow | always | deny | None for one option's label."""
    text = re.sub(r"\s*\((?:esc|shift\+tab|tab|[a-z])\)\s*$", "", label.strip(), flags=re.I).lower()
    if text.startswith("no"):
        return "deny"
    if text.startswith("yes"):
        rest = text[3:].lstrip(" ,")
        if not rest or rest == "proceed":
            return "allow"
        if re.search(r"don't ask again|do not ask again|always allow|allow all|from now on|this session|allow access|allow reading", rest):
            return "always"
        return "allow" if rest.startswith(("once", "just this")) else None
    return None


def permission_dialog(screen, cli="claude"):
    """Claude's permission prompt on this screen: {"title", "subject" (what it asks about: the
    command, the file), "question", "options": [{"n", "label", "kind", "focused"}]}, or None when
    the visible screen shows no permission prompt (its prompt box, another dialog, a picker)."""
    if cli != "claude":
        return None
    if screen_state(screen, cli)["state"] != "dialog":
        return None
    lines = [_unbox(x) for x in _lines(screen)]
    while lines and not lines[-1].strip():
        lines.pop()
    q = next((i for i in range(len(lines) - 1, -1, -1) if PERMISSION_QUESTION.match(lines[i])), None)
    if q is None:
        return None
    options, j = [], q + 1
    while j < len(lines) and len(options) < 9:
        m = OPTION.match(lines[j])
        if m and int(m.group(1)) == len(options) + 1:
            label = m.group(2)
            # A long label wraps onto an indented line without a number.
            while j + 1 < len(lines) and lines[j + 1].strip() and not OPTION.match(lines[j + 1]) \
                    and len(lines[j + 1]) - len(lines[j + 1].lstrip()) > len(lines[j]) - len(lines[j].lstrip()) + 2:
                j += 1
                label += " " + lines[j].strip()
            options.append({"n": int(m.group(1)), "label": label, "kind": option_kind(label), "focused": "❯" in lines[j].split(".")[0]})
        elif options and lines[j].strip():
            break
        j += 1
    if len(options) < 2 or not any(o["kind"] == "allow" for o in options) or not any(o["kind"] == "deny" for o in options):
        return None
    # The block above the question: back to the frame (a rule or a box top), its first line the title.
    top = next((i for i in range(q - 1, -1, -1) if FRAME.match(lines[i]) or TOP_BORDER.match(lines[i])), None)
    body = [x for x in lines[(top + 1 if top is not None else max(0, q - 14)):q]]
    while body and not body[0].strip():
        body.pop(0)
    title = body.pop(0).strip() if body else ""
    subject = [x.strip() for x in body if x.strip() and not re.fullmatch(r"[╌┄┈─-]+", x.strip())]
    return {"title": title, "subject": "\n".join(subject), "question": lines[q].strip(), "options": options}


def _squash(text):
    return re.sub(r"\s+", "", str(text or "")).lower()


def dialog_matches(dialog, expect):
    """Does the prompt on screen ask about `expect` (the command or file the Desk showed)? Whitespace
    is ignored (the screen wraps long commands); a file matches by its name in the question."""
    if not expect:
        return True
    want, shown = _squash(expect), _squash(dialog["subject"] + "\n" + dialog["question"])
    if not want:
        return True
    if want in shown:
        return True
    # A very long command the dialog shortened: its first part must still be there, word for word.
    if len(want) > 160 and want[:160] in shown:
        return True
    name = os.path.basename(str(expect).strip().rstrip("/"))
    return bool(name) and "/" in str(expect) and _squash(name) in _squash(dialog["question"] + dialog["subject"])


def pick_option(dialog, choice):
    """The option that means `choice` (allow | always | deny) on this dialog, or None."""
    return next((o for o in dialog["options"] if o["kind"] == choice), None)


# ── what the Desk shows about a member's work ────────────────────────────────────────────────────

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
    head = out("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    candidates = ([head] if head else []) + list(BASES) + [f"origin/{b}" for b in BASES]
    base = next((c for c in candidates if c and c.split("/")[-1] != branch and out("rev-parse", "--verify", "--quiet", c)), None)
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
