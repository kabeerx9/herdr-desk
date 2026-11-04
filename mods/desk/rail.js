import { div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, shared } from "herdr";
import { TABS, currentTab, isOpen, setOpen, choose } from "./tabs.js";
import { fetchUsage, railMeters, openLimits } from "./usage.js";
import { inboxCount } from "./inbox.js";
import { showTerminals } from "./desks.js";

// The always-visible edge of the Desk: one icon per tab, a badge for counts.
export class Rail {
  init(_props, cx) {
    this.hovered = null;
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
    if (c === "toggle") setOpen(!isOpen());
    else if (TABS.some((t) => t.id === c) && !(isOpen() && currentTab() === c)) choose(c);
  }

  render() {
    const t = theme(), open = isOpen(), active = currentTab(), counts = shared("desk.counts") ?? {}, inbox = inboxCount();
    return v_flex().id("desk-rail").size_full().pt(10).gap(4).items_center().bg(t.chrome)
      .children(TABS.map((tab) => {
        const on = open && tab.id === active, n = tab.id === "inbox" ? inbox.n : counts[tab.id], hovered = this.hovered === tab.id;
        return div().id(`rail-${tab.id}`).relative().size(34).flex().items_center().justify_center().rounded(8).cursor_pointer()
          .bg(on ? t.selected : hovered ? t.hover : "#00000000")
          .text_color(on ? t.foreground : hovered ? t.foreground : t.muted)
          .tooltip(tab.label)
          .on_hover((h, cx) => { this.hovered = h ? tab.id : this.hovered === tab.id ? null : this.hovered; cx.notify(); })
          .on_click(() => choose(tab.id))
          .child(svg(`mods/desk/icons/${tab.icon}.svg`).size(17))
          .when(on, (el) => el.child(div().absolute().right(-7).top(9).w(3).h(16).rounded(2).bg(t.accent)))
          .when(Boolean(n), (el) => el.child(div().absolute().top(2).right(1).min_w(14).h(14).px(3).rounded(7)
            .flex().items_center().justify_center().bg(tab.id === "git" || (tab.id === "inbox" && inbox.blocked) ? t.blocked : tab.id === "inbox" ? t.done : t.accent)
            .text_color(t.accent_foreground).text_size(9).font_semibold().child(n > 99 ? "99+" : String(n))));
      }))
      .child(div().flex_1())
      .child(railMeters(t));
  }
}
