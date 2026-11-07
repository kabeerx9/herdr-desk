"""The agent port: what the Desk needs from a coding-agent CLI.

Each CLI the Desk can run is one AgentAdapter subclass. Everything that depends on how a
CLI is invoked lives in its adapter, so a CLI update touches one file.
Rule: nothing in desk_adapters imports desk_runtime or team (no import cycles).
"""
from dataclasses import dataclass


class UnsupportedCli(ValueError):
    """A role names a CLI with no adapter and gives no argv of its own."""


@dataclass(frozen=True)
class LaunchEnv:
    """What a launch needs from the Desk, passed in so adapters never import team."""
    self_path: str          # bin/team, for hook commands
    attachments: str        # folder agents may read attachments from
    question_timeout: int   # seconds a PermissionRequest hook may wait


@dataclass(frozen=True)
class HookEvent:
    """One hook call from a CLI, in the Desk's words. Fields a CLI doesn't send stay empty."""
    kind: str = ""              # "turn_end" for an end of turn; otherwise whatever the CLI sent
    message: str = ""           # the turn's final text, as the CLI gave it
    transcript: str = None      # path of the conversation log
    session_id: str = None
    cwd: str = None
    tool: str = None            # the tool a PreToolUse or PermissionRequest is about
    tool_input: object = None
    suggestions: tuple = ()     # rules the CLI offers for "always allow"

    @property
    def conversation(self):
        """The conversation's durable identity: the transcript's file name."""
        import os
        return os.path.splitext(os.path.basename(self.transcript))[0] if self.transcript else None


class AgentAdapter:
    name = None
    # Default resume/fork/session argument templates; "{session_id}" is replaced.
    default_args = {}
    # Process names this CLI shows as (argv[0], foreground name, Herdr's status.app).
    aliases = frozenset()
    # Reads its own conversation log (team transcript, team cost).
    has_transcript = False
    # Shows a dialog right after launch that the Desk must surface (not a trust prompt).
    startup_dialog = False

    def trust_prompt(self, screen):
        """Keys that accept this CLI's folder-trust prompt if the screen shows one, else None."""
        return None

    def screen_state(self, screen):
        raise NotImplementedError

    def permission_prompt(self, screen):
        """The permission prompt this screen shows, in screen.permission_dialog's shape, or None."""
        return None

    def find_transcript(self, session):
        return None

    def turns(self, path, limit):
        raise NotImplementedError

    def usage(self, lines):
        raise NotImplementedError

    def config(self, role):
        """The role's argument templates: the adapter's defaults, then roles.json "adapter"."""
        config = dict(self.default_args)
        config.update(role.get("adapter") or {})
        return config

    def args(self, role, action, identity):
        """Arguments for "resume", "fork" or "session", or ValueError when none are configured."""
        return expand_args(self.config(role), action, identity)

    def launch_argv(self, role, task, env):
        raise NotImplementedError

    def plan_usage(self):
        """This CLI's plan limits ({provider, plan, windows, error}), or None when it has none or isn't signed in."""
        return None


class ArgvAdapter(AgentAdapter):
    """A role that gives its own argv list: launched as written, with no defaults."""
    name = "argv"

    def launch_argv(self, role, task, env):
        return role["argv"] + ([task] if task else [])


def expand_args(config, action, identity):
    """Fill "{session_id}" into a config's "<action>_args" template; ValueError when it has none."""
    values = config.get(action + "_args")
    if not isinstance(values, list) or not all(isinstance(x, str) for x in values):
        raise ValueError("This CLI has no configured %s arguments" % action)
    return [x.replace("{session_id}", identity) for x in values]
