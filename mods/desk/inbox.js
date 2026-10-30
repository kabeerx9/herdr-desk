import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, panes, spaces, run } from "herdr";
import { icon, pill, button, section, empty, card } from "./ui.js";

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
  const list = agents();
  return { n: list.filter((a) => a.status === "blocked" || a.status === "done").length, blocked: list.some((a) => a.status === "blocked") };
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
    .on_click(() => run("agent.focus", { terminal: a.address }))
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
          .when(hovered, (el) => el.child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: a.address }))))))
    );
}

export function inboxView(panel, t) {
  const list = agents();
  if (!list.length) return v_flex().py(8).child(empty(t, "No agents running."));
  const paneById = new Map(panes().map((p) => [p.pane, p]));
  const tabById = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
  return v_flex().py(8).children(GROUPS.map((group) => {
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
