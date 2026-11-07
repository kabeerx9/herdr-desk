import ast
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

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


class Host(unittest.TestCase):
    """HcHost against a recorded hc: the argv it sends and how it reads hc's answers."""

    def host(self, code=0, out="", err=""):
        self.calls = []
        return da.HcHost(lambda argv: self.calls.append(argv) or subprocess.CompletedProcess(argv, code, out, err))

    def test_launch_argv(self):
        r = self.host(out='{"address":"t9"}').launch(["claude", "go"], "/w", {"role": "cto", "herdr.tab": "tb1"},
                                                     name="cto-x", parent="t1", shell="/bin/zsh")
        self.assertEqual(["hc", "run", "--bg", "--outlive-parent", "--name", "cto-x", "--cwd", "/w",
                          "--label", "role=cto", "--label", "herdr.tab=tb1", "--parent", "t1",
                          "--", "/bin/zsh", "-lic", 'exec "$@"', "team-role", "claude", "go"], self.calls[0])
        self.assertEqual("t9", r.json()["address"])
        self.host().launch(["x"], "/w", {}, parent="t1", no_parent=True)
        self.assertIn("--no-parent", self.calls[0]); self.assertNotIn("--parent", self.calls[0])

    def test_label_empty_value_clears(self):
        self.host().label("t1", {"awaiting": "", "ctx": 1200})
        self.assertEqual(["hc", "label", "t1", "awaiting=", "ctx=1200"], self.calls[0])

    def test_failure_keeps_text_and_unwraps_hc_message(self):
        err = json.dumps({"error": {"message": "no such terminal"}})
        r = self.host(code=1, err=err).send_text("t1", "hi")
        self.assertEqual((False, err, "no such terminal"), (r.ok, r.error, r.message))
        self.assertEqual("plain", self.host(code=1, out="plain\n").send_keys("t1", ["enter"]).message)
        self.assertIsNone(self.host(code=1, out="{}").send_text("t1", "x").json())

    def test_records(self):
        self.assertEqual("", self.host(code=1, out="junk").screen("t1"))
        self.assertIsNone(self.host(code=1).get("t1"))
        self.assertIsNone(self.host(out="[1]").get("t1"))
        self.assertEqual(["hc", "get", "t1", "--json"], self.calls[0])
        live = [{"address": "t1"}, "noise"]
        self.assertEqual([{"address": "t1"}], self.host(out=json.dumps({"terminals": live})).list(label="task=x"))
        self.assertEqual(["hc", "ls", "--label", "task=x", "--json"], self.calls[0])
        self.assertEqual([{"address": "t1"}], self.host(out=json.dumps(live)).list(all=True))
        self.assertEqual(["hc", "ls", "--all", "--json"], self.calls[0])
        self.assertEqual([], self.host(code=1).list())

    def test_reachable(self):
        self.host().reachable("t1"); self.assertEqual(["hc", "get", "t1", "--json"], self.calls[0])
        self.host().reachable(); self.assertEqual(["hc", "server", "status"], self.calls[0])


