import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, terminals, agents, exec, run } from "herdr";
import { icon, statusBadge, button, pill, tileColor } from "./ui.js";
import { roleTile } from "./roles.js";
import { runtimeData } from "./workflows.js";
import { Desks, deskMembers, showTerminals, openTerminal } from "./desks.js";

// The floating card at the chat's top right (layouts/desk-chat.json), after Codex's, and the one
// place for a desk's controls: the Chat / Terminals switch, its changes per worktree, its pull
// requests, its agents (add one, an agent's actions), and Wrap up, then Delete. It follows the
// desk the chat shows (shared "desk.view") and acts through the same Desks code as the chat.

const WIDTH = 320;
// One line per worktree: branch, base, commits ahead, uncommitted files, and the shortstat of
// everything since it left the base (committed or not). Reads take no git locks.
const GIT = `cd "$1" 2>/dev/null || exit 0
g() { git --no-optional-locks -c core.fsmonitor=false "$@"; }
b=$(g symbolic-ref --short -q HEAD || g rev-parse --short HEAD) || exit 0
base=$(g rev-parse --abbrev-ref -q origin/HEAD 2>/dev/null)
mb=""; [ -n "$base" ] && mb=$(g merge-base HEAD "$base" 2>/dev/null)
ahead=0; [ -n "$mb" ] && ahead=$(g rev-list --count "$mb"..HEAD)
dirty=$(g status --porcelain | wc -l | tr -d ' ')
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$b" "\${base#origin/}" "$ahead" "$dirty" "$(g diff --shortstat \${mb:-HEAD} 2>/dev/null)"`;

