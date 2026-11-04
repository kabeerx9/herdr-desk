import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, run, shared, notify } from "herdr";
import { icon, pill, button, section, empty, card } from "./ui.js";
import { openTerminal } from "./desks.js";
import { runtimeData, runTeam, refreshRuntime, openDesk } from "./workflows.js";

// The Inbox tab: every agent, grouped by what it needs from me, with enough
// context (space › tab, what it's doing, branch, how long) to tell them apart.
const GROUPS = [
  { status: "blocked", title: "Needs you", label: "Needs you", color: "blocked" },
  { status: "done", title: "Finished", label: "Done", color: "done" },
  { status: "working", title: "Working", label: "Working", color: "working" },
  { status: "idle", title: "Idle", label: "Idle", color: "dim" },
];

// What the rail badge counts: agents waiting on me.
export function inboxCount() {
  const items = runtimeData().attention ?? [], covered = new Set(items.map((i) => i.address).filter(Boolean));
  const rest = agents().filter((a) => !covered.has(a.address) && ["blocked", "done"].includes(a.status));
  return { n: items.length + rest.length, blocked: items.some((i) => i.kind !== "done") || rest.some((a) => a.status === "blocked") };
}

function attentionCard(panel, t, item) {
  const id = `attention-${item.id}`, expanded = Boolean(panel.collapsed[id]);
  const open = () => item.task ? openDesk(item.task) : item.address ? openTerminal(item.address) : null;
  const session = (runtimeData().sessions ?? []).find((s) => s.address === item.address && s.state === "disconnected");
  const recoverable = item.kind === "disconnected" && session?.can_resume;
  const act = (args, cx) => {
    cx.spawn(async (cx) => {
      try { await runTeam(args); refreshRuntime(cx, true); }
      catch (e) { notify({ title: "Couldn't update the inbox", body: String(e?.message ?? e), level: "error", timeout: 6000 }); }
      cx.notify();
    });
  };
  return v_flex().id(id).mx(10).mb(7).px(10).py(9).gap(6).rounded(9).border_1().border_color(t.border).bg(t.raised)
    .child(h_flex().gap(6).items_center()
      .child(icon(item.kind === "disconnected" ? "terminal" : item.kind === "done" ? "check" : "bell", 13).text_color(item.kind === "done" ? t.done : t.blocked))
      .child(div().min_w(0).flex_1().truncate().text_size(12).font_semibold().text_color(t.foreground).child(item.title || item.kind))
      .child(div().text_size(10.5).text_color(t.dim).child(since(item.at) ?? "")))
    .child(div().h(16).flex_none().text_size(10.5).text_color(t.dim).truncate().child(item.desk_name ?? item.task ?? item.address ?? "Desk"))
    .when(Boolean(item.text), (el) => el.child(div().id(`${id}-text`).max_h(expanded ? 200 : 48).overflow_y_scrollbar().text_size(11.5).line_height(1.4).text_color(t.muted)
      .child(item.text)))
    .child(h_flex().gap(5).items_center().flex_wrap()
      .child(button(t, `${id}-open`, "Open", open, { primary: true, disabled: !item.task && !item.address }))
      .when(Boolean(recoverable), (el) => el.child(button(t, `${id}-resume`, "Resume", (_e, cx) => act(["recover", "--session", session.id], cx))))
      .when(Boolean(item.text?.length > 150), (el) => el.child(button(t, `${id}-more`, expanded ? "Less" : "Details", (_e, cx) => panel.toggle(id, cx))))
      .child(div().flex_1())
      .when(!["permission", "disconnected"].includes(item.kind), (el) => el.child(button(t, `${id}-dismiss`, "Acknowledge", (_e, cx) => act(["attention-dismiss", "--id", item.id], cx), { tip: "Mark this item seen; no message is sent" }))));
}

const since = (ms) => {
  if (!ms) return null;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

const shortPath = (cwd) => (cwd ? cwd.replace(/^\/Users\/[^/]+/, "~").split("/").slice(-2).join("/") : null);

function programIcon(t, program, color) {
  const glyph = program?.icon ? (program.tint ? svg(program.icon).size(15).text_color(color) : image(program.icon).w(15).h(15)) : icon("terminal", 15).text_color(color);
  return div().size(28).flex_none().rounded(7).flex().items_center().justify_center().bg(color + "1f").child(glyph);
}

function agentCard(panel, t, a, group, pane, tab) {
  const id = `inbox-${a.address}`, hovered = panel.hovered === id, color = t[group.color] ?? t.accent;
  const time = group.status === "working" ? since(tab?.working_since) : since(tab?.changed_at);
  const where = [a.program?.name, pane?.branch ?? shortPath(pane?.cwd)].filter(Boolean).join(" · ");
  return card(t, id, hovered).cursor_pointer().relative()
    .on_hover((h, cx) => panel.hover(id, h, cx))
    .on_click(() => openTerminal(a.address))
    .child(div().absolute().left(0).top(8).bottom(8).w(3).rounded(2).bg(color))
    .child(h_flex().pl(4).gap(10).items_start()
      .child(programIcon(t, a.program, color))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(4).items_center().min_w(0)
          .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(a.space_name))
          .child(div().flex_none().text_size(12).text_color(t.dim).child("›"))
          .child(div().truncate().text_size(12.5).text_color(t.muted).child(a.tab_name))
          .child(div().flex_1())
          .child(pill(t, time && group.status !== "idle" ? `${group.label} · ${time}` : group.label, color).flex_none()))
        .when(Boolean(a.title), (el) => el.child(div().truncate().text_size(12).text_color(t.foreground).child(a.title)))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(where))
          .when(hovered, (el) => el.child(button(t, `${id}-go`, "Go", () => openTerminal(a.address))))))
    );
}

export function inboxView(panel, t) {
  const list = agents();
  const attention = runtimeData().attention ?? [];
  const notices = v_flex().gap(2)
    .child(section(t, "attention-heading", "Needs you", attention.length, true, () => {}))
    .when(Boolean(shared("desk.runtime.error")), (el) => el.child(empty(t, "Session inbox unavailable: " + shared("desk.runtime.error"))))
    .children(attention.map((item) => attentionCard(panel, t, item)));
  if (!list.length) return v_flex().py(8).child(notices).when(!attention.length, (el) => el.child(empty(t, "Nothing waiting on you.")));
  const paneById = new Map(panes().map((p) => [p.pane, p]));
  const tabById = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
  return v_flex().py(8).child(notices).children(GROUPS.map((group) => {
    const members = list.filter((a) => a.status === group.status).sort((x, y) => y.seq - x.seq);
    if (!members.length) return null;
    const key = `inbox-${group.status}`;
    // Idle agents start folded (they rarely need anything), so for them the stored flag means shown.
    const open = group.status === "idle" ? Boolean(panel.collapsed[key]) : !panel.collapsed[key];
    return v_flex().pb(6)
      .child(section(t, key, group.title, members.length, open, (_e, cx) => panel.toggle(key, cx)))
      .when(open, (el) => el.gap(2).children(members.map((a) => agentCard(panel, t, a, group, paneById.get(a.pane), tabById.get(a.tab)))));
  }).filter(Boolean));
}
