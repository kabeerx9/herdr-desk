// "Delete this desk?", centered over the app. Opened as a dialog with props { deleteDesk: { slug, name } }.
// A dialog is its own mod copy, so it can't call the desk that opened it. It answers through
// shared "desk.delete", and that desk does the work. Enter confirms, Esc cancels.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, setShared, theme } from "herdr";
import { button } from "./ui.js";

export const DIALOG = { kind: "dialog", width: 400, height: 156 };

export class DeleteDialog {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  yes() {
    const p = props();
    setShared("desk.delete", { slug: p.deleteDesk.slug, at: Date.now() });
    closeOverlay(p.overlay);
  }

  no() { closeOverlay(props().overlay); }

  render(_cx) {
    const t = theme(), { name } = props().deleteDesk;
    return v_flex().id("delete-desk").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.yes();
        else if (e.key === "escape") this.no();
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Delete this desk?"))
      .child(div().flex_1().min_h(0).text_color(t.muted).child(`"${name}" leaves your desks. Its chat is kept, so you can put it back later.`))
      .child(h_flex().justify_end().gap(8)
        .child(button(t, "delete-no", "Cancel", () => this.no()))
        .child(button(t, "delete-yes", "Delete desk", () => this.yes(), { primary: true })));
  }
}
