import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// blocks.js imports gpui-kit / gpui-base, which only exist inside Herdr. Stand them in with a
// chainable fake element that records its children and handlers, so the parser is tested
// directly and the renderer can be smoke-run (and its clicks fired) without the app.
const STUB = `
const mk = (kind, arg) => {
  const el = { kind, arg, kids: [], calls: {}, handlers: {} };
  const p = new Proxy(el, { get(o, k) {
    if (k in o) return o[k];
    if (k === 'then') return undefined;
    return (...a) => {
      (o.calls[k] ??= []).push(a);
      if (k === 'child') o.kids.push(a[0]);
      else if (k === 'children') o.kids.push(...a[0]);
      else if (k === 'when') { if (a[0]) a[1](p); }
      else if (k === 'on_click') o.handlers.click = a[0];
      return p;
    };
  } });
  return p;
};
export const div = () => mk('div');
export const svg = (s) => mk('svg', s);
export const h_flex = () => mk('h_flex');
export const v_flex = () => mk('v_flex');
export const TextView = { markdown: (id, md) => mk('md', { id, md }), html: (id, h) => mk('html', { id, h }) };
`;
const stubUrl = `data:text/javascript,${encodeURIComponent(STUB)}`;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'gpui-kit' || spec === 'gpui-base') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  return next(spec, ctx);
}`)}`);

const { parseBlocks, parseNext, splitRow, cellTone, renderBlocks, blocksFor } = await import('./blocks.js');

const types = (text) => parseBlocks(text).map((b) => b.type);

test('lead: a short first paragraph is the lead, a long one is not', () => {
  const b = parseBlocks('Yes, ship it. The tests pass.\n\nSecond paragraph here.');
  assert.deepEqual(b.map((x) => x.type), ['para', 'para']);
  assert.equal(b[0].lead, true);
  assert.equal(b[1].lead, undefined);
  assert.equal(parseBlocks('One. Two. Three sentences.')[0].lead, undefined);
  assert.equal(parseBlocks('# Title\n\nShort.')[1].lead, undefined, 'only the very first block can lead');
});

test('paragraph lines join; blank lines split', () => {
  const b = parseBlocks('line one\nline two\n\nnext');
  assert.equal(b[0].text, 'line one\nline two');
  assert.equal(b[1].text, 'next');
});

test('headings at three levels, trailing hashes dropped', () => {
  const b = parseBlocks('# One\n## Two ##\n### Three');
  assert.deepEqual(b.map((x) => [x.type, x.level, x.text]), [['heading', 1, 'One'], ['heading', 2, 'Two'], ['heading', 3, 'Three']]);
  assert.deepEqual(types('#nospace'), ['para']);
});

test('callouts: bold first word in a blockquote; Warning/Risk use the blocked tone', () => {
  const [rec] = parseBlocks('> **Recommendation**\n> Use option B.\n> It is cheaper.');
  assert.deepEqual(rec, { type: 'callout', label: 'Recommendation', tone: 'accent', text: 'Use option B.\nIt is cheaper.' });
  const [warn] = parseBlocks('> **Warning:** this drops the table');
  assert.equal(warn.tone, 'blocked');
  assert.equal(warn.text, 'this drops the table');
  assert.equal(parseBlocks('> **Risk**\n> x')[0].tone, 'blocked');
  const [q] = parseBlocks('> just a quote\n> more');
  assert.deepEqual(q, { type: 'quote', text: 'just a quote\nmore' });
});

test('tables: header, alignment row, rows padded to the header width', () => {
  const [t] = parseBlocks('| Option | Cost | Fast |\n|:--|--:|:-:|\n| **A** | $5 | ✓ |\n| B | $9 |\n');
  assert.equal(t.type, 'table');
  assert.deepEqual(t.header, ['Option', 'Cost', 'Fast']);
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.deepEqual(t.rows, [['**A**', '$5', '✓'], ['B', '$9', '']]);
  const [plain] = parseBlocks('a | b\n--- | ---\n1 | 2\n');
  assert.deepEqual(plain.align, [null, null]);
  assert.deepEqual(plain.rows, [['1', '2']]);
});

test('table cells: escaped pipes and pipes inside code stay in the cell', () => {
  assert.deepEqual(splitRow('| a \\| b | `x|y` | c |'), ['a | b', '`x|y`', 'c']);
});

