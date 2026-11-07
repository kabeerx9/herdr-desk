"""Codex CLI adapter. Tested against codex-cli 0.167.0."""
import json

from .agents import AgentAdapter


class CodexAdapter(AgentAdapter):
    name = "codex"
    default_args = {}  # resume and fork aren't wired up for Codex yet

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
