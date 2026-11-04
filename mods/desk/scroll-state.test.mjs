import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollState } from './scroll-state.js';

test('first measurement opens at latest, including a long reply', () => {
  const s = new ScrollState(); s.measure(600, 5000);
  assert.equal(s.offset, 4400); assert.equal(s.following, true);
});
test('new messages and composer resize follow only while at the bottom', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.measure(500, 5300);
  assert.equal(s.offset, 4800);
  s.move(2200); s.measure(400, 6000);
  assert.equal(s.offset, 2200); assert.equal(s.following, false);
});
test('hover or equal-size redraw does not move a reader', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.move(1200);
  for (let i = 0; i < 20; i++) s.measure(600, 5000);
  assert.equal(s.offset, 1200);
});
test('latest explicitly resumes following, and scrolling back to bottom does too', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.move(100); s.latest();
  assert.equal(s.offset, 4400); assert.equal(s.following, true);
  s.move(100); s.move(4400); s.measure(600, 5500);
  assert.equal(s.offset, 4900);
});
test('wheel accepts pixel and line devices without leaving the content bounds', () => {
  const s = new ScrollState(); s.measure(600, 5000);
  s.wheel({ delta: { y: 50 } }); assert.equal(s.offset, 4350);
  s.wheel({ delta: { y: 3 }, delta_lines: { y: 3 } }); assert.equal(s.offset, 4278);
  s.wheel({ delta: { y: 10000 } }); assert.equal(s.offset, 0);
  s.wheel({ delta: { y: -10000 } }); assert.equal(s.offset, 4400);
});
test('shrinking content clamps safely, and short/empty threads never overscroll', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.move(2200); s.measure(600, 1000);
  assert.equal(s.offset, 400);
  s.measure(600, 100); assert.equal(s.offset, 0); assert.equal(s.max, 0);
  s.seek(300); assert.equal(s.offset, 0);
  assert.deepEqual(s.thumb, { top: 0, height: 600 });
});
test('scrollbar maps its top and bottom to the content endpoints', () => {
  const s = new ScrollState(); s.measure(600, 6000);
  assert.deepEqual(s.thumb, { top: 540, height: 60 });
  s.seek(30); assert.equal(s.offset, 0);
  s.seek(570); assert.equal(s.offset, 5400);
});
test('conversations keep independent positions', () => {
  const a = new ScrollState(), b = new ScrollState();
  a.measure(600, 5000); b.measure(600, 2000); a.move(1200);
  b.measure(600, 3000); a.measure(600, 5000);
  assert.equal(a.offset, 1200); assert.equal(b.offset, 2400);
});
test('following the tail glides only when content grows, never on the first measure', () => {
  const s = new ScrollState(); s.measure(600, 5000);
  assert.equal(s.glide, false);
  s.measure(600, 5200); assert.equal(s.glide, true); assert.equal(s.offset, 4600);
  s.measure(600, 5200); assert.equal(s.glide, false);
  s.measure(500, 5400); assert.equal(s.glide, false, 'composer resize snaps');
});
test('reader input stops a glide immediately', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.measure(600, 5300);
  assert.equal(s.glide, true);
  s.wheel({ delta: { y: 40 } }); assert.equal(s.glide, false); assert.equal(s.following, false);
  s.measure(600, 5600); assert.equal(s.glide, false, 'growth while reading never glides');
  s.latest(); assert.equal(s.glide, false);
  s.measure(600, 5800); s.seek(10); assert.equal(s.glide, false);
});
test('anchoring keeps the reader in place when rows are added above', () => {
  const s = new ScrollState(); s.measure(600, 5000); s.move(1000);
  s.anchorBottom(); s.measure(600, 8000);
  assert.equal(s.offset, 4000); assert.equal(s.following, false);
  s.measure(600, 8400); assert.equal(s.offset, 4000, 'anchor applies once');
});
test('anchoring while following just keeps following', () => {
  const s = new ScrollState(); s.measure(600, 1000); s.anchorBottom(); s.measure(600, 3000);
  assert.equal(s.offset, 2400); assert.equal(s.following, true);
});

test('the jump pill returns to the tail with a glide; reader input cancels it', () => {
  const s = new ScrollState();
  s.measure(100, 1000); s.move(200);
  assert.equal(s.following, false);
  s.jump();
  assert.deepEqual([s.following, s.glide, s.offset], [true, true, 900]);
  s.wheel({ delta: { y: 10 } });
  assert.equal(s.glide, false);
});