test('cell tones: exact words and leading glyphs only', () => {
  assert.equal(cellTone('✓'), 'done');
  assert.equal(cellTone('Yes'), 'done');
  assert.equal(cellTone('pass'), 'done');
  assert.equal(cellTone('✅ fast'), 'done');
  assert.equal(cellTone('✗'), 'fail');
  assert.equal(cellTone('No'), 'fail');
  assert.equal(cellTone('❌'), 'fail');
  assert.equal(cellTone('⚠ slow'), 'warn');
  assert.equal(cellTone('warn'), 'warn');
  assert.equal(cellTone('yes, mostly'), null);
  assert.equal(cellTone('nobody'), null);
  assert.equal(cellTone(''), null);
});

test('ordered lists are steps with their start number; unordered are bullets', () => {
  const [steps] = parseBlocks('3. Build\n4. Test\n5. Ship');
  assert.equal(steps.ordered, true);
  assert.equal(steps.start, 3);
  assert.deepEqual(steps.items.map((x) => x.text), ['Build', 'Test', 'Ship']);
  const [dots] = parseBlocks('- a\n* b\n+ c');
  assert.equal(dots.ordered, false);
  assert.equal(dots.items.length, 3);
});

test('nested lists, continuation lines, and a list that switches kind', () => {
  const [l] = parseBlocks('1. First\n   - sub a\n   - sub b\n     1. deep\n2. Second\n   more of second');
  assert.equal(l.items.length, 2);
  const sub = l.items[0].children[0];
  assert.equal(sub.ordered, false);
  assert.deepEqual(sub.items.map((x) => x.text), ['sub a', 'sub b']);
  assert.equal(sub.items[1].children[0].items[0].text, 'deep');
  assert.equal(l.items[1].text, 'Second\nmore of second');
  assert.deepEqual(types('- a\n- b\n1. c'), ['list', 'list']);
});

test('a loose list (blank lines between items) stays one list', () => {
  const b = parseBlocks('- a\n\n- b\n\nAfter.');
  assert.deepEqual(b.map((x) => x.type), ['list', 'para']);
  assert.equal(b[0].items.length, 2);
});

test('code fences: language, no language, tildes, inner backticks', () => {
  const [a] = parseBlocks('```ts\nconst x = 1;\n```');
  assert.deepEqual(a, { type: 'code', lang: 'ts', code: 'const x = 1;' });
  const [b] = parseBlocks('```\nplain\n\nblank kept\n```');
  assert.deepEqual(b, { type: 'code', lang: null, code: 'plain\n\nblank kept' });
  const [c] = parseBlocks('~~~sh\necho ```\n~~~');
  assert.equal(c.code, 'echo ```');
  const [d] = parseBlocks('````md\n```js\nx\n```\n````');
  assert.equal(d.code, '```js\nx\n```');
});

test('horizontal rules', () => {
  assert.deepEqual(types('a\n\n---\n\nb'), ['para', 'hr', 'para']);
  assert.deepEqual(types('***'), ['hr']);
  assert.deepEqual(types('- - -'), ['hr']);
});

test('Next: bracket form, pipe form, max three, only on the last line', () => {
  assert.deepEqual(parseNext('Next: [Plan it] [Measure latency first]'), ['Plan it', 'Measure latency first']);
  assert.deepEqual(parseNext('Next: Plan it | Measure latency first'), ['Plan it', 'Measure latency first']);
  assert.deepEqual(parseNext('**Next:** [a] [b] [c] [d]'), ['a', 'b', 'c']);
  assert.deepEqual(parseNext('Next: [a], [b]'), ['a', 'b']);
  assert.equal(parseNext('Next: [see docs](https://x.dev)'), null, 'a link is not a chip');
  assert.equal(parseNext('Next: [a] and then [b]'), null, 'prose between chips');
  const b = parseBlocks('Done.\n\nNext: [Ship] [Wait]\n\n');
  assert.deepEqual(b.at(-1), { type: 'next', options: ['Ship', 'Wait'] });
  assert.deepEqual(types('Next: [a]\n\nMore text after.'), ['para', 'para'], 'not last: stays prose');
});

test('streaming: an unclosed fence is plain text until it closes', () => {
  const b = parseBlocks('Here:\n\n```js\nconst a = 1;\nconst b');
  assert.deepEqual(b.map((x) => x.type), ['para', 'plain']);
  assert.equal(b[1].text, '```js\nconst a = 1;\nconst b');
  assert.equal(b[1].mono, true);
  assert.deepEqual(types('Here:\n\n```js\nconst a = 1;\n```'), ['para', 'code']);
});

