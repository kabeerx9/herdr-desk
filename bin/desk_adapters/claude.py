"""Claude Code adapter. Tested against Claude Code 2.1.319."""
import json
import os

from .agents import AgentAdapter
from . import claude_transcript, screen


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
