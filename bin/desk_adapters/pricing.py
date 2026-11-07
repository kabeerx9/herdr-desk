"""Model prices for `team cost`: what each provider charges per million tokens."""


PRICES = {"claude-fable-5-1": (10.0, 50.0, 0.25), "claude-opus-5-5": (4.0, 20.0, 0.20),
          "claude-sonnet-5-5": (2.0, 10.0, 0.20), "claude-haiku-5-5": (0.10, 0.50, 0.01)}


def call_cost(model, usage):
    """API-rate dollars for one model call, or None for a model with no known price."""
    price = PRICES.get(model)
    if not price:
        return None
    inp, out, read = price
    fresh = usage.get("input_tokens") or 0
    cached = usage.get("cache_read_input_tokens") or 0
    written = usage.get("cache_creation_input_tokens") or 0
    parts = usage.get("cache_creation") or {}
    hour = parts.get("ephemeral_1h_input_tokens") or 0
    five = parts.get("ephemeral_5m_input_tokens") or 0
    if not hour and not five:
        five = written
    scale = 5 if model == "claude-haiku-5-5" and fresh + cached + written > 100000 else 1
    return scale * (fresh * inp + hour * inp * 2 + five * inp * 1.25 + cached * read
                    + (usage.get("output_tokens") or 0) * out) / 1e6
