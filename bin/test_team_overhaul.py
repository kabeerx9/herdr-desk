"""Desk overhaul runtime: triage, timeline, review-send, contracts, merge gate, runner fallback,
turn snapshots. Real CLI functions, temp state dirs and fixture repos; no live terminal is touched."""
import contextlib
import copy
from datetime import datetime, timezone
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
loader = importlib.machinery.SourceFileLoader('desk_team_overhaul', os.path.join(os.path.dirname(__file__), 'team'))
spec = importlib.util.spec_from_loader(loader.name, loader)
team = importlib.util.module_from_spec(spec)
loader.exec_module(team)
import desk_runtime as rt
import desk_review
from test_desk_timeline import Transcript


def now():
    return int(time.time() * 1000)


def terminal(name='claude', state='idle', task='desk', role='cto', address='t1', **extra):
    return {'address': address, 'state': 'live', 'foreground': {'name': name, 'argv': [name], 'cwd': '/work'},
            'status': {'state': state, 'app': name}, 'cwd': '/work', 'turn': 3, 'status_ms': 1,
            'labels': {'task': task, 'role': role, 'herdr.space': 'space', 'herdr.tab': 'tab'}, **extra}


def git_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    for args in [('init', '-q'), ('config', 'user.email', 't@e.com'), ('config', 'user.name', 'T')]:
        subprocess.run(['git', *args], cwd=str(path), check=True, capture_output=True)
    (path / 'a.txt').write_text('a\n')
    subprocess.run(['git', 'add', '.'], cwd=str(path), check=True, capture_output=True)
    subprocess.run(['git', 'commit', '-qm', 'a'], cwd=str(path), check=True, capture_output=True)
    return subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=str(path), check=True, capture_output=True, text=True).stdout.strip()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.info = {'t1': terminal()}
        self.ended = {}
        self.roles = [{'id': 'cto', 'name': 'CTO', 'cli': 'claude', 'promptText': 'p'}]
        self.patches = [patch.object(team, 'CHAT', self.tmp.name), patch.object(team, 'ME', None),
                        patch.object(team, 'ACTIVITY', os.path.join(self.tmp.name, '.activity')),
                        patch.object(team, 'load_roles', lambda: copy.deepcopy(self.roles)),
                        patch.object(team, 'runtime_terminals', lambda: copy.deepcopy(self.info)),
                        patch.object(team, 'terminal', lambda a: copy.deepcopy(self.info.get(a, {}))),
                        patch.object(team, 'wake_queue', lambda: None),
                        patch.object(team, 'ended_terminals', lambda: copy.deepcopy(self.ended)),
                        patch.object(team, 'STARTUP_DIALOG_S', 0),
                        patch.object(team, 'unique_name', lambda name: name[:30]),
                        patch.object(team, 'rename_tab', lambda *a: True),
                        patch.dict(os.environ, {'TEAM_CLAUDE_PROJECTS': os.path.join(self.tmp.name, 'projects')})]
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in reversed(self.patches)])
        self.rec = team.runtime_record('t1', 'cto', 'desk', '/work', 'claude', 'conv-1')

    def call(self, fn, **kwargs):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                fn(types.SimpleNamespace(**kwargs))
            except SystemExit as exc:
                code = exc.code
        self.err = err.getvalue()
        return code, (json.loads(out.getvalue()) if out.getvalue().strip() else None)

    def state(self):
        return self.call(team.runtime_state, task=None)[1]['sessions'][0]

    def session(self):
        return team.runtime_store().load()['sessions'][0]


class TriageTests(Base):
    def test_settle_shows_in_state_and_clears_when_work_starts_after_it(self):
        code, out = self.call(team.runtime_triage, cmd='settle', address='t1')
        self.assertEqual(0, code)
        self.assertIsNotNone(self.state()['settled_at'])
        self.assertEqual(3, self.session()['settled_turn'])
        self.info['t1']['status'] = {'state': 'working', 'app': 'claude'}
        self.info['t1']['status_ms'] = now() + 5
        self.assertIsNone(self.state()['settled_at'])
        self.assertNotIn('settled_at', self.session())  # persisted, not just hidden

    def test_working_since_before_settling_doesnt_unsettle(self):
        self.info['t1']['status'] = {'state': 'working', 'app': 'claude'}
        self.call(team.runtime_triage, cmd='settle', address='t1')
        self.assertIsNotNone(self.state()['settled_at'])
        # A new turn (turn counter moved) brings it back even if status_ms is missing.
        self.info['t1'].pop('status_ms'); self.info['t1']['turn'] = 4
        self.assertIsNone(self.state()['settled_at'])

    def test_blocked_and_done_report_bring_it_back(self):
        self.call(team.runtime_triage, cmd='settle', address='t1')
        time.sleep(0.002)
        team.chat_append('desk', {'from': 'cto', 'address': 't1', 'kind': 'done', 'text': 'shipped'})
        self.assertIsNone(self.state()['settled_at'])
        self.call(team.runtime_triage, cmd='settle', address='t1')
        self.assertIsNotNone(self.state()['settled_at'])  # the earlier done doesn't count
        self.info['t1']['status'] = {'state': 'blocked', 'app': 'claude'}; self.info['t1']['status_ms'] = now() + 5
        self.assertIsNone(self.state()['settled_at'])

    def test_snooze_expires_and_rejects_the_past(self):
        code, _ = self.call(team.runtime_triage, cmd='snooze', address='t1', until_ms=now() - 1)
        self.assertNotEqual(0, code)
        self.assertNotIn('snoozed_until', self.session())
        self.call(team.runtime_triage, cmd='snooze', address='t1', until_ms=now() + 60_000)
        self.assertIsNotNone(self.state()['snoozed_until'])
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(snoozed_until=now() - 1))
        self.assertIsNone(self.state()['snoozed_until'])

    def test_unsettle_clears_both_and_unknown_address_fails(self):
        self.call(team.runtime_triage, cmd='settle', address='t1')
        self.call(team.runtime_triage, cmd='snooze', address='t1', until_ms=now() + 60_000)
        code, out = self.call(team.runtime_triage, cmd='unsettle', address='t1')
        self.assertEqual((None, None), (out['settled_at'], out['snoozed_until']))
        self.assertFalse({'settled_turn', 'snoozed_at'} & set(self.session()))
        with self.assertRaises(team.DeskRuntimeError):
            self.call(team.runtime_triage, cmd='settle', address='t9')

    def test_state_has_title_and_null_defaults(self):
        tr = Transcript(os.path.join(self.tmp.name, 'projects'))
        tr.add({'type': 'ai-title', 'aiTitle': 'Wire the gate'})
        view = self.state()
        self.assertEqual('Wire the gate', view['title'])
        self.assertEqual((None, None, None), (view['settled_at'], view['snoozed_until'], view['evidence']))


