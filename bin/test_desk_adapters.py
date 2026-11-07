import ast
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import desk_adapters as da

HERE = os.path.join(os.path.dirname(__file__), "desk_adapters")


class Registry(unittest.TestCase):
    def test_role_argv_wins_over_cli(self):
        self.assertIsInstance(da.for_role({"cli": "codex", "argv": ["x"]}), da.ArgvAdapter)

    def test_cli_picks_adapter_and_defaults_to_claude(self):
        self.assertIsInstance(da.for_role({"cli": "codex"}), da.CodexAdapter)
        self.assertIsInstance(da.for_role({}), da.ClaudeAdapter)

    def test_unknown_cli_names_the_role(self):
        with self.assertRaisesRegex(da.UnsupportedCli, "Role Muse uses muse"):
            da.for_role({"name": "Muse", "cli": "muse"})


class Args(unittest.TestCase):
    def test_role_adapter_overrides_defaults(self):
        cfg = da.config_for({"cli": "claude", "adapter": {"fork_args": ["--f", "{session_id}"]}})
        self.assertEqual(cfg["fork_args"], ["--f", "{session_id}"])
        self.assertEqual(cfg["resume_args"], ["--resume", "{session_id}"])

    def test_codex_has_no_resume_by_default(self):
        with self.assertRaisesRegex(ValueError, "no configured resume"):
            da.for_role({"cli": "codex"}).args({"cli": "codex"}, "resume", "S")

    def test_unknown_cli_keeps_its_own_templates(self):
        role = {"cli": "muse", "adapter": {"resume_args": ["-r", "{session_id}"]}}
        self.assertEqual(da.expand_args(da.config_for(role), "resume", "S"), ["-r", "S"])

    def test_bad_template_is_refused(self):
        with self.assertRaises(ValueError):
            da.expand_args({"resume_args": "--resume {session_id}"}, "resume", "S")


class Launch(unittest.TestCase):
    def setUp(self):
        self.env = da.LaunchEnv("/bin/team", tempfile.mkdtemp(), 60)

    def test_task_is_last(self):
        for role in ({"cli": "claude", "promptText": "p"}, {"cli": "codex", "promptText": "p"},
                     {"argv": ["x"], "promptText": ""}):
            self.assertEqual(da.for_role(role).launch_argv(role, "do it", self.env)[-1], "do it")

    def test_hooks_call_the_given_team(self):
        argv = da.ClaudeAdapter().launch_argv({"promptText": ""}, "", self.env)
        settings = argv[argv.index("--settings") + 1]
        self.assertIn("/bin/team hook claude-permission", settings)
        self.assertIn('"timeout": 60', settings)


FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return f.read()


class Screens(unittest.TestCase):
    """Each adapter reads its own CLI's real screens (recorded in bin/fixtures)."""

    def test_prompt_screens(self):
        self.assertEqual(da.ClaudeAdapter().screen_state(fixture("claude-prompt.txt"))["state"], "prompt")
        self.assertEqual(da.CodexAdapter().screen_state(fixture("codex-prompt.txt"))["state"], "prompt")

    def test_dialog_screens(self):
        self.assertEqual(da.CodexAdapter().screen_state(fixture("codex-model-picker.txt"))["state"], "dialog")

    def test_trust_prompt_keys(self):
        # codex-cli 0.167 replaced "Trust this folder?" with an approval-mode question, so the Desk
        # no longer answers it: accepting would also turn off Codex's approvals for the folder.
        # The startup-dialog check shows it to Kabeer instead. Kabeer decides whether to change this.
        self.assertIsNone(da.CodexAdapter().trust_prompt(fixture("codex-trust.txt")))
        self.assertEqual(da.CodexAdapter().trust_prompt("  Trust this folder?"), ["enter"])
        self.assertIsNone(da.CodexAdapter().trust_prompt(fixture("codex-prompt.txt")))
        self.assertEqual(da.ClaudeAdapter().trust_prompt("│ ❯ 1. Yes, I trust this folder"), ["down", "enter"])
        self.assertIsNone(da.ClaudeAdapter().trust_prompt(fixture("claude-prompt.txt")))

    def test_unknown_cli_screens_read_as_claude(self):
        self.assertIsInstance(da.screen_adapter("muse"), da.ClaudeAdapter)
        self.assertIsNone(da.by_cli("muse"))


class Processes(unittest.TestCase):
    def test_aliases_cover_every_adapter_and_known_cli(self):
        aliases = da.process_aliases()
        self.assertEqual(aliases["claude"], {"claude", "claude-code"})
        self.assertEqual(aliases["codex"], {"codex", "codex-cli"})
        self.assertIn("muse", aliases)

    def test_runtime_uses_adapter_aliases(self):
        import desk_runtime as rt
        live = {"foreground": {"name": "2.1.319", "argv": ["claude-code"]}, "status": {}}
        self.assertTrue(rt.foreground_agent(live, "claude"))
        self.assertFalse(rt.foreground_agent(live, "codex"))


class Boundary(unittest.TestCase):
    def test_adapters_never_import_desk_code(self):
        """Adapters sit below the core: importing desk_runtime or team would make a cycle."""
        for name in os.listdir(HERE):
            if not name.endswith(".py"):
                continue
            tree = ast.parse(open(os.path.join(HERE, name)).read())
            for node in ast.walk(tree):
                mods = [a.name for a in node.names] if isinstance(node, ast.Import) else \
                       [node.module or ""] if isinstance(node, ast.ImportFrom) else []
                for m in mods:
                    self.assertNotIn(m.split(".")[0], ("desk_runtime", "team"), f"{name} imports {m}")


if __name__ == "__main__":
    unittest.main()
