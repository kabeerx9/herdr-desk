"""Adapters for the programs the Desk runs but doesn't own. See docs/plans/2026-11-07-adapter-layer.md."""
from .agents import AgentAdapter, ArgvAdapter, LaunchEnv, UnsupportedCli, expand_args
from .claude import ClaudeAdapter
from .codex import CodexAdapter

_AGENTS = {"claude": ClaudeAdapter(), "codex": CodexAdapter()}
_ARGV = ArgvAdapter()


def for_role(role):
    """The adapter that launches this role: its own argv list first, then its "cli" (default claude)."""
    if isinstance(role.get("argv"), list):
        return _ARGV
    cli = role.get("cli") or "claude"
    if cli not in _AGENTS:
        raise UnsupportedCli("Role %s uses %s; give it an argv list until that adapter is configured."
                             % (role.get("name", role.get("id", "role")), cli))
    return _AGENTS[cli]


def config_for(role):
    """A role's resume/fork/session templates; a role with an unknown CLI gets only its own."""
    try:
        return for_role(role).config(role)
    except UnsupportedCli:
        return dict(role.get("adapter") or {})