class TimelineCommandTests(Base):
    def test_claude_session_reads_its_transcript(self):
        tr = Transcript(os.path.join(self.tmp.name, 'projects'))
        tr.prompt()
        tr.tool('Bash', {'command': 'ls'})
        code, out = self.call(team.runtime_timeline, address='t1', since_ms=None)
        self.assertEqual(('t1', True, 'Ran 1 command'), (out['address'], out['supported'], out['tools']['summary']))

    def test_codex_and_missing_transcripts(self):
        code, out = self.call(team.runtime_timeline, address='t1', since_ms=None)
        self.assertTrue(out['supported']); self.assertIsNone(out['turn']); self.assertIn('reason', out)
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(cli='codex'))
        code, out = self.call(team.runtime_timeline, address='t1', since_ms=None)
        self.assertFalse(out['supported'])
        self.assertEqual([None] * 6, [out[k] for k in ('turn', 'thought', 'tools', 'subagents', 'context', 'title')])
        code, _ = self.call(team.runtime_timeline, address='nope', since_ms=None)
        self.assertEqual(1, code)


class ReviewSendTests(Base):
    def setUp(self):
        super().setUp()
        self.file = os.path.join(self.tmp.name, 'batch.md')
        Path(self.file).write_text('- `a.py:3` this breaks on empty input\n')
        self.labels = []
        self.sent = []

    def send(self, why=None):
        return [patch.object(team, 'expect_reply', side_effect=lambda a, w: self.labels.append(w) or True),
                patch.object(team, 'send_text', side_effect=lambda a, t: self.sent.append(t) or why),
                patch.object(team, 'sh', side_effect=lambda args, **k: self.labels.append(args) or subprocess.CompletedProcess(args, 0, '', ''))]

    def run_send(self, why=None):
        with contextlib.ExitStack() as stack:
            for p in self.send(why):
                stack.enter_context(p)
            return self.call(team.review_send, address='t1', file=self.file)

    def test_batch_is_prefixed_with_worktree_and_logged(self):
        code, out = self.run_send()
        self.assertEqual(0, code)
        self.assertEqual("Fix each comment, then run the checks.\nWorktree: /work\n\n- `a.py:3` this breaks on empty input", self.sent[0])
        self.assertTrue(os.path.exists(self.file))
        self.assertEqual('review', team.chat_read('desk')[-1]['kind'])

    def test_empty_batch_is_an_approval(self):
        Path(self.file).write_text('  \n')
        code, out = self.run_send()
        self.assertEqual(['Kabeer approved the changes.'], self.sent)
        self.assertTrue(out['approved'])

    def test_refuses_a_permission_prompt_and_keeps_the_file(self):
        self.info['t1']['status'] = {'state': 'blocked', 'app': 'claude'}
        code, _ = self.run_send()
        self.assertEqual(1, code); self.assertEqual([], self.sent)
        self.assertIn('permission', self.err); self.assertTrue(os.path.exists(self.file))

    def test_refuses_a_shell_and_oversized_batches(self):
        self.info['t1'] = terminal('zsh')
        self.assertEqual(1, self.run_send()[0])
        self.info['t1'] = terminal()
        Path(self.file).write_text('x' * (256 * 1024 + 1))
        self.assertEqual(1, self.run_send()[0])
        self.assertEqual([], self.sent)
        self.assertIn('256 KiB', self.err)

    def test_send_failure_exits_nonzero_keeps_file_and_releases_reply(self):
        code, _ = self.run_send(why='transport closed')
        self.assertEqual(1, code)
        self.assertTrue(os.path.exists(self.file))
        self.assertIn(['hc', 'label', 't1', 'awaiting='], self.labels)
        self.assertFalse([r for r in team.chat_read('desk') if r.get('kind') == 'review'])

    def test_missing_file_is_an_error(self):
        os.unlink(self.file)
        self.assertEqual(1, self.run_send()[0])


class ContractTests(unittest.TestCase):
    BRIEF = """# Deliver the gate

## Acceptance
- A1: rejects a stale review
- [ ] **A2** escalates after three rounds
- counts rounds per engineer

## Owns
- `bin/team`
- bin/desk_runtime.py

## Must run
- `python3 -m unittest`

## Notes
- not part of the contract
"""

    def test_brief_sections_parse(self):
        c = rt.parse_contract(self.BRIEF)
        self.assertEqual([('A1', 'rejects a stale review'), ('A2', 'escalates after three rounds'), ('A3', 'counts rounds per engineer')],
                         [(x['id'], x['text']) for x in c['acceptance']])
        self.assertEqual(['bin/team', 'bin/desk_runtime.py'], c['owns'])
        self.assertEqual(['python3 -m unittest'], c['must_run'])
        self.assertIsNone(rt.parse_contract('# Just prose\n\nNo sections.'))

    def test_duplicate_ids_get_fresh_ones(self):
        c = rt.parse_contract('## Acceptance\n- A1: x\n- A1: y\n')
        self.assertEqual(['A1', 'A2'], [x['id'] for x in c['acceptance']])

    def test_criteria_validation(self):
        c = rt.parse_contract(self.BRIEF)
        items = rt.parse_criteria('{"A1":"pass: test_stale","a2":"FAIL - not yet","A3":"n/a"}', c)
        self.assertEqual([('A1', 'pass', 'test_stale'), ('A2', 'fail', 'not yet'), ('A3', 'n/a', '')],
                         [(x['id'], x['result'], x['note']) for x in items])
        self.assertEqual('rejects a stale review', items[0]['text'])
        for bad in ('not json', '[]', '{}', '{"A1":"maybe"}', '{"A1":3}'):
            with self.assertRaises(rt.RuntimeError):
                rt.parse_criteria(bad, c)
        with self.assertRaisesRegex(rt.RuntimeError, 'missing: A3'):
            rt.parse_criteria('{"A1":"pass","A2":"pass"}', c)
        with self.assertRaisesRegex(rt.RuntimeError, "isn't in the brief"):
            rt.parse_criteria('{"A1":"pass","A2":"pass","A3":"pass","B9":"pass"}', c)
        self.assertEqual('B9', rt.parse_criteria('{"B9":"pass"}')[0]['id'])  # no contract: any ids


