"""Plan usage for the Desk: Claude Code and Codex limits, as JSON on stdout.

Each CLI's adapter (bin/desk_adapters) reads that CLI's own sign-in and asks only
its provider's usage endpoint. Tokens stay in this process: only plan names,
percentages and reset times are printed. A CLI you aren't signed in to is left out.
Run with: python3 -I usage.py
"""
import json
import os
import sys

# -I keeps the current folder off the import path; the Desk's own bin/ is added by its full path.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "bin"))
import desk_adapters  # noqa: E402

json.dump(desk_adapters.plan_usage(), sys.stdout)
