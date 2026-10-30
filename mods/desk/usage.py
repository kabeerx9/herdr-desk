"""Plan usage for the Desk: Claude Code and Codex limits, as JSON on stdout.

Reads each CLI's own sign-in (Claude Code's keychain item, Codex's auth.json)
and asks only that provider's usage endpoint, the one its CLI's /usage or
/status uses. Tokens stay in this process: only percentages and reset times
are printed. A provider you aren't signed in to is left out.
Run with: python3 -I usage.py
"""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone


def get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def iso_to_epoch(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def claude():
    try:
        raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                             capture_output=True, text=True, timeout=10).stdout
        creds = json.loads(raw)["claudeAiOauth"]
    except Exception:
        path = os.path.expanduser("~/.claude/.credentials.json")
        if not os.path.exists(path):
            return None
        creds = json.load(open(path))["claudeAiOauth"]
    plan = (creds.get("subscriptionType") or "").title()
    tier = (creds.get("rateLimitTier") or "").rsplit("_", 1)[-1]
    if tier.endswith("x") and tier[:-1].isdigit():
        plan = f"{plan} {tier}"
    out = {"provider": "Claude", "plan": plan or None, "windows": [], "error": None}
    try:
        u = get("https://api.anthropic.com/api/oauth/usage", {
            "Authorization": f"Bearer {creds['accessToken']}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.1.0",
        })
    except Exception as e:
        out["error"] = f"usage request failed ({getattr(e, 'code', type(e).__name__)})"
        return out
    # `limits` is the list Claude's own usage page draws: session, weekly, and
    # weekly limits scoped to one model (Fable, ...). Older responses lack it.
    for l in u.get("limits") or []:
        model = ((l.get("scope") or {}).get("model") or {}).get("display_name")
        label = {"session": "Session"}.get(l.get("group"), f"{model} week" if model else "Week")
        out["windows"].append({"label": label, "used": round(l.get("percent") or 0),
                               "resets_at": iso_to_epoch(l.get("resets_at")), "severity": l.get("severity")})
    if not out["windows"]:
        for key, label in (("five_hour", "Session"), ("seven_day", "Week")):
            w = u.get(key)
            if w and w.get("utilization") is not None:
                out["windows"].append({"label": label, "used": round(w["utilization"]), "resets_at": iso_to_epoch(w.get("resets_at"))})
    return out


def codex():
    path = os.path.join(os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex")), "auth.json")
    if not os.path.exists(path):
        return None
    tokens = (json.load(open(path)).get("tokens") or {})
    if not tokens.get("access_token"):
        return None
    headers = {"Authorization": f"Bearer {tokens['access_token']}", "User-Agent": "codex-cli",
               "OpenAI-Beta": "codex-1", "originator": "codex_cli_rs"}
    if tokens.get("account_id"):
        headers["ChatGPT-Account-Id"] = tokens["account_id"]
    out = {"provider": "Codex", "plan": None, "windows": [], "error": None}
    try:
        u = get("https://chatgpt.com/backend-api/wham/usage", headers)
    except Exception as e:
        out["error"] = f"usage request failed ({getattr(e, 'code', type(e).__name__)})"
        return out
    out["plan"] = (u.get("plan_type") or "").title() or None
    now = int(datetime.now(timezone.utc).timestamp())
    limits = u.get("rate_limit") or {}
    for key, label in (("primary_window", "Session"), ("secondary_window", "Week")):
        w = limits.get(key)
        if not w or w.get("used_percent") is None:
            continue
        resets = w.get("reset_at") or (now + w["reset_after_seconds"] if w.get("reset_after_seconds") is not None else None)
        out["windows"].append({"label": label, "used": round(w["used_percent"]), "resets_at": resets})
    return out


results = []
for fetch in (claude, codex):
    try:
        r = fetch()
    except Exception as e:  # one provider failing never hides the other
        r = {"provider": fetch.__name__.title(), "plan": None, "windows": [], "error": type(e).__name__}
    if r:
        results.append(r)
json.dump(results, sys.stdout)
