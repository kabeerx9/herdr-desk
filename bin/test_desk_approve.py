"""Answering a Claude permission prompt from the Desk (team approve): the prompt classifier on
screens in Claude 2.1's shape (bin/fixtures/claude-permission-*.txt, codex-approval.txt), and the
command against a fake terminal: each choice maps to the option the screen shows, a stale click
never answers a different prompt, Codex is refused, a hook still waiting is answered by its id,
and nothing counts as answered until the prompt is gone. No live terminal is touched."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import desk_runtime as rt
from test_desk_commands import FakeTerminal, PICKER, PROMPT, USAGE, fixture
from test_team_overhaul import Base, git_repo, team

BASH = fixture("claude-permission-bash")          # git log: 1 Yes · 2 don't ask again · 3 No
EDIT = fixture("claude-permission-edit")          # Edit file: 1 Yes · 2 allow all edits · 3 No
REORDERED = fixture("claude-permission-reordered")  # 1 don't ask again · 2 Yes · 3 No
CODEX = fixture("codex-approval")
CMD = "git log --oneline -5 main..HEAD"


class PermissionDialogTests(unittest.TestCase):
    def test_bash_prompt(self):
        d = rt.permission_dialog(BASH)
        self.assertEqual(("Bash command", "Do you want to proceed?"), (d["title"], d["question"]))
        self.assertTrue(d["subject"].startswith(CMD))
        self.assertEqual([(1, "allow", True), (2, "always", False), (3, "deny", False)], [(o["n"], o["kind"], o["focused"]) for o in d["options"]])

    def test_edit_prompt_drops_the_diff_frame(self):
        d = rt.permission_dialog(EDIT)
        self.assertEqual("Edit file", d["title"])
        self.assertTrue(d["subject"].startswith("apps/web/src/hooks/use-stay.ts"))
        self.assertNotIn("╌", d["subject"])
        self.assertEqual(["allow", "always", "deny"], [o["kind"] for o in d["options"]])

    def test_options_are_read_not_assumed(self):
        d = rt.permission_dialog(REORDERED)
        self.assertEqual((1, 2, 3), tuple(rt.pick_option(d, c)["n"] for c in ("always", "allow", "deny")))

    def test_not_a_permission_prompt(self):
        for screen in (PROMPT, USAGE, PICKER, "", "Loading…\n"):
            self.assertIsNone(rt.permission_dialog(screen))
        self.assertIsNone(rt.permission_dialog(CODEX))            # not Claude's shape
        self.assertIsNone(rt.permission_dialog(BASH, "codex"))    # and never for another CLI

    def test_option_kinds(self):
        cases = {"Yes": "allow", "Yes, proceed (y)": "allow", "No": "deny", "No, and tell Claude what to do differently (esc)": "deny",
                 "Yes, and don't ask again for npm commands in ~/x": "always", "Yes, allow all edits during this session (shift+tab)": "always",
                 "Yes, and always allow access to src/ from this project": "always", "Maybe later": None}
        for label, kind in cases.items():
            self.assertEqual(kind, rt.option_kind(label), label)

    def test_matching_ignores_wrapping_and_rejects_other_commands(self):
        d = rt.permission_dialog(BASH)
        self.assertTrue(rt.dialog_matches(d, CMD))
        self.assertTrue(rt.dialog_matches(d, "git log --oneline\n -5 main..HEAD"))
        self.assertFalse(rt.dialog_matches(d, "git push --force origin main"))
        self.assertFalse(rt.dialog_matches(d, "git log --oneline -5"[:-1] + "9"))
        self.assertTrue(rt.dialog_matches(rt.permission_dialog(EDIT), "/Users/kabeer/x/apps/web/src/hooks/use-stay.ts"))
        self.assertFalse(rt.dialog_matches(rt.permission_dialog(EDIT), "/Users/kabeer/x/apps/web/src/hooks/use-guest.ts"))


class ApproveTests(Base):
    def setUp(self):
        super().setUp()
        for name, value in (("APPROVE_S", 0.2), ("POLL_S", 0.01), ("PERMITS", os.path.join(self.tmp.name, ".permits"))):
            p = patch.object(team, name, value); p.start(); self.addCleanup(p.stop)
        self.term = FakeTerminal(BASH)
        p = patch.object(team, "sh", side_effect=self.term.sh); p.start(); self.addCleanup(p.stop)
        team.chat_append("desk", {"from": "kabeer", "kind": "desk", "name": "Desk"})

    def approve(self, choice=None, expect=None, peek=False):
        return self.call(team.approve, address="t1", choice=choice, expect=expect, peek=peek)

    def answered_by(self, n, closes_to=PROMPT):
        self.term.on_keys = lambda keys, now: closes_to if keys == [str(n)] else None

    def error(self):
        return json.loads(self.err)

    def chat(self, kind):
        return [r for r in team.chat_read("desk") if r.get("kind") == kind]

    def test_allow_presses_the_yes_option_and_confirms_it_closed(self):
        self.answered_by(1)
        code, out = self.approve("allow", CMD)
        self.assertEqual((0, True, 1, "keys"), (code, out["ok"], out["option"]["n"], out["via"]))
        self.assertEqual([["1"]], self.term.keys())
        asked, done = self.chat("permission")[-1], self.chat("permission-done")[-1]
        self.assertEqual(("screen", "Bash command", asked["id"], "allow"), (asked["source"], asked["tool"], done["re"], done["decision"]))

    def test_always_and_deny_use_their_own_options(self):
        self.answered_by(2)
        self.assertEqual(0, self.approve("always", CMD)[0])
        self.term.screen, self.term.calls = BASH, []
        self.answered_by(3)
        self.assertEqual(0, self.approve("deny", CMD)[0])
        self.assertEqual([["3"]], self.term.keys())

    def test_options_in_another_order(self):
        self.term.screen = REORDERED
        self.answered_by(2)
        code, out = self.approve("allow", "pnpm --filter web check-types")
        self.assertEqual((0, 2), (code, out["option"]["n"]))
        self.term.screen, self.term.calls = REORDERED, []
        self.answered_by(1)
        self.assertEqual(1, self.approve("always", "pnpm --filter web check-types")[1]["option"]["n"])

    def test_prompt_already_gone(self):
        self.term.screen = PROMPT
        code, _ = self.approve("allow", CMD)
        self.assertEqual((2, "no_prompt", []), (code, self.error()["code"], self.term.keys()))
        self.assertEqual([], self.chat("permission-done"))

    def test_a_different_command_is_never_answered(self):
        code, _ = self.approve("allow", "rm -rf node_modules")
        err = self.error()
        self.assertEqual((2, "different", True, []), (code, err["code"], err["open_terminal"], self.term.keys()))
        self.assertTrue(err["showing"].startswith(CMD))

    def test_codex_is_refused_with_open_terminal(self):
        self.info["t1"]["foreground"] = {"name": "codex", "argv": ["codex"], "cwd": "/work"}
        self.term.screen = CODEX
        code, _ = self.approve("allow")
        self.assertEqual((2, "unsupported", True), (code, self.error()["code"], self.error()["open_terminal"]))
        self.assertEqual([], self.term.typed())

    def test_a_prompt_that_stays_open_is_an_error_not_a_success(self):
        code, _ = self.approve("allow", CMD)
        self.assertEqual((2, "still_open"), (code, self.error()["code"]))
        # Its focus was already on Yes, so one Enter was tried to confirm; never more.
        self.assertEqual([["1"], ["enter"]], self.term.keys())
        self.assertEqual([], self.chat("permission-done"))

    def test_deny_never_presses_enter_on_a_focused_yes(self):
        self.approve("deny", CMD)
        self.assertEqual([["3"]], self.term.keys())

    def test_no_such_option(self):
        self.term.screen = BASH.replace("   2. Yes, and don't ask again for git log commands in /Users/kabeer/Desktop/projects/tattvix\n", "").replace("3. No", "2. No")
        code, _ = self.approve("always", CMD)
        self.assertEqual((2, "no_option", []), (code, self.error()["code"], self.term.keys()))

    def test_a_waiting_hook_is_answered_by_its_id(self):
        team.chat_append("desk", {"from": "cto", "address": "t1", "kind": "permission", "id": "ab12cd34", "tool": "Bash", "detail": CMD,
                                  "always": "Bash(git log:*)"})
        permit = Path(team.PERMITS) / "ab12cd34.json"
        reads = self.term.sh
        def sh(args, **kw):
            if args[:2] == ["hc", "read"] and permit.exists():
                self.term.screen = PROMPT
            return reads(args, **kw)
        with patch.object(team, "sh", side_effect=sh):
            code, out = self.approve("always", CMD)
        self.assertEqual((0, "hook"), (code, out["via"]))
        self.assertEqual({"decision": "always"}, json.loads(permit.read_text()))
        self.assertEqual([], self.term.keys())
        self.assertEqual(1, len(self.chat("permission")))  # the hook's own record, not a second one

    def hook_alone(self, always=None):
        """Claude runs the hook first: it draws no prompt while the hook waits on the Desk."""
        self.term.screen = PROMPT
        team.chat_append("desk", {"from": "cto", "address": "t1", "kind": "permission", "id": "ab12cd34", "tool": "Bash", "detail": CMD,
                                  "always": always})
        return Path(team.PERMITS) / "ab12cd34.json"

    def test_a_waiting_hook_is_answered_with_no_prompt_on_screen(self):
        permit = self.hook_alone()
        code, out = self.approve("allow", CMD)
        self.assertEqual((0, "hook"), (code, out["via"]))
        self.assertEqual({"decision": "allow"}, json.loads(permit.read_text()))
        self.assertEqual([], self.term.keys())

    def test_a_click_for_another_command_never_answers_the_waiting_hook(self):
        permit = self.hook_alone()
        code, _ = self.approve("allow", "rm -rf /")
        self.assertEqual((2, "different"), (code, self.error()["code"]))
        self.assertFalse(permit.exists())

    def test_always_needs_a_rule_from_claude(self):
        permit = self.hook_alone()
        code, _ = self.approve("always", CMD)
        self.assertEqual((2, "no_option"), (code, self.error()["code"]))
        self.assertFalse(permit.exists())

    def test_peek(self):
        code, out = self.approve(peek=True)
        self.assertEqual((0, "Bash command", 3), (code, out["title"], len(out["options"])))
        self.assertEqual([], self.term.typed())


class TaskLineAndDiffTests(unittest.TestCase):
    def test_task_line(self):
        self.assertEqual("Guest check-in API", rt.task_line("do it", "intro\n# Guest check-in API\n## Acceptance"))
        self.assertEqual("Add the stays endpoint.", rt.task_line("Add the stays endpoint. Then tests.\nMore"))
        self.assertIsNone(rt.task_line("", None))
        self.assertEqual(120, len(rt.task_line("x" * 300)))

    def test_diff_stat_counts_branch_and_working_tree(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            repo = Path(d) / "r"
            git_repo(repo)
            subprocess.run(["git", "branch", "-M", "main"], cwd=repo, check=True, capture_output=True)
            self.assertIsNone(rt.diff_stat(str(repo)))   # on the base
            subprocess.run(["git", "checkout", "-qb", "feat"], cwd=repo, check=True, capture_output=True)
            self.assertIsNone(rt.diff_stat(str(repo)))   # nothing changed
            (repo / "a.txt").write_text("a\nb\nc\n")
            (repo / "n.txt").write_text("n\n")
            subprocess.run(["git", "add", "n.txt"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "commit", "-qm", "n"], cwd=repo, check=True, capture_output=True)
            self.assertEqual({"added": 3, "removed": 0, "files": 2, "branch": "feat", "base": "main"}, rt.diff_stat(str(repo)))
        self.assertIsNone(rt.diff_stat("/nonexistent/folder"))


if __name__ == "__main__":
    unittest.main()
