import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, run, shared, notify } from "herdr";
import { icon, button, section, empty, statusMark, offMain, ROW } from "./ui.js";
import { openTerminal } from "./desks.js";
import { runtimeData, runTeam, refreshRuntime, openDesk, sessionOf, settledState, settledNote, triageIcons, snoozeChips } from "./workflows.js";

// The Inbox tab: every agent, grouped by what it needs from me, with enough
// context (space › tab, what it's doing, branch, how long) to tell them apart.
const GROUPS = [
  { status: "blocked", title: "Needs you", label: "Needs you", color: "blocked" },
  { status: "done", title: "Finished", label: "Done", color: "done" },
  { status: "working", title: "Working", label: "Working", color: "working" },
  { status: "idle", title: "Idle", label: "Idle", color: "dim" },
];

// What the rail badge counts: agents waiting on me.
// A settled or snoozed agent's reports wait on its shelf; permissions and disconnects never do.
const putAway = (item) => item.address && !["permission", "disconnected"].includes(item.kind)
  && settledState(sessionOf(item.address), agents().find((a) => a.address === item.address)?.status);
const waiting = () => (runtimeData().attention ?? []).filter((i) => !putAway(i));

export function inboxCount() {
  const items = waiting(), covered = new Set(items.map((i) => i.address).filter(Boolean));
  const rest = agents().filter((a) => !covered.has(a.address) && ["blocked", "done"].includes(a.status) && !settledState(sessionOf(a.address), a.status));
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
  const live = item.address ? agents().find((a) => a.address === item.address) : null;
  const canPut = item.address && !["permission", "disconnected"].includes(item.kind) && !["working", "blocked"].includes(live?.status);
  return v_flex().id(id).mx(8).mb(6).px(12).py(10).gap(6).rounded(10).border_1().border_color(t.border).bg(t.background)
    .child(h_flex().gap(8).items_center()
      .child(statusMark(t, ATTENTION_MARK[item.kind] ?? "blocked", 12))
      .child(div().min_w(0).flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground).child(item.title || item.kind))
      .child(div().text_size(10.5).text_color(t.dim).child(since(item.at) ?? "")))
    .child(div().h(16).flex_none().text_size(11).text_color(t.dim).truncate().child(item.desk_name ?? item.task ?? item.address ?? "Desk"))
    .when(Boolean(item.text), (el) => el.child(div().id(`${id}-text`).max_h(expanded ? 200 : 48).overflow_y_scrollbar().text_size(12).line_height(1.5).text_color(t.muted)
      .child(item.text)))
    .child(h_flex().gap(5).items_center().flex_wrap()
      .child(button(t, `${id}-open`, "Open", open, { primary: true, disabled: !item.task && !item.address }))
      .when(Boolean(recoverable), (el) => el.child(button(t, `${id}-resume`, "Resume", (_e, cx) => act(["recover", "--session", session.id], cx))))
      .when(Boolean(item.text?.length > 150), (el) => el.child(button(t, `${id}-more`, expanded ? "Less" : "Details", (_e, cx) => panel.toggle(id, cx))))
      .child(div().flex_1())
      .when(Boolean(canPut), (el) => el.children(triageIcons(t, id, panel, item.address, false)))
      .when(!["permission", "disconnected"].includes(item.kind), (el) => el.child(button(t, `${id}-dismiss`, "Acknowledge", (_e, cx) => act(["attention-dismiss", "--id", item.id], cx), { variant: "ghost", tip: "Mark this item seen; no message is sent" }))))
    .when(Boolean(canPut), (el) => el.child(snoozeChips(t, id, panel, item.address, { indent: 0 }) ?? div()));
}
const ATTENTION_MARK = { disconnected: "disconnected", done: "done", failed: "failed", uncertain: "failed", permission: "blocked", blocked: "blocked", ask: "blocked" };

