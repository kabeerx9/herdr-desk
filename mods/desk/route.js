import { div, svg } from "gpui-kit";
import { renderBlocks } from "./blocks.js";
import { h_flex, v_flex, TextView } from "gpui-base";
import { icon, statusMark, shownStatus } from "./ui.js";
import { contextMeter } from "./model.js";
import { subagents, mineBubble, commandChip, commandResult, commandNote, FACE } from "./timeline.js";

// A member's own conversation (shared "desk.route" = { task, address }): T3's thread-per-route.
// Rows come from model.js buildRouteRows over `team transcript`, fetched by desks.js on the
// step feed's wake; this file only draws.

export const routeKey = (address) => `route-${address}`;
const STATUS = { blocked: "needs you", done: "done", working: "working", idle: "idle" };
const clock = (ms) => {
  if (!ms) return "";
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${new Date().toDateString() === d.toDateString() ? "" : `${d.getDate()}/${d.getMonth() + 1} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function action(t, id, label, name, tip, onClick, { disabled = false } = {}) {
  return h_flex().id(id).h(26).px(8).gap(5).items_center().rounded(7).flex_none().text_size(12)
    .text_color(disabled ? t.dim : t.muted).tooltip(tip)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) onClick(e, cx); })
    .child(icon(name, 13)).child(label);
}

// "‹ Desk name / [tile] Backend ● · model · ctx" … Terminal · Changes · Compact · Fresh start.
export function routeHeader(o, t, d, m) {
  const role = o.roles.byId(m.role), name = role?.name ?? m.role;
  const claude = !role?.cli || role.cli === "claude";
  const model = role?.label ?? role?.model ?? null;
  const meter = contextMeter(o.timelines[m.address]?.context);
  const status = m.status === "blocked" ? "blocked" : m.status === "working" ? "working" : m.status === "done" ? "done" : "idle";
  return h_flex().id("route-head").h(32).gap(6).items_center().text_size(12.5)
    .child(h_flex().id("route-back").h(26).pl(4).pr(8).gap(4).items_center().rounded(7).flex_none().cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Back to the team chat")
      .on_click((_e, cx) => o.closeRoute(cx))
      .child(div().w(12).flex().justify_center().child(svg("mods/desk/icons/back.svg").size(12)))
      .child(div().max_w(180).truncate().child(d.name)))
    .child(div().flex_none().text_color(t.dim).child("/"))
    .child(h_flex().flex_none().gap(7).items_center()
      .child(o.face(t, m.role, m.address, 18))
      .child(div().font_semibold().text_color(t.foreground).child(name))
      .child(div().id("route-status").tooltip(STATUS[m.status] ?? "starting").child(statusMark(t, shownStatus(status, m.address), 12))))
    .when(Boolean(model), (el) => el.child(div().flex_none().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(model)))
    .when(Boolean(meter), (el) => el.child(div().flex_none().text_size(11.5).text_color(meter.level === "normal" ? t.dim : t.blocked).child(meter.label)))
    .child(div().flex_1())
    .child(action(t, "route-term", "Terminal", "terminal", `Open ${name}'s terminal`, () => o.openTerminal(m.address)))
    .child(action(t, "route-changes", "Changes", "branch", "Review this agent's changes", (_e, cx) => o.openReview(m, d, cx)))
    .when(claude, (el) => el
      .child(action(t, "route-compact", o.acting === `compact-${m.address}` ? "Compacting…" : "Compact", "collapse",
        "Claude's /compact: same session, the history becomes a summary", (_e, cx) => o.compact(m, cx),
        { disabled: Boolean(o.acting) || m.handingOff || m.status === "working" || m.status === "blocked" }))
      .child(action(t, "route-fresh", m.handingOff ? "Handing off…" : "Fresh start", "play",
        "It writes a handoff, then a new session of it takes over", (_e, cx) => o.freshStart(m, cx),
        { disabled: Boolean(o.acting) || m.handingOff || m.status === "working" })));
}

// One row of a member's conversation. Yours: the raised bubble; commands: a chip; the CTO or the
// Desk talking to it: a quiet aside with who; its replies: plain prose, its tool run folded above.
export function routeRow(o, t, key, row, { role, now, member }) {
  const x = row.x, id = `rt-${key}-${row.key}`, size = o.wide ? 14 : 13;
  if (row.type === "event") return h_flex().id(id).justify_center().pt(16).pb(2)
    .child(div().text_size(11).text_color(t.dim).child(`${x.text} · ${clock(x.at)}`));
  if (row.type === "command") return commandChip(o, t, id, x.text, clock(x.at));
  if (row.type === "result") return commandResult(o, t, id, role?.name ?? x.outcome?.from ?? "", x.outcome?.command ?? "", x.text, clock(x.at));
  if (row.type === "note") return commandNote(o, t, id, x.outcome ?? x, clock(x.at));
  if (row.type === "mine") return mineBubble(o, t, id, x.text, x.via === "chat" ? `From the desk chat · ${clock(x.at)}` : `In its terminal · ${clock(x.at)}`);
  if (row.type === "notice") {
    const from = x.who === "parent" ? (o.nameOfAddress?.(x.from) ?? x.from ?? "Another agent") : "Desk";
    return v_flex().id(id).gap(4).pt(o.wide ? 22 : 16)
      .child(h_flex().h(20).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(icon(x.who === "parent" ? "team" : "chat", 12))
        .child(div().text_color(t.muted).child(`From ${from}`))
        .child(div().child(clock(x.at))))
      .child(div().pl(18).max_h(o.expanded.has(id) ? 100000 : 150).overflow_hidden().text_size(size - 1).line_height(1.55).text_color(t.muted)
        .child(TextView.markdown(`${id}-md`, x.text).selectable(true)))
      .when(x.text.length > 500 && !o.expanded.has(id), (el) => el.child(div().id(`${id}-more`).pl(18).text_size(12).text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { o.expanded.add(id); cx.notify(); }).child("Show more")));
  }
  // An agent reply: its face (once per run of replies), the work before it ("Worked · read 4 files,
  // ran 2 commands"), subagents, then the text.
  const subs = x.subagents ?? [];
  const column = v_flex().min_w(0).flex_1().gap(6)
    .when(!row.grouped, (el) => el.child(h_flex().h(FACE).gap(8).items_center()
      .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(role?.name ?? member?.role ?? "Agent"))
      .when(Boolean(x.at), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(clock(x.at))))))
    .when(Boolean(x.tools?.summary), (el) => el.child(h_flex().h(22).gap(6).items_center().text_size(12).text_color(t.dim)
      .child(div().min_w(0).truncate().child(`Worked · ${x.tools.summary[0].toLowerCase()}${x.tools.summary.slice(1)}`))
      .when(Boolean(x.tools.failed), (y) => y.child(h_flex().flex_none().gap(4).items_center().child(statusMark(t, "failed", 10)).child(`${x.tools.failed} failed`)))))
    .when(subs.length > 0, (el) => el.child(subagents(o, t, `${id}-subs`, subs, now)))
    .when(Boolean(x.text), (el) => el.child(div().text_size(size).line_height(1.6).text_color(t.foreground)
      .child(renderBlocks(t, `${id}-md`, x.text, { size, onReply: (text, cx) => { o.input.set_value(text); o.send(cx); } }))));
  return v_flex().id(id).pt(row.grouped ? 8 : o.wide ? 18 : 14)
    .child(h_flex().w_full().items_start().gap(10)
      .child(row.grouped ? div().w(FACE).flex_none() : o.face(t, member?.role ?? role?.id, member?.address, FACE))
      .child(column));
}

