"""team transcript (a member's own conversation) and team post --raw (slash commands), on fixture
transcripts and patched terminals; no live terminal is touched."""
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
import desk_runtime as rt
from test_desk_timeline import Transcript
from test_team_overhaul import Base, team, terminal


class ClassifyTests(unittest.TestCase):
    def test_desk_chat_delivery_is_kabeer_without_prefix_or_digest(self):
        said = rt.classify_prompt("[desk chat] Kabeer (to cto, backend): ship it\n\nAlso new in the chat:\n[10:00] backend: hi")
        self.assertEqual(("kabeer", "ship it", "chat"), (said["who"], said["text"], said["via"]))
        self.assertEqual("kabeer", rt.classify_prompt("[desk chat] Kabeer (via CTO): why?")["who"])

    def test_hc_wrapper_is_parent_unless_it_carries_kabeer(self):
        said = rt.classify_prompt('<hc from="t7">Take the API half; Frontend has the UI.</hc>')
        self.assertEqual(("parent", "t7", "Take the API half; Frontend has the UI."), (said["who"], said["from"], said["text"]))
        self.assertEqual("kabeer", rt.classify_prompt('<hc from="t18">[desk chat] Kabeer: pong</hc>')["who"])

    def test_desk_notices_brief_and_typed_text(self):
        self.assertEqual(("desk", "Your context is long"), tuple(rt.classify_prompt("[desk] Your context is long").values())[:2])
        self.assertEqual("desk", rt.classify_prompt("[desk chat] backend asks you (q1): which port?")["who"])
        self.assertEqual("desk", rt.classify_prompt("Build it.\n\n(Team task: x. Report with ...)")["who"])
        self.assertEqual(("kabeer", "typed by hand"), (rt.classify_prompt("typed by hand")["who"], rt.classify_prompt("typed by hand")["text"]))


class TurnsTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tr = Transcript(self.tmp.name)

    def turns(self, **kw):
        return rt.transcript_turns(self.tr.path, **kw)

    def test_tools_between_texts_fold_into_the_reply_after_them(self):
        tr = self.tr
        tr.prompt("[desk chat] Kabeer: fix the bug")
        tr.assistant([{"type": "text", "text": "Looking."}])
        a = tr.tool("Read", {"file_path": "/a.py"}); tr.result(a)
        b = tr.tool("Bash", {"command": "pytest"}); tr.result(b, "boom", error=True)
        tr.assistant([{"type": "text", "text": "Fixed."}])
        tr.assistant([{"type": "text", "text": "Tests pass."}])
        out = self.turns()
        self.assertEqual([("kabeer", "fix the bug"), ("agent", "Looking."), ("agent", "Fixed.\n\nTests pass.")],
                         [(t["who"], t["text"]) for t in out["turns"]])
        self.assertIsNone(out["turns"][1]["tools"])
        self.assertEqual("Ran 1 command, read 1 file, 1 failed", out["turns"][2]["tools"]["summary"])
        self.assertEqual(1, out["turns"][2]["tools"]["failed"])
        self.assertFalse(out["partial"])

    def test_work_still_going_is_a_textless_entry_with_its_subagents(self):
        tr = self.tr
        tr.prompt('<hc from="t3">Review the branch</hc>')
        tid = tr.tool("Agent", {"description": "Scan the diff", "subagent_type": "Explore"})
        tr.subagent("ab", tid, False, [[{"type": "tool_use", "name": "Grep", "input": {"pattern": "TODO"}}]])
        out = self.turns()
        last = out["turns"][-1]
        self.assertEqual(("parent", "agent", ""), (out["turns"][0]["who"], last["who"], last["text"]))
        self.assertEqual("Started 1 agent", last["tools"]["summary"])
        self.assertEqual([("Scan the diff", "running", "Search for TODO")], [(s["title"], s["status"], s["line"]) for s in last["subagents"]])
        self.assertNotIn("_open", last)

    def test_commands_once_compaction_pastes_and_noise(self):
        tr = self.tr
        tr.prompt("/compact keep the plan")
        tr.add({"type": "system", "subtype": "compact_boundary", "content": "Conversation compacted"})
        tr.prompt("summary of earlier", isCompactSummary=True)
        tr.add({"type": "user", "isMeta": True, "message": {"content": "<local-command-caveat>x</local-command-caveat>"}})
        tr.prompt("<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>")
        tr.prompt("<local-command-stdout>Compacted</local-command-stdout>")
        tr.prompt('\n\n<pasted_content id="d3">\n[desk chat] Kabeer: /clear\n</pasted_content id="d3">\n')
        tr.prompt("<task-notification>done</task-notification>")
        tr.add({"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "side"}]}})
        out = self.turns()
        self.assertEqual([("kabeer", "command", "/compact keep the plan"), ("desk", "event", "Conversation compacted"),
                          ("kabeer", None, "/clear")], [(t["who"], t.get("kind"), t["text"]) for t in out["turns"]])

    def test_limit_and_a_cut_tail_are_partial(self):
        for i in range(5):
            self.tr.prompt("q%d" % i)
            self.tr.assistant([{"type": "text", "text": "a%d" % i}])
        out = self.turns(limit=3)
        self.assertEqual(["a3", "q4", "a4"], [t["text"] for t in out["turns"]])
        self.assertTrue(out["partial"])
        self.assertTrue(self.turns(tail=200)["partial"])

    def test_garbage_lines_are_skipped(self):
        with open(self.tr.path, "a") as f:
            f.write("not json\n[1,2]\n")
        self.tr.prompt("hi")
        self.assertEqual(["hi"], [t["text"] for t in self.turns()["turns"]])


class TranscriptCommandTests(Base):
    def test_claude_member_reads_its_transcript(self):
        tr = Transcript(os.path.join(self.tmp.name, 'projects'))
        tr.prompt("[desk chat] Kabeer: hello")
        tr.assistant([{"type": "text", "text": "hi"}])
        code, out = self.call(team.runtime_transcript, address='t1', limit=None)
        self.assertEqual((0, 't1', True), (code, out['address'], out['supported']))
        self.assertEqual([('kabeer', 'hello'), ('agent', 'hi')], [(t['who'], t['text']) for t in out['turns']])

    def test_codex_missing_transcript_and_unknown_address(self):
        code, out = self.call(team.runtime_transcript, address='t1', limit=5)
        self.assertEqual((True, []), (out['supported'], out['turns'])); self.assertIn('reason', out)
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(cli='codex'))
        code, out = self.call(team.runtime_transcript, address='t1', limit=5)
        self.assertEqual((False, []), (out['supported'], out['turns']))
        code, _ = self.call(team.runtime_transcript, address='nope', limit=5)
        self.assertEqual(1, code)

    def test_unreadable_transcript_is_an_error(self):
        tr = Transcript(os.path.join(self.tmp.name, 'projects'))
        with patch.object(team, 'transcript_turns', side_effect=OSError('denied')):
            code, _ = self.call(team.runtime_transcript, address='t1', limit=5)
        self.assertEqual(1, code); self.assertIn('denied', self.err)


class RawPostTests(Base):
    def setUp(self):
        super().setUp()
        self.calls = []
        self.code = 0
        p = patch.object(team, 'sh', side_effect=lambda args, **k: self.calls.append(args) or subprocess.CompletedProcess(args, self.code, '', 'nope' if self.code else ''))
        p.start(); self.addCleanup(p.stop)
        self.reply = patch.object(team, 'expect_reply', side_effect=AssertionError('a command reserves no reply'))
        self.reply.start(); self.addCleanup(self.reply.stop)
        for name, value in (('SETTLE_S', 0.05), ('ACCEPT_S', 0.05), ('POLL_S', 0.01)):
            p = patch.object(team, name, value); p.start(); self.addCleanup(p.stop)

    @property
    def typed(self):
        """What went into the terminal: screen reads (hc read) aren't typing."""
        return [c for c in self.calls if c[:2] != ['hc', 'read']]

    def post(self, text, to=('t1:cto',)):
        return self.call(team.post, task='desk', to=list(to), text=[text], raw=True)

    def test_short_command_is_typed_as_keys_and_logged_as_a_command(self):
        code, rec = self.post('/model opus')
        self.assertEqual(0, code)
        self.assertEqual(['hc', 'keys', 't1', '/', 'm', 'o', 'd', 'e', 'l', 'space', 'o', 'p', 'u', 's', 'enter'], self.typed[0])
        self.assertEqual(('command', '/model opus', ['cto'], ['t1']), (rec['kind'], rec['text'], rec['delivered'], rec['delivered_to']))
        self.assertEqual('command', team.chat_read('desk')[-1]['kind'])
        self.assertNotIn('[desk chat]', json.dumps(self.calls))

    def test_long_or_plain_text_is_pasted_exactly(self):
        self.post('plain words, no prefix')
        self.assertEqual(['hc', 'send', 't1', 'plain words, no prefix'], self.typed[0])
        self.post('/x ' + 'y' * 300)
        self.assertEqual('send', self.typed[1][1])

    def test_refuses_a_prompt_a_shell_and_another_desk_and_still_logs(self):
        self.info['t1']['status'] = {'state': 'blocked', 'app': 'claude'}
        code, _ = self.post('/clear')
        self.assertEqual(1, code); self.assertEqual([], self.calls)
        rec = team.chat_read('desk')[-1]
        self.assertEqual(('command', []), (rec['kind'], rec['delivered'])); self.assertIn('prompt', rec['failed'][0]['why'])
        self.info['t1'] = terminal('zsh')
        self.assertEqual(1, self.post('/clear')[0])
        self.info['t1'] = terminal(task='other')
        self.assertEqual(1, self.post('/clear')[0])
        self.assertEqual([], self.calls)

    def test_typing_failure_is_reported_not_swallowed(self):
        self.code = 1
        code, _ = self.post('/status')
        self.assertEqual(1, code)
        self.assertEqual('nope', team.chat_read('desk')[-1]['failed'][0]['why'])


if __name__ == '__main__':
    unittest.main()


class AutoNameTests(Base):
    def desk(self, **head):
        with open(team.chat_file('desk'), 'w') as f:
            f.write(json.dumps({'at': 1, 'from': 'kabeer', 'kind': 'desk', **head}) + '\n')
            f.write(json.dumps({'at': 2, 'from': 'cto', 'kind': 'say', 'text': 'hi'}) + '\n')

    def test_auto_named_desk_takes_the_title_once_and_keeps_the_thread(self):
        self.desk(name='shotgun · Nov 4 18:02', folder='/w')
        self.assertTrue(team.desk_autoname('desk', '  Lobby tour   review '))
        rows = team.chat_read('desk')
        self.assertEqual(('Lobby tour review', '/w', 'title', 2), (rows[0]['name'], rows[0]['folder'], rows[0]['named'], len(rows)))
        self.assertFalse(team.desk_autoname('desk', 'Something else'))
        self.assertEqual('Lobby tour review', team.chat_read('desk')[0]['name'])

    def test_named_desks_bad_heads_and_empty_titles_are_left_alone(self):
        self.desk(name='Health check')
        self.assertFalse(team.desk_autoname('desk', 'Title'))
        self.desk(name='Health check', auto=True)
        self.assertTrue(team.desk_autoname('desk', 'Title'))
        self.desk(name='x · Nov 4 18:02')
        self.assertFalse(team.desk_autoname('desk', '   '))
        self.assertFalse(team.desk_autoname('missing', 'Title'))
        with open(team.chat_file('desk'), 'w') as f:
            f.write('not json\n')
        self.assertFalse(team.desk_autoname('desk', 'Title'))

    def test_new_desk_marks_unnamed_and_state_renames_from_the_cto_title(self):
        code, out = self.call(team.new_desk, name=None, repo=None)
        self.assertTrue(out['auto'])
        slug = out['slug']
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(task=slug))
        with patch.object(team, 'session_title', lambda rec: 'Fix the login flow'):
            self.call(team.runtime_state, task=None)
        self.assertEqual('Fix the login flow', team.chat_read(slug)[0]['name'])
        code, out = self.call(team.new_desk, name='Mine', repo=None)
        self.assertFalse(out['auto'])

    def test_appends_wait_for_the_rewrite_lock(self):
        import threading
        self.desk(name='x · Nov 4 18:02')
        with team.chat_lock('desk'):
            t = threading.Thread(target=lambda: team.chat_append('desk', {'kind': 'say', 'text': 'late'}))
            t.start(); t.join(0.2)
            self.assertTrue(t.is_alive())
        t.join(2)
        self.assertTrue(team.desk_autoname('desk', 'T'))
        self.assertEqual(['desk', 'say', 'say'], [r['kind'] for r in team.chat_read('desk')])
