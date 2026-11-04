import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, windowStart, summarizeSteps, summarizeCounts, thoughtLine, parseTimeline, splitPoll, SPLIT, subagentHeader,
  contextMeter, snapshotFor, statusLines, rowOffsets, activePrompt, span } from './model.js';

const thread = [
  { at: 0, from: 'kabeer', kind: 'desk', name: 'x' },
  { at: 10, from: 'kabeer', kind: 'start', role: 'cto' },
  { at: 20, from: 'kabeer', kind: 'start', role: 'frontend' },
  { at: 1000, from: 'kabeer', kind: 'say', to: ['cto'], text: 'build it' },
  { at: 61000, from: 'cto', address: 't1', kind: 'say', text: 'on it' },
  { at: 62000, from: 'cto', address: 't1', kind: 'say', text: 'more' },
  { at: 70000, id: 'p1', from: 'cto', address: 't1', kind: 'permission', tool: 'Bash', detail: 'git push' },
  { at: 71000, from: 'cto', kind: 'permission-done', re: 'p1', decision: 'allow' },
  { at: 80000, from: 'kabeer', kind: 'say', to: ['cto', 'frontend'], text: 'next' },
  { at: 213000, from: 'cto', address: 't1', kind: 'done', text: 'shipped' },
];

test('rows merge start events, span turns, group runs, and list prompts', () => {
  const { rows, prompts, permitDone, lastReply, open, said } = buildRows(thread);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[1].m.roles, ['cto', 'frontend']);
  assert.equal(rows[3].worked, 60000); assert.equal(rows[3].turnStart, 1000);
  assert.equal(rows[4].grouped, true); assert.equal(rows[4].worked, null);
  assert.equal(rows[7].worked, 133000); assert.equal(span(rows[7].worked), '2m 13s');
  assert.equal(rows[7].grouped, false, 'reports always get a name row');
  assert.equal(permitDone.get('p1'), 'allow');
  assert.deepEqual(prompts.map((p) => p.text), ['build it', 'next']);
  assert.equal(lastReply, 7); assert.equal(open.frontend, 80000); assert.equal(said, true);
});

test('unchanged rows are the same objects across reloads; edited ones are rebuilt', () => {
  const cache = new Map();
  const a = buildRows(thread, cache).rows;
  const b = buildRows(thread, cache).rows;
  assert.ok(a.every((r, i) => r === b[i]));
  const edited = thread.map((m) => (m.text === 'on it' ? { ...m, text: 'on it now' } : m));
  const c = buildRows(edited, cache).rows;
  assert.notEqual(c[3], a[3]); assert.equal(c[2], a[2]);
});

test('an empty or event-only thread has nothing said', () => {
  assert.equal(buildRows([]).said, false);
  assert.equal(buildRows(thread.slice(0, 3)).said, false);
});

test('the window shows the newest rows and holds its start while reading', () => {
  assert.equal(windowStart(100), 40);
  assert.equal(windowStart(30), 0);
  assert.equal(windowStart(110, { following: false, from: 40 }), 40);
  assert.equal(windowStart(110, { following: true, from: 40 }), 50);
  assert.equal(windowStart(110, { following: false, from: 0 }), 0, 'show earlier sticks');
  assert.equal(windowStart(20, { following: false, from: 40 }), 0, 'clamps when the thread shrinks');
});

test('tool groups read like a sentence', () => {
  const steps = [{ tool: 'Read' }, { tool: 'Read' }, { tool: 'Glob' }, { tool: 'Bash' }, { tool: 'Read' }, { tool: 'Read' }, { tool: 'Bash' }];
  assert.equal(summarizeSteps(steps), 'Read 4 files, ran 2 commands, searched 1 time');
  assert.equal(summarizeSteps([]), '');
  assert.equal(summarizeCounts({ read: 1, edit: 2, command: 3, web: 1, other: 2 }), 'Read 1 file, edited 2 files, 6 other steps');
  assert.equal(summarizeSteps([{ tool: 'Task' }]), 'Started 1 subagent');
});

test('thought lines prefer the heading and drop markdown', () => {
  assert.equal(thoughtLine({ heading: null, text: '**Checking the scroll path**\nThen more.' }), 'Checking the scroll path');
  assert.equal(thoughtLine({ heading: 'Plan the `fix`', text: 'x' }), 'Plan the fix');
  assert.equal(thoughtLine({ text: 'Look at [the file](a.js) and\n- run tests' }), 'Look at the file and run tests');
  assert.equal(thoughtLine(null), '');
});

test('timeline parsing degrades to null and normalizes fields', () => {
  assert.equal(parseTimeline(''), null);
  assert.equal(parseTimeline('nope'), null);
  assert.equal(parseTimeline('{"supported": false}'), null);
  const tl = parseTimeline(JSON.stringify({ supported: true, turn: { started_ms: 5, working: true },
    tools: { counts: { read: 2 } }, subagents: [{ id: 'a', title: 'Explore', status: 'weird' }, null], context: { tokens: 1, max: 0 } }));
  assert.equal(tl.turn.started_ms, 5); assert.equal(tl.tools.summary, 'Read 2 files');
  assert.equal(tl.subagents.length, 1); assert.equal(tl.subagents[0].status, 'running');
  assert.equal(tl.context, null);
});

