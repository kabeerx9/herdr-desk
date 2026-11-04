// Scroll authority is per conversation, independent of render/hover/composer state.
export class ScrollState {
  constructor() { this.offset = 0; this.viewport = 0; this.content = 0; this.following = true; }
  get max() { return Math.max(0, this.content - this.viewport); }
  measure(viewport, content) {
    this.viewport = Math.max(0, viewport); this.content = Math.max(0, content);
    this.offset = this.following ? this.max : Math.min(this.offset, this.max);
  }
  move(offset) {
    this.offset = Math.max(0, Math.min(this.max, offset));
    this.following = this.max - this.offset < 2;
  }
  latest() { this.following = true; this.offset = this.max; }
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
