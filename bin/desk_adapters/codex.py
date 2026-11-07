"""Codex CLI adapter. Tested against codex-cli 0.167.0."""
import json
import os
import time

from .agents import AgentAdapter, HookEvent
from . import codex_transcript, plan_usage as usage_api, screen

USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"


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

    def hook_event(self, argv):
        """Codex's notify: its JSON is the last argument. None when it isn't a JSON object."""
        try:
            payload = json.loads(argv[-1]) if argv else {}
        except ValueError:
            return None
        if not isinstance(payload, dict):
            return None
        if payload.get("type") != "agent-turn-complete":
            return HookEvent(kind=payload.get("type") or "")
        return HookEvent(kind="turn_end", message=payload.get("last-assistant-message") or "")

    def find_transcript(self, session):
        return codex_transcript.find_codex_rollout(session)

    def turns(self, path, limit):
        return codex_transcript.codex_turns(path, limit)

    def usage(self, lines):
        return codex_transcript.codex_usage(lines)

    # Plan usage: the endpoint Codex's /status reads, with its own sign-in.

    @staticmethod
    def tokens(environ=os.environ):
        """Codex's sign-in tokens from $CODEX_HOME/auth.json, or None when it isn't signed in."""
        path = os.path.join(environ.get("CODEX_HOME", os.path.expanduser("~/.codex")), "auth.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            tokens = json.load(f).get("tokens") or {}
        return tokens if tokens.get("access_token") else None

    @staticmethod
    def usage_windows(u, now):
        windows, limits = [], u.get("rate_limit") or {}
        for key, label in (("primary_window", "Session"), ("secondary_window", "Week")):
            w = limits.get(key)
            if not w or w.get("used_percent") is None:
                continue
            resets = w.get("reset_at") or (now + w["reset_after_seconds"] if w.get("reset_after_seconds") is not None else None)
            windows.append({"label": label, "used": round(w["used_percent"]), "resets_at": resets})
        return windows

    def plan_usage(self, get=usage_api.http_get, tokens=None):
        """Codex's plan limits, or None when Codex isn't signed in."""
        tokens = tokens or self.tokens()
        if not tokens:
            return None
        headers = {"Authorization": f"Bearer {tokens['access_token']}", "User-Agent": "codex-cli",
                   "OpenAI-Beta": "codex-1", "originator": "codex_cli_rs"}
        if tokens.get("account_id"):
            headers["ChatGPT-Account-Id"] = tokens["account_id"]
        out = usage_api.report("Codex")
        try:
            u = get(USAGE_URL, headers)
        except Exception as e:
            out["error"] = usage_api.request_failed(e)
            return out
        out["plan"] = (u.get("plan_type") or "").title() or None
        out["windows"] = self.usage_windows(u, int(time.time()))
        return out

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
