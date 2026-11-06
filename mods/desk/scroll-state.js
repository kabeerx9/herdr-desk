// Scroll authority is per conversation, independent of render/hover/composer state.
// `glide` says the last change was the tail growing while following, so the viewport may
// spring to the new offset; any reader input (wheel, drag, keys, seek) clears it at once.
// `anchorBottom()` keeps the reader's distance from the bottom across the next content change
// (rows added above, such as "Show earlier").
export class ScrollState {
  constructor() { this.offset = 0; this.viewport = 0; this.content = 0; this.following = true; this.glide = false; this.anchor = null; }
  get max() { return Math.max(0, this.content - this.viewport); }
  measure(viewport, content) {
    const grew = this.content > 0 && content > this.content && Math.abs(viewport - this.viewport) < 0.5;
    this.viewport = Math.max(0, viewport); this.content = Math.max(0, content);
    if (this.following) { this.glide = grew; this.offset = this.max; }
    else if (this.anchor !== null) { this.glide = false; this.offset = Math.max(0, Math.min(this.max, this.max - this.anchor)); this.anchor = null; }
    else { this.glide = false; this.offset = Math.min(this.offset, this.max); }
  }
  move(offset) {
    this.glide = false; this.anchor = null;
    this.offset = Math.max(0, Math.min(this.max, offset));
    this.following = this.max - this.offset < 2;
  }
  latest() { this.glide = false; this.anchor = null; this.following = true; this.offset = this.max; }
  // The jump pill: back to the tail with the follow spring (a glide), not a cut.
  // A long way back cuts: rows between here and there aren't drawn, so a glide would cross blank.
  jump() { this.anchor = null; this.following = true; this.glide = this.max - this.offset <= this.viewport; this.offset = this.max; }
  anchorBottom() { if (!this.following) this.anchor = this.max - this.offset; }
  wheel(event) {
    const delta = event.delta_lines ? event.delta_lines.y * 24 : event.delta.y;
    if (delta) this.move(this.offset - delta);
  }
  get thumb() {
    const height = Math.min(this.viewport, Math.max(32, this.viewport * this.viewport / Math.max(1, this.content)));
    return { height, top: this.max ? this.offset / this.max * (this.viewport - height) : 0 };
  }
  seek(y) {
    const { height } = this.thumb;
    this.move((y - height / 2) / Math.max(1, this.viewport - height) * this.max);
  }
}
