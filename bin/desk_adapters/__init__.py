"""Adapters for the programs the Desk runs but doesn't own. See docs/plans/2026-11-07-adapter-layer.md."""
from .agents import AgentAdapter, ArgvAdapter, HookEvent, LaunchEnv, UnsupportedCli, expand_args
from .claude import ClaudeAdapter
from .codex import CodexAdapter
from .host import HcHost, HostResult

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


# CLIs the Desk recognises in a terminal but has no adapter for yet.
_KNOWN_ONLY = {"muse": frozenset({"muse", "muse-code"})}


def process_aliases():
    """{cli: process names it shows as}, for every CLI the Desk recognises."""
    return {**{name: a.aliases for name, a in _AGENTS.items()}, **_KNOWN_ONLY}


def by_cli(cli):
    """The adapter for a CLI name, or None when the Desk has none."""
    return _AGENTS.get(cli or "claude")


def screen_adapter(cli):
    """Who reads a screen: the CLI's adapter, else Claude's (the Desk's long-standing default)."""
    return _AGENTS.get(cli) or _AGENTS["claude"]


def plan_usage():
    """Every signed-in CLI's plan limits. One provider failing never hides another."""
    results = []
    for name, agent in _AGENTS.items():
        try:
            r = agent.plan_usage()
        except Exception as e:
            r = {"provider": name.title(), "plan": None, "windows": [], "error": type(e).__name__}
        if r:
            results.append(r)
    return results


def config_for(role):
    """A role's resume/fork/session templates; a role with an unknown CLI gets only its own."""
    try:
        return for_role(role).config(role)
    except UnsupportedCli:
        return dict(role.get("adapter") or {})
