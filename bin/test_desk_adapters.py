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
