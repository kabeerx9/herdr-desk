"""Claude Code transcripts (~/.claude/projects/*/<id>.jsonl): usage, timeline, turns, title.
Tested against Claude Code 2.1.319."""
import calendar
import glob
import json
import os
import re
import tempfile
import time
from .pricing import call_cost


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


def last_tool_at(path):
    """When the turn's newest tool call was made. None if the transcript shows none."""
    try:
        lines, _ = read_tail(path)
    except (OSError, TypeError):
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = (entry.get("message") or {}).get("content") if isinstance(entry, dict) else None
        if entry.get("type") == "assistant" and isinstance(content, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_use" for b in content):
            return ts_ms(entry.get("timestamp"))
    return None


def turn_started(path):
    """When this turn began: the last line a person or agent sent, not a tool's result. None if unknown."""
    try:
        lines, _ = read_tail(path)
    except OSError:
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = (entry.get("message") or {}).get("content") if isinstance(entry, dict) else None
        if entry.get("type") == "user" and not entry.get("isMeta") and not (
                isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)):
            return ts_ms(entry.get("timestamp"))
    return None


# ── Leftover processes ───────────────────────────────────────────────────────

TAIL_BYTES = 512 * 1024
JOB_TAIL = 16 * 1024 * 1024  # API blobs fill a transcript fast, and a job can outlive 512 KB by far
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


NOTIFICATION = re.compile(r"<task-notification>.*?<task-id>([^<]+)</task-id>.*?<status>([^<]+)</status>", re.S)
OUTPUT_FILE = re.compile(r"written to: (\S+?)\.?(?:\s|$)")


def transcript_jobs(lines):
    """Background commands in a Claude transcript, oldest first: {id, title, status, started_ms, ended_ms, output}.
    A command starts with a tool result carrying backgroundTaskId and ends with a <task-notification>."""
    titles, jobs = {}, {}
    for line in lines:
        if not ("backgroundTaskId" in line or "<task-notification>" in line or '"tool_use"' in line):
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        kind, at = entry.get("type"), ts_ms(entry.get("timestamp"))
        if kind == "assistant":
            for block in _content(entry):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool = block.get("input") or {}
                    titles[block.get("id")] = str(tool.get("description") or tool.get("command") or block.get("name") or "")
        elif kind == "user" and isinstance(entry.get("toolUseResult"), dict) and entry["toolUseResult"].get("backgroundTaskId"):
            block = next((b for b in _content(entry) if isinstance(b, dict) and b.get("type") == "tool_result"), {})
            found = OUTPUT_FILE.search(str(block.get("content") or ""))
            job = entry["toolUseResult"]["backgroundTaskId"]
            jobs[job] = {"id": job, "title": titles.get(block.get("tool_use_id")) or "Background command", "status": "running",
                         "started_ms": at, "ended_ms": None, "output": found.group(1) if found else None}
        if kind in ("user", "queue-operation"):
            text = entry.get("content") if kind == "queue-operation" else (entry.get("message") or {}).get("content")
            for job, status in NOTIFICATION.findall(text if isinstance(text, str) else ""):
                if job in jobs and jobs[job]["status"] == "running":
                    jobs[job].update(status="done" if status == "completed" else "failed", ended_ms=at)
    return list(jobs.values())


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


def tail_lines(path, size=4_000_000):
    """The end of a (possibly huge) transcript, newest line first."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - size))
        return reversed(f.read().decode("utf-8", "replace").splitlines())


def claude_context(transcript):
    """Tokens in a Claude agent's context now: its last main-thread call's prompt plus reply."""
    try:
        lines = tail_lines(transcript)
    except (OSError, TypeError):
        return None
    for line in lines:
        if '"compact_boundary"' in line:  # compacted since its last call: unknown until its next one
            return None
        if '"usage"' not in line:
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("type") != "assistant" or r.get("isSidechain"):
            continue
        u = (r.get("message") or {}).get("usage") or {}
        return sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")) or None
    return None


def compact_meta(transcript):
    try:
        for line in tail_lines(transcript):
            if '"compact_boundary"' in line:
                return json.loads(line).get("compactMetadata")
    except (OSError, TypeError, ValueError):
        pass
    return None


def last_text(transcript):
    """The newest assistant text in a Claude transcript (older Claude Codes' Stop input lacks it)."""
    try:
        with open(transcript) as f:
            lines = f.readlines()[-200:]
    except (OSError, TypeError):
        return ""
    for line in reversed(lines):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("type") == "assistant":
            parts = [c.get("text", "") for c in (r.get("message") or {}).get("content", []) if isinstance(c, dict) and c.get("type") == "text"]
            if any(parts):
                return "\n".join(parts)
    return ""
