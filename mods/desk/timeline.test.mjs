import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Elements are single-use in Herdr: attaching one to a second parent fails the whole view. This
// stub of the UI kit enforces that, so rows can be drawn here without the app.
const STUBS = {
  'gpui-kit': 'export { div, svg, image } from "stub:ui";',
  'gpui-base': 'export { h_flex, v_flex, TextView } from "stub:ui";',
  herdr: 'export { noop as agents, noop as terminals, noop as panes, noop as spaces, noop as run, noop as notify, noop as appHome, noop as home, noop as readTextFile, noop as exec, noop as hc, noop as shared, noop as setShared } from "stub:ui";',
  'stub:ui': `
    const element = (name) => {
      const self = new Proxy({ name, parent: null }, { get(target, prop) {
        if (prop === "isElement") return true;
        if (prop === "name" || prop === "parent") return target[prop];
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "when") return (on, draw) => (on ? draw(self) : self);
        const add = (x) => {
          // Herdr fails the whole view on anything but an element or a string, null included.
          if (typeof x === "string") return;
          if (!x?.isElement) throw new Error("child(value) expects an element, a string, or an entity from cx.new(Class, props)");
          if (x.parent) throw new Error("element " + x.name + " was already added to a parent");
          x.parent = self;
        };
        if (prop === "child") return (x) => { add(x); return self; };
        if (prop === "children") return (list) => { [...list].forEach(add); return self; };
        return () => self;
      }, set(target, prop, value) { target[prop] = value; return true; } });
      return self;
    };
    export const div = () => element("div"), h_flex = () => element("h_flex"), v_flex = () => element("v_flex");
    export const svg = () => element("svg"), image = () => element("image");
    export const TextView = { markdown: () => element("text") };
    export const noop = () => "";`,
};
registerHooks({
  resolve: (specifier, context, next) => (specifier in STUBS ? { url: specifier.startsWith('stub:') ? specifier : `stub:${specifier}`, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url.startsWith('stub:') ? { format: 'module', source: STUBS[url in STUBS ? url : url.slice(5)], shortCircuit: true } : next(url, context)),
});
const { messageRow } = await import('./timeline.js');
const { buildRows } = await import('./model.js');
const { div } = await import('gpui-kit');

const drawAll = (model, { hover = () => null } = {}) => {
  const o = { model, wide: true, copied: null, expanded: new Set(), folds: new Set(), snapshots: {}, toolsOpen: new Set(),
    roles: { byId: (id) => ({ id, name: id }) }, face: () => div(), desk: () => null, overLimit: () => false };
  model.rows.forEach((row, index) => {
    o.hoverMsg = hover(row);
    messageRow(o, {}, 'd', row, { members: [], now: 0, index });
  });
};

test('a reply grouped under another draws, once a later reply follows it', () => {
  const model = buildRows([
    { at: 0, from: 'kabeer', kind: 'say', to: ['cto'], text: 'one' },
    { at: 1000, from: 'cto', address: 't1', kind: 'say', text: 'first' },
    { at: 2000, from: 'cto', address: 't1', kind: 'say', text: 'second' },
    { at: 3000, from: 'kabeer', kind: 'say', to: ['cto'], text: 'two' },
    { at: 4000, from: 'cto', address: 't1', kind: 'say', text: 'third' },
  ]);
  assert.equal(model.rows.filter((r) => r.grouped).length, 1);
  assert.notEqual(model.rows.findIndex((r) => r.grouped), model.lastReply);
  assert.doesNotThrow(() => drawAll(model));
});

test('a sent message with an attachment draws (no remove button outside the composer)', () => {
  const model = buildRows([
    { at: 0, from: 'kabeer', kind: 'say', to: ['cto'], text: 'look at this',
      attachments: [{ path: '/tmp/a.png', name: 'a.png', kind: 'image' }, { path: '/tmp/b.txt', name: 'b.txt', kind: 'file' }] },
  ]);
  assert.doesNotThrow(() => drawAll(model));
});

test('the latest reply draws, grouped or not', () => {
  const model = buildRows([
    { at: 1000, from: 'cto', address: 't1', kind: 'say', text: 'first' },
    { at: 2000, from: 'cto', address: 't1', kind: 'say', text: 'second' },
  ]);
  assert.doesNotThrow(() => drawAll(model));
});