// Above the transcript: what this view is, when there's nothing (yet) or it can't be read.
export function routeEmpty(t, name, state) {
  const line = state?.supported === false ? `${name} runs a CLI whose conversation the Desk can't read. Its terminal has it all.`
    : state?.error ? `Couldn't read ${name}'s conversation: ${state.error}` : state ? `Nothing in ${name}'s conversation yet.` : `Loading ${name}'s conversation…`;
  return v_flex().id("route-empty").py(28).gap(6).items_center()
    .child(div().text_size(14).font_semibold().text_color(t.foreground).child(`${name}'s own conversation`))
    .child(div().max_w(340).text_size(12).line_height(1.5).text_color(t.muted).text_center().child(line));
}

// The slash menu over the composer (T3's command drawer): icon, /name, description; the
// highlighted row filled. Mouse picks; ↑/↓/Tab/Enter/Esc are handled by desks.js.
export function commandMenu(o, t, items, index) {
  const body = items.length
    ? items.map((c, i) => h_flex().id(`cmd-${c.kind}-${c.name}`).h(32).px(10).gap(10).items_center().rounded(8).cursor_pointer()
      .when(i === index, (el) => el.bg(t.selected))
      .hover((s) => s.bg(i === index ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => o.pickCommand(c, cx))
      .child(icon(c.icon, 14).text_color(i === index ? t.foreground : t.muted))
      .child(div().flex_none().w(104).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(`/${c.name}`))
      .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.muted).child(c.desc))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(c.kind === "desk" ? "Desk" : c.cli === "codex" ? "Codex" : "Claude")))
    : [div().px(10).py(8).text_size(12).text_color(t.muted).child("No matching command. Enter sends it to the agent as typed.")];
  return v_flex().id("cmd-menu").w_full().max_h(300).overflow_y_scrollbar().p(4).gap(1).rounded(12).border_1().border_color(o.light ? t.input : t.border).bg(t.popover).shadow_md()
    .children(body);
}

