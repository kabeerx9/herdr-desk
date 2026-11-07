"""Codex CLI adapter. Tested against codex-cli 0.167.0."""
import json

from .agents import AgentAdapter
from . import codex_transcript, screen


class CodexAdapter(AgentAdapter):
    name = "codex"
    default_args = {}  # resume and fork aren't wired up for Codex yet
    aliases = frozenset({"codex", "codex-cli"})
    has_transcript = True
    startup_dialog = True

    def trust_prompt(self, text):
        return ["enter"] if "Trust this folder?" in text else None

    def screen_state(self, text):
        return screen.screen_state(text, "codex")

    def find_transcript(self, session):
        return codex_transcript.find_codex_rollout(session)

    def turns(self, path, limit):
        return codex_transcript.codex_turns(path, limit)

    def usage(self, lines):
        return codex_transcript.codex_usage(lines)

    def launch_argv(self, role, task, env):
        prompt, extra, effort = role["promptText"], role.get("args", []), role.get("effort")
        # --no-daemon: otherwise Codex runs its commands outside hc. -c parses TOML;
        # a JSON string is a valid TOML basic string, and a JSON list a TOML array.
        base = ["codex", "--no-daemon"] + (["-m", role["model"]] if role.get("model") else [])
        base += ["-c", f'model_reasoning_effort="{effort}"'] if effort else []
        # Codex's auto mode: the sandbox stays on, and a reviewer model answers its approval requests.
        base += ["--approve-for-me"] if role.get("permission_mode") == "auto" else []
        base += ["-c", "notify=" + json.dumps([env.self_path, "hook", "codex"])]
        base += ["-c", "developer_instructions=" + json.dumps(prompt)] if prompt else []
        return base + extra + ([task] if task else [])
