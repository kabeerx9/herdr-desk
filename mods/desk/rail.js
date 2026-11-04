import { div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, shared, setShared } from "herdr";
import { TABS, currentTab, isOpen, setOpen, choose } from "./tabs.js";
import { fetchUsage, railMeters, openLimits } from "./usage.js";
import { inboxCount } from "./inbox.js";
import { showTerminals } from "./desks.js";
import { RuntimeWatch } from "./workflows.js";

// The always-visible edge of the Desk: one icon per tab, a badge for counts.
export class Rail {
  init(_props, cx) {
    this.hovered = null;
    this.runtime = new RuntimeWatch();
    this.runtime.init(cx);
    // Bring the panel back the way it was left.
    setOpen(isOpen());
    // The rail is always shown, so it keeps usage fresh for both copies.
    fetchUsage(cx);
    cx.timer.every(300000, (cx) => fetchUsage(cx));
  }

  // ⌘⇧J is "desk.toggle"; `herdr-app do desk.<tab>` opens a tab.
  command(c) {
    // desk.claude-limits / desk.codex-limits: the same popover a logo click opens.
    if (c.endsWith("-limits")) return openLimits(c[0].toUpperCase() + c.slice(1, -"-limits".length));
    // desk.chat (⌘E in the desk-chat layout): the center between the chat and the terminals.
    if (c === "chat") return showTerminals(!shared("deskchat.terminals"));
    // desk.new-here: a fresh desk for the current space, in the chat (what a space click does there).
    if (c === "new-here") { setShared("desk.here", { at: Date.now() }); setShared("desk.view", "new"); return showTerminals(false); }
    // desk.open-<slug>: that desk's chat (a permission toast's click).
    if (c.startsWith("open-")) {
      setShared("desk.view", c.slice(5));
      if (shared("layout") === "desk-chat") return showTerminals(false);
      setShared("desk.tab", "desks");
      return setOpen(true);
    }
    if (c === "toggle") setOpen(!isOpen());
    else if (TABS.some((t) => t.id === c) && !(isOpen() && currentTab() === c)) choose(c);
  }

  // Quiet by default: 28px icon buttons, a hover fill, the open panel's tab selected. A badge
  // only for what needs Kabeer (the inbox's blocked/permission count, in the blocked colour);
  // every other count lives in the tooltip.
  render() {
    const t = theme(), open = isOpen(), active = currentTab(), counts = shared("desk.counts") ?? {}, inbox = inboxCount();
    return v_flex().id("desk-rail").size_full().pt(10).gap(4).items_center().bg(t.chrome)
      .children(TABS.map((tab) => {
        const on = open && tab.id === active, hovered = this.hovered === tab.id;
        const n = tab.id === "inbox" ? inbox.n : counts[tab.id] ?? 0;
        const needs = tab.id === "inbox" ? inbox.needs ?? 0 : 0;
        const tip = needs ? `${tab.label} · ${needs} need${needs === 1 ? "s" : ""} you` : n ? `${tab.label} · ${n}` : tab.label;
        return div().id(`rail-${tab.id}`).relative().size(28).flex().items_center().justify_center().rounded(8).cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .when(!on && hovered, (el) => el.bg(t.hover))
          .text_color(on || hovered ? t.foreground : t.dim)
          .tooltip(tip)
          .on_hover((h, cx) => { this.hovered = h ? tab.id : this.hovered === tab.id ? null : this.hovered; cx.notify(); })
          .on_click(() => choose(tab.id))
          .child(svg(`mods/desk/icons/${tab.icon}.svg`).size(15))
          // A chrome ring cuts the badge from the icon.
          .when(needs > 0, (el) => el.child(div().absolute().top(-3).right(-4).min_w(14).h(14).px(3).rounded(7).border_2().border_color(t.chrome)
            .flex().items_center().justify_center().bg(t.blocked)
            .text_color(t.background).text_size(9).font_semibold().child(needs > 9 ? "9+" : String(needs))));
      }))
      .child(div().flex_1())
      .child(railMeters(t));
  }
}