class ReportTests(Base):
    def setUp(self):
        super().setUp()
        self.info['t1'] = terminal(role='frontend')
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(role='frontend', contract=rt.parse_contract(ContractTests.BRIEF)))
        self.sends = []

    def report(self, kind='done', text='did it', **kw):
        def sh(args, **k):
            if args[:2] == ['hc', 'send']:
                self.sends.append(args[3])
            return subprocess.CompletedProcess(args, 0, '', '')
        args = dict(kind=kind, text=[text], criteria=None, evidence='asserted', blocking=None, head=None)
        args.update(kw)
        with patch.object(team, 'ME', 't1'), patch.object(team, 'need_core'), patch.object(team, 'sh', side_effect=sh), \
                patch.object(team, 'git_out', return_value='abc123def456'), patch.object(team, 'desk_members', return_value=[]):
            return self.call(team.report, **args)

    def test_done_without_criteria_is_refused_before_anything_is_recorded(self):
        code, _ = self.report()
        self.assertEqual(2, code)
        self.assertIn('A1', self.err)
        self.assertEqual([], team.chat_read('desk'))

    def test_criteria_and_evidence_land_on_chat_and_session(self):
        code, out = self.report(criteria='{"A1":"pass: t1","A2":"pass: t2","A3":"n/a"}', evidence='verified')
        self.assertEqual(0, code)
        msg = team.chat_read('desk')[-1]
        self.assertEqual(('verified', 'abc123def456'), (msg['evidence'], msg['head']))
        self.assertEqual(['A1', 'A2', 'A3'], [c['id'] for c in msg['criteria']])
        self.assertEqual('verified', self.session()['evidence'])
        self.assertEqual('verified', self.state()['evidence'])

    def test_evidence_defaults_to_asserted_and_updates_skip_criteria(self):
        team.runtime_store().mutate(lambda d: d['sessions'][0].pop('contract'))
        self.report()
        self.assertEqual('asserted', team.chat_read('desk')[-1]['evidence'])
        self.report(kind='update', text='halfway')
        self.assertNotIn('evidence', team.chat_read('desk')[-1])

    def test_reviewer_must_state_blocking_findings(self):
        self.info['t1'] = terminal(role='reviewer')
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(role='reviewer', contract=None))
        self.assertEqual(2, self.report()[0])
        self.assertEqual(2, self.report(blocking=-1)[0])
        code, _ = self.report(blocking=0)
        self.assertEqual(0, code)
        self.assertEqual(0, team.chat_read('desk')[-1]['blocking'])


class GateTests(unittest.TestCase):
    ENG = {'address': 'e1', 'role': 'frontend', 'task': 'desk', 'cwd': '/wt', 'cli': 'claude'}

    def reviewer(self, address='r1', cli='codex', **extra):
        return {'address': address, 'role': 'reviewer', 'task': 'desk', 'cwd': '/wt', 'cli': cli, 'parent': 'e1', **extra}

    def done(self, address='r1', head='h2', blocking=0, at=1):
        return {'kind': 'done', 'task': 'desk', 'address': address, 'head': head, 'blocking': blocking, 'at': at, 'text': 'ok'}

    def verdict(self, sessions, chats, head='h2', dirty=False):
        return rt.gate_verdict(self.ENG, [self.ENG] + sessions, chats, head, dirty)

    def test_rounds_restart_after_a_clean_review(self):
        chats = [self.done(head='a', blocking=3, at=1), self.done(head='b', blocking=0, at=2),
                 self.done(head='c', blocking=2, at=3), self.done(head='d', blocking=1, at=4)]
        v = self.verdict([self.reviewer()], chats, head='e')
        self.assertEqual(('fail', 2), (v['verdict'], v['rounds']))

    def test_no_review_fails(self):
        v = self.verdict([], [])
        self.assertEqual(('fail', 0), (v['verdict'], v['rounds']))
        self.assertIn('no Reviewer', v['reasons'][0])

    def test_clean_review_on_another_cli_for_head_passes(self):
        v = self.verdict([self.reviewer()], [self.done()])
        self.assertEqual(('pass', []), (v['verdict'], v['reasons']))

    def test_same_cli_stale_head_blocking_and_dirty_fail(self):
        self.assertIn("engineer's own CLI", ' '.join(self.verdict([self.reviewer(cli='claude')], [self.done()])['reasons']))
        self.assertIn('branch is at h2', ' '.join(self.verdict([self.reviewer()], [self.done(head='h1')])['reasons']))
        self.assertIn('2 blocking findings', ' '.join(self.verdict([self.reviewer()], [self.done(blocking=2)])['reasons']))
        self.assertIn("didn't state", ' '.join(self.verdict([self.reviewer()], [self.done(blocking=None)])['reasons']))
        self.assertIn('uncommitted', ' '.join(self.verdict([self.reviewer()], [self.done()], dirty=True)['reasons']))

    def test_other_engineers_reviews_and_non_reviewers_dont_count(self):
        other = self.reviewer(address='r2', parent='e9', cwd='/elsewhere')
        qa = {**self.reviewer(address='q1'), 'role': 'qa'}
        v = self.verdict([other, qa], [self.done('r2'), self.done('q1')])
        self.assertEqual(0, v['rounds'])

    def test_clean_review_for_head_wins_over_a_later_same_cli_one(self):
        v = self.verdict([self.reviewer(), self.reviewer('r2', cli='claude')], [self.done(at=1), self.done('r2', at=2)])
        self.assertEqual('pass', v['verdict'])

    def test_three_rounds_without_a_clean_review_escalate(self):
        chats = [self.done(head='h0', blocking=1, at=1), self.done(head='h1', blocking=1, at=2), self.done(head='h2', blocking=1, at=3)]
        v = self.verdict([self.reviewer()], chats)
        self.assertEqual(('escalate', 3), (v['verdict'], v['rounds']))
        self.assertIn('ask Kabeer', v['reasons'][-1])
        chats[-1]['blocking'] = 0
        self.assertEqual('pass', self.verdict([self.reviewer()], chats)['verdict'])  # the third round came back clean

    def test_runner_pinned_cli_is_the_one_compared(self):
        eng = {**self.ENG, 'role_config': {'cli': 'codex'}}
        v = rt.gate_verdict(eng, [eng, self.reviewer()], [self.done()], 'h2')
        self.assertIn("engineer's own CLI", ' '.join(v['reasons']))



