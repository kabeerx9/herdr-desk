"""Codex screens and the dialog guard for every CLI: the classifier on Codex fixtures (bin/fixtures,
laid out from Codex v0.166.0 screens; the hooks footer is the measured one), nothing typed into a
dialog on any send path, the queue holding a message while a dialog is open, and team start
reporting a Codex startup dialog to the chat. No live terminal is touched; nothing is pressed."""
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import desk_runtime as rt
from test_desk_commands import PROMPT, USAGE, FakeTerminal, fixture
from test_team_overhaul import Base, team, terminal

HOOKS = fixture("codex-hooks-dialog")        # "⚠ 2 hooks need review" … "t trust all · enter review · esc close"
IDLE = fixture("codex-prompt")               # "› Ask Codex to do anything" over the footer
LIVE_IDLE = fixture("codex-prompt-live")      # captured from a real Codex v0.166.0 terminal
WORKING = fixture("codex-working")           # "• Working (14s • esc to interrupt)" above the input line
APPROVAL = fixture("codex-approval")         # "Would you like to run…" numbered options + "Press enter to confirm"
APPROVAL_YN = fixture("codex-approval-yn")   # older "Allow command?" with "Yes (y) … No (n)", no key hint line
TRUST = fixture("codex-trust")               # first launch in a folder: numbered options, no hint line
PICKER = fixture("codex-model-picker")       # /model: numbered options, the hint line scrolled off


class CodexScreenTests(unittest.TestCase):
    def test_idle_and_working_are_the_input_line(self):
        for screen in (IDLE, WORKING):
            self.assertEqual({"state": "prompt", "input": "", "why": None}, rt.screen_state(screen, "codex"))

    def test_typed_text_is_input_but_placeholders_are_not(self):
        typed = IDLE.replace("› Ask Codex to do anything", "› half a thought")
        self.assertEqual("half a thought", rt.screen_state(typed, "codex")["input"])
        tip = IDLE.replace("› Ask Codex to do anything", "› Find and fix a bug in @filename")
        self.assertEqual("", rt.screen_state(tip, "codex")["input"])

    def test_every_dialog_is_a_dialog(self):
        for name, screen in (("hooks", HOOKS), ("approval", APPROVAL), ("approval-yn", APPROVAL_YN),
                             ("trust", TRUST), ("model", PICKER)):
            with self.subTest(name):
                self.assertEqual("dialog", rt.screen_state(screen, "codex")["state"])
        self.assertEqual("enter review", rt.screen_state(HOOKS, "codex")["why"])

    def test_the_hooks_dialog_is_caught_even_read_as_claude(self):
        # A runner list can put Codex in a role configured for Claude.
        self.assertEqual("dialog", rt.screen_state(HOOKS, "claude")["state"])

    def test_a_dialog_never_seen_before_is_still_a_dialog(self):
        # Key hints in a new wording, or no hints at all: no input line is enough to not type.
        hinted = "\n".join(["  Rename session", "", "  New name: _", "", "  enter save · esc close"])
        self.assertEqual("dialog", rt.screen_state(hinted, "codex")["state"])
        bare = "\n".join(["  Transcript", "", "  › Run the tests", "  • Ran pnpm test", "  └ ok"])
        state = rt.screen_state(bare, "codex")
        self.assertEqual(("dialog", rt.NO_INPUT), (state["state"], state["why"]))

    def test_a_cursor_or_a_hint_below_the_last_arrow_is_not_the_input(self):
        self.assertIsNone(rt.codex_input(HOOKS.split("\n")))
        self.assertIsNone(rt.codex_input(TRUST.split("\n")))
        self.assertIsNotNone(rt.codex_input(WORKING.split("\n")))

    def test_esc_to_interrupt_above_the_input_is_not_a_dialog(self):
        self.assertEqual("prompt", rt.screen_state(WORKING, "codex")["state"])

    def test_blank_or_barely_started_is_unknown(self):
        self.assertEqual("unknown", rt.screen_state("", "codex")["state"])
        self.assertEqual("unknown", rt.screen_state("Loading…\n", "codex")["state"])

    def test_claude_permission_reader_ignores_codex(self):
        self.assertIsNone(rt.permission_dialog(HOOKS))
        self.assertIsNone(rt.permission_dialog(APPROVAL, "codex"))


