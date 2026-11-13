import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeWake, agentSignature } from './poll.js';

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
