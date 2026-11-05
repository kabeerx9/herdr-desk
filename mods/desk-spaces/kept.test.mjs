import test from 'node:test';
import assert from 'node:assert/strict';
import { keepable, withKept, removeBlockers } from './kept.js';

test('home, nothing and team worktrees are not kept', () => {
  assert.equal(keepable('/Users/k', '/Users/k'), false);
  assert.equal(keepable(null, '/Users/k'), false);
  assert.equal(keepable('/Users/k/.herdr/worktrees/x/y', '/Users/k'), false);
  assert.equal(keepable('/Users/k/code/app', '/Users/k'), true);
});

test('a folder is kept once, in first-seen order', () => {
  const one = withKept([], '/a', '/h');
  assert.deepEqual(withKept(one, '/b', '/h'), ['/a', '/b']);
  assert.equal(withKept(one, '/a', '/h'), one);
  assert.equal(withKept(one, '/h', '/h'), one);
});

test('an agent in its space or a desk member anywhere blocks removal', () => {
  const desk = (slug) => (slug === 'd1' ? '/a' : '/b');
  const spaces = [{ id: 's1' }];
  assert.deepEqual(removeBlockers('/a', spaces, [{ space: 's1', address: 't1' }, { space: 's2', address: 't2' }], [], desk), ['t1']);
  assert.deepEqual(removeBlockers('/a', [], [], [{ address: 't3', labels: { task: 'd1' } }, { address: 't4', labels: { task: 'd2' } }], desk), ['t3']);
  assert.deepEqual(removeBlockers('/a', spaces, [{ space: 's1', address: 't1' }], [{ address: 't1', labels: { task: 'd1' } }], desk), ['t1']);
  assert.deepEqual(removeBlockers('/a', spaces, [], [{ address: 't5', labels: {} }], desk), []);
});