class Hooks(unittest.TestCase):
    """Each CLI's hook payload in the Desk's words, and Claude's reply shape."""

    def test_claude_payload(self):
        ev = da.ClaudeAdapter().hook_event(json.dumps({
            "hook_event_name": "PermissionRequest", "session_id": "S", "cwd": "/w", "transcript_path": "/p/abc-123.jsonl",
            "tool_name": "Bash", "tool_input": {"command": "ls"}, "permission_suggestions": [{"type": "addRules"}]}))
        self.assertEqual(("PermissionRequest", "S", "/w", "Bash", {"command": "ls"}, ({"type": "addRules"},), "abc-123"),
                         (ev.kind, ev.session_id, ev.cwd, ev.tool, ev.tool_input, ev.suggestions, ev.conversation))
        for bad in ("nope", "[1]", ""):
            self.assertIsNone(da.ClaudeAdapter().hook_event(bad))

    def test_claude_turn_message_falls_back_to_the_transcript(self):
        claude = da.ClaudeAdapter()
        self.assertEqual("said", claude.turn_message(claude.hook_event('{"last_assistant_message": "said"}')))
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as f:
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "from log"}]}}) + "\n")
        self.addCleanup(os.remove, f.name)
        self.assertEqual("from log", claude.turn_message(claude.hook_event(json.dumps({"transcript_path": f.name}))))
        self.assertEqual("", claude.turn_message(claude.hook_event("{}")))

    def test_claude_permission_reply(self):
        reply = da.ClaudeAdapter().permission_reply
        wrap = lambda d: {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": d}}
        self.assertEqual(wrap({"behavior": "allow"}), reply("allow"))
        self.assertEqual(wrap({"behavior": "deny", "message": "no"}), reply("deny", "no"))
        self.assertEqual(wrap({"behavior": "allow", "updatedPermissions": [{"r": 1}]}), reply("allow", rules=({"r": 1},)))
        self.assertEqual(wrap({"behavior": "allow", "updatedInput": {"answers": {}}}), reply("allow", updated_input={"answers": {}}))

    def test_codex_notify(self):
        codex = da.CodexAdapter()
        ev = codex.hook_event(["x", json.dumps({"type": "agent-turn-complete", "last-assistant-message": "done"})])
        self.assertEqual(("turn_end", "done"), (ev.kind, ev.message))
        self.assertEqual("approval-requested", codex.hook_event(['{"type": "approval-requested"}']).kind)
        self.assertEqual("", codex.hook_event([]).kind)
        self.assertIsNone(codex.hook_event(["not json"]))

    def test_claude_context_and_compaction(self):
        call = {"type": "assistant", "message": {"usage": {"input_tokens": 10, "cache_read_input_tokens": 90, "output_tokens": 5}}}
        side = {**call, "isSidechain": True, "message": {"usage": {"input_tokens": 999}}}
        boundary = {"type": "system", "subtype": "compact_boundary", "compactMetadata": {"preTokens": 5000, "trigger": "manual"}}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.jsonl")
            with open(path, "w") as f:
                f.write("\n".join(json.dumps(x) for x in (call, side)))
            self.assertEqual(105, da.ClaudeAdapter().context_size(path))
            with open(path, "a") as f:
                f.write("\n" + json.dumps(boundary))
            self.assertIsNone(da.ClaudeAdapter().context_size(path))
            self.assertEqual({"preTokens": 5000, "trigger": "manual"}, da.ClaudeAdapter().compact_info(path))
        self.assertIsNone(da.ClaudeAdapter().context_size("/nonexistent"))


class PlanUsage(unittest.TestCase):
    """Each CLI's plan limits from a recorded usage answer; tokens go only into the request."""

    def fake_get(self, answer):
        self.sent = []
        def get(url, headers):
            self.sent.append((url, headers))
            if isinstance(answer, Exception):
                raise answer
            return answer
        return get

    def test_claude_limits_and_plan(self):
        u = {"limits": [{"group": "session", "percent": 47.6, "resets_at": "2026-11-07T10:00:00Z", "severity": "normal"},
                        {"group": "weekly", "percent": 24, "resets_at": None},
                        {"group": "weekly", "percent": 29, "scope": {"model": {"display_name": "Fable"}}}]}
        creds = {"accessToken": "TOKEN", "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x"}
        out = da.ClaudeAdapter().plan_usage(self.fake_get(u), creds=creds)
        self.assertEqual(("Claude", "Max 5x", None), (out["provider"], out["plan"], out["error"]))
        self.assertEqual([("Session", 48, 1794045600), ("Week", 24, None), ("Fable week", 29, None)],
                         [(w["label"], w["used"], w["resets_at"]) for w in out["windows"]])
        self.assertEqual("Bearer TOKEN", self.sent[0][1]["Authorization"])
        self.assertNotIn("TOKEN", json.dumps(out))

    def test_claude_older_answer_shape(self):
        u = {"five_hour": {"utilization": 10.2, "resets_at": None}, "seven_day": {"utilization": None}}
        self.assertEqual([{"label": "Session", "used": 10, "resets_at": None}], da.ClaudeAdapter.usage_windows(u))

    def test_codex_limits(self):
        u = {"plan_type": "plus", "rate_limit": {"primary_window": {"used_percent": 0, "reset_after_seconds": 60},
                                                 "secondary_window": {"used_percent": 52.4, "reset_at": 1794405593}}}
        with patch.object(da.codex.time, "time", return_value=1000):
            out = da.CodexAdapter().plan_usage(self.fake_get(u), tokens={"access_token": "T", "account_id": "A"})
        self.assertEqual(("Codex", "Plus"), (out["provider"], out["plan"]))
        self.assertEqual([("Session", 0, 1060), ("Week", 52, 1794405593)], [(w["label"], w["used"], w["resets_at"]) for w in out["windows"]])
        self.assertEqual("A", self.sent[0][1]["ChatGPT-Account-Id"])

    def test_failed_request_names_the_status_not_the_body(self):
        err = urllib.error.HTTPError("u", 401, "secret body", {}, None)
        out = da.CodexAdapter().plan_usage(self.fake_get(err), tokens={"access_token": "T"})
        self.assertEqual(("usage request failed (401)", []), (out["error"], out["windows"]))

    def test_not_signed_in_is_left_out(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(da.CodexAdapter.tokens({"CODEX_HOME": d}))
            with open(os.path.join(d, "auth.json"), "w") as f:
                json.dump({"tokens": {"access_token": ""}}, f)
            self.assertIsNone(da.CodexAdapter.tokens({"CODEX_HOME": d}))

    def test_one_provider_failing_never_hides_another(self):
        ok = {"provider": "Codex", "plan": None, "windows": [], "error": None}
        with patch.object(da.ClaudeAdapter, "plan_usage", side_effect=OSError), patch.object(da.CodexAdapter, "plan_usage", return_value=ok):
            self.assertEqual([{"provider": "Claude", "plan": None, "windows": [], "error": "OSError"}, ok], da.plan_usage())
        with patch.object(da.ClaudeAdapter, "plan_usage", return_value=None), patch.object(da.CodexAdapter, "plan_usage", return_value=ok):
            self.assertEqual([ok], da.plan_usage())


class Boundary(unittest.TestCase):
    def test_adapters_never_import_desk_code(self):
        """Adapters sit below the core: importing desk_runtime or team would make a cycle."""
        for name in os.listdir(HERE):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(HERE, name)) as f:
                tree = ast.parse(f.read())
            for node in ast.walk(tree):
                mods = [a.name for a in node.names] if isinstance(node, ast.Import) else \
                       [node.module or ""] if isinstance(node, ast.ImportFrom) else []
                for m in mods:
                    self.assertNotIn(m.split(".")[0], ("desk_runtime", "team"), f"{name} imports {m}")


if __name__ == "__main__":
    unittest.main()
