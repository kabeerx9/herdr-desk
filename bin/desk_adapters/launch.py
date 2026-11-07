"""What a just-launched CLI's screen says when it can't start: a usage limit or a sign-in."""
import re


LAUNCH_FAILURES = (
    ("usage_limit", r"usage limit reached|you(?:'|\u2019)ve hit your (?:usage )?limit|limit will reset|"
                    r"\b\d+-hour limit reached|weekly limit reached|rate_limit_error|insufficient_quota|"
                    r"credit balance is too low|out of extra usage"),
    ("auth", r"invalid api key|please run /login|oauth token has expired|authentication_error|"
             r"api error: 401|not logged in|codex login|please log in"),
)


def classify_launch_failure(text, task=None):
    """usage_limit | auth | None for a just-launched CLI's screen (or stderr)."""
    text = text or ""
    if task:
        text = text.replace(task, " ")
    flat = " ".join(text.split()).lower()
    for kind, pattern in LAUNCH_FAILURES:
        if re.search(pattern, flat):
            return kind
    return None


# ── Claude transcripts: timeline and title ──────────────────────────────────
