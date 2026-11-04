import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, theme, run, layout, setAgentOrder, setShared, home, exec, watchFolder } from "herdr";
import { Roles, labelsByAddress, roleTile } from "./roles.js";
import { setOpen } from "./tabs.js";
import { chatLayout, showTerminals } from "./desks.js";
import { statusBadge } from "./ui.js";

// The sidebar's agent list: every desk (its agents under it, each with its status;
// a quiet desk is one row), then any other agent only while it's working or needs
// you. Idle and done agents outside a desk stay out; the Inbox still lists every agent.

// slug \t mtime \t first line, per desk thread.
const DESKS = `cd "$1" 2>/dev/null || exit 0
for f in *.jsonl; do [ -f "$f" ] || continue
  printf '%s\\t%s\\t%s\\n' "\${f%.jsonl}" "$(stat -f %m "$f")" "$(head -n1 "$f")"
done`;

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
    this.desks = [];   // every desk thread: { slug, name, project, at }
    this.roles.load(cx);
    cx.timer.every(5000, (cx) => this.roles.load(cx));
    cx.spawn(async (cx) => {
      const dir = `${home()}/.herdr/team`;
      await exec("mkdir", ["-p", dir]);
      for (;;) { await this.loadDesks(cx, dir); await watchFolder(dir); }
    });
  }

  async loadDesks(cx, dir) {
    try {
      const r = await exec("sh", ["-c", DESKS, "desks", dir]);
      this.desks = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [slug, mtime, first] = line.split("\t");
        let head = null;
        try { head = JSON.parse(first); } catch {}
        return { slug, name: head?.kind === "desk" ? head.name : slug, project: head?.project ?? null, at: Number(mtime) * 1000 };
      }).sort((a, b) => b.at - a.at);
    } catch {}
    cx.notify();
  }

  openDesk(view) {
    setShared("desk.view", view);
    // In desk-chat the chat is the main view; elsewhere it's the panel's Desks tab.
    if (chatLayout()) return showTerminals(false);
    setShared("desk.tab", "desks");
    setOpen(true);
  }

  hover(id, on, cx) {
    if (on) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  // The shared badge; the rail (compact) keeps its dots.
  status(t, status) { return statusBadge(t, status); }

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

  header(t, id, label, { onClick, extra } = {}) {
    return h_flex().id(id).px(8).pt(10).h(32).flex_none().gap(6).items_center().text_size(11).font_medium().rounded(6)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(onClick))
      .child(div().min_w(0).truncate().text_color(t.dim).child(label))
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  render() {
    const t = theme(), compact = narrow(), all = agents(), labels = labelsByAddress();
    // Desks: agents labeled task=<desk> role=<role>, CTO first, most urgent next.
    const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
    const desks = new Map();
    for (const a of all) {
      const l = labels.get(a.address) ?? {};
      if (!l.role) continue;
      const key = l.task ?? "";
      desks.set(key, [...(desks.get(key) ?? []), { a, role: this.roles.byId(l.role), id: l.role, note: l.note }]);
    }
    for (const list of desks.values()) list.sort((x, y) => (x.id === "cto" ? -1 : y.id === "cto" ? 1 : (RANK[x.a.status] ?? 9) - (RANK[y.a.status] ?? 9)));
    const groups = [...desks].sort(([, x], [, y]) => Math.min(...x.map((m) => RANK[m.a.status] ?? 9)) - Math.min(...y.map((m) => RANK[m.a.status] ?? 9)));
    const inDesk = new Set(groups.flatMap(([, list]) => list.map((m) => m.a.address)));
    const others = all.filter((a) => !inDesk.has(a.address) && (a.status === "working" || a.status === "blocked"))
      .sort((x, y) => (x.status === "blocked" ? 0 : 1) - (y.status === "blocked" ? 0 : 1) || y.seq - x.seq);
    setAgentOrder([...groups.flatMap(([, list]) => list.map((m) => m.a.address)), ...others.map((a) => a.address)]);
    // In desk-chat the terminals sit behind the chat: bring them forward first.
    const focus = (a) => () => { showTerminals(true); run("pane.focus", { pane: a.pane }); };
    const meta = new Map(this.desks.map((d) => [d.slug, d]));
    const name = (slug) => (slug ? meta.get(slug)?.name ?? slug : "No desk");
    // Desks with nobody running, newest first (the Desks tab has the rest).
    const quiet = this.desks.filter((d) => !desks.has(d.slug));
    const QUIET = 6;
    const tile = (m, size, dim) => (m.role ? roleTile(div, svg, t, m.role, size, dim) : div().size(size).rounded(6).bg(t.raised));

    if (compact) {
      // The rail: each desk's tiles with a status dot, a gap between desks, then the other busy agents.
      const dot = (status) => status && status !== "idle"
        ? div().absolute().right(-2).bottom(-2).size(9).rounded(5).border(2).border_color(t.chrome).bg(t[status] ?? t.dim) : null;
      const cell = (id, child, status, onClick, tip) => h_flex().id(id).h(32).flex_none().items_center().justify_center().rounded(8)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick)
        .child(div().relative().child(child).when(Boolean(dot(status)), (el) => el.child(dot(status))));
      return v_flex().size_full().min_h(0).pt(6).bg(t.chrome).border_t(1).border_color(t.border)
        .child(v_flex().id("ag-list").flex_1().min_h(0).px(4).gap(2).overflow_y_scrollbar()
          .child(cell("rr-new", svg("mods/desk/icons/plus.svg").size(14).text_color(t.dim), null, () => this.openDesk("new"), "New desk"))
          .children(groups.flatMap(([slug, list], i) => [
            ...(i ? [div().mx(8).my(3).h(1).bg(t.border)] : []),
            ...list.map((m) => cell(`rr-${m.a.address}`, tile(m, 22, false), m.a.status, focus(m.a), `${name(slug)} · ${m.role?.name ?? m.id}`)),
          ]))
          .children(quiet.slice(0, QUIET).map((d) => cell(`rq-${d.slug}`, svg("mods/desk/icons/chat.svg").size(15).text_color(t.dim), null, () => this.openDesk(d.slug), d.name)))
          .children(others.map((a) => cell(`ro-${a.address}`, programIcon(a.program, 16), a.status, focus(a), `${a.space_name} · ${a.tab_name}`))));
    }

    const rows = [];
    for (const [slug, list] of groups) {
      const open = div().id(`dh-${slug}-open`).flex_none().px(5).h(18).rounded(5).flex().items_center().text_size(10.5).text_color(t.dim)
        .hover((s) => s.bg(t.raised).text_color(t.foreground)).child("Chat");
      rows.push(this.header(t, `dh-${slug}`, name(slug), { onClick: slug ? () => this.openDesk(slug) : undefined, extra: slug ? open : undefined }));
      for (const m of list) rows.push(this.row(t, `r-${m.a.address}`, {
        lead: tile(m, 22, m.a.status === "idle"),
        name: m.role?.name ?? m.id,
        detail: m.note ?? null,
        status: this.status(t, m.a.status, false),
        focused: m.a.focused,
        dim: m.a.status === "idle",
        onClick: focus(m.a),
      }));
    }
    for (const d of quiet.slice(0, QUIET)) rows.push(this.row(t, `q-${d.slug}`, {
      lead: h_flex().size(22).flex_none().items_center().justify_center().rounded(6).bg(t.raised).text_color(t.dim).child(svg("mods/desk/icons/chat.svg").size(13)),
      name: d.name, detail: d.project, dim: true, onClick: () => this.openDesk(d.slug),
    }));
    if (quiet.length > QUIET) rows.push(this.row(t, "q-more", { name: `${quiet.length - QUIET} more desks`, dim: true, indent: 31, height: 26, onClick: () => this.openDesk("list") }));
    if (!groups.length && !quiet.length) rows.push(h_flex().id("no-desks").mx(8).mt(8).px(10).h(34).gap(8).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(t.border).text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover))
      .on_click(() => this.openDesk("new"))
      .child(svg("mods/desk/icons/team.svg").size(14).flex_none()).child("Start a desk"));
    if (others.length) {
      rows.push(this.header(t, "h-other", `Other agents · ${others.length}`));
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
        .when(Boolean(this.roles.error), (el) => el.child(div().text_size(11).text_color(t.blocked).tooltip(this.roles.error).child("roles.json error")))
        .child(h_flex().id("new-desk").h(22).px(7).gap(4).items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Start a desk: its own team, chat and worktrees")
          .on_click(() => this.openDesk("new"))
          .child(svg("mods/desk/icons/plus.svg").size(11)).child("Desk")))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(rows));
  }
}