class CodexGuardTests(Base):
    """Every path that types into an agent, against a Codex member showing its hooks dialog."""

    def setUp(self):
        super().setUp()
        self.roles = [{"id": "cto", "name": "CTO", "cli": "claude", "promptText": "p"},
                      {"id": "reviewer", "name": "Reviewer", "cli": "codex", "promptText": "p"}]
        self.info["t4"] = terminal("codex", address="t4", role="reviewer")
        self.term = FakeTerminal(HOOKS)
        for name, value in (("SETTLE_S", 0.2), ("ACCEPT_S", 0.1), ("POLL_S", 0.01)):
            p = patch.object(team, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(team, "sh", side_effect=self.term.sh); p.start(); self.addCleanup(p.stop)
        p = patch.object(team, "expect_reply", lambda *a: True); p.start(); self.addCleanup(p.stop)
        team.runtime_record("t4", "reviewer", "desk", "/work", "codex", None)

    def sent(self):
        return [c for c in self.term.typed() if c[:2] in (["hc", "send"], ["hc", "keys"])]

    def test_post_refuses_and_records_the_dialog(self):
        code, rec = self.call(team.post, task="desk", to=["t4:reviewer"], text=["hello"], raw=False)
        self.assertEqual([], rec["delivered"])
        self.assertEqual(("Reviewer has a dialog open in its terminal", True, "t4"),
                         (rec["failed"][0]["why"], rec["failed"][0]["dialog"], rec["failed"][0]["address"]))
        self.assertEqual([], self.sent())
        self.assertIn(["hc", "label", "t4", "awaiting="], self.term.calls)

    def test_post_raw_refuses(self):
        code, _ = self.call(team.post, task="desk", to=["t4:reviewer"], text=["/status"], raw=True, mode="info")
        self.assertEqual((1, []), (code, self.sent()))
        self.assertTrue(team.chat_read("desk")[-1]["failed"][0]["dialog"])

    def test_agent_to_agent_send_refuses(self):
        self.assertEqual("Reviewer has a dialog open in its terminal", team.send_text("t4", "[desk chat] CTO asks you: ok?"))
        self.assertEqual([], self.sent())

    def test_delivered_once_the_codex_input_is_back(self):
        self.term.screen = IDLE
        code, rec = self.call(team.post, task="desk", to=["t4:reviewer"], text=["hello"], raw=False)
        self.assertEqual(["reviewer"], rec["delivered"])
        self.assertEqual(["hc", "send", "t4", "[desk chat] Kabeer: hello"], self.sent()[-1])

    def test_unsent_codex_text_is_not_typed_over(self):
        self.term.screen = IDLE.replace("› Ask Codex to do anything", "› half a thought")
        self.assertIn("unsent text", team.type_raw("t4", "/status"))
        self.assertEqual([], self.sent())

    def test_codex_running_in_a_claude_role_is_read_as_codex(self):
        info = terminal("codex", address="t1", role="cto")
        self.assertEqual("codex", team.cli_of(info))
        self.assertEqual("claude", team.cli_of(terminal("claude")))

    def test_queue_waits_for_the_dialog_then_delivers(self):
        self.call(team.runtime_queue, task="desk", to=["t4:reviewer"], text=["later"])
        code, out = self.call(team.runtime_queue_dispatch)
        self.assertEqual({"state": "waiting"}, out)
        self.term.screen = IDLE
        code, out = self.call(team.runtime_queue_dispatch)
        self.assertEqual("delivered", out["state"])
        self.assertEqual(["hc", "send", "t4", "[desk chat] Kabeer: later"], self.sent()[-1])

    def test_a_dialog_opening_after_the_claim_keeps_it_queued(self):
        # The claim saw the input line; by the time it typed, the dialog was up: nothing typed.
        self.call(team.runtime_queue, task="desk", to=["t4:reviewer"], text=["later"])
        self.term.screen = IDLE
        reads = {"n": 0}
        real = self.term.sh
        def sh(args, **kw):
            if args[:2] == ["hc", "read"]:
                reads["n"] += 1
                self.term.screen = IDLE if reads["n"] == 1 else HOOKS
            return real(args, **kw)
        with patch.object(team, "sh", side_effect=sh):
            code, out = self.call(team.runtime_queue_dispatch)
        self.assertEqual("pending", out["state"])
        self.assertEqual([], self.sent())
        self.assertIn(["hc", "label", "t4", "awaiting="], self.term.calls)
        self.assertFalse(any(r.get("kind") == "say" for r in team.chat_read("desk")))
        self.term.screen = IDLE
        code, out = self.call(team.runtime_queue_dispatch)
        self.assertEqual("delivered", out["state"])

    def test_report_to_a_parent_in_a_dialog_is_recorded_not_typed(self):
        self.info["t5"] = terminal("codex", address="t5", role="reviewer", parent="t4")
        with patch.object(team, "ME", "t5"), patch.object(team, "need_core"), \
                patch.object(team, "git_out", return_value=None), patch.object(team, "desk_members", return_value=[]):
            code, _ = self.call(team.report, kind="update", text=["halfway"], criteria=None, evidence=None, blocking=None, head=None)
        self.assertEqual([], self.sent())
        self.assertIn("dialog open", self.err)
        self.assertEqual("halfway", team.chat_read("desk")[-1]["text"])

    def test_compact_refuses_a_claude_dialog(self):
        self.term.screen = USAGE
        code, _ = self.call(team.compact, address="t1")
        self.assertNotEqual(0, code)
        self.assertEqual([], self.sent())
        self.term.screen = PROMPT
        self.call(team.compact, address="t1")
        self.assertEqual("/", self.sent()[-1][3])


class StartupDialogTests(Base):
    """team start for a Codex member: a bounded watch of its screen, a chat line when a dialog shows."""

    def start(self, screens, cli="codex"):
        self.roles = [{"id": "reviewer", "name": "Reviewer", "cli": cli, "promptText": ""}]
        reads, pressed = {"n": 0}, []
        def sh(args, cwd=None, check=False):
            if args[:2] == ["hc", "run"]:
                self.info["t4"] = terminal(cli, address="t4", role="reviewer")
                return subprocess.CompletedProcess(args, 0, json.dumps({"address": "t4"}), "")
            if args[:2] == ["hc", "read"]:
                screen = screens[min(reads["n"], len(screens) - 1)]; reads["n"] += 1
                return subprocess.CompletedProcess(args, 0, screen, "")
            if args[:2] in (["hc", "keys"], ["hc", "send"]):
                pressed.append(args)
            return subprocess.CompletedProcess(args, 0, "{}", "")
        args = dict(role="reviewer", repo=self.tmp.name, brief=None, task="Review it", slug="desk", parent=None, no_parent=True,
                    space=None, requested=True, by="desk", share=True, tab=None, fresh_of=None, note=None, display_task=None)
        with patch.object(team, "need_core"), patch.object(team, "repo_of", return_value=None), \
                patch.object(team, "sh", side_effect=sh), patch.object(team, "STARTUP_DIALOG_S", 2), patch.object(team.time, "sleep"):
            code, out = self.call(team.start, **args)
        return out, pressed, [r for r in team.chat_read("desk") if r.get("kind") == "command-note"]

    def test_hooks_dialog_at_startup_posts_the_dialog_line(self):
        out, pressed, notes = self.start(["", HOOKS])
        self.assertEqual("enter review", out["startup_dialog"])
        self.assertEqual(1, len(notes))
        note = notes[0]
        self.assertEqual(("reviewer", "t4", "Reviewer has a dialog open in its terminal", True, True),
                         (note["from"], note["address"], note["text"], note["terminal"], note["dialog"]))
        self.assertEqual([], pressed)   # never trusted, reviewed or dismissed

    def test_a_clean_start_posts_nothing(self):
        out, pressed, notes = self.start(["", IDLE])
        self.assertEqual((None, [], []), (out["startup_dialog"], notes, pressed))

    def test_a_screen_still_drawing_is_not_reported(self):
        bare = "\n".join(["╭────╮", "│ >_ OpenAI Codex │", "╰────╯", "  Booting…"])
        out, _, notes = self.start([bare])
        self.assertEqual((None, []), (out["startup_dialog"], notes))

    def test_claude_members_are_not_watched(self):
        out, _, notes = self.start([USAGE], cli="claude")
        self.assertEqual((None, []), (out["startup_dialog"], notes))

    def test_the_watch_is_bounded(self):
        with patch.object(team, "terminal", lambda a: {"state": "live"}), patch.object(team, "screen_of", lambda *a: ""):
            clock = iter(range(0, 100))
            with patch.object(team.time, "time", lambda: next(clock)), patch.object(team.time, "sleep"):
                self.assertIsNone(team.watch_startup_dialog("t4", seconds=3))


if __name__ == "__main__":
    unittest.main()


class LiveCapture(unittest.TestCase):
    def test_real_idle_codex_screen_is_a_prompt(self):
        st = rt.screen_state(LIVE_IDLE, "codex")
        self.assertEqual((st["state"], st["input"]), ("prompt", ""))
