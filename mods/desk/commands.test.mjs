import test from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor, slashQuery, matchCommands, resolveCommand, menuKey } from './commands.js';

test('the menu follows the target CLI and keeps the Desk actions', () => {
  const claude = commandsFor('claude').map((c) => c.name), codex = commandsFor('codex').map((c) => c.name);
  for (const n of ['clear', 'compact', 'model', 'context', 'cost', 'review', 'status', 'memory', 'agents']) assert.ok(claude.includes(n), n);
  assert.deepEqual(codex.slice(0, 5), ['new', 'model', 'status', 'review', 'diff']);
  assert.ok(!codex.includes('clear'));
  for (const list of [claude, codex]) assert.deepEqual(list.slice(-5), ['fresh', 'terminal', 'changes', 'wrap', 'queue']);
  assert.equal(commandsFor(null)[0].name, 'clear');
});

test('the menu opens only on a leading slash word', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/Mo'), 'mo');
  for (const v of ['', 'hi /mo', '/model opus', '/a\nb', ' /x']) assert.equal(slashQuery(v), null, v);
});

test('matching ranks prefixes, then substrings, then descriptions', () => {
  const list = commandsFor('claude');
  assert.equal(matchCommands(list, 'co')[0].name, 'compact');
  assert.deepEqual(matchCommands(list, 'co').slice(0, 3).map((c) => c.name), ['compact', 'context', 'cost']);
  assert.ok(matchCommands(list, 'handoff').some((c) => c.name === 'fresh'));
  assert.deepEqual(matchCommands(list, 'zzz'), []);
  assert.equal(matchCommands(list, '').length, list.length);
});

test('sent lines: Desk actions run, everything else goes raw', () => {
  assert.deepEqual(resolveCommand('/fresh', 'claude'), { kind: 'desk', action: 'fresh', name: 'fresh' });
  assert.deepEqual(resolveCommand('/model opus', 'claude'), { kind: 'cli', text: '/model opus', name: 'model' });
  assert.deepEqual(resolveCommand('/whatever x', 'codex'), { kind: 'cli', text: '/whatever x', name: 'whatever' });
  assert.equal(resolveCommand('hello', 'claude'), null);
});

test('menu keys wrap and map to actions', () => {
  assert.deepEqual(menuKey('up', 0, 3), { index: 2 });
  assert.deepEqual(menuKey('down', 2, 3), { index: 0 });
  assert.deepEqual(menuKey('tab', 1, 3), { complete: true });
  assert.deepEqual(menuKey('enter', 1, 3), { run: true });
  assert.deepEqual(menuKey('escape', 0, 0), { close: true });
  assert.equal(menuKey('a', 0, 3), null);
});