test('one exec carries the step tail and the timeline', () => {
  const out = `{"at":1,"tool":"Read","text":"Read a"}\nbad\n{"at":2,"tool":"Bash","text":"x"}\n\n${SPLIT}\n{"supported":true,"title":"T"}`;
  const { steps, timeline } = splitPoll(out);
  assert.equal(steps.length, 2); assert.equal(timeline.title, 'T');
  assert.equal(splitPoll('').timeline, null);
});

test('subagent groups say how many are still running', () => {
  assert.deepEqual(subagentHeader([{ status: 'running' }, { status: 'running' }, { status: 'done' }]), { text: '3 subagents · 2 running', status: 'working' });
  assert.equal(subagentHeader([{ status: 'done' }, { status: 'failed' }]).status, 'failed');
  assert.equal(subagentHeader([{ status: 'done' }, { status: 'done' }]).text, '2 subagents · all done');
});

test('the context meter shows only past half, amber past 75%, red past 90%', () => {
  assert.equal(contextMeter({ tokens: 90000, max: 200000 }), null);
  assert.equal(contextMeter(null), null);
  assert.equal(contextMeter({ tokens: 120000, max: 200000 }).level, 'normal');
  assert.equal(contextMeter({ tokens: 160000, max: 200000 }).level, 'amber');
  const red = contextMeter({ tokens: 190000, max: 200000 });
  assert.equal(red.level, 'red'); assert.equal(red.label, '190k / 200k');
});

test('a finished turn finds the snapshot taken during it', () => {
  const row = { m: { address: 't1', at: 100000 }, turnStart: 40000 };
  const snaps = { t1: [{ first: 10000, ended: 20000 }, { first: 45000, ended: 99000, steps: [1] }] };
  assert.deepEqual(snapshotFor(row, snaps).steps, [1]);
  assert.equal(snapshotFor({ m: { address: 't2', at: 1 } }, snaps), null);
});

test('status lines put what needs you first and offer one action each', () => {
  const lines = statusLines({
    waiting: [{ id: 'p', from: 'cto', tool: 'Bash', detail: 'git push\nmore' }],
    blocked: [{ address: 't9', role: 'backend' }],
    disconnected: [{ id: 's1', role: 'frontend', state: 'disconnected', can_resume: false }],
    handingOff: [{ address: 't2', role: 'cto' }], queued: 2, error: 'boom', name: (r) => r.toUpperCase(),
  });
  assert.deepEqual(lines.map((l) => l.mark), ['blocked', 'blocked', 'disconnected', 'working', 'queued', 'failed']);
  assert.equal(lines[0].title, 'CTO is waiting on your approval'); assert.equal(lines[0].detail, 'Bash: git push');
  assert.equal(lines[2].action.disabled, true);
  assert.equal(lines[4].title, '2 messages queued');
  assert.deepEqual(statusLines({}), []);
});

test('minimap offsets walk measured rows and pick the prompt being read', () => {
  const heights = new Map([['a', 100], ['b', 300], ['c', 50]]);
  const off = rowOffsets(['a', 'b', 'c', 'd', 'e'], heights, 12);
  assert.equal(off.get('b'), 112); assert.equal(off.get('d'), 462); assert.equal(off.has('e'), false);
  const prompts = [{ key: 'z', hidden: true }, { key: 'a' }, { key: 'c' }];
  assert.equal(activePrompt(prompts, off, 0, 100), 1);
  assert.equal(activePrompt(prompts, off, 400, 100), 2);
  assert.equal(activePrompt([{ key: 'z', hidden: true }, { key: 'c' }], off, 0, 100), 0);
});

import { parseTranscript, buildRouteRows } from './model.js';

test('transcripts parse defensively', () => {
  assert.equal(parseTranscript('nope'), null);
  assert.equal(parseTranscript(''), null);
  const p = parseTranscript(JSON.stringify({ supported: true, partial: true, turns: [
    { who: 'kabeer', text: 'hi', at: 1 }, { who: 'robot', text: 'x' }, null,
    { who: 'agent', text: 'ok', at: 2, tools: { counts: { read: 2 } } }] }));
  assert.deepEqual(p.turns.map((x) => x.who), ['kabeer', 'agent']);
  assert.equal(p.turns[1].tools.summary, 'Read 2 files');
  assert.equal(p.partial, true);
  assert.equal(parseTranscript('{"supported":false,"turns":[]}').supported, false);
});

