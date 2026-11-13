import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeWake, agentSignature, tickEvery, lastLines, due } from './poll.js';

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