test('streaming: a Next line inside an open fence is not chips', () => {
  assert.deepEqual(types('```\nNext: [a] [b]'), ['plain']);
});

test('streaming: a table appears only once its delimiter row is complete', () => {
  assert.deepEqual(types('| A | B |'), ['para']);
  assert.deepEqual(types('| A | B |\n| --- | -'), ['para'], 'delimiter still being typed');
  assert.deepEqual(types('| A | B |\n| --- | --- |\n'), ['table']);
  const b = parseBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3');
  assert.deepEqual(b.map((x) => x.type), ['table', 'plain']);
  assert.deepEqual(b[0].rows, [['1', '2']]);
  assert.equal(b[1].text, '| 3');
  assert.deepEqual(parseBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |')[0].rows, [['1', '2']], 'a full last row counts');
});

test('streaming: a half-typed Next chip is prose until its bracket closes', () => {
  assert.deepEqual(types('Ok.\n\nNext: [Plan it] [Meas'), ['para', 'para']);
});

test('a mixed reply parses into the expected sequence', () => {
  const reply = [
    'Use Redis for the queue. It is already deployed.',
    '',
    '> **Recommendation**',
    '> Start with one worker.',
    '',
    '## Options',
    '',
    '| Option | Cost | Ready |',
    '| --- | --- | --- |',
    '| Redis | low | ✓ |',
    '| SQS | med | ✗ |',
    '',
    '1. Add the client',
    '2. Move the job',
    '',
    '```',
    'pnpm add ioredis',
    '```',
    '',
    'Next: [Plan it] [Measure latency first]',
  ].join('\n');
  assert.deepEqual(types(reply), ['para', 'callout', 'heading', 'table', 'list', 'code', 'next']);
  assert.equal(parseBlocks(reply)[0].lead, true);
});

test('parse cache: same text returns the same blocks object', () => {
  const a = blocksFor('cache me\n\n- x');
  assert.equal(blocksFor('cache me\n\n- x'), a);
  assert.notEqual(blocksFor('cache me\n\n- y'), a);
});

// ---- renderer smoke ----

const theme = { foreground: '#111', muted: '#555', dim: '#888', border: '#ddd', accent: '#0aa', blocked: '#c80', done: '#090', raised: '#f4f4f4', hover: '#eee' };
const walk = (el, fn) => { fn(el); for (const k of el.kids ?? []) if (k && typeof k === 'object') walk(k, fn); };

test('renderBlocks draws every block kind and inline runs via TextView', () => {
  const text = 'Lead. Short.\n\n# H\n\n> **Note**\n> body `x`\n\n> q\n\n| a | b |\n|---|--:|\n| **x** | yes |\n\n1. one\n   - nested\n2. two\n\n- dot\n\n```py\nprint(1)\n```\n\n---\n\nNext: [A] [B]';
  const el = renderBlocks(theme, 'm1', text, { onReply: () => {} });
  const kinds = [];
  walk(el, (e) => kinds.push(e.kind));
  assert.ok(kinds.includes('md'));
  const mds = [];
  walk(el, (e) => { if (e.kind === 'md') mds.push(e.arg.id); });
  assert.equal(new Set(mds).size, mds.length, 'TextView ids are unique');
});

test('Next chips call onReply with their text; Copy writes the code to the clipboard', () => {
  const replies = [];
  const el = renderBlocks(theme, 'm2', '```sh\nls -la\n```\n\nNext: [Plan it] [Wait]', { onReply: (s) => replies.push(s) });
  const clickable = [];
  walk(el, (e) => { if (e.handlers?.click) clickable.push(e); });
  const cx = { clip: null, notified: 0, stop_propagation() {}, write_to_clipboard(s) { this.clip = s; }, notify() { this.notified++; } };
  for (const e of clickable) e.handlers.click({}, cx);
  assert.equal(cx.clip, 'ls -la');
  assert.deepEqual(replies, ['Plan it', 'Wait']);
});

test('renderBlocks survives streaming prefixes of a reply', () => {
  const reply = '# T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```js\nx\n```\n\n1. a\n   - b\n\nNext: [x] [y]';
  for (let n = 0; n <= reply.length; n++) renderBlocks(theme, `s${n}`, reply.slice(0, n));
});