test('route rows: types, stable keys, and the live tail left to the live row', () => {
  const turns = [
    { who: 'kabeer', text: 'go', at: 1 }, { who: 'kabeer', kind: 'command', text: '/clear', at: 2 },
    { who: 'parent', text: 'from cto', at: 3 }, { who: 'agent', text: 'done', at: 4, tools: { summary: 'Ran 1 command' } },
    { who: 'agent', text: '', at: 5, tools: { summary: 'Read 1 file' }, subagents: [] }];
  const cache = new Map();
  const a = buildRouteRows(turns, cache, { working: true });
  assert.deepEqual(a.rows.map((r) => r.type), ['mine', 'command', 'notice', 'reply']);
  assert.deepEqual(a.prompts.map((p) => p.text), ['go']);
  const b = buildRouteRows(turns.slice(1), cache, { working: false });
  assert.equal(b.rows[0], a.rows[1]);
  assert.equal(b.rows.at(-1).type, 'reply');
  const twins = buildRouteRows([{ who: 'agent', text: 'x', at: 9 }, { who: 'agent', text: 'x', at: 9 }]);
  assert.notEqual(twins.rows[0].key, twins.rows[1].key);
});

test('a command message is a chip row: no turn, no prompt mark', () => {
  const { rows, prompts, open } = buildRows([{ at: 1, from: 'kabeer', kind: 'command', to: ['cto'], text: '/clear' }]);
  assert.equal(rows[0].type, 'command');
  assert.deepEqual(prompts, []);
  assert.deepEqual(open, {});
});

test('slash command outcomes are their own rows and open or end no turn', () => {
  const m = buildRows([
    { at: 1, from: 'kabeer', kind: 'say', to: ['cto'], text: 'hi' },
    { at: 2, from: 'kabeer', kind: 'command', to: ['cto'], text: '/context' },
    { at: 3, from: 'cto', address: 't1', kind: 'command-result', command: '/context', text: 'Context Usage' },
    { at: 4, from: 'cto', address: 't1', kind: 'command-note', command: '/clear', text: 'CTO started a new conversation' },
  ]);
  assert.deepEqual(m.rows.map((r) => r.type), ['mine', 'command', 'result', 'note']);
  assert.equal(m.open.cto, 1);  // still waiting for its reply to "hi"
  assert.equal(m.lastReply, -1);
});

test('a member route slots command outcomes in by time, and unlogged commands as chips', () => {
  const turns = [{ who: 'kabeer', kind: 'command', text: '/context', at: 1000 }, { who: 'agent', text: 'later', at: 9000 }];
  const outcomes = [
    { at: 1100, kind: 'command', text: '/context', delivered_to: ['t1'] },                 // logged by Claude: no second chip
    { at: 1200, kind: 'command-result', address: 't1', command: '/context', text: 'grid' },
    { at: 5000, kind: 'command', text: '/cost', delivered_to: ['t1'] },                    // a dialog: not in the transcript
    { at: 5100, kind: 'command-result', address: 't1', command: '/cost', text: '$0' },
    { at: 5200, kind: 'say', address: 't1', text: 'ignored' },
  ];
  const { rows } = buildRouteRows(turns, new Map(), { outcomes });
  assert.deepEqual(rows.map((r) => [r.type, r.x.text]), [['command', '/context'], ['result', 'grid'], ['command', '/cost'], ['result', '$0'], ['reply', 'later']]);
  assert.equal(rows[1].x.outcome.command, '/context');
});

test('a member bringing people in keeps who, where and why per member; reports are remembered', () => {
  const { rows, reports } = buildRows([
    { at: 1, from: 'kabeer', kind: 'say', text: 'build it', to: ['cto'] },
    { at: 2, from: 'cto', kind: 'start', role: 'frontend', address: 't2', task_line: 'Guest check-in screen', branch: 'fe' },
    { at: 3, from: 'cto', kind: 'start', role: 'backend', address: 't3', task_line: 'Check-in API' },
    { at: 9, from: 'frontend', address: 't2', kind: 'done', text: 'shipped', diff: { added: 3, removed: 1, files: 2, branch: 'fe' } },
  ]);
  const team = rows.find((r) => r.m.kind === 'start').m;
  assert.deepEqual(team.members.map((x) => [x.role, x.address, x.task_line]), [['frontend', 't2', 'Guest check-in screen'], ['backend', 't3', 'Check-in API']]);
  assert.equal(reports.get('t2'), 'done');
  assert.equal(reports.has('t3'), false);
});

test('route replies in a row share one face', () => {
  const { rows } = buildRouteRows([
    { who: 'kabeer', text: 'go', at: 1 }, { who: 'agent', text: 'one', at: 2 }, { who: 'agent', text: 'two', at: 3 },
    { who: 'kabeer', text: 'more', at: 4 }, { who: 'agent', text: 'three', at: 5 },
  ]);
  assert.deepEqual(rows.map((r) => [r.type, Boolean(r.grouped)]), [['mine', false], ['reply', false], ['reply', true], ['mine', false], ['reply', false]]);
});