class ParallelWorkerTests(unittest.TestCase):
    def test_codex_auto_mode_keeps_the_sandbox(self):
        argv = team.argv_for({'cli': 'codex', 'promptText': '', 'permission_mode': 'auto'}, '')
        self.assertIn('--approve-for-me', argv)
        self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', argv)
        self.assertNotIn('--approve-for-me', team.argv_for({'cli': 'codex', 'promptText': ''}, ''))

    def test_every_claude_engineer_launches_with_skills(self):
        roles = [r for r in team.load_roles() if r.get('cli') == 'claude' and r['id'] != 'cto']
        self.assertEqual({'frontend', 'backend', 'worker', 'qa'}, {r['id'] for r in roles})
        for role in roles:
            self.assertIn('Skill', team.argv_for({**role, 'promptText': ''}, '')[2].split(','), role['id'])

    def test_claude_roles_launch_without_prompt_suggestions(self):
        argv = team.argv_for({'cli': 'claude', 'promptText': ''}, '')
        settings = json.loads(argv[argv.index('--settings') + 1])
        self.assertEqual('false', settings['env']['CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION'])

    def test_cto_launches_as_a_full_claude_code_session(self):
        cto = next(r for r in team.load_roles() if r['id'] == 'cto')
        argv = team.argv_for({**cto, 'promptText': ''}, '')
        self.assertNotIn('--tools', argv)
        self.assertNotIn('--strict-mcp-config', argv)

    def test_claude_roles_run_commands_in_bash(self):
        argv = team.argv_for({'cli': 'claude', 'promptText': ''}, '')
        settings = json.loads(argv[argv.index('--settings') + 1])
        self.assertEqual('/bin/bash', settings['env']['CLAUDE_CODE_SHELL'])

    def test_two_copies_of_a_role_started_in_one_second_get_different_branches(self):
        with mock.patch.object(team, 'sh'), mock.patch.object(team.time, 'strftime', return_value='1105-101010'):
            first = team.add_worktree({'name': 'r', 'top': '/r'}, {'id': 'worker'})
            second = team.add_worktree({'name': 'r', 'top': '/r'}, {'id': 'worker'})
        self.assertNotEqual(first, second)
        self.assertTrue(first[1].startswith('team/worker-1105-101010-'))


class GateCommandTests(Base):
    def test_gate_reads_the_worktree_head_and_exits_by_verdict(self):
        repo = Path(self.tmp.name) / 'wt'
        head = git_repo(repo)
        team.runtime_store().mutate(lambda d: d['sessions'][0].update(role='frontend', cwd=str(repo)))
        team.runtime_record('r1', 'reviewer', 'desk', str(repo), 'codex', None, parent='t1')
        code, out = self.call(team.runtime_gate, address='t1')
        self.assertEqual((1, 'fail'), (code, out['verdict']))
        team.chat_append('desk', {'from': 'reviewer', 'address': 'r1', 'kind': 'done', 'head': head, 'blocking': 0, 'text': 'clean'})
        code, out = self.call(team.runtime_gate, address='t1')
        self.assertEqual((0, 'pass', head), (code, out['verdict'], out['head']))
        self.call(team.runtime_gate, address='t1')
        gates = [c['text'] for c in team.chat_read('desk') if c.get('kind') == 'gate']
        self.assertEqual(2, len(gates), 'one line per result, none for a repeat')
        self.assertIn('passed', gates[-1])
        (repo / 'a.txt').write_text('edited\n')
        code, out = self.call(team.runtime_gate, address='t1')
        self.assertEqual(1, code)
        self.assertIn('uncommitted', ' '.join(out['reasons']))


