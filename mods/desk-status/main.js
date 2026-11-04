import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys } from "herdr";

export default class WorkspaceStatus extends View {
  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // A quiet 24px bar: only what's useful. The machine only when it's remote, the branch, how many
  // agents are working and, in the blocked colour, how many need Kabeer.
  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const working = list.filter(a => a.status === "working").length;
    const label = (icon, text) => h_flex().gap(5).items_center().child(svg(`mods/desk-chrome/${icon}.svg`).size(12)).child(text);
    return h_flex().size_full().px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .when(Boolean(space?.machine), el => el.child(label("server", space.machine)))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(div().child(working ? `${working} of ${list.length} working` : `${list.length} agents`))
      .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`${needs} need${needs === 1 ? "s" : ""} you`)))
      .child(div().flex_1())
      .child(div().id("palette").cursor_pointer().hover(s => s.text_color(t.foreground)).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
