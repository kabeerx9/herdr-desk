import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { settings } from "herdr";
import { icon } from "./ui.js";
import { ScrollState } from "./scroll-state.js";

// The bridge cannot drive a regular scroll area and virtual lists forbid row
// handlers. Keep interactive messages in normal elements, and own their offset.
export class ThreadViewport {
  constructor(cx) { this.states = new Map(); this.focus = cx.focus_handle(); this.drag = null; }
  state(key) {
    if (!this.states.has(key)) this.states.set(key, new ScrollState());
    return this.states.get(key);
  }
  latest(key) { this.state(key).latest(); }
  // Rows start this far down the content (window pixels), for offsets measured from row heights.
  static top(zoom) { return 12 * zoom; }
  // overlay: elements drawn over the viewport, outside the scrolled content (the minimap).
  // pill: drawn instead of "Latest" while scrolled up (the desk's "N new from …" pill).
  render(t, key, children, wide, overlay = null, pill = null) {
    const s = this.state(key), { top, height } = s.thumb;
    // Size/pointer events are window pixels; numeric styles are zoomed by Herdr.
    const zoom = settings().zoom || 1;
    const measure = (viewport, content, cx) => {
      if (Math.abs(s.viewport - viewport) < .5 && Math.abs(s.content - content) < .5) return;
      s.measure(viewport, content); this.onMeasure?.(key, cx); cx.notify();
    };
    const drag = (e, cx) => {
      if (this.drag?.key !== key) return;
      s.move(this.drag.offset + (e.position.y - this.drag.y) * s.max / Math.max(1, s.viewport - s.thumb.height));
      cx.notify();
    };
    return div().id(`thread-${key}`).relative().flex_1().min_h(0).w_full().overflow_hidden()
      .track_focus(this.focus)
      .on_size_change((size, cx) => measure(size.height, s.content, cx))
      .on_scroll_wheel((e, cx) => { s.wheel(e); cx.stop_propagation(); cx.notify(); })
      .on_mouse_down("left", () => this.focus.focus())
      .on_mouse_move(drag)
      .on_mouse_up("left", (_e, cx) => { this.drag = null; cx.notify(); })
      .on_mouse_down_out(() => { this.drag = null; })
      .on_hover((inside) => { if (!inside) this.drag = null; })
      .on_key_down((e, cx) => {
        if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) return;
        const key = e.key.toLowerCase();
        if (key === "end") s.latest();
        else if (key === "home") s.move(0);
        else if (["pageup", "pagedown", "up", "down", "space"].includes(key)) {
          const amount = key === "up" || key === "down" ? 48 : s.viewport * .85;
          s.move(s.offset + (["up", "pageup"].includes(key) || (key === "space" && e.modifiers.shift) ? -amount : amount));
        } else return;
        cx.stop_propagation(); cx.notify();
      })
      // Following the tail glides to new content; reader input (s.glide false) moves at once.
      .child(v_flex().id(`thread-content-${key}`).absolute().top(-s.offset / zoom).left(0).right(0)
        .when(s.glide && s.following, el => el.spring("top", { response: 320, damping: 1 }))
        .px(wide ? 28 : 16).pt(12).pb(24).when(wide, el => el.items_center())
        .on_size_change((size, cx) => measure(s.viewport, size.height, cx)).children(children))
      .when(Boolean(overlay), el => el.child(overlay))
      .when(s.max > 0, el => el.child(div().id(`thread-rail-${key}`).absolute().right(0).top(0).bottom(0).w(12)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); s.seek(e.local_position?.y ?? 0); cx.notify(); })
        .on_mouse_move(drag)
        .child(div().id(`thread-thumb-${key}`).absolute().top(top / zoom).right(3).w(5).h(height / zoom).rounded(3).bg(t.input)
          .hover(style => style.bg(t.dim)).cursor_pointer()
          .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.drag = { key, y: e.position.y, offset: s.offset }; })
          .on_mouse_up("left", (_e, cx) => { this.drag = null; cx.stop_propagation(); }))))
      .when(!s.following && Boolean(pill), el => el.child(h_flex().absolute().bottom(10).left(0).right(0).justify_center().child(pill)))
      .when(!s.following && !pill, el => el.child(h_flex().absolute().bottom(10).left(0).right(0).justify_center()
        .child(h_flex().id(`thread-latest-${key}`).h(32).px(12).gap(6).items_center().rounded(16)
          .bg(t.popover).border_1().border_color(t.input).shadow_sm().text_color(t.foreground).text_size(12).cursor_pointer()
          .tooltip("Jump to the latest reply and follow new messages · End")
          .on_click((_e, cx) => { s.latest(); cx.notify(); }).child(icon("down", 13)).child("Latest"))));
  }
}
