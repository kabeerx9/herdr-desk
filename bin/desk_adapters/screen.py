"""Reading an agent CLI's terminal screen: its prompt box, dialogs and permission prompts.
Claude Code 2.1.319 and codex-cli 0.167.0 layouts."""
import os
import re


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
    """The CLI's permission prompt on this screen: {"title", "subject" (what it asks about: the
    command, the file), "question", "options": [{"n", "label", "kind", "focused", "keys"?,
    "button"?}]}, or None when the visible screen shows no permission prompt (its prompt box,
    another dialog, a picker). An option's "keys" pick it (default: its number); "button" names
    it on the Desk's card when the kind's usual name would mislead."""
    if cli == "codex":
        return codex_permission_dialog(screen)
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


# Codex 0.167: "Would you like to run the following command?" with numbered options, or the older
# one-line "Allow command?" › "Yes (y)    Always (a)    No, provide feedback (n)". Its first launch
# in a folder asks whether it may work there without asking for approval at all.
CODEX_QUESTION = re.compile(r"^\s*(?:Would you like to .+|Allow [\w ]+)\?\s*$")
CODEX_OPTION = re.compile(r"^\s*([›❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$")
CODEX_SHORTCUT = re.compile(r"\s*\((y|a|n|esc)\)\s*$", re.I)
CODEX_CHOICE = re.compile(r"([A-Z][^()›]*?)\s*\((y|a|n|esc)\)")
CODEX_TRUST = "work in this folder without asking for approval"
CODEX_FOLDER = re.compile(r"You are running Codex in (\S.*?)\s*$")


def _codex_kind(label):
    text = CODEX_SHORTCUT.sub("", label).strip().lower()
    return "always" if text.startswith("always") else option_kind(label)


def codex_permission_dialog(screen):
    """Codex's approval prompt, or its folder-trust prompt, in permission_dialog's shape."""
    if screen_state(screen, "codex")["state"] != "dialog":
        return None
    lines = [x.rstrip() for x in _lines(screen)]
    while lines and not lines[-1].strip():
        lines.pop()
    tail = lines[-40:]
    numbered = [(i, CODEX_OPTION.match(x)) for i, x in enumerate(tail) if CODEX_OPTION.match(x)]
    if any(CODEX_TRUST in m.group(3) for _, m in numbered):
        folder = next((m.group(1) for m in map(CODEX_FOLDER.search, tail) if m), "")
        options = []
        for _, m in numbered:
            yes = m.group(3).lower().startswith("yes")
            # "Yes" turns Codex's approvals off in this folder for good; "No" lets it start and keeps asking.
            options.append({"n": int(m.group(2)), "label": m.group(3), "kind": "always" if yes else "allow",
                            "focused": bool(m.group(1)), "keys": [m.group(2)], "button": "Trust folder" if yes else "Keep asking"})
        return {"title": "Trust folder", "subject": folder, "question": "Let Codex work in this folder without asking for approval?",
                "options": options}
    q = next((i for i in range(len(tail) - 1, -1, -1) if CODEX_QUESTION.match(tail[i])), None)
    if q is None:
        return None
    below = tail[q + 1:]
    options = []
    for _, m in ((i, CODEX_OPTION.match(x)) for i, x in enumerate(below)):
        if m and int(m.group(2)) == len(options) + 1:
            key = CODEX_SHORTCUT.search(m.group(3))
            options.append({"n": int(m.group(2)), "label": CODEX_SHORTCUT.sub("", m.group(3)), "kind": _codex_kind(m.group(3)),
                            "focused": bool(m.group(1)), "keys": [key.group(1).lower()] if key else [m.group(2)]})
    if not options:
        line = next((x for x in below if len(CODEX_CHOICE.findall(x)) >= 2), "")
        for n, (label, key) in enumerate(CODEX_CHOICE.findall(line), 1):
            options.append({"n": n, "label": label.strip(), "kind": _codex_kind(label), "focused": False, "keys": [key.lower()]})
    if not any(o["kind"] == "allow" for o in options) or not any(o["kind"] == "deny" for o in options):
        return None
    command = [x.strip()[2:] for x in below if x.strip().startswith("$ ")]
    reason = next((x.strip()[len("Reason:"):].strip() for x in below if x.strip().startswith("Reason:")), "")
    question = tail[q].strip()
    title = "Run command" if command else "Edit files" if "edit" in question.lower() else "Codex"
    subject = "\n".join(command) or "\n".join(x.strip() for x in below if x.strip() and not CODEX_OPTION.match(x)
                                              and not CODEX_CHOICE.search(x) and not _hinted(x) and not x.strip().startswith("Reason:"))
    return {"title": title, "subject": subject, "question": question + (f" ({reason})" if reason else ""), "options": options}


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
