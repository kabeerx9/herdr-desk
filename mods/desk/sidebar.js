import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, theme, run, layout, setAgentOrder, shared } from "herdr";
import { Roles, sessions, startRole, roleTile } from "./roles.js";

// The sidebar's agent list: the team's roles (each with its own status), then any
// other agent only while it's working or needs you. Idle and done agents that
// aren't a role stay out; the Desk's Inbox still lists every agent.

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
// Narrow like the shipped list: the sidebar dragged or collapsed to a rail.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function programIcon(p, size) {
  if (!p?.icon) return svg("mods/desk/icons/terminal.svg").size(size).flex_none();
  return p.tint ? svg(p.icon).size(size).flex_none() : image(p.icon).w(size).h(size).flex_none();
}

export class Sidebar {
  init(_props, cx) {
    this.roles = new Roles();
    this.hovered = null;
    this.roles.load(cx);
    cx.timer.every(5000, (cx) => this.roles.load(cx));
  }

  hover(id, on, cx) {
    if (on) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  // Working: a spinner; needs you: a badge; done: a dot; idle: a ring.
  status(t, status, compact) {
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (status === "blocked") return compact
      ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
    if (status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return null;
  }

  row(t, id, { lead, name, detail, status, focused, dim, onClick, hoverChild, indent = 0, height = 30 }) {
    const hovered = this.hovered === id;
    return h_flex().id(id).h(height).pl(8 + indent).pr(8).flex_none().rounded(8).items_center().gap(9).cursor_pointer()
      .when(focused, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => this.hover(id, h, cx))
      .on_click(onClick)
      .when(Boolean(lead), (el) => el.child(lead))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).flex_none().max_w(130).truncate().text_color(dim ? t.muted : t.foreground).child(name))
        .when(Boolean(detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`· ${detail}`))))
      .when(hovered && Boolean(hoverChild), (el) => el.child(hoverChild))
      .when(!(hovered && hoverChild) && Boolean(status), (el) => el.child(status));
  }

  header(t, id, label, count) {
    return h_flex().id(id).px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(t.dim).child(label))
      .when(count !== undefined, (el) => el.child(div().text_color(t.dim).child(String(count))));
  }

  render() {
    const t = theme(), compact = narrow(), all = agents(), roles = this.roles.list ?? [];
    const roleTabs = new Set(roles.map((r) => r.name));
    const team = roles.map((role) => ({ role, live: sessions(role, all) }));
    const others = all.filter((a) => !roleTabs.has(a.tab_name) && (a.status === "working" || a.status === "blocked"))
      .sort((x, y) => (x.status === "blocked" ? 0 : 1) - (y.status === "blocked" ? 0 : 1) || y.seq - x.seq);
    setAgentOrder([...team.flatMap((m) => m.live.map((a) => a.address)), ...others.map((a) => a.address)]);
    const focus = (a) => () => run("pane.focus", { pane: a.pane });

    if (compact) {
      // The rail: role tiles with a status dot in the corner, then the other busy agents.
      const dot = (status) => status && status !== "idle"
        ? div().absolute().right(-2).bottom(-2).size(9).rounded(5).border(2).border_color(t.chrome).bg(t[status] ?? t.dim) : null;
      const tile = (id, child, status, onClick, tip) => h_flex().id(id).h(32).flex_none().items_center().justify_center().rounded(8)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick)
        .child(div().relative().child(child).when(Boolean(dot(status)), (el) => el.child(dot(status))));
      return v_flex().size_full().min_h(0).pt(6).bg(t.chrome).border_t(1).border_color(t.border)
        .child(v_flex().id("ag-list").flex_1().min_h(0).px(4).gap(2).overflow_y_scrollbar()
          .children(team.map(({ role, live }) => tile(`rr-${role.name}`, roleTile(div, svg, t, role, 22, !live.length), live[0]?.status,
            live[0] ? focus(live[0]) : () => startRole(role, { roles: this.roles.list }), live[0] ? role.name : `Start ${role.name}`)))
          .children(others.map((a) => tile(`ro-${a.address}`, programIcon(a.program, 16), a.status, focus(a), `${a.space_name} · ${a.tab_name}`))));
    }

    const briefs = shared("desk.counts")?.team ?? 0;
    const rows = [this.header(t, "h-team", "Team")];
    for (const { role, live } of team) {
      const top = live[0], id = `r-${role.name}`;
      const start = div().id(`${id}-start`).flex_none().p(3).rounded(5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(top ? `Start another ${role.name}` : `Start ${role.name}`)
        .on_click((_e, cx) => { cx.stop_propagation(); startRole(role, { roles: this.roles.list }); })
        .child(svg("mods/desk/icons/plus.svg").size(12));
      rows.push(this.row(t, id, {
        lead: roleTile(div, svg, t, role, 22, !top),
        name: role.name,
        detail: role.id === "cto" && briefs ? `${briefs} brief${briefs > 1 ? "s" : ""} waiting`
          : top ? (live.length > 1 ? `${live.length} running` : top.space_name) : role.label ?? role.model,
        status: top && this.status(t, top.status, false),
        focused: live.some((a) => a.focused),
        dim: !top,
        onClick: top ? focus(top) : () => startRole(role, { roles: this.roles.list }),
        hoverChild: start,
      }));
      // More than one of a role: each one under it, by where it runs.
      if (live.length > 1) for (const a of live) {
        rows.push(this.row(t, `${id}-${a.address}`, {
          name: a.space_name, detail: a.title && a.title !== role.name ? a.title : null,
          status: this.status(t, a.status, true), focused: a.focused, dim: a.status === "idle",
          onClick: focus(a), indent: 31, height: 26,
        }));
      }
    }
    if (others.length) {
      rows.push(this.header(t, "h-other", "Other agents", others.length));
      for (const a of others) rows.push(this.row(t, `o-${a.address}`, {
        lead: div().text_color(t.foreground).child(programIcon(a.program, 16)),
        name: a.space_name, detail: /^\d+$/.test(a.tab_name) ? a.title || null : a.tab_name,
        status: this.status(t, a.status, false), focused: a.focused, onClick: focus(a),
      }));
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
        .child(div().flex_1())
        .when(Boolean(this.roles.error), (el) => el.child(div().text_size(11).text_color(t.blocked).tooltip(this.roles.error).child("roles.json error"))))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(rows));
  }
}
