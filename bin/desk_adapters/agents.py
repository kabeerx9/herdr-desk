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


class AgentAdapter:
    name = None
    # Default resume/fork/session argument templates; "{session_id}" is replaced.
    default_args = {}

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
