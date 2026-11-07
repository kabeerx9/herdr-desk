"""The terminal-host port: what the Desk needs from the program that runs its agents' terminals.

One adapter, HcHost, for herdr-core's `hc` (tested against 0.1.18). Every `hc` argv, its JSON
shapes and its error format live here, so an `hc` update touches one file.

Terminal records are the dicts `hc get --json` prints; their keys (state, status, labels,
foreground, parent, cwd) are checked against a live `hc` by `team doctor`.
"""
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class HostResult:
    """The outcome of one host call."""
    ok: bool
    out: str = ""
    error: str = ""     # what hc printed on failure, as printed

    @property
    def message(self):
        """The failure in one line: hc's JSON error message when it gives one, else its text."""
        try:
            return json.loads(self.error)["error"]["message"]
        except (ValueError, KeyError, TypeError):
            return self.error

    def json(self):
        """The output parsed as JSON, or None."""
        try:
            return json.loads(self.out) if self.ok else None
        except ValueError:
            return None


class HcHost:
    """herdr-core's `hc`. `run(argv)` runs one command and returns a subprocess.CompletedProcess."""

    def __init__(self, run):
        self._run = run

    def _call(self, *args):
        r = self._run(["hc", *args])
        ok = r.returncode == 0
        return HostResult(ok, r.stdout or "", "" if ok else (r.stderr or r.stdout or "").strip())

    def _json(self, *args):
        return self._call(*args, "--json").json()

    @staticmethod
    def _terminals(data):
        items = data.get("terminals", []) if isinstance(data, dict) else (data or [])
        return [t for t in items if isinstance(t, dict)]

    # Launch

    def launch(self, argv, cwd, labels, name=None, parent=None, no_parent=False, shell="/bin/zsh"):
        """Starts argv in a new background terminal that outlives its parent; result.json() has
        its "address". It runs through the user's login + interactive shell, because hc's own
        environment lacks what ~/.zshrc sets up (nvm's node, Android tools); exec swaps the shell
        for the agent. labels: {name: value}, in order."""
        cmd = ["run", "--bg", "--outlive-parent"] + (["--name", name] if name else []) + ["--cwd", cwd]
        for key, value in labels.items():
            cmd += ["--label", f"{key}={value}"]
        cmd += ["--no-parent"] if no_parent else (["--parent", parent] if parent else [])
        return self._call(*cmd, "--", shell, "-lic", 'exec "$@"', "team-role", *argv)

    # Input

    def send_text(self, address, text):
        """Pastes text and submits it."""
        return self._call("send", address, text)

    def send_keys(self, address, keys):
        """Presses keys in order: names like "enter", "esc", "down", "space", or single characters."""
        return self._call("keys", address, *keys)

    # Output

    def screen(self, address, history=0):
        """The visible screen plus `history` lines of scrollback, or "" when it can't be read."""
        r = self._call("read", "--lines", str(history), address)
        return r.out if r.ok else ""

    # Records

    def label(self, address, labels):
        """Sets labels ({name: value}, in order); an empty value clears that label."""
        return self._call("label", address, *(f"{k}={v}" for k, v in labels.items()))

    def get(self, address):
        """The terminal's record, or None when hc can't give it (gone, or hc is down)."""
        data = self._json("get", address)
        return data if isinstance(data, dict) else None

    def list(self, label=None, all=False):
        """Terminal summaries (address, state, ...), live only unless all=True; [] when hc is down.
        `hc ls` filters by label but prints no labels: get() a terminal for those."""
        args = ["ls"] + (["--all"] if all else []) + (["--label", label] if label else [])
        return self._terminals(self._json(*args))

    # Lifecycle

    def kill(self, address):
        return self._call("kill", address)

    def remove(self, address):
        return self._call("rm", address)

    def reachable(self, me=None):
        """Whether hc can reach herdr-core: through this terminal's own record when it has one."""
        return self._call("get", me, "--json") if me else self._call("server", "status")
