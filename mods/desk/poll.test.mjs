import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeWake, agentSignature, tickEvery, lastLines, due, peekDue, coalesce } from './poll.js';

const dir = '/u/.herdr/team';

test('the runtime poll wakes for the runtime file, threads and a root refresh only', () => {
  assert.equal(runtimeWake([`${dir}/.runtime.json`], dir), true);
  assert.equal(runtimeWake([`${dir}/desk-1108-0019.jsonl`], dir), true);
  assert.equal(runtimeWake([dir], dir), true);
  assert.equal(runtimeWake([`${dir}/`], dir), true);
  // Its own writes and the per-tool-call feed must not wake it, or it would poll itself.
  assert.equal(runtimeWake([`${dir}/.titles.json`, `${dir}/.runtime.lock`, `${dir}/desk-1.lock`], dir), false);
  assert.equal(runtimeWake([`${dir}/.activity/t3.jsonl`, `${dir}/desk-1.handoffs/a.jsonl`], dir), false);
  assert.equal(runtimeWake([`${dir}/desk-1.cursors.json`, '/elsewhere/x.jsonl'], dir), false);
  assert.equal(runtimeWake(null, dir), false);
  assert.equal(runtimeWake([`${dir}/.activity/t3.jsonl`, `${dir}/d.jsonl`], dir), true);
});

test('the agent signature changes with status or membership, not with order', () => {
  const a = [{ address: 't1', status: 'working' }, { address: 't2', status: 'idle' }];
  assert.equal(agentSignature(a), agentSignature([...a].reverse()));
  assert.notEqual(agentSignature(a), agentSignature([{ ...a[0], status: 'blocked' }, a[1]]));
  assert.notEqual(agentSignature(a), agentSignature([a[0]]));
  assert.equal(agentSignature(null), '');
});

test('elapsed labels tick every second for a minute, then every 5 s', () => {
  assert.equal(tickEvery(0), 1000);
  assert.equal(tickEvery(59999), 1000);
  assert.equal(tickEvery(60000), 5000);
  assert.equal(tickEvery(3600000), 5000);
});

test('lastLines matches tail -n', () => {
  assert.equal(lastLines('a\nb\nc\n', 2), 'b\nc');
  assert.equal(lastLines('a\nb\nc', 2), 'b\nc');
  assert.equal(lastLines('a\n', 60), 'a');
  assert.equal(lastLines('', 60), '');
  assert.equal(lastLines(null, 60), '');
  const many = Array.from({ length: 100 }, (_, i) => JSON.stringify({ at: i + 1, tool: 'Read' })).join('\n') + '\n';
  assert.deepEqual(lastLines(many, 60).split('\n').map((l) => JSON.parse(l).at), Array.from({ length: 60 }, (_, i) => i + 41));
});

test('due spaces runs per key', () => {
  const stamps = {};
  assert.equal(due(stamps, 'd1', 3000, 10000), true);
  assert.equal(due(stamps, 'd1', 3000, 12999), false);
  assert.equal(due(stamps, 'd2', 3000, 12999), true, 'another desk has its own spacing');
  assert.equal(due(stamps, 'd1', 3000, 13000), true);
  assert.equal(stamps.d1, 13000);
});

test('peekDue keeps blocked members quick and skips unchanged idle ones', () => {
  const old = 0, now = 1_000_000;
  const idle = { status: 'idle', sig: 'idle|3|9', created: old };
  assert.equal(peekDue(undefined, idle, now), true, 'first look');
  assert.equal(peekDue({ at: now - 3000, sig: 'blocked|3|9' }, { ...idle, status: 'blocked' }, now), true, 'blocked: 2.5 s');
  assert.equal(peekDue({ at: now - 2000, sig: 'x' }, { ...idle, status: 'blocked' }, now), false);
  assert.equal(peekDue({ at: now - 11000, sig: 'idle|3|9' }, idle, now), false, 'unchanged idle member is skipped');
  assert.equal(peekDue({ at: now - 11000, sig: 'idle|2|8' }, idle, now), true, 'its turn moved');
  assert.equal(peekDue({ at: now - 5000, sig: 'idle|2|8' }, idle, now), false, 'never sooner than 10 s');
  assert.equal(peekDue({ at: now - 11000, sig: 'idle|3|9', dialog: { title: 'Trust?' } }, idle, now), true, 'a shown prompt is watched until it goes');
  assert.equal(peekDue({ at: now - 11000, sig: 'idle|3|9' }, { ...idle, created: now - 30000 }, now), true, 'a new agent may show a trust prompt');
  assert.equal(peekDue({ at: now - 61000, sig: 'idle|3|9' }, idle, now), true, 'once a minute regardless');
  assert.equal(peekDue({ at: 0, dialog: null, why: null }, idle, now), true, 'after an answer, look again at once');
});

test('coalesce shares a read in flight only with callers it started after', async () => {
  const reads = new Map();
  let runs = 0;
  const start = () => { const n = ++runs; return new Promise((r) => setImmediate(() => r(`read ${n}`))); };
  const a = coalesce(reads, 'list', 100, start, 100);
  const b = coalesce(reads, 'list', 100, start, 100);      // woke at the same moment: joins
  const c = coalesce(reads, 'list', 101, start, 101);      // woke after it started: its own read
  assert.equal(await a, 'read 1'); assert.equal(await b, 'read 1'); assert.equal(await c, 'read 2');
  assert.equal(runs, 2);
  assert.equal(reads.size, 0, 'settled reads are dropped');
  const d = coalesce(reads, 'list', 0, start, 200);
  assert.equal(await d, 'read 3', 'nothing settled is reused');
  const e = coalesce(reads, 'other', Infinity, start, 300);
  const f = coalesce(reads, 'other', Infinity, start, 300); // no wake time: never joins
  await Promise.all([e, f]); assert.equal(runs, 5);
});

test('a joiner reads for itself when the shared read fails', async () => {
  const reads = new Map();
  const failing = coalesce(reads, 'k', 0, () => Promise.reject(new Error('closed')), 10);
  const joined = coalesce(reads, 'k', 10, () => Promise.resolve('own'), 10);
  await assert.rejects(failing);
  assert.equal(await joined, 'own');
});
