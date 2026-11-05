import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Elements are single-use in Herdr, so the stub fails on a second parent, as the app does.
const STUBS = {
  'gpui-kit': 'export { div, svg, image } from "stub:ui";',
  'gpui-base': 'export { h_flex, v_flex } from "stub:ui";',
  herdr: 'export { props, closeOverlay, setShared, theme, noop as shared, noop as appHome, noop as home } from "stub:ui";',
  'stub:ui': `
    export const log = { keys: null, closed: [], shared: [] };
    const element = (name) => {
      const self = new Proxy({ name, parent: null }, { get(target, prop) {
        if (prop === "isElement") return true;
        if (prop === "name" || prop === "parent") return target[prop];
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop === "when") return (on, draw) => (on ? draw(self) : self);
        if (prop === "on_key_down") return (fn) => { log.keys = fn; return self; };
        const add = (x) => {
          if (!x?.isElement) return;
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
    export const noop = () => "";
    export const theme = () => ({});
    export const props = () => ({ overlay: "o1", deleteDesk: { slug: "s1", name: "Desk one" } });
    export const closeOverlay = (id) => log.closed.push(id);
    export const setShared = (key, value) => log.shared.push([key, value]);`,
};
registerHooks({
  resolve: (specifier, context, next) => (specifier in STUBS ? { url: specifier.startsWith('stub:') ? specifier : `stub:${specifier}`, shortCircuit: true } : next(specifier, context)),
  load: (url, context, next) => (url.startsWith('stub:') ? { format: 'module', source: STUBS[url in STUBS ? url : url.slice(5)], shortCircuit: true } : next(url, context)),
});
const { DeleteDialog } = await import('./delete-dialog.js');
const { log } = await import('stub:ui');

const open = () => {
  log.closed.length = 0; log.shared.length = 0;
  const dialog = new DeleteDialog();
  dialog.init({}, { focus_handle: () => ({ focus() {} }) });
  dialog.render({});
  return dialog;
};
const press = (key) => log.keys({ key }, { stop_propagation() {} });

test('Enter sends the desk to delete and closes the dialog', () => {
  open();
  press('enter');
  assert.equal(log.shared.length, 1);
  assert.equal(log.shared[0][0], 'desk.delete');
  assert.equal(log.shared[0][1].slug, 's1');
  assert.deepEqual(log.closed, ['o1']);
});

test('Esc closes the dialog and deletes nothing', () => {
  open();
  press('escape');
  assert.deepEqual(log.shared, []);
  assert.deepEqual(log.closed, ['o1']);
});

test('other keys do nothing', () => {
  open();
  press('a');
  assert.deepEqual(log.shared, []);
  assert.deepEqual(log.closed, []);
});