const since = (ms) => {
  if (!ms) return null;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

const shortPath = (cwd) => (cwd ? cwd.replace(/^\/Users\/[^/]+/, "~").split("/").slice(-2).join("/") : null);

// One agent, one 28px row: its mark, space › tab (or its session's title), where, how long.
// Hover: settle / snooze when it's a desk session, else Go.
function agentRow(panel, t, a, group, pane, tab, put) {
  const id = `inbox-${a.address}`, hovered = panel.hovered === id, s = sessionOf(a.address);
  const time = group.status === "working" ? since(tab?.working_since) : since(tab?.changed_at);
  const where = put ? settledNote(s) : [offMain(pane?.branch) ? pane.branch : shortPath(pane?.cwd), time].filter(Boolean).join(" · ");
  const name = s?.title || a.title || a.tab_name;
  const actions = s ? triageIcons(t, id, panel, a.address, Boolean(put)) : [];
  return v_flex().child(h_flex().id(id).h(ROW).mx(8).px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .bg(hovered ? t.hover : "#00000000")
    .on_hover((h, cx) => panel.hover(id, h, cx))
    .on_click(() => openTerminal(a.address))
    .tooltip(`${a.space_name} › ${a.tab_name}${a.program?.name ? ` · ${a.program.name}` : ""}`)
    .child(h_flex().w(14).flex_none().justify_center().child(statusMark(t, a.status, 12)))
    .child(div().flex_none().max_w(110).truncate().text_size(13).font_medium().text_color(put ? t.muted : t.foreground).child(a.space_name))
    .child(div().min_w(0).flex_shrink_1().truncate().text_size(12).text_color(t.dim).child(name))
    .child(div().flex_1())
    .when(!hovered || !actions.length, (el) => el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(where)))
    .when(hovered && actions.length > 0, (el) => el.child(h_flex().flex_none().gap(1).children(actions))))
    .child(snoozeChips(t, id, panel, a.address, { indent: 38 }) ?? div());
}

// Never re-sort under the pointer: while it's over the list, each agent keeps the group it was in.
let held = null;
function groupOf(a) {
  if (held?.has(a.address)) return held.get(a.address);
  return settledState(sessionOf(a.address), a.status) ? "settled" : a.status;
}

export function inboxView(panel, t) {
  const list = agents();
  const attention = waiting();
  const notices = v_flex().gap(2)
    .child(section(t, "attention-heading", "Needs you", attention.length, true, () => {}))
    .when(Boolean(shared("desk.runtime.error")), (el) => el.child(empty(t, "Session inbox unavailable: " + shared("desk.runtime.error"))))
    .children(attention.map((item) => attentionCard(panel, t, item)));
  if (!list.length) return v_flex().py(8).child(notices).when(!attention.length, (el) => el.child(empty(t, "Nothing waiting on you. Agents that need you land here.")));
  const paneById = new Map(panes().map((p) => [p.pane, p]));
  const tabById = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
  const groupBy = new Map(list.map((a) => [a.address, groupOf(a)]));
  return v_flex().id("inbox-list").py(8)
    .on_hover((inside, cx) => { held = inside ? groupBy : null; if (!inside) cx.notify(); })
    .child(notices).children([...GROUPS, SETTLED].map((group) => {
      const members = list.filter((a) => groupBy.get(a.address) === group.status).sort((x, y) => y.seq - x.seq);
      if (!members.length) return null;
      const key = `inbox-${group.status}`;
      // Idle and Settled start folded (they rarely need anything), so for them the stored flag means shown.
      const quiet = group.status === "idle" || group.status === "settled";
      const open = quiet ? Boolean(panel.collapsed[key]) : !panel.collapsed[key];
      return v_flex().pb(6)
        .child(section(t, key, group.title, members.length, open, (_e, cx) => panel.toggle(key, cx)))
        .when(open, (el) => el.children(members.map((a) => agentRow(panel, t, a, group, paneById.get(a.pane), tabById.get(a.tab), group.status === "settled"))));
    }).filter(Boolean));
}
const SETTLED = { status: "settled", title: "Settled", label: "Settled", color: "dim" };
