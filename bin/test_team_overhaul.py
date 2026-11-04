"""Desk overhaul runtime: triage, timeline, review-send, contracts, merge gate, runner fallback,
turn snapshots. Real CLI functions, temp state dirs and fixture repos; no live terminal is touched."""
import contextlib
import copy
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
        self.roles = [{'id': 'cto', 'name': 'CTO', 'cli': 'claude', 'promptText': 'p'}]
        self.patches = [patch.object(team, 'CHAT', self.tmp.name), patch.object(team, 'ME', None),
                        patch.object(team, 'ACTIVITY', os.path.join(self.tmp.name, '.activity')),
                        patch.object(team, 'load_roles', lambda: copy.deepcopy(self.roles)),
                        patch.object(team, 'runtime_terminals', lambda: copy.deepcopy(self.info)),
                        patch.object(team, 'terminal', lambda a: copy.deepcopy(self.info.get(a, {}))),
                        patch.object(team, 'wake_queue', lambda: None),
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


if __name__ == '__main__':
    unittest.main()