const num = (text, word) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export class DeskCard {
  init(_props, cx) {
    this.desks = new Desks(null, cx, {});
    this.roles = this.desks.roles;
    this.adding = false;   // the role chips under Agents
    this.open = null;      // the agent whose actions are shown
    this.git = {};      // cwd → { branch, base, ahead, dirty, files, adds, dels }
    this.prs = {};      // cwd → [{ number, title, state, url }]
    this.hovered = null;
    this.collapsed = store.get("card.compact", true);
    this.key = "";
    this.section = "team";
    cx.timer.every(3000, (cx) => { if (this.watchKey() !== this.key) this.refresh(cx); });
    cx.timer.every(10000, (cx) => this.refresh(cx, { git: true }));
    cx.timer.every(120000, (cx) => this.refresh(cx, { prs: true }));
    this.refresh(cx, { prs: true });
  }

  get slug() { const v = shared("desk.view"); return v && v !== "list" && v !== "new" ? v : null; }
  worktrees() {
    const seen = new Map();
    for (const m of deskMembers(this.slug)) if (m.cwd && !seen.has(m.cwd)) seen.set(m.cwd, m);
    return [...seen.values()];
  }
  watchKey() { return `${this.slug}|${this.worktrees().map((m) => m.cwd).join("|")}`; }

  // Sub-agents: live terminals an agent of this desk started (hc run records the parent),
  // that aren't desk members themselves. Nested ones too.
  subagents(members) {
    const desk = new Set(members.map((m) => m.address)), under = new Set(desk), out = [];
    for (let grew = true; grew;) {
      grew = false;
      for (const t of terminals()) {
        if (t.state !== "live" || !t.parent || !under.has(t.parent) || under.has(t.address) || t.labels?.role) continue;
        under.add(t.address); out.push(t); grew = true;
      }
    }
    return out;
  }

  refresh(cx, { prs = false } = {}) {
    this.key = this.watchKey();
    const slug = this.slug, trees = this.worktrees();
    if (!slug || this.collapsed) return cx.notify();
    cx.spawn(async (cx) => {
      for (const m of trees) {
        const r = await exec("sh", ["-c", GIT, "git", m.cwd]);
        const [branch, base, ahead, dirty, stat = ""] = r.stdout.replace(/\n$/, "").split("\t");
        if (!branch) { this.git[m.cwd] = null; continue; }
        this.git[m.cwd] = { branch, base, ahead: Number(ahead) || 0, dirty: Number(dirty) || 0,
          files: num(stat, "files? changed"), adds: num(stat, "insertions?"), dels: num(stat, "deletions?") };
        if (prs && branch !== base) {
          const p = await exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "3", "--json", "number,title,state,url"], { cwd: m.cwd });
          try { this.prs[m.cwd] = p.code === 0 ? JSON.parse(p.stdout) : []; } catch { this.prs[m.cwd] = []; }
        }
      }
      cx.notify();
    });
  }

  hover(id, on, cx) {
    if (on) this.hovered = id; else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  // A worktree's diff: its terminal shown and focused, so Herdr's Changes panel follows it.
  openChanges(m) {
    setShared("desk.review", { repo: m.cwd, address: m.address, role: m.role, task: this.slug, at: Date.now() });
    showTerminals(false);
  }

  row(t, id, onClick, children, tip) {
    return h_flex().id(id).min_h(40).mx(8).px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .bg(this.hovered === id ? t.hover : "#00000000")
      .on_hover((h, cx) => this.hover(id, h, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .children(children);
  }

  // A section title with its count and an optional action.
  label(t, text, count, extra) {
    return h_flex().h(30).pl(16).pr(10).pt(6).gap(6).items_center()
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(text))
      .when(count !== undefined && count !== null, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))))
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  note(t, text) {
    return div().mx(16).mb(4).text_size(12).text_color(t.dim).child(text);
  }

  // Chat | Terminals: which one fills the center.
  switcher(t, compact = false) {
    const terms = Boolean(shared("deskchat.terminals"));
    const seg = (id, name, text, on, onClick) => h_flex().id(id).h(24).when(compact, (el) => el.w(28).justify_center()).when(!compact, (el) => el.pl(7).pr(9)).gap(5).items_center().rounded(6).cursor_pointer()
      .bg(on ? t.background : "#00000000").text_color(on ? t.foreground : t.muted).text_size(11.5).font_medium()
      .when(on, (el) => el.shadow_sm()).when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .when(compact, (el) => el.tooltip(text))
      .child(icon(name, 13)).when(!compact, (el) => el.child(text));
    return h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised)
      .child(seg("sw-chat", "chat", "Chat", !terms, () => showTerminals(false)))
      .child(seg("sw-terms", "terminal", "Terminals", terms, () => showTerminals(true)));
  }

  // The desk's tile: its first letter in a steady color.
  tile(t, name, size) {
    return div().size(size).flex_none().rounded(Math.round(size * 0.3)).flex().items_center().justify_center()
      .bg(tileColor(t, name)).text_color("#ffffff").text_size(Math.round(size * 0.46)).font_bold()
      .child([...name][0]?.toUpperCase() ?? "?");
  }

  // What the desk is doing, in one line: "3 agents · 1 needs you · 2 working".
  summary(members, trees) {
    const n = (k) => members.filter((m) => m.status === k).length;
    const parts = [members.length ? `${members.length} agent${members.length === 1 ? "" : "s"}` : "No agents"];
    if (n("blocked")) parts.push(`${n("blocked")} need${n("blocked") === 1 ? "s" : ""} you`);
    if (n("working")) parts.push(`${n("working")} working`);
    if (n("done")) parts.push(`${n("done")} done`);
    const dirty = trees.filter((m) => this.git[m.cwd]?.dirty).length;
    if (dirty) parts.push(`${dirty} uncommitted`);
    return parts.join(" · ");
  }

  render(_cx) {
    if (shared("desk.review")) return div().size(0);
    const t = theme(), slug = this.slug, d = slug ? this.desks.desk(slug) : null;
    if (!d) return h_flex().id("desk-card").p(4).child(this.switcher(t));
    // Opening the controls is explicit, at every window size.
    const folded = this.collapsed;
    const members = deskMembers(slug), subs = this.subagents(members), trees = this.worktrees();
    // An unnamed desk is "<folder> · <when>": the folder is its name, the time its subline.
    const [name, when] = d.name.includes(" · ") ? d.name.split(" · ") : [d.name, null];
    const lost = (runtimeData().sessions ?? []).filter((s) => s.task === slug && s.state === "disconnected");
    const urgent = lost.length > 0 || members.some((m) => m.status === "blocked");
    const where = d.project && d.project !== name ? d.project : when;
    const sub = folded ? (members.length ? this.summary(members, trees) : where) : where;
    const toggle = h_flex().id("card-toggle").size(24).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .tooltip(folded ? "Show the desk's changes, pull requests and agents" : "Fold")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.collapsed = !folded; store.set("card.compact", this.collapsed);
        this.refresh(cx, { prs: true }); })
      .child(icon(folded ? "chevron-down" : "up", 13));
    const header = h_flex().id("card-head").h(48).pl(12).pr(8).gap(10).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(this.tile(t, name, 24))
      .child(v_flex().min_w(0).flex_1().gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
          .when(urgent, (el) => el.child(div().size(7).rounded(4).flex_none().bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1400 }))))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))

      .child(this.switcher(t, true))
      .child(toggle);
    if (folded) return v_flex().id("desk-card").w(WIDTH).child(header);

    const changes = trees.map((m) => {
      const g = this.git[m.cwd], role = this.roles.byId(m.role), read = m.cwd in this.git;
      if (read && !g) return this.row(t, `ch-${m.address}`, () => openTerminal(m.address), [
        role ? roleTile(div, svg, t, role, 20) : icon("branch", 14).text_color(t.dim),
        v_flex().min_w(0).flex_1()
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(role?.name ?? m.role))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(`${m.cwd.split("/").pop() || m.cwd} · not a git repo`)),
      ], m.cwd);
      const tip = g ? [`${g.files} file${g.files === 1 ? "" : "s"} changed since ${g.base || "HEAD"}`,
        g.ahead ? `${g.ahead} commit${g.ahead === 1 ? "" : "s"} ahead` : null, g.dirty ? `${g.dirty} uncommitted` : null].filter(Boolean).join(" · ") : "Reading git…";
      return this.row(t, `ch-${m.address}`, () => this.openChanges(m), [
        role ? roleTile(div, svg, t, role, 20) : icon("branch", 14).text_color(t.dim),
        v_flex().min_w(0).flex_1()
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(role?.name ?? m.role))
          .child(h_flex().min_w(0).gap(4).items_center().text_size(10.5).text_color(t.dim)
            .child(icon("branch", 10)).child(div().min_w(0).truncate().child(g?.branch ?? "…"))
            .when(Boolean(g?.ahead), (el) => el.child(div().flex_none().child(`· ${g.ahead} ahead`)))
            .when(Boolean(g?.dirty), (el) => el.child(div().flex_none().text_color(t.blocked).child(`· ${g.dirty} uncommitted`)))),
        g && (g.adds || g.dels)
          ? h_flex().flex_none().gap(5).text_size(11.5).font_semibold()
            .child(div().text_color(t.ansi2).child(`+${g.adds}`)).child(div().text_color(t.ansi1).child(`−${g.dels}`))
          : div().flex_none().text_size(10.5).text_color(t.dim).child(g ? "clean" : ""),
      ], tip);
    });

    const prs = trees.flatMap((m) => (this.prs[m.cwd] ?? []).map((p) => {
      const color = p.state === "MERGED" ? t.ansi5 : p.state === "OPEN" ? t.ansi2 : t.dim;
      return this.row(t, `pr-${p.number}`, () => exec("open", [p.url]), [
        icon("pr", 14).text_color(color),
        div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(p.title),
        pill(t, p.state === "MERGED" ? "Merged" : p.state === "OPEN" ? "Open" : "Closed", color),
        div().flex_none().text_size(11).text_color(t.dim).child(`#${p.number}`),
      ], `${p.state.toLowerCase()} · ${p.url}`);
    }));

    const app = new Map(agents().map((a) => [a.address, a]));
    const people = [
      ...members.flatMap((m) => {
        const role = this.roles.byId(m.role), open = this.open === m.address;
        const more = h_flex().id(`ag-more-${m.address}`).size(22).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(open ? t.foreground : t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(open ? "Hide its actions" : "Its actions: compact, fresh start, review, QA, PR")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.open = open ? null : m.address; cx.notify(); })
          .child(icon(open ? "chevron-down" : "chevron", 12));
        return [this.row(t, `ag-${m.address}`, () => openTerminal(m.address), [
          div().w(m.depth * 12).flex_none(),
          role ? roleTile(div, svg, t, role, 20) : div().size(20),
          div().min_w(0).flex_1().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(role?.name ?? m.role),
          statusBadge(t, m.status) ?? div(),
          more,
        ], `${m.note ?? "Open its terminal"}`),
        ...(open ? [div().mx(8).mb(4).rounded(8).bg(t.raised).child(this.desks.memberDetail(t, m, d, true))] : [])];
      }),
      ...subs.map((s) => {
        const a = app.get(s.address), status = a?.status ?? null;
        return this.row(t, `sub-${s.address}`, () => openTerminal(s.address, { peek: true }), [
          div().w(12).flex_none(),
          icon("sparkles", 14).text_color(t.dim),
          div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.muted).child(s.name || a?.app || s.program?.name || s.address),
          statusBadge(t, status) ?? div(),
        ], "Sub-agent: peek at its terminal");
      }),
    ];
    const present = new Set(members.map((m) => m.role));
    const adder = this.adding ? h_flex().px(14).pb(8).gap(5).flex_wrap()
      .children((this.roles.list ?? []).map((r) => this.desks.chip(t, `cadd-${r.id}`, false, `${r.name}${present.has(r.id) ? " +1" : ""}`,
        (_e, cx) => { this.adding = false; this.desks.busy(`add-${r.id}`, () => this.desks.addMember(r, d), cx); }, roleTile(div, svg, t, r, 16)))) : null;
    const add = h_flex().id("card-add").h(22).px(7).gap(4).items_center().rounded(6).cursor_pointer().text_size(11.5).font_medium().text_color(t.accent)
      .hover((s) => s.bg(t.accent + "14"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.adding = !this.adding; cx.notify(); })
      .child(icon(this.adding ? "minus" : "plus", 11)).child(this.adding ? "Cancel" : "Add agent");

    // Wrap up while anyone's running; once they're all closed, Delete (click twice).
    const acting = this.desks.acting, deleting = Date.now() < this.desks.confirmDelete;
    const footer = h_flex().h(44).px(12).gap(8).items_center().bg(t.raised + "80").border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(11).text_color(t.dim)
        .child(acting && acting !== "wrap" ? "Working…" : "Desk controls"))
      .when(members.length > 0, (el) => el.child(button(t, "card-wrap", acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.desks.wrapUp(d, cx),
        { disabled: Boolean(acting), tip: "Each agent flags anything left locally, or cleans up its worktree and closes" })))
      .when(!members.length, (el) => el.child(button(t, "card-del", deleting ? "Click again to delete" : "Delete desk", (_e, cx) => this.desks.deleteDesk(d, cx),
        { iconName: "trash", disabled: Boolean(acting), tip: "Nobody's running. Kept in ~/.herdr/team/.deleted, so it can be put back" })));

    const tab = (id, label, count) => h_flex().id(`card-section-${id}`).flex_1().h(30).gap(5).items_center().justify_center().rounded(7)
      .bg(this.section === id ? t.background : "#00000000").text_color(this.section === id ? t.foreground : t.muted)
      .text_size(12).font_medium().cursor_pointer().hover(style => style.text_color(t.foreground))
      .on_click((_e, cx) => { this.section = id; cx.notify(); }).child(label)
      .child(div().text_size(10.5).text_color(t.dim).child(String(count)));
    const body = v_flex().id(`card-body-${slug}`).max_h(440).overflow_y_scrollbar().pb(10)
      .when(lost.length > 0, el => el.child(div().mx(10).my(5).child(v_flex().gap(5).children(this.desks.workflow.disconnected(t, slug)))))
      .when(this.section === "team", el => el
        .child(this.label(t, "Agents", subs.length ? `${members.length} + ${subs.length} sub` : members.length, add))
        .when(Boolean(adder), el => el.child(adder))
        .children(people.length ? people : [this.note(t, "Nobody running")]))
      .when(this.section === "changes", el => el
        .child(this.label(t, "Worktrees", trees.length))
        .children(changes.length ? changes : [this.note(t, "No worktrees yet")])
        .child(this.label(t, "Pull requests", prs.length))
        .children(prs.length ? prs : [this.note(t, "No pull requests on these branches")]));
    return v_flex().id("desk-card").w(WIDTH)
      .on_mouse_down_out((_e, cx) => { this.collapsed = true; store.set("card.compact", true); cx.notify(); })
      .child(header)
      .child(h_flex().mx(10).mb(4).p(3).gap(3).rounded(10).bg(t.raised)
        .child(tab("team", "Team", members.length + subs.length)).child(tab("changes", "Changes", trees.length)))
      .child(body).child(footer);
  }
}