class RunnerTests(Base):
    def test_variants_pin_each_runner_and_single_roles_are_unchanged(self):
        role = {'id': 'fe', 'cli': 'claude', 'model': 'm0', 'runners': [{'cli': 'claude', 'model': 'm1', 'effort': 'high'}, {'cli': 'codex', 'model': 'm2'}, 'junk']}
        variants = rt.runner_variants(role)
        self.assertEqual([('claude', 'm1', 'high', 0), ('codex', 'm2', None, 1)], [(v['cli'], v['model'], v['effort'], v['runner']['index']) for v in variants])
        self.assertTrue(all('runners' not in v for v in variants))
        plain = {'id': 'x', 'cli': 'claude'}
        self.assertEqual([plain], rt.runner_variants(plain))

    def test_failure_classification_ignores_the_task_text(self):
        self.assertEqual('usage_limit', rt.classify_launch_failure("Claude AI usage limit reached|1730000000"))
        self.assertEqual('usage_limit', rt.classify_launch_failure("■ You've hit your usage limit. Try again at 3pm"))
        self.assertEqual('auth', rt.classify_launch_failure("Invalid API key · Please run /login"))
        task = 'Fix the banner that says usage limit reached when it is not'
        self.assertIsNone(rt.classify_launch_failure('> ' + task + '\n  Reading files…', task))
        self.assertIsNone(rt.classify_launch_failure('Welcome to Claude Code'))

    def launch(self, screens, exit_state=None):
        """team start for a role with two runners; screens maps an address to what hc read shows."""
        self.roles = [{'id': 'frontend', 'name': 'Frontend', 'cli': 'claude', 'promptText': '', 'tools': ['Read'],
                       'runners': [{'cli': 'claude', 'model': 'opus'}, {'cli': 'codex', 'model': 'gpt'}]}]
        launches, killed = [], []
        def sh(args, cwd=None, check=False):
            if args[:2] == ['hc', 'run']:
                address = 't%d' % (len(launches) + 2)
                launches.append(args)
                self.info[address] = terminal(address=address, role='frontend')
                if exit_state:
                    self.info[address]['state'] = exit_state
                return subprocess.CompletedProcess(args, 0, json.dumps({'address': address}), '')
            if args[:2] == ['hc', 'read']:
                return subprocess.CompletedProcess(args, 0, screens.get(args[-1], ''), '')
            if args[:2] in (['hc', 'kill'], ['hc', 'rm']):
                killed.append(args)
            return subprocess.CompletedProcess(args, 0, '{}', '')
        args = dict(role='frontend', repo=self.tmp.name, brief=None, task='Build it', slug='desk', parent=None, no_parent=True,
                    space=None, requested=True, by='desk', share=True, tab=None, fresh_of=None, note=None, display_task=None)
        with patch.object(team, 'need_core'), patch.object(team, 'repo_of', return_value=None), patch.object(team, 'sh', side_effect=sh), \
                patch.object(team, 'RUNNER_WATCH', 0):
            code, out = self.call(team.start, **args)
        return code, out, launches, killed

    def test_usage_limit_falls_back_and_pins_the_next_runner(self):
        code, out, launches, killed = self.launch({'t2': 'Claude AI usage limit reached|1730000000'})
        self.assertEqual(2, len(launches))
        self.assertEqual('claude', launches[0][launches[0].index('team-role') + 1])
        self.assertEqual('codex', launches[1][launches[1].index('team-role') + 1])
        self.assertEqual([['hc', 'kill', 't2'], ['hc', 'rm', 't2']], killed)
        self.assertEqual(('t3', 'codex', 1), (out['address'], out['runner']['cli'], out['runner']['index']))
        rec = next(s for s in team.runtime_store().load()['sessions'] if s['address'] == 't3')
        self.assertEqual(('codex', 'codex'), (rec['cli'], rec['role_config']['cli']))
        self.assertNotIn('runners', rec['role_config'])
        self.assertFalse(any(s['address'] == 't2' for s in team.runtime_store().load()['sessions']))
        self.assertIn('usage limit', team.chat_read('desk')[-1]['text'])

    def test_a_healthy_first_runner_or_another_crash_does_not_fall_back(self):
        code, out, launches, killed = self.launch({'t2': 'Welcome back'})
        self.assertEqual((1, [], 'claude'), (len(launches), killed, out['runner']['cli']))
        self.info = {'t1': terminal()}
        code, out, launches, killed = self.launch({'t2': 'segfault'}, exit_state='finished')
        self.assertEqual((1, []), (len(launches), killed))

    def test_every_runner_failing_leaves_the_last_one_and_says_so(self):
        code, out, launches, killed = self.launch({'t2': 'usage limit reached', 't3': 'Please run /login'})
        self.assertEqual((2, 't3'), (len(launches), out['address']))
        self.assertIn('every runner failed (auth)', out['note'])


