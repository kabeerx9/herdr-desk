"""Helpers for the adapters' plan_usage(): each CLI's plan limits from its own sign-in.

Tokens stay in this process: plan_usage() returns only plan names, percentages and
reset times. These endpoints are private and the most likely to change.
"""
import json
import urllib.request
from datetime import datetime


def http_get(url, headers, timeout=15):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def iso_to_epoch(value):
    if not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def request_failed(exc):
    """A failed usage request in words, with its HTTP status when it has one, never its body."""
    return f"usage request failed ({getattr(exc, 'code', type(exc).__name__)})"


def report(provider, plan=None):
    return {"provider": provider, "plan": plan, "windows": [], "error": None}
