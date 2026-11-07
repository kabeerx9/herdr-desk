"""Slash commands from the Desk: the screen classifiers on real Claude screens (bin/fixtures,
captured read-only from a live CTO terminal), and team post --raw's follow-up per kind (info,
interactive, action) plus the dialog guard on every path that types into an agent, against a
fake terminal. No live terminal is touched."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import desk_runtime as rt
from test_desk_timeline import Transcript
from test_team_overhaul import Base, team

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name + ".txt"), encoding="utf-8") as f:
        return f.read()


PROMPT = fixture("claude-prompt")            # idle, empty input box
CLEARED = fixture("claude-cleared")          # just after /clear
CONTEXT = fixture("claude-context")          # /context printed inline, prompt back
TYPED = fixture("claude-typed-menu")         # "/context" typed, Claude's command menu open
USAGE = fixture("claude-usage-dialog")       # /cost: the Settings › Usage dialog, taller than the screen
RULE = "─" * 80
# Synthetic (not captured): a picker in Claude's shape, its key hints at the bottom.
PICKER = "\n".join(["", " Select model", "", " ❯ 1. Default (recommended)", "   2. Opus", "   3. Haiku", "",
                    " Enter to confirm · Esc to exit"])


def with_input(text):
    """The idle prompt fixture with `text` sitting in its input box."""
    assert "\n❯\xa0\n" in PROMPT
    return PROMPT.replace("\n❯\xa0\n", "\n❯\xa0" + text + "\n", 1)


class ScreenStateTests(unittest.TestCase):
    def test_real_prompt_screens(self):
        for screen in (PROMPT, CLEARED, CONTEXT):
            self.assertEqual({"state": "prompt", "input": "", "why": None}, rt.screen_state(screen))
        self.assertEqual(("prompt", "/context"), (rt.screen_state(TYPED)["state"], rt.screen_state(TYPED)["input"]))

    def test_dialogs(self):
        self.assertEqual("dialog", rt.screen_state(USAGE)["state"])  # no key hint visible: its border gives it away
        self.assertEqual(("dialog", "Enter to confirm"), (rt.screen_state(PICKER)["state"], rt.screen_state(PICKER)["why"]))
        status = "\n".join(["▔" * 80, "  Settings  Status  Config", "", "  Version: 2.1.318", "", "  Esc to cancel"])
        self.assertEqual("dialog", rt.screen_state(status)["state"])

    def test_key_hints_in_output_above_the_prompt_box_dont_count(self):
        screen = PROMPT.replace("     /context all to expand", "     It said: Esc to cancel, Enter to confirm", 1)
        self.assertEqual("prompt", rt.screen_state(screen)["state"])

    def test_working_and_starting_screens(self):
        working = PROMPT.replace("     /context all to expand", "✻ Thinking… (esc to interrupt)", 1)
        self.assertEqual("prompt", rt.screen_state(working)["state"])
        self.assertEqual("unknown", rt.screen_state("")["state"])
        self.assertEqual("unknown", rt.screen_state("Loading…\n")["state"])

    def test_codex_prompt_line(self):
        self.assertEqual({"state": "prompt", "input": "", "why": None}, rt.screen_state("output\n\n› \n  ⏎ send", "codex"))
        self.assertEqual("dialog", rt.screen_state("Select model\n  Press enter to confirm or esc to go back", "codex")["state"])


class CommandResultTests(unittest.TestCase):
    def test_inline_output_without_chrome(self):
        text = rt.command_result(CONTEXT, "/context")
        self.assertTrue(text.startswith("Context Usage"), text[:40])
        self.assertIn("31.5k/400k tokens (8%)", text)
        self.assertTrue(text.endswith("/context all to expand"))
        for chrome in ("─", "❯", "auto mode", "⎿"):
            self.assertNotIn(chrome, text)

    def test_dialog_body(self):
        text = rt.command_result(USAGE, "/cost")
        self.assertTrue(text.startswith("Session\n"), text[:40])
        self.assertIn("Total cost:", text)
        self.assertNotIn("Settings  Status", text); self.assertNotIn("▔", text); self.assertFalse(text.endswith("↓"))

    def test_nearest_start_wins_and_nothing_is_none(self):
        history = "▔" * 80 + "\nold dialog\n\n❯ /context\n  ⎿  fresh\n" + RULE + "\n❯ \n" + RULE + "\n"
        self.assertEqual("fresh", rt.command_result(history, "/context"))
        self.assertIsNone(rt.command_result(PROMPT, "/doctor"))


class ClearedTranscriptTests(unittest.TestCase):
    def test_newest_fresh_transcript_that_starts_with_clear(self):
        with tempfile.TemporaryDirectory() as d:
            def write(name, body, age=0):
                path = os.path.join(d, name + ".jsonl")
                with open(path, "w") as f: f.write(body)
                stamp = time.time() - age; os.utime(path, (stamp, stamp))
            clear = '{"message":{"content":"<command-name>/clear</command-name>"}}\n'
            write("old", clear); write("other", '{"type":"user"}\n'); write("stale", clear, age=600); write("new", clear)
            since = int(time.time() * 1000) - 5000
            self.assertEqual("new", rt.cleared_transcript(d, "old", since))
            os.remove(os.path.join(d, "new.jsonl"))
            self.assertIsNone(rt.cleared_transcript(d, "old", since))
        self.assertIsNone(rt.cleared_transcript("/nonexistent", "old", 0))


class FakeTerminal:
    """hc read / keys / send / label for one terminal: `screen` is what it shows; `on_keys` turns
    keys into the next screen."""

    def __init__(self, screen):
        self.screen, self.calls, self.on_keys = screen, [], None

    def sh(self, args, **_kw):
        self.calls.append(args)
        if args[:2] == ["hc", "read"]:
            return subprocess.CompletedProcess(args, 0, self.screen, "")
        if args[:2] == ["hc", "keys"] and self.on_keys:
            nxt = self.on_keys(args[3:], self.screen)
            if nxt is not None: self.screen = nxt
        return subprocess.CompletedProcess(args, 0, "", "")

    def typed(self):
        return [c for c in self.calls if c[:2] != ["hc", "read"]]

    def keys(self, *which):
        return [c[3:] for c in self.calls if c[:2] == ["hc", "keys"] and (not which or c[3:] == list(which))]


class CommandTests(Base):
    def setUp(self):
        super().setUp()
        for name, value in (("SETTLE_S", 0.3), ("ACCEPT_S", 0.2), ("POLL_S", 0.01)):
            p = patch.object(team, name, value); p.start(); self.addCleanup(p.stop)
        self.term = FakeTerminal(PROMPT)
        p = patch.object(team, "sh", side_effect=self.term.sh); p.start(); self.addCleanup(p.stop)
        p = patch.object(team, "expect_reply", lambda *a: True); p.start(); self.addCleanup(p.stop)
        self.info["t1"]["rows"] = 40

    def raw(self, text, mode=None):
        return self.call(team.post, task="desk", to=["t1:cto"], text=[text], raw=True, mode=mode)

    def chat(self, kind):
        return [r for r in team.chat_read("desk") if r.get("kind") == kind]

    def on_enter(self, screen):
        self.term.on_keys = lambda keys, now: screen if keys[-1:] == ["enter"] else None

    def test_info_inline_result_lands_under_the_command(self):
        self.on_enter(CONTEXT)
        code, out = self.raw("/context", "info")
        self.assertEqual((0, [], []), (code, out["peek"], out["cleared"]))
        result = self.chat("command-result")[-1]
        self.assertEqual(("cto", "t1", "/context", False), (result["from"], result["address"], result["command"], result["dialog"]))
        self.assertTrue(result["text"].startswith("Context Usage"))
        self.assertEqual([], self.term.keys("esc"))
        kinds = [r["kind"] for r in team.chat_read("desk")]
        self.assertLess(kinds.index("command"), kinds.index("command-result"))

    def test_info_dialog_is_captured_then_closed(self):
        def keys(k, now):
            return USAGE if k[-1:] == ["enter"] else PROMPT if k == ["esc"] else None
        self.term.on_keys = keys
        code, out = self.raw("/cost", "info")
        result = self.chat("command-result")[-1]
        self.assertEqual((0, True), (code, result["dialog"]))
        self.assertTrue(result["text"].startswith("Session"))
        self.assertEqual([["esc"]], self.term.keys("esc"))
        self.assertEqual(([], "prompt"), (out["peek"], rt.screen_state(self.term.screen)["state"]))

    def test_a_dialog_that_wont_close_opens_the_terminal(self):
        self.on_enter(USAGE)
        _, out = self.raw("/status", "info")
        self.assertEqual(["t1"], out["peek"])
        self.assertEqual(2, len(self.term.keys("esc")))
        note = self.chat("command-note")[-1]
        self.assertTrue(note["terminal"]); self.assertIn("still shows a dialog", note["text"])

    def test_interactive_opens_the_terminal(self):
        self.on_enter(PICKER)
        _, out = self.raw("/model", "interactive")
        self.assertEqual(["t1"], out["peek"])
        self.assertEqual("Opened CTO's terminal for /model", self.chat("command-note")[-1]["text"])
        self.assertEqual([], self.term.keys("esc"))  # the picker is Kabeer's to use

    def test_clear_points_the_desk_at_the_new_conversation(self):
        projects = os.path.join(self.tmp.name, "projects")
        Transcript(projects, "conv-1").prompt("[desk chat] Kabeer: hello")
        def keys(k, now):
            if k[-1:] != ["enter"]: return None
            new = Transcript(projects, "conv-2")
            new.prompt("<command-name>/clear</command-name>\n<command-message>clear</command-message>")
            os.utime(new.path, None)
            return CLEARED
        self.term.on_keys = keys
        code, out = self.raw("/clear")
        self.assertEqual((0, ["t1"]), (code, out["cleared"]))
        self.assertEqual("conv-2", self.session()["conversation"])
        self.assertEqual("CTO started a new conversation", self.chat("command-note")[-1]["text"])

    def test_clear_already_recorded_by_the_session_hook(self):
        def keys(k, now):
            if k[-1:] == ["enter"]:
                team.runtime_record("t1", "cto", "desk", "/work", "claude", "conv-9")
                return CLEARED
        self.term.on_keys = keys
        _, out = self.raw("/clear", "action")
        self.assertEqual(["t1"], out["cleared"])
        self.assertEqual("conv-9", self.session()["conversation"])

    def test_a_command_left_in_the_input_gets_one_more_enter(self):
        presses = []
        def keys(k, now):
            if k[-1:] != ["enter"]: return None
            presses.append(k)
            return with_input("/compact") if len(presses) == 1 else PROMPT
        self.term.on_keys = keys
        self.raw("/compact")
        self.assertEqual([["enter"]], self.term.keys("enter"))
        self.assertEqual([], self.chat("command-note"))  # compact's own hook posts its line

    def test_a_command_that_never_leaves_the_input_is_reported(self):
        self.term.on_keys = lambda k, now: with_input("/compact") if k[-1:] == ["enter"] else None
        self.raw("/compact")
        note = self.chat("command-note")[-1]
        self.assertTrue(note["failed"]); self.assertIn("still in its input", note["text"])

    def test_an_unexpected_dialog_after_an_action_opens_the_terminal(self):
        self.on_enter(PICKER)
        _, out = self.raw("/agents")
        self.assertEqual(["t1"], out["peek"])

    def test_review_reserves_the_reply(self):
        seen = []
        with patch.object(team, "expect_reply", lambda a, what: seen.append((a, what)) or True):
            self.on_enter(PROMPT)
            self.raw("/review 12")
        self.assertEqual([("t1", "chat")], seen)

    # ── the guard: nothing is typed into an open dialog or over unsent text ──

    def test_raw_refuses_an_open_dialog(self):
        self.term.screen = USAGE
        code, _ = self.raw("/context", "info")
        self.assertEqual((1, []), (code, self.term.typed()))
        failed = self.chat("command")[-1]["failed"][0]
        self.assertEqual(("CTO has a dialog open in its terminal", True, "t1"), (failed["why"], failed["dialog"], failed["address"]))

    def test_raw_refuses_unsent_text(self):
        self.term.screen = with_input("half a thought")
        code, _ = self.raw("/clear")
        self.assertEqual((1, []), (code, self.term.typed()))
        self.assertIn("unsent text", self.chat("command")[-1]["failed"][0]["why"])

    def test_chat_message_refuses_an_open_dialog_and_releases_the_reply(self):
        self.term.screen = PICKER
        code, rec = self.call(team.post, task="desk", to=["t1:cto"], text=["hello"], raw=False)
        self.assertEqual([], rec["delivered"]); self.assertTrue(rec["failed"][0]["dialog"])
        self.assertNotIn("send", [c[1] for c in self.term.typed()])
        self.assertIn(["hc", "label", "t1", "awaiting="], self.term.calls)

    def test_send_text_guard(self):
        self.term.screen = USAGE
        self.assertEqual("CTO has a dialog open in its terminal", team.send_text("t1", "hi"))
        self.term.screen = PROMPT
        self.assertIsNone(team.send_text("t1", "hi"))
        self.assertEqual(["hc", "send", "t1", "hi"], self.term.typed()[-1])

    def test_team_send_command_refuses_a_dialog(self):
        """The Desk's Open PR and send-brief buttons go through `team send`, not a bare hc send."""
        self.term.screen = PICKER
        code, out = self.call(team.send, address="t1", text="open a PR")
        self.assertEqual((1, None), (code, out))
        self.assertIn("dialog open", self.err)
        self.assertNotIn("send", [c[1] for c in self.term.typed()])
        self.term.screen = PROMPT
        self.assertEqual((0, {"ok": True}), self.call(team.send, address="t1", text="open a PR"))
        self.assertEqual(["hc", "send", "t1", "open a PR"], self.term.typed()[-1])

    def test_queue_waits_while_a_dialog_is_open(self):
        self.call(team.runtime_queue, task="desk", to=["t1:cto"], text=["later"])
        self.term.screen = USAGE
        code, out = self.call(team.runtime_queue_dispatch, )
        self.assertEqual({"state": "waiting"}, out)
        self.term.screen = PROMPT
        code, out = self.call(team.runtime_queue_dispatch, )
        self.assertEqual("delivered", out["state"])
        self.assertEqual(["hc", "send", "t1", "[desk chat] Kabeer: later"], self.term.typed()[-1])


if __name__ == "__main__":
    unittest.main()
