import test from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor, slashQuery, matchCommands, resolveCommand, menuKey, MODES, mentionQuery, matchMentions, mentionItems } from './commands.js';

test('the menu follows the target CLI and keeps the Desk actions', () => {
  const claude = commandsFor('claude').map((c) => c.name), codex = commandsFor('codex').map((c) => c.name);
  for (const n of ['clear', 'compact', 'model', 'context', 'cost', 'review', 'status', 'memory', 'agents']) assert.ok(claude.includes(n), n);
  assert.deepEqual(codex.slice(0, 6), ['new', 'compact', 'model', 'status', 'review', 'diff']);
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
  assert.deepEqual(resolveCommand('/model opus', 'claude'), { kind: 'cli', text: '/model opus', name: 'model', mode: 'action' });
  assert.deepEqual(resolveCommand('/whatever x', 'codex'), { kind: 'cli', text: '/whatever x', name: 'whatever', mode: null });
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

test('every CLI command has a mode the runtime knows', () => {
  for (const cli of ['claude', 'codex'])
    for (const c of commandsFor(cli).filter((x) => x.kind === 'cli')) assert.ok(MODES.includes(c.mode), `${cli} /${c.name}`);
  const mode = (text, cli = 'claude') => resolveCommand(text, cli).mode;
  for (const n of ['/clear', '/compact', '/review 12']) assert.equal(mode(n), 'action', n);
  for (const n of ['/context', '/cost', '/status']) assert.equal(mode(n), 'info', n);
  for (const n of ['/model', '/memory', '/agents', '/permissions', '/mcp']) assert.equal(mode(n), 'interactive', n);
  assert.equal(mode('/model  '), 'interactive');
  assert.deepEqual(['/new', '/compact', '/status', '/diff', '/model'].map((n) => mode(n, 'codex')), ['action', 'action', 'info', 'info', 'interactive']);
});

test('@ mentions: the query at the end, and the options it matches', () => {
  assert.deepEqual(mentionQuery('@ba'), { start: 0, q: 'ba' });
  assert.deepEqual(mentionQuery('hi @Ba'), { start: 3, q: 'ba' });
  assert.deepEqual(mentionQuery('hi @'), { start: 3, q: '' });
  for (const v of ['', 'a@ba', '@ba ', 'hi']) assert.equal(mentionQuery(v), null, v);
  const opts = [{ id: 'cto', name: 'CTO' }, { id: 'backend', name: 'Backend' }, { id: 'all', name: 'Everyone' }];
  assert.deepEqual(matchMentions(opts, 'ba').map((o) => o.id), ['backend']);
  assert.deepEqual(matchMentions(opts, 'ev').map((o) => o.id), ['all']);
  assert.equal(matchMentions(opts, '').length, 3);
  // Tab completes the highlighted one; arrows wrap; Esc closes (the same keys as the slash menu).
  assert.deepEqual(menuKey('tab', 0, 1), { complete: true });
  assert.deepEqual(menuKey('down', 2, 3), { index: 0 });
  assert.deepEqual(menuKey('escape', 0, 3), { close: true });
});

test('@ menu: Send to the members with their status, then Bring in the rest', () => {
  const roles = [{ id: 'cto', name: 'CTO' }, { id: 'frontend', name: 'Frontend' }, { id: 'backend', name: 'Backend' }, { id: 'qa', name: 'QA' }];
  const members = [{ role: 'cto', address: 't1', status: 'idle' }, { role: 'frontend', address: 't2', status: 'working' },
    { role: 'frontend', address: 't3', status: 'blocked' }];
  const items = mentionItems(members, roles, '');
  assert.deepEqual(items.map((x) => [x.section, x.id, x.status]), [['send', 'cto', 'idle'], ['send', 'frontend', 'blocked'], ['send', 'all', null],
    ['bring', 'backend', null], ['bring', 'qa', null]]);
  assert.equal(items[1].address, 't3');
  assert.deepEqual(mentionItems(members, roles, 'b').map((x) => x.id), ['backend']);
  assert.deepEqual(mentionItems([{ role: 'cto', address: 't1', status: 'idle' }], roles, '').filter((x) => x.section === 'send').map((x) => x.id), ['cto']);
});