class FinalReplyHookTests(unittest.TestCase):
    """A hand post stands in for the final message only when nothing happened after it."""
    START = 1_793_990_000_000

    def iso(self, ms):
        return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'

    def stop(self, posts, tools, awaiting='chat', transcript=True):
        """Run the Stop hook for a CTO turn. Times are ms after the turn began. Returns what it posted."""
        lines = [{'type': 'user', 'timestamp': self.iso(self.START), 'message': {'content': 'go'}}]
        lines += [{'type': 'assistant', 'timestamp': self.iso(self.START + at),
                   'message': {'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {}}]}} for at in tools]
        rows = [{'address': 't1', 'kind': 'say', 'at': self.START + at} for at in posts]
        info = {'labels': {'task': 'desk', 'role': 'cto', 'awaiting': f'{awaiting}:{self.START}' if awaiting else ''}}
        with tempfile.NamedTemporaryFile('w', suffix='.jsonl') as f:
            f.write('\n'.join(json.dumps(x) for x in lines))
            f.flush()
            payload = {'last_assistant_message': 'The answer.', **({'transcript_path': f.name} if transcript else {})}
            with patch.object(team, 'ME', 't1'), patch.object(team, 'terminal', return_value=info), \
                    patch.object(team, 'sh'), patch.object(team, 'wake_queue'), patch.object(team, 'clear_activity'), \
                    patch.object(team, 'runtime_record'), patch.object(team.subprocess, 'Popen'), \
                    patch.object(team, 'chat_read', return_value=rows), patch.object(team, 'chat_append') as append, \
                    patch.object(team.sys, 'stdin', io.StringIO(json.dumps(payload))):
                team.hook(types.SimpleNamespace(cli='claude', payload=[]))
        return [c.args[1]['text'] for c in append.call_args_list]

    def test_a_plan_posted_before_the_work_does_not_swallow_the_answer(self):
        self.assertEqual(['The answer.'], self.stop(posts=[2000], tools=[1000, 5000, 9000]))

    def test_the_same_holds_for_a_turn_a_report_started(self):
        self.assertEqual(['The answer.'], self.stop(posts=[2000], tools=[1000, 5000], awaiting=None))

    def test_a_report_posted_as_the_last_step_is_not_repeated(self):
        self.assertEqual([], self.stop(posts=[2000, 9500], tools=[1000, 9000]))
        self.assertEqual([], self.stop(posts=[9500], tools=[9000], awaiting=None))

    def test_a_turn_with_no_hand_post_still_posts(self):
        self.assertEqual(['The answer.'], self.stop(posts=[], tools=[1000]))

    def test_without_a_transcript_any_hand_post_counts(self):
        self.assertEqual([], self.stop(posts=[2000], tools=[], transcript=False))


class TurnSnapshotHookTests(Base):
    def test_prompt_hook_snapshots_quietly_and_first_tool_only_once_per_turn(self):
        repo = Path(self.tmp.name) / 'repo'
        git_repo(repo)
        (repo / 'a.txt').write_text('mid-work\n')
        index = (repo / '.git' / 'index').read_bytes()
        out = io.StringIO()
        with patch.object(team, 'ME', 't1'), patch.object(team.sys, 'stdin', io.StringIO(json.dumps({'cwd': str(repo)}))), contextlib.redirect_stdout(out):
            team.hook(types.SimpleNamespace(cli='claude-prompt', payload=[]))
        self.assertEqual('', out.getvalue())
        self.assertEqual(index, (repo / '.git' / 'index').read_bytes())
        self.assertEqual([], desk_review.review(str(repo), 'turn')['files'])
        (repo / 'a.txt').write_text('changed by a tool\n')
        with patch.object(team, 'ME', 't1'), patch.object(team.sys, 'stdin', io.StringIO(json.dumps({'cwd': str(repo), 'tool_name': 'Edit', 'tool_input': {}}))):
            team.hook(types.SimpleNamespace(cli='claude-tool', payload=[]))
        self.assertEqual(['a.txt'], [f['path'] for f in desk_review.review(str(repo), 'turn')['files']])  # no re-snapshot mid-turn
        team.clear_activity('t1')  # the Stop hook: next turn's first tool snapshots again
        with patch.object(team, 'ME', 't1'), patch.object(team.sys, 'stdin', io.StringIO(json.dumps({'cwd': str(repo), 'tool_name': 'Read', 'tool_input': {}}))):
            team.hook(types.SimpleNamespace(cli='claude-tool', payload=[]))
        self.assertEqual([], desk_review.review(str(repo), 'turn')['files'])

    def test_non_git_folder_is_ignored_and_claude_launch_has_the_hook(self):
        with patch.object(team, 'ME', 't1'), patch.object(team.sys, 'stdin', io.StringIO(json.dumps({'cwd': self.tmp.name}))):
            team.hook(types.SimpleNamespace(cli='claude-prompt', payload=[]))
        argv = team.argv_for({'id': 'cto', 'cli': 'claude', 'promptText': ''}, '')
        settings = json.loads(argv[argv.index('--settings') + 1])
        self.assertIn('claude-prompt', settings['hooks']['UserPromptSubmit'][0]['hooks'][0]['command'])


class Attachments(unittest.TestCase):
    """Files from the Desk's composer: kept beside the chat, sent to agents as paths."""
    def setUp(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        self.dir = d.name
        p = patch.object(team, 'ATTACHMENTS', os.path.join(d.name, 'att')); p.start(); self.addCleanup(p.stop)

    def source(self, name, size=4):
        path = os.path.join(self.dir, name)
        with open(path, 'wb') as f:
            f.write(b'x' * size)
        return path

    def test_keeps_a_copy_and_names_its_kind(self):
        png, pdf = team.keep_attachment('Desk 1', self.source('a.PNG')), team.keep_attachment('Desk 1', self.source('b c.pdf'))
        self.assertEqual(('image', 'file'), (png['kind'], pdf['kind']))
        self.assertEqual('b c.pdf', pdf['name'])
        self.assertTrue(team.inside(pdf['path'], team.ATTACHMENTS) and os.path.isfile(pdf['path']))

    def test_refuses_a_folder_a_missing_file_and_a_huge_one(self):
        self.assertIsInstance(team.keep_attachment('d', self.dir), str)
        self.assertIsInstance(team.keep_attachment('d', self.dir + '/nope'), str)
        with patch.object(team, 'ATTACH_MAX', 2):
            self.assertIn('over', team.keep_attachment('d', self.source('big.bin')))

    def test_a_name_cant_leave_the_desk_folder(self):
        kept = team.keep_attachment('../../x', self.source('a.txt'), name='../../evil.txt')
        self.assertTrue(team.inside(kept['path'], team.ATTACHMENTS))
        self.assertNotIn('/', kept['name'])

    def test_note_lists_paths_and_empty_adds_nothing(self):
        self.assertEqual('', team.attachment_note([]))
        self.assertIn('- /a/b.png', team.attachment_note([{'path': '/a/b.png'}]))

    def test_post_refuses_a_path_outside_the_attachments_folder(self):
        args = types.SimpleNamespace(task='s', to=['t1:cto'], text=['hi'], attach=['/etc/passwd'], raw=False)
        with self.assertRaises(SystemExit):
            team.post(args)

    def test_claude_launch_can_read_attachments_and_the_task_stays_positional(self):
        argv = team.argv_for({'cli': 'claude', 'promptText': ''}, 'do it')
        i = argv.index('--add-dir')
        self.assertTrue(argv[i + 2].startswith('--'))
        self.assertEqual('do it', argv[-1])


class Closing(Base):
    """Closing an agent on purpose must never read as losing it."""
    def setUp(self):
        super().setUp()
        self.order = []
        self.real_sh = team.sh
        def sh(argv, **kw):
            if argv[:2] == ['hc', 'kill']:
                self.order.append(('kill', team.session_by_address(team.runtime_store().load(), argv[2]).get('finished')))
                self.info['t1'] = {'state': 'finished', 'reason': 'killed'}
                return types.SimpleNamespace(returncode=0, stdout='', stderr='')
            return self.real_sh(argv, **kw) if argv[0] == 'git' else types.SimpleNamespace(returncode=0, stdout='', stderr='')
        for p in (patch.object(team, 'sh', sh), patch.object(team, 'need_core', lambda: None), patch.object(team.time, 'sleep', lambda _s: None)):
            p.start(); self.addCleanup(p.stop)

    def chat(self):
        return team.chat_read('desk')

    def test_close_marks_it_finished_before_ending_it(self):
        code, out = self.call(team.close, address='t1', force=False)
        self.assertEqual((0, True), (code, out['closed']))
        self.assertEqual([('kill', True)], self.order)
        self.assertEqual('finished', self.state()['state'])
        self.assertEqual('finish', self.chat()[-1]['kind'])

    def test_close_keeps_uncommitted_files_and_says_so(self):
        repo = Path(self.tmp.name) / 'repo'
        git_repo(repo)
        (repo / 'left.txt').write_text('unsaved\n')
        self.info['t1'].update(cwd=str(repo), foreground={'cwd': str(repo)})
        code, out = self.call(team.close, address='t1', force=False)
        self.assertEqual((0, True, 1), (code, out['closed'], len(self.order)))
        self.assertTrue((repo / 'left.txt').exists())
        self.assertIn('1 uncommitted', self.chat()[-1]['text'])

    def test_close_waits_for_a_working_agent_unless_forced(self):
        self.info['t1']['status'] = {'state': 'working'}
        self.assertFalse(self.call(team.close, address='t1', force=False)[1]['closed'])
        self.assertEqual([], self.order)
        self.assertTrue(self.call(team.close, address='t1', force=True)[1]['closed'])
        self.assertEqual(1, len(self.order))

    def test_close_clears_an_agent_already_gone_without_a_chat_line(self):
        self.info['t1'] = {'state': 'finished', 'reason': 'killed'}
        self.assertTrue(self.call(team.close, address='t1', force=False)[1]['closed'])
        self.assertEqual(([], []), (self.order, self.chat()))
        self.assertTrue(self.session()['finished'])

    def test_finish_also_marks_before_ending(self):
        self.info['t1'].update(cwd=self.tmp.name, foreground={'cwd': self.tmp.name})
        self.call(team.finish, address='t1', keep_open=False, keep_worktree=True, force=False)
        self.assertEqual([('kill', True)], self.order)

    def wrap(self, status='idle', me=None):
        repo = Path(self.tmp.name) / 'shared'
        git_repo(repo)
        (repo / 'a.txt').write_text('Kabeer was editing this\n')
        self.info['t1'].update(cwd=str(repo), foreground={'cwd': str(repo)}, status={'state': status})
        self.info['t1']['labels'] = {**self.info['t1']['labels'], 'role': 'worker'}
        with patch.object(team, 'ME', me):
            self.call(team.finish, address='t1', keep_open=False, keep_worktree=False, force=False)
        return repo

    def test_dirty_files_in_the_main_checkout_never_block_a_wrap_up(self):
        repo = self.wrap()
        self.assertEqual([('kill', True)], self.order)
        self.assertEqual('finish', self.chat()[-1]['kind'])
        self.assertIn('1 uncommitted or untracked file (left as is)', self.chat()[-1]['text'])
        self.assertEqual('Kabeer was editing this\n', (repo / 'a.txt').read_text())

    def test_an_agent_wrapping_itself_up_is_not_refused_for_working(self):
        self.wrap(status='working', me='t1')
        self.assertEqual([('kill', True)], self.order)

    def test_the_desk_still_waits_for_a_working_agent(self):
        self.wrap(status='working')
        self.assertEqual([], self.order)
        self.assertIn('Still working', self.chat()[-1]['text'])

    def test_state_sees_a_raw_kill_after_done(self):
        team.runtime_store().mutate(lambda d: team.session_by_address(d, 't1').update(evidence_at=5))
        del self.info['t1']
        self.ended['t1'] = {'state': 'finished', 'reason': 'killed'}
        self.assertEqual('finished', self.state()['state'])

    def test_a_new_prompt_after_done_is_recorded_once(self):
        def prompt():
            with patch.object(team, 'ME', 't1'), patch.object(team.sys, 'stdin', io.StringIO('{}')):
                team.prompt_hook()
        prompt()
        self.assertIsNone(self.session().get('prompt_at'))
        team.runtime_store().mutate(lambda d: team.session_by_address(d, 't1').update(evidence_at=5))
        prompt()
        first = self.session()['prompt_at']
        self.assertGreater(first, 5)
        prompt()
        self.assertEqual(first, self.session()['prompt_at'])

    def test_the_cto_is_told_to_close_and_not_to_kill(self):
        text = Path(os.path.dirname(__file__)).parent.joinpath('mods/desk/roles/cto.md').read_text()
        self.assertIn('team close --address', text)
        self.assertIn('Never use `hc kill`', text)


class NearestBase(unittest.TestCase):
    def out(self, counts):
        def run(*args):
            if args[0] == 'symbolic-ref':
                return 'origin/main'
            return counts.get(args[-1].split('..')[0])
        return run

    def test_a_branch_cut_from_dev_compares_with_dev(self):
        self.assertEqual('origin/dev', rt.nearest_base(self.out({'origin/main': '106', 'origin/dev': '1'}), 'team/x'))

    def test_a_tie_goes_to_the_default_branch(self):
        self.assertEqual('origin/main', rt.nearest_base(self.out({'origin/main': '2', 'origin/dev': '2'}), 'team/x'))

    def test_a_missing_ref_is_skipped_and_nothing_gives_none(self):
        self.assertEqual('origin/main', rt.nearest_base(self.out({'origin/main': '3'}), 'team/x'))
        self.assertIsNone(rt.nearest_base(self.out({}), 'team/x'))

    def test_dev_is_not_its_own_base(self):
        self.assertEqual('origin/main', rt.nearest_base(self.out({'origin/main': '5', 'origin/dev': '0'}), 'dev'))


class HookReplies(unittest.TestCase):
    """What the hooks print back to Claude, and what they read from Claude's and Codex's payloads."""

    def setUp(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        for p in (patch.object(team, 'CHAT', d.name), patch.object(team, 'PERMITS', os.path.join(d.name, '.permits')),
                  patch.object(team, 'ME', 't1'), patch.object(team, 'watch_permit', lambda *a: None),
                  patch.object(team, 'terminal', lambda t: {'labels': {'task': 's', 'role': 'cto'}})):
            p.start(); self.addCleanup(p.stop)
        os.makedirs(team.PERMITS)

    def permit(self, got, suggestions=None):
        payload = {'tool_name': 'Bash', 'tool_input': {'command': 'ls'}, **({'permission_suggestions': suggestions} if suggestions else {})}
        out = io.StringIO()
        with patch.object(team, 'await_permit', return_value=got), patch.object(team.sys, 'stdin', io.StringIO(json.dumps(payload))), \
                contextlib.redirect_stdout(out):
            team.hook(types.SimpleNamespace(cli='claude-permission', payload=[]))
        return json.loads(out.getvalue()) if out.getvalue().strip() else None

    def test_allow_always_and_deny_replies(self):
        rule = [{'type': 'addRules', 'rules': [{'toolName': 'Bash'}]}]
        reply = lambda d: {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': d}}
        self.assertEqual(reply({'behavior': 'allow'}), self.permit({'decision': 'allow'}, rule))
        self.assertEqual(reply({'behavior': 'allow', 'updatedPermissions': rule}), self.permit({'decision': 'always'}, rule))
        self.assertEqual(reply({'behavior': 'allow'}), self.permit({'decision': 'always'}))
        self.assertEqual(reply({'behavior': 'deny', 'message': 'Kabeer said no from the desk chat: not now'}),
                         self.permit({'decision': 'deny', 'message': 'not now'}))
        self.assertTrue(self.permit({'decision': 'deny'})['hookSpecificOutput']['decision']['message'].startswith("Kabeer said no from the desk chat. Don't retry"))

    def test_no_answer_prints_nothing_so_claude_asks_in_its_terminal(self):
        self.assertIsNone(self.permit(None))
        self.assertEqual(['permission', 'permission-done'], [r['kind'] for r in team.chat_read('s')])
        self.assertEqual('Bash', team.chat_read('s')[0]['tool'])

    def codex(self, payload):
        with patch.object(team, 'chain_codex_notify'), patch.object(team, 'wake_queue'), \
                patch.object(team, 'clear_activity') as cleared, patch.object(team, 'sh'), \
                patch.object(team, 'terminal', return_value={'labels': {'task': 's', 'role': 'eng', 'awaiting': 'chat:1'}}), \
                patch.object(team, 'chat_append') as append:
            team.hook(types.SimpleNamespace(cli='codex', payload=['ignored', json.dumps(payload)]))
        return cleared.called, [c.args[1].get('text') for c in append.call_args_list]

    def test_codex_turn_complete_posts_its_last_message(self):
        cleared, posted = self.codex({'type': 'agent-turn-complete', 'last-assistant-message': 'Done it.'})
        self.assertTrue(cleared); self.assertIn('Done it.', posted)

    def test_codex_other_notifications_are_ignored(self):
        self.assertEqual((False, []), self.codex({'type': 'approval-requested'}))


class QuestionCards(unittest.TestCase):
    """AskUserQuestion in the desk chat: the hook's card, team choose, and how a wait ends."""
    QUESTION = {'question': 'Which?', 'header': 'Pick', 'multiSelect': False, 'options': [{'label': 'Red', 'description': 'r'}, {'label': 'Blue', 'description': 'b'}]}

    def setUp(self):
        d = tempfile.TemporaryDirectory(); self.addCleanup(d.cleanup)
        for p in (patch.object(team, 'CHAT', d.name), patch.object(team, 'PERMITS', os.path.join(d.name, '.permits')),
                  patch.object(team, 'ME', 't1'), patch.object(team, 'watch_permit', lambda *a: None),
                  patch.object(team, 'terminal', lambda t: {'status': {'state': 'blocked'}})):
            p.start(); self.addCleanup(p.stop)
        os.makedirs(team.PERMITS)

    def asked(self, wait=2, answer=None):
        payload = {'tool_name': 'AskUserQuestion', 'tool_input': {'questions': [self.QUESTION], 'metadata': {'source': 'x'}}}
        def fake_write():
            import threading
            def go():
                for _ in range(100):
                    rec = next((r for r in team.chat_read('s') if r.get('kind') == 'question'), None)
                    if rec:
                        team.choose(types.SimpleNamespace(task='s', id=rec['id'], answers=json.dumps(answer))); return
                    time.sleep(0.02)
            threading.Thread(target=go, daemon=True).start()
        if answer: fake_write()
        out = io.StringIO()
        with patch.object(team, 'QUESTION_WAIT', wait), contextlib.redirect_stdout(out):
            team.ask_question(payload['tool_input'], 's', 'cto')
        return json.loads(out.getvalue())['hookSpecificOutput']['decision']

    def test_answer_goes_back_as_the_tools_own_input(self):
        got = self.asked(answer={'Which?': 'Blue'})
        self.assertEqual('allow', got['behavior'])
        self.assertEqual({'Which?': 'Blue'}, got['updatedInput']['answers'])
        self.assertEqual([self.QUESTION], got['updatedInput']['questions'])
        self.assertEqual({'source': 'x'}, got['updatedInput']['metadata'])
        done = [r for r in team.chat_read('s') if r.get('kind') == 'permission-done']
        self.assertEqual(['answered'], [r['decision'] for r in done])

    def test_no_answer_in_time_denies_instead_of_stalling_in_the_terminal(self):
        got = self.asked(wait=0.1)
        self.assertEqual('deny', got['behavior'])
        self.assertEqual('expired', team.chat_read('s')[-1]['decision'])

    def test_choose_refuses_a_partial_answer_and_a_finished_question(self):
        team.chat_append('s', {'kind': 'question', 'id': 'aaaa0000', 'questions': [self.QUESTION]})
        for bad in ('{}', '{"Which?":" "}', '{"Which?":"Red","Other?":"x"}', 'nope'):
            with self.assertRaises(SystemExit):
                team.choose(types.SimpleNamespace(task='s', id='aaaa0000', answers=bad))
        self.assertEqual([], os.listdir(team.PERMITS))
        team.chat_append('s', {'kind': 'permission-done', 're': 'aaaa0000', 'decision': 'expired'})
        with self.assertRaises(SystemExit):
            team.choose(types.SimpleNamespace(task='s', id='aaaa0000', answers='{"Which?":"Red"}'))

    def test_only_the_cto_can_call_the_tool(self):
        for role in team.load_roles():
            if role.get('cli') == 'claude' and role['id'] != 'cto':
                self.assertNotIn('AskUserQuestion', role['tools'])


if __name__ == '__main__':
    unittest.main()
