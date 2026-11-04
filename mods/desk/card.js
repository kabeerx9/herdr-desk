import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, terminals, agents, exec, run } from "herdr";
import { icon, statusBadge, button } from "./ui.js";
import { roleTile } from "./roles.js";
import { Desks, deskMembers, showTerminals, openTerminal } from "./desks.js";

// The floating card at the chat's top right (layouts/desk-chat.json), after Codex's, and the one
// place for a desk's controls: the Chat / Terminals switch, its changes per worktree, its pull
// requests, its agents (add one, an agent's actions), and Wrap up, then Delete. It follows the
// desk the chat shows (shared "desk.view") and acts through the same Desks code as the chat.

const WIDTH = 284;
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
    this.collapsed = store.get("card.collapsed", false);
    this.key = "";
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
        if (!branch) continue;
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
    openTerminal(m.address);
    run("layout.show", { id: "panel" });
    run("layout.select", { stack: "panel-body", child: "changes" });
  }

  row(t, id, onClick, children, tip) {
    return h_flex().id(id).h(30).mx(6).px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .bg(this.hovered === id ? t.hover : "#00000000")
      .on_hover((h, cx) => this.hover(id, h, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .children(children);
  }

  label(t, text) {
    return div().px(14).pt(12).pb(4).text_size(11.5).text_color(t.dim).child(text);
  }

  // Chat | Terminals: which one fills the center.
  switcher(t) {
    const terms = Boolean(shared("deskchat.terminals"));
    const seg = (id, name, on, tip, onClick) => h_flex().id(id).w(30).h(24).items_center().justify_center().rounded(6).cursor_pointer()
      .bg(on ? t.background : "#00000000").text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.shadow_sm()).when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(icon(name, 14));
    return h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised)
      .child(seg("sw-chat", "chat", !terms, "Chat", () => showTerminals(false)))
      .child(seg("sw-terms", "terminal", terms, "Terminals", () => showTerminals(true)));
  }

  render(_cx) {
    const t = theme(), slug = this.slug, d = slug ? this.desks.desk(slug) : null;
    if (!d) return h_flex().id("desk-card").p(4).child(this.switcher(t));
    // Over the terminals, or a narrow chat: just the name and the switch, folded.
    const folded = this.collapsed || Boolean(shared("deskchat.terminals")) || Boolean(shared("deskchat.narrow"));
    const members = deskMembers(slug), subs = this.subagents(members);
    const header = h_flex().id("card-head").h(38).pl(12).pr(6).gap(8).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.collapsed = !folded ? true : false; store.set("card.collapsed", this.collapsed);
        if (folded) { setShared("deskchat.narrow", false); } this.refresh(cx, { prs: true }); })
      .child(icon(folded ? "chevron" : "chevron-down", 12).text_color(t.dim))
      .child(v_flex().min_w(0).flex_1()
        .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(d.name))
        .when(!folded && Boolean(d.project), (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(d.project))))
      .child(this.switcher(t));
    if (folded) return v_flex().id("desk-card").w(WIDTH).child(header);

    const trees = this.worktrees();
    const changes = trees.map((m) => {
      const g = this.git[m.cwd], role = this.roles.byId(m.role);
      const tip = g ? [`${g.files} file${g.files === 1 ? "" : "s"} changed since ${g.base || "HEAD"}`,
        g.ahead ? `${g.ahead} commit${g.ahead === 1 ? "" : "s"} ahead` : null, g.dirty ? `${g.dirty} uncommitted` : null].filter(Boolean).join(" · ") : "Reading git…";
      return this.row(t, `ch-${m.address}`, () => this.openChanges(m), [
        role ? roleTile(div, svg, t, role, 16) : icon("branch", 14).text_color(t.dim),
        v_flex().min_w(0).flex_1()
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(role?.name ?? m.role))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(g?.branch ?? "")),
        g && (g.adds || g.dels)
          ? h_flex().flex_none().gap(5).text_size(11.5).font_medium()
            .child(div().text_color(t.done).child(`+${g.adds}`)).child(div().text_color(t.ansi1).child(`−${g.dels}`))
          : div().flex_none().text_size(11).text_color(t.dim).child(g ? "clean" : ""),
      ], tip);
    });

    const prs = trees.flatMap((m) => (this.prs[m.cwd] ?? []).map((p) => {
      const color = p.state === "MERGED" ? t.ansi5 : p.state === "OPEN" ? t.done : t.dim;
      return this.row(t, `pr-${p.number}`, () => exec("open", [p.url]), [
        icon("pr", 14).text_color(color),
        div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(p.title),
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
          role ? roleTile(div, svg, t, role, 16) : div().size(16),
          div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(role?.name ?? m.role),
          statusBadge(t, m.status) ?? div(),
          more,
        ], `${m.note ?? "Open its terminal"}`),
        ...(open ? [div().pt(2).pb(4).child(this.desks.memberDetail(t, m, d))] : [])];
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
    const adder = this.adding ? h_flex().px(12).pb(6).gap(5).flex_wrap()
      .children((this.roles.list ?? []).map((r) => this.desks.chip(t, `cadd-${r.id}`, false, `${r.name}${present.has(r.id) ? " +1" : ""}`,
        (_e, cx) => { this.adding = false; this.desks.busy(`add-${r.id}`, () => this.desks.addMember(r, d), cx); }, roleTile(div, svg, t, r, 16)))) : null;
    const add = h_flex().id("card-add").h(20).px(6).gap(4).items_center().rounded(5).cursor_pointer().text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.adding = !this.adding; cx.notify(); })
      .child(icon(this.adding ? "minus" : "plus", 11)).child(this.adding ? "Cancel" : "Add");

    // Wrap up while anyone's running; once they're all closed, Delete (click twice).
    const acting = this.desks.acting, deleting = Date.now() < this.desks.confirmDelete;
    const footer = h_flex().px(12).pt(10).gap(6).items_center()
      .when(members.length > 0, (el) => el.child(button(t, "card-wrap", acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.desks.wrapUp(d, cx),
        { disabled: Boolean(acting), tip: "Each agent flags anything left locally, or cleans up its worktree and closes" })))
      .when(!members.length, (el) => el.child(button(t, "card-del", deleting ? "Click again to delete" : "Delete desk", (_e, cx) => this.desks.deleteDesk(d, cx),
        { iconName: "trash", disabled: Boolean(acting), tip: "Nobody's running. Kept in ~/.herdr/team/.deleted, so it can be put back" })))
      .child(div().flex_1())
      .when(Boolean(acting) && acting !== "wrap", (el) => el.child(div().text_size(11).text_color(t.dim).child("Working…")));

    return v_flex().id("desk-card").w(WIDTH).pb(10)
      .child(header)
      .child(div().h(1).mx(12).bg(t.border))
      .child(this.label(t, "Changes"))
      .children(changes.length ? changes : [div().px(14).py(4).text_size(12).text_color(t.dim).child("No worktrees yet")])
      .when(prs.length > 0, (el) => el.child(this.label(t, "Pull requests")).children(prs))
      .child(h_flex().pr(8).items_center()
        .child(div().flex_1().child(this.label(t, subs.length ? `Agents · ${subs.length} sub-agent${subs.length === 1 ? "" : "s"}` : "Agents")))
        .child(div().pt(8).child(add)))
      .when(Boolean(adder), (el) => el.child(adder))
      .children(people.length ? people : [div().px(14).py(4).text_size(12).text_color(t.dim).child("Nobody running")])
      .child(div().h(1).mx(12).mt(10).bg(t.border))
      .child(footer);
  }
}
