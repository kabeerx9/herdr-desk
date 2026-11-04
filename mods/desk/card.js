import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, terminals, agents, exec, home, readTextFile, run } from "herdr";
import { icon, statusBadge } from "./ui.js";
import { Roles, roleTile } from "./roles.js";
import { deskMembers, showTerminals, openTerminal } from "./desks.js";

// The floating card at the chat's top right (layouts/desk-chat.json), after Codex's: the open
// desk's changes per worktree, its pull requests and its agents with their sub-agents, plus the
// Chat / Terminals switch. It follows the desk the chat shows (shared "desk.view").

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
    this.roles = new Roles();
    this.roles.load(cx);
    this.git = {};      // cwd → { branch, base, ahead, dirty, files, adds, dels }
    this.prs = {};      // cwd → [{ number, title, state, url }]
    this.names = {};    // desk slug → name
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
      if (!this.names[slug]) {
        try {
          const head = JSON.parse((await readTextFile(`${home()}/.herdr/team/${slug}.jsonl`)).split("\n")[0]);
          this.names[slug] = head?.name ?? slug;
        } catch { this.names[slug] = slug; }
      }
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
    const t = theme(), slug = this.slug;
    const small = Boolean(shared("deskchat.narrow")) || Boolean(shared("deskchat.terminals"));
    if (small || !slug) return h_flex().id("desk-card").p(4).child(this.switcher(t));

    const members = deskMembers(slug), subs = this.subagents(members);
    const name = this.names[slug] ?? slug;
    const header = h_flex().id("card-head").h(38).pl(14).pr(6).gap(8).items_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.collapsed = !this.collapsed; store.set("card.collapsed", this.collapsed); this.refresh(cx, { prs: true }); })
      .child(icon(this.collapsed ? "chevron" : "chevron-down", 12).text_color(t.dim))
      .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
      .child(this.switcher(t));
    if (this.collapsed) return v_flex().id("desk-card").w(WIDTH).child(header);

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
      ...members.map((m) => {
        const role = this.roles.byId(m.role);
        return this.row(t, `ag-${m.address}`, () => openTerminal(m.address), [
          div().w(m.depth * 12).flex_none(),
          role ? roleTile(div, svg, t, role, 16) : div().size(16),
          div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(role?.name ?? m.role),
          statusBadge(t, m.status) ?? div(),
        ], m.note ?? null);
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

    return v_flex().id("desk-card").w(WIDTH).pb(8)
      .child(header)
      .child(div().h(1).mx(14).bg(t.border))
      .child(this.label(t, "Changes"))
      .children(changes.length ? changes : [div().px(14).py(4).text_size(12).text_color(t.dim).child("No worktrees yet")])
      .when(prs.length > 0, (el) => el.child(this.label(t, "Pull requests")).children(prs))
      .child(this.label(t, subs.length ? `Agents · ${subs.length} sub-agent${subs.length === 1 ? "" : "s"}` : "Agents"))
      .children(people.length ? people : [div().px(14).py(4).text_size(12).text_color(t.dim).child("Nobody running")]);
  }
}
