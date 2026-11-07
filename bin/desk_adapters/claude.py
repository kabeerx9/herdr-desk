"""Claude Code adapter. Tested against Claude Code 2.1.319."""
import json
import os
import subprocess

from .agents import AgentAdapter, HookEvent
from . import claude_transcript, plan_usage as usage_api, screen

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"


class ClaudeAdapter(AgentAdapter):
    name = "claude"
    default_args = {"resume_args": ["--resume", "{session_id}"],
                    "fork_args": ["--resume", "{session_id}", "--fork-session"],
                    "session_args": ["--session-id", "{session_id}"]}
    aliases = frozenset({"claude", "claude-code"})
    has_transcript = True

    def trust_prompt(self, text):
        # Claude's prompt defaults to "No, exit", so it needs down then enter.
        return ["down", "enter"] if "Yes, I trust this folder" in text else None

    def screen_state(self, text):
        return screen.screen_state(text, "claude")

    def permission_prompt(self, text):
        return screen.permission_dialog(text, "claude")

    # Hooks: Claude sends each hook one JSON object on stdin.

    def hook_event(self, text):
        """A hook's stdin as a HookEvent, or None when it isn't a JSON object."""
        try:
            payload = json.loads(text)
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        return HookEvent(kind=payload.get("hook_event_name") or "", message=payload.get("last_assistant_message") or "",
                         transcript=payload.get("transcript_path"), session_id=payload.get("session_id"),
                         cwd=payload.get("cwd"), tool=payload.get("tool_name"), tool_input=payload.get("tool_input"),
                         suggestions=tuple(payload.get("permission_suggestions") or ()))

    def turn_message(self, event):
        """The turn's final text; older Claude Codes' Stop input lacks it, so then the transcript's."""
        return event.message or claude_transcript.last_text(event.transcript)

    def permission_reply(self, behavior, message=None, rules=None, updated_input=None):
        """What a PermissionRequest hook prints to answer for Kabeer: "allow" or "deny"."""
        decision = {"behavior": behavior}
        if message:
            decision["message"] = message
        if updated_input is not None:
            decision["updatedInput"] = updated_input
        if rules:
            decision["updatedPermissions"] = list(rules)
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}

    # Plan usage: the endpoint Claude Code's /usage reads, with its own sign-in.

    @staticmethod
    def oauth(home=None):
        """Claude Code's sign-in: its keychain item, else ~/.claude/.credentials.json; None when neither."""
        try:
            raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                                 capture_output=True, text=True, timeout=10).stdout
            return json.loads(raw)["claudeAiOauth"]
        except Exception:
            path = os.path.join(home or os.path.expanduser("~"), ".claude", ".credentials.json")
            if not os.path.exists(path):
                return None
            with open(path) as f:
                return json.load(f)["claudeAiOauth"]

    @staticmethod
    def plan_name(creds):
        plan = (creds.get("subscriptionType") or "").title()
        tier = (creds.get("rateLimitTier") or "").rsplit("_", 1)[-1]
        if tier.endswith("x") and tier[:-1].isdigit():
            plan = f"{plan} {tier}"
        return plan or None

    @staticmethod
    def usage_windows(u):
        windows = []
        # `limits` is the list Claude's own usage page draws: session, weekly, and
        # weekly limits scoped to one model (Fable, ...). Older responses lack it.
        for l in u.get("limits") or []:
            model = ((l.get("scope") or {}).get("model") or {}).get("display_name")
            label = {"session": "Session"}.get(l.get("group"), f"{model} week" if model else "Week")
            windows.append({"label": label, "used": round(l.get("percent") or 0),
                            "resets_at": usage_api.iso_to_epoch(l.get("resets_at")), "severity": l.get("severity")})
        if not windows:
            for key, label in (("five_hour", "Session"), ("seven_day", "Week")):
                w = u.get(key)
                if w and w.get("utilization") is not None:
                    windows.append({"label": label, "used": round(w["utilization"]), "resets_at": usage_api.iso_to_epoch(w.get("resets_at"))})
        return windows

    def plan_usage(self, get=usage_api.http_get, creds=None):
        """Claude's plan limits, or None when Claude Code isn't signed in."""
        creds = creds or self.oauth()
        if creds is None:
            return None
        out = usage_api.report("Claude", self.plan_name(creds))
        try:
            u = get(USAGE_URL, {"Authorization": f"Bearer {creds['accessToken']}",
                                "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0"})
        except Exception as e:
            out["error"] = usage_api.request_failed(e)
            return out
        out["windows"] = self.usage_windows(u)
        return out

    def context_size(self, transcript):
        return claude_transcript.claude_context(transcript)

    def compact_info(self, transcript):
        return claude_transcript.compact_meta(transcript)

    def find_transcript(self, session):
        return claude_transcript.find_transcript(session.get("conversation"))

    def turns(self, path, limit):
        return claude_transcript.transcript_turns(path, limit)

    def usage(self, lines):
        return claude_transcript.transcript_usage(lines)

    def launch_argv(self, role, task, env):
        prompt, extra, effort = role["promptText"], role.get("args", []), role.get("effort")
        # --tools first: it takes several values, so a value-less flag must follow it, never the task.
        # Fewer tools and no MCP servers keep every call's prompt small (measured 41k -> 17k tokens).
        # A role without Skill in its list gets no skills. With it, the skill list adds about 11k tokens.
        # A role with no tools list and mcp true (the CTO) launches as a full Claude Code session.
        base = ["claude"] + (["--tools", ",".join(role["tools"])] if role.get("tools") else [])
        base += [] if role.get("mcp") else ["--strict-mcp-config"]
        base += ["--model", role["model"]] if role.get("model") else []
        base += ["--effort", effort] if effort else []
        base += ["--permission-mode", role["permission_mode"]] if role.get("permission_mode") else []
        # Stop: post replies, measure context. PreToolUse: each tool call as one line of the agent's
        # activity feed (the Desk shows it while the agent works; no tokens spent).
        # SessionStart after a compaction (asked for or Claude's own): its new size.
        # PermissionRequest: what it would ask in its terminal, asked in the desk chat (team permit answers).
        # bash: in zsh, a bare `echo ====` is a failed =cmd lookup that stops the rest of the command.
        # Prompt suggestions: Claude's grey guess at the next message sits in the input box, and the
        # screen text can't tell it from typing, so the Desk reads it as unsent text. Nobody types
        # there anyway, and each guess is a model call.
        # Before --settings: --add-dir takes several values, so a one-value flag must follow it.
        os.makedirs(env.attachments, exist_ok=True)
        base += ["--add-dir", env.attachments]
        me = env.self_path
        base += ["--settings", json.dumps({"env": {"CLAUDE_CODE_SHELL": "/bin/bash", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false"}, "hooks": {
            "Stop": [{"hooks": [{"type": "command", "command": f"{me} hook claude", "timeout": 20}]}],
            "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": f"{me} hook claude-tool", "timeout": 10}]}],
            # UserPromptSubmit: the turn starts; snapshot the worktree for the Last turn review.
            "UserPromptSubmit": [{"hooks": [{"type": "command", "command": f"{me} hook claude-prompt", "timeout": 15}]}],
            "SessionStart": [{"matcher": "startup|resume|clear", "hooks": [{"type": "command", "command": f"{me} hook session", "timeout": 10}]}, {"matcher": "compact", "hooks": [{"type": "command", "command": f"{me} hook claude-compact", "timeout": 20}]}],
            "PermissionRequest": [{"matcher": "*", "hooks": [{"type": "command", "command": f"{me} hook claude-permission", "timeout": env.question_timeout}]}]}})]
        base += ["--append-system-prompt", prompt] if prompt else []
        return base + extra + ([task] if task else [])
