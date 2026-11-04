import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, terminals, agents, exec, appHome, notify } from "herdr";
import { icon, button, tileColor, statusMark, iconButton, offMain, mostUrgent, ROW } from "./ui.js";
// Roles draw as one-colour glyphs here (no tinted tiles): see glyph().
import { runtimeData, openDesk, sessionOf, settledState, settledNote, triageIcons, snoozeChips, refreshRuntime } from "./workflows.js";
import { Desks, deskMembers, showTerminals, openTerminal } from "./desks.js";
import { openLimits } from "./usage.js";

// The floating card at the chat's top right (layouts/desk-chat.json): the desk's controls in five
// sections, Team, Lineage, Changes, PRs and Usage. Right-click picks which show (only changes from
// the defaults are stored). The card measures the room it has (shared "desk.center.h", written by
// the chat it floats over) and picks a density: full, compact (lower-priority sections shrink to
// a line or two) or essential (they drop). It follows the desk the chat shows (shared "desk.view").

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

const SECTIONS = [
  { id: "team", label: "Team" },
  { id: "lineage", label: "Lineage" },
  { id: "changes", label: "Changes" },
  { id: "prs", label: "Pull requests" },
  { id: "usage", label: "Usage" },
];
// Who shrinks first when room runs out, and who may drop (Team and Changes stay).
const DEGRADE = ["usage", "prs", "lineage", "changes", "team"];
const DROPPABLE = ["usage", "prs", "lineage"];
const HEAD = 48, FOOT = 44, SECTION = 28, PAD = 8;
const ENGINEERS = new Set(["frontend", "backend"]);
const REVIEWS = { reviewer: "Reviewer", qa: "QA" };

const num = (text, word) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const firstLine = (text) => (text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";

export class DeskCard {
  init(_props, cx) {
    this.desks = new Desks(null, cx, {});
    this.roles = this.desks.roles;
    this.adding = false;   // the role chips under Team
    this.open = null;      // the agent whose actions are shown
    this.git = {};         // cwd → { branch, base, ahead, dirty, files, adds, dels }
    this.prs = {};         // cwd → [{ number, title, state, url }]
    this.hovered = null;
    this.snoozing = null;  // the row whose snooze times show
    this.stopping = null;  // { id, until }: Stop asks once more
    this.menu = false;     // the "Show in card" list
    this.shown = store.get("card.sections", {});   // only non-defaults (false) are stored
    this.shelf = { settled: false, previous: false };
    this.collapsed = store.get("card.compact", true);
    this.key = "";
    this.lineKey = null; this.lineCache = null;
    cx.timer.every(3000, (cx) => { if (this.watchKey() !== this.key) this.refresh(cx); });
    cx.timer.every(10000, (cx) => this.refresh(cx));
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
  on(id) { return this.shown[id] !== false; }
  setShown(id, value) {
    if (value) delete this.shown[id]; else this.shown[id] = false;
    store.set("card.sections", this.shown);
  }

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
        if ((prs || !(m.cwd in this.prs)) && branch !== base) {
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

  // A worktree's diff, in the review pane.
  openChanges(m) {
    setShared("desk.review", { repo: m.cwd, address: m.address, role: m.role, task: this.slug, at: Date.now() });
    showTerminals(false);
  }

  // Stop asks once: the first click arms it for 3s. Stopping is `team finish` (the agent flags
  // anything left, or cleans its worktree and closes), children first.
  stop(id, addresses, cx) {
    if (this.stopping?.id !== id || Date.now() > this.stopping.until) {
      this.stopping = { id, until: Date.now() + 3000 };
      cx.timer.after(3100, (cx) => cx.notify());
      return cx.notify();
    }
    this.stopping = null;
    cx.spawn(async (cx) => {
      for (const a of addresses) {
        const r = await exec(`${appHome()}/bin/team`, ["finish", "--address", a]);
        if (r.code !== 0) notify({ title: "Couldn't stop it", body: (r.stderr || r.stdout).trim().slice(0, 200), level: "error", timeout: 6000 });
      }
      refreshRuntime(cx, true);
      cx.notify();
    });
  }

  // ── pieces ────────────────────────────────────────────────────────────────

  // One 28px row: lead, name, quiet meta, then its hover actions (or what it shows at rest) and mark.
  row(t, id, { lead, name, meta, metaColor, rest, mark, actions = [], onClick, tip, indent = 0, muted = false }) {
    const hovered = this.hovered === id;
    return h_flex().id(id).h(ROW).flex_none().mx(6).pl(8 + indent).pr(4).gap(8).items_center().rounded(6)
      .when(Boolean(onClick), (el) => el.cursor_pointer())
      .bg(hovered ? t.hover : "#00000000")
      .on_hover((h, cx) => this.hover(id, h, cx))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick?.(cx); })
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(lead), (el) => el.child(lead))
      .child(div().min_w(0).flex_shrink_1().truncate().text_size(13).text_color(muted ? t.muted : t.foreground).child(name))
      .when(Boolean(meta), (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_size(11).text_color(metaColor ?? t.dim).child(meta)))
      .child(div().flex_1())
      .when(hovered && actions.length > 0, (el) => el.child(h_flex().flex_none().gap(1).children(actions)))
      .when(!(hovered && actions.length) && Boolean(rest), (el) => el.child(rest))
      .when(Boolean(mark), (el) => el.child(h_flex().w(16).flex_none().justify_center().child(mark)));
  }

  // A section's title: name, a quiet count or summary, an optional action at the right.
  head(t, id, title, meta, extra) {
    return h_flex().id(`card-sec-${id}`).h(SECTION).flex_none().pl(14).pr(8).gap(6).items_center()
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(meta), (el) => el.child(div().text_size(11).text_color(t.dim).child(`· ${meta}`)))
      .child(div().flex_1())
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // A folded group ("Settled · 2", "Previous · 3").
  shelfRow(t, id, label, count, open, onToggle) {
    return h_flex().id(id).h(ROW).flex_none().mx(6).pl(8).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onToggle(); cx.notify(); })
      .child(icon(open ? "chevron-down" : "chevron", 11)).child(`${label} · ${count}`);
  }

  note(t, text) {
    return div().h(ROW).flex_none().px(14).flex().items_center().text_size(12).text_color(t.dim).child(text);
  }

  // Chat | Terminals: which one fills the center.
  switcher(t) {
    const terms = Boolean(shared("deskchat.terminals"));
    const seg = (id, name, text, on, onClick) => h_flex().id(id).h(24).w(28).justify_center().items_center().rounded(6).cursor_pointer()
      .bg(on ? t.background : "#00000000").text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.border_1().border_color(t.border))
      .when(!on, (el) => el.hover((s) => s.text_color(t.foreground)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .tooltip(text).child(icon(name, 13));
    return h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(seg("sw-chat", "chat", "Chat", !terms, () => showTerminals(false)))
      .child(seg("sw-terms", "terminal", "Terminals", terms, () => showTerminals(true)));
  }

  // A role's glyph in one colour: the text's, a step down.
  glyph(t, role, size = 14) {
    return svg(`mods/desk/icons/${role?.icon ?? "terminal"}.svg`).size(size).flex_none().text_color(t.dim);
  }

  summary(members, trees) {
    const n = (k) => members.filter((m) => m.status === k).length;
    const parts = [members.length ? plural(members.length, "agent") : "No agents"];
    if (n("blocked")) parts.push(`${n("blocked")} need${n("blocked") === 1 ? "s" : ""} you`);
    if (n("working")) parts.push(`${n("working")} working`);
    const dirty = trees.filter((m) => this.git[m.cwd]?.dirty).length;
    if (dirty) parts.push(`${dirty} uncommitted`);
    return parts.join(" · ");
  }

  // ── lineage: the desk's parent, its forks and side questions, its reviewers and QA ──

  lineage(slug, d, members) {
    const runtime = runtimeData();
    const key = `${slug}|${this.desks.desks.length}|${this.desks.desks.map((x) => x.parent_task ?? "").join(",")}|${agents().map((a) => a.address + a.status).join(",")}|${(runtime.sessions ?? []).length}|${members.length}`;
    if (key === this.lineKey) return this.lineCache;
    const running = [], previous = [];
    const deskRow = (x, kind) => {
      const ms = deskMembers(x.slug);
      // Side questions and forks are named after their parent; their latest line says more.
      const name = kind === "Parent" ? x.name : (firstLine(x.last?.text) || x.name);
      const row = { id: `ln-${x.slug}`, kind, name, status: ms.length ? mostUrgent(ms.map((m) => m.status)) ?? "idle" : "idle",
        open: () => openDesk(x.slug), stop: ms.length ? [...ms].sort((a, b) => b.depth - a.depth).map((m) => m.address) : null };
      (ms.length ? running : previous).push(row);
    };
    if (d.parent_task) { const p = this.desks.desk(d.parent_task); if (p) deskRow(p, "Parent"); }
    for (const x of this.desks.desks) if (x.parent_task === slug) deskRow(x, x.slug.startsWith("fork-") || x.name.startsWith("Fork") ? "Fork" : "Side question");
    const byAddress = new Map(members.map((m) => [m.address, m]));
    for (const m of members) {
      const parent = byAddress.get(m.parent);
      const kind = REVIEWS[m.role] ?? (parent && ENGINEERS.has(parent.role) && !ENGINEERS.has(m.role) ? this.roles.byId(m.role)?.name ?? m.role : null);
      if (!kind) continue;
      running.push({ id: `ln-${m.address}`, kind, name: sessionOf(m.address)?.title || (parent ? `of ${this.roles.byId(parent.role)?.name ?? parent.role}` : this.roles.byId(m.role)?.name ?? m.role),
        status: m.status ?? "idle", open: () => openTerminal(m.address), stop: [m.address] });
    }
    const live = new Set(members.map((m) => m.address));
    for (const s of runtime.sessions ?? []) {
      if (s.task !== slug || !REVIEWS[s.role] || live.has(s.address) || s.state !== "finished") continue;
      previous.push({ id: `ln-s-${s.id}`, kind: REVIEWS[s.role], name: s.title || "Finished", status: "done", open: null, stop: null });
    }
    this.lineKey = key;
    this.lineCache = { running, previous };
    return this.lineCache;
  }

  lineRow(t, r) {
    const armed = this.stopping?.id === r.id && Date.now() < this.stopping.until;
    const actions = [
      ...(r.open ? [iconButton(t, `${r.id}-open`, "arrow-up", "Open", () => r.open())] : []),
      ...(r.stop ? [armed
        ? h_flex().id(`${r.id}-stop`).h(22).px(7).flex_none().items_center().rounded(6).cursor_pointer().text_size(11).font_medium()
          .text_color(t.blocked).hover((s) => s.bg(t.raised))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.stop(r.id, r.stop, cx); }).child("Stop?")
        : iconButton(t, `${r.id}-stop`, "minus", "Stop (asks once more)", (_e, cx) => this.stop(r.id, r.stop, cx))] : []),
    ];
    return this.row(t, r.id, {
      lead: div().w(78).flex_none().truncate().text_size(11).text_color(t.dim).child(r.kind),
      name: r.name, muted: !r.stop, mark: statusMark(t, r.status, 12), actions,
      onClick: r.open ? () => r.open() : null, tip: r.name,
    });
  }

  // ── density ───────────────────────────────────────────────────────────────

  // Each enabled section's height at full and compact, then shrink the lowest priority first,
  // then drop what may drop. Returns { density, level: { id: "full" | "compact" | "off" } }.
  plan(counts) {
    const avail = Math.max(240, (shared("desk.center.h") ?? 720) - 34);
    const h = {
      team: { full: SECTION + ROW * (counts.team + (counts.settled ? 1 : 0)) + counts.extra, compact: SECTION + ROW * Math.min(counts.team, 4) + counts.extra },
      lineage: { full: SECTION + ROW * (counts.running + (counts.previous ? 1 : 0)), compact: SECTION + ROW * Math.min(counts.running, 2) },
      changes: { full: SECTION + ROW * Math.max(1, counts.trees), compact: SECTION + ROW },
      prs: { full: SECTION + ROW * Math.max(1, counts.prs), compact: SECTION + ROW * Math.min(Math.max(1, counts.prs), 2) },
      usage: { full: SECTION + 36 * Math.max(1, counts.usage), compact: SECTION + ROW },
    };
    const level = {};
    for (const s of SECTIONS) level[s.id] = this.on(s.id) && !(s.id === "lineage" && !counts.running && !counts.previous) ? "full" : "off";
    const total = () => HEAD + FOOT + PAD + Object.entries(level).reduce((n, [id, l]) => n + (l === "off" ? 0 : h[id][l]), 0);
    for (const id of DEGRADE) { if (total() <= avail) break; if (level[id] === "full") level[id] = "compact"; }
    let dropped = false;
    for (const id of DROPPABLE) { if (total() <= avail) break; if (level[id] !== "off") { level[id] = "off"; dropped = true; } }
    const shrunk = Object.values(level).includes("compact");
    return { density: dropped ? "essential" : shrunk ? "compact" : "full", level, max: avail - HEAD - FOOT };
  }

  // ── sections ──────────────────────────────────────────────────────────────

  teamSection(t, d, members, subs, level) {
    const app = new Map(agents().map((a) => [a.address, a]));
    const put = [], active = [];
    for (const m of members) (settledState(sessionOf(m.address), m.status) ? put : active).push(m);
    const memberRow = (m, quiet) => {
      const role = this.roles.byId(m.role), open = this.open === m.address, s = sessionOf(m.address), id = `ag-${m.address}`;
      const more = iconButton(t, `${id}-more`, open ? "chevron-down" : "chevron", open ? "Hide its actions" : "Its actions: compact, fresh start, review, QA, PR",
        (_e, cx) => { this.open = open ? null : m.address; cx.notify(); }, { color: open ? t.foreground : undefined });
      const rows = [this.row(t, id, {
        indent: m.depth * 12, lead: role ? this.glyph(t, role) : div().size(16),
        name: role?.name ?? m.role, meta: quiet ? settledNote(s) : s?.title ?? null, muted: quiet,
        mark: statusMark(t, m.status ?? "idle", 12), actions: [...triageIcons(t, id, this, m.address, quiet), more],
        // Its own conversation (a route of this desk); the terminal stays one click away in its actions.
        onClick: () => { showTerminals(false); setShared("desk.view", d.slug); setShared("desk.route", { task: d.slug, address: m.address }); },
        tip: m.note ?? s?.title ?? "Open its conversation",
      })];
      const chips = snoozeChips(t, id, this, m.address);
      if (chips) rows.push(chips);
      if (open) rows.push(div().mx(8).mb(4).rounded(8).bg(t.raised).child(this.desks.memberDetail(t, m, d, true)));
      return rows;
    };
    let shown = active;
    const cap = level === "compact" ? 4 : Infinity;
    const hidden = Math.max(0, shown.length - cap);
    shown = shown.slice(0, cap);
    const rows = [
      ...shown.flatMap((m) => memberRow(m, false)),
      ...(level === "full" ? subs.map((s) => {
        const a = app.get(s.address);
        return this.row(t, `sub-${s.address}`, { indent: 12, lead: icon("sparkles", 13).text_color(t.dim),
          name: s.name || a?.app || s.program?.name || s.address, muted: true, mark: statusMark(t, a?.status ?? "idle", 12),
          onClick: () => openTerminal(s.address, { peek: true }), tip: "Sub-agent: peek at its terminal" });
      }) : []),
      ...(hidden ? [this.note(t, `${hidden} more`)] : []),
      ...(put.length ? [this.shelfRow(t, "team-settled", "Settled", put.length, this.shelf.settled, () => { this.shelf.settled = !this.shelf.settled; })] : []),
      ...(put.length && this.shelf.settled ? put.flatMap((m) => memberRow(m, true)) : []),
    ];
    const present = new Set(members.map((m) => m.role));
    const adder = this.adding ? h_flex().px(14).pb(6).gap(5).flex_wrap()
      .children((this.roles.list ?? []).map((r) => this.desks.chip(t, `cadd-${r.id}`, false, `${r.name}${present.has(r.id) ? " +1" : ""}`,
        (_e, cx) => { this.adding = false; this.desks.busy(`add-${r.id}`, () => this.desks.addMember(r, d), cx); }, this.glyph(t, r, 13)))) : null;
    const add = iconButton(t, "card-add", this.adding ? "minus" : "plus", this.adding ? "Cancel" : "Add an agent",
      (_e, cx) => { this.adding = !this.adding; cx.notify(); }, { color: t.accent });
    const n = (k) => members.filter((m) => m.status === k).length;
    const meta = [n("blocked") && `${n("blocked")} need${n("blocked") === 1 ? "s" : ""} you`, n("working") && `${n("working")} working`].filter(Boolean).join(", ")
      || (members.length ? String(members.length + subs.length) : null);
    return v_flex().child(this.head(t, "team", "Team", meta, add))
      .when(Boolean(adder), (el) => el.child(adder))
      .children(rows.length ? rows : [this.note(t, "Nobody running. Add an agent to start.")]);
  }

  lineageSection(t, line, level) {
    const { running, previous } = line;
    const rows = [...(level === "compact" ? running.slice(0, 2) : running).map((r) => this.lineRow(t, r))];
    if (level === "full" && previous.length) {
      rows.push(this.shelfRow(t, "lineage-prev", "Previous", previous.length, this.shelf.previous, () => { this.shelf.previous = !this.shelf.previous; }));
      if (this.shelf.previous) rows.push(...previous.map((r) => this.lineRow(t, r)));
    }
    return v_flex().child(this.head(t, "lineage", "Lineage", running.length ? `${running.length} running` : `${previous.length} previous`))
      .children(rows);
  }

  changesSection(t, trees, level) {
    if (level === "compact") {
      const gs = trees.map((m) => this.git[m.cwd]).filter(Boolean);
      const files = gs.reduce((n, g) => n + g.files, 0), adds = gs.reduce((n, g) => n + g.adds, 0), dels = gs.reduce((n, g) => n + g.dels, 0);
      const first = trees[0];
      return v_flex().child(this.head(t, "changes", "Changes", plural(trees.length, "worktree")))
        .child(trees.length ? this.row(t, "ch-all", { lead: icon("branch", 13).text_color(t.dim), name: files ? plural(files, "file") : "No changes", muted: !files,
          rest: files ? this.stat(t, adds, dels) : null, onClick: first ? () => this.openChanges(first) : null, tip: "Review the first worktree's changes" })
          : this.note(t, "No worktrees yet"));
    }
    const rows = trees.map((m) => {
      const g = this.git[m.cwd], role = this.roles.byId(m.role), read = m.cwd in this.git;
      const lead = role ? this.glyph(t, role) : icon("branch", 13).text_color(t.dim);
      if (read && !g) return this.row(t, `ch-${m.address}`, { lead, name: role?.name ?? m.role, meta: "not a git repo", muted: true, onClick: () => openTerminal(m.address), tip: m.cwd });
      const meta = g ? [offMain(g.branch, g.base) ? g.branch : null, g.ahead ? `↑${g.ahead}` : null].filter(Boolean).join(" ") : "…";
      const tip = g ? [`${plural(g.files, "file")} changed since ${g.base || "HEAD"}`, g.branch, g.dirty ? `${g.dirty} uncommitted` : null].filter(Boolean).join(" · ") : "Reading git…";
      return this.row(t, `ch-${m.address}`, { lead, name: role?.name ?? m.role, meta,
        rest: g && (g.adds || g.dels) ? this.stat(t, g.adds, g.dels, g.dirty) : div().text_size(11).text_color(t.dim).child(g ? "clean" : ""),
        onClick: () => this.openChanges(m), tip });
    });
    return v_flex().child(this.head(t, "changes", "Changes", trees.length > 1 ? plural(trees.length, "worktree") : null))
      .children(rows.length ? rows : [this.note(t, "No worktrees yet")]);
  }

  stat(t, adds, dels, dirty) {
    return h_flex().flex_none().gap(5).text_size(11.5).font_medium()
      .when(Boolean(dirty), (el) => el.child(div().size(5).rounded(3).bg(t.blocked)).tooltip(`${dirty} uncommitted`))
      .child(div().text_color(t.ansi2).child(`+${adds}`)).child(div().text_color(t.ansi1).child(`−${dels}`));
  }

  prsSection(t, prs, level) {
    const list = level === "compact" ? prs.slice(0, 2) : prs;
    return v_flex().child(this.head(t, "prs", "Pull requests", prs.length ? String(prs.length) : null))
      .children(list.length ? list.map((p) => {
        const color = p.state === "MERGED" ? t.ansi5 : p.state === "OPEN" ? t.ansi2 : t.dim;
        return this.row(t, `pr-${p.number}`, { lead: icon("pr", 13).text_color(color), name: p.title, muted: p.state !== "OPEN",
          rest: div().text_size(11).text_color(t.dim).child(`#${p.number}`), onClick: () => exec("open", [p.url]),
          tip: `${p.state === "MERGED" ? "Merged" : p.state === "OPEN" ? "Open" : "Closed"} · ${p.url}` });
      }) : [this.note(t, "No pull requests on these branches")]);
  }

  usageSection(t, level) {
    const providers = (shared("desk.usage")?.providers ?? []).filter((p) => p.windows?.length);
    const week = (p) => p.windows.find((w) => w.label === "Week") ?? p.windows[p.windows.length - 1];
    const color = (used) => (used >= 90 ? t.ansi1 : used >= 70 ? t.blocked : t.accent);
    if (!providers.length) return v_flex().child(this.head(t, "usage", "Usage", null)).child(this.note(t, "No plan limits read yet"));
    if (level === "compact") return v_flex().child(this.head(t, "usage", "Usage", null))
      .child(this.row(t, "usage-line", { name: providers.map((p) => `${p.provider} ${week(p).used}%`).join(" · "), muted: true,
        onClick: () => openLimits(providers[0].provider), tip: "Weekly plan limits" }));
    return v_flex().child(this.head(t, "usage", "Usage", "this week")).children(providers.map((p) => {
      const w = week(p), id = `usage-${p.provider}`, hovered = this.hovered === id;
      return v_flex().id(id).h(36).flex_none().mx(6).px(8).gap(5).justify_center().rounded(6).cursor_pointer()
        .bg(hovered ? t.hover : "#00000000").on_hover((h, cx) => this.hover(id, h, cx))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openLimits(p.provider); })
        .child(h_flex().gap(6).items_center().text_size(12)
          .child(div().text_color(t.foreground).child(p.provider)).child(div().flex_1())
          .child(div().text_size(11.5).font_medium().text_color(w.used >= 70 ? color(w.used) : t.muted).child(`${w.used}%`)))
        .child(div().w_full().h(3).rounded(2).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${Math.min(100, Math.max(w.used, w.used > 0 ? 2 : 0))}%`).rounded(2).bg(color(w.used))));
    }));
  }

  // Right-click: which sections show.
  menuView(t) {
    return v_flex().pb(6)
      .child(this.head(t, "menu", "Show in card", null, iconButton(t, "card-menu-done", "check", "Done", (_e, cx) => { this.menu = false; cx.notify(); })))
      .children(SECTIONS.map((s) => {
        const on = this.on(s.id);
        return this.row(t, `card-show-${s.id}`, {
          lead: h_flex().size(14).flex_none().items_center().justify_center().rounded(4).border_1().border_color(on ? t.accent : t.input)
            .bg(on ? t.accent : "#00000000").text_color(t.accent_foreground).when(on, (el) => el.child(icon("check", 10))),
          name: s.label, muted: !on, onClick: (cx) => { this.setShown(s.id, !on); cx.notify(); },
        });
      }));
  }

  render(_cx) {
    if (shared("desk.review")) return div().size(0);
    const t = theme(), slug = this.slug, d = slug ? this.desks.desk(slug) : null;
    if (!d) return h_flex().id("desk-card").p(4).child(this.switcher(t));
    const folded = this.collapsed;
    const members = deskMembers(slug), trees = this.worktrees();
    const [name, when] = d.name.includes(" · ") ? d.name.split(" · ") : [d.name, null];
    const lost = (runtimeData().sessions ?? []).filter((s) => s.task === slug && s.state === "disconnected");
    const urgent = lost.length > 0 || members.some((m) => m.status === "blocked");
    const where = d.project && d.project !== name ? d.project : when;
    const sub = folded && members.length ? this.summary(members, trees) : where;
    const toggle = iconButton(t, "card-toggle", folded ? "chevron-down" : "up", folded ? "Show the desk's team, lineage, changes and pull requests" : "Fold",
      (_e, cx) => { this.collapsed = !folded; store.set("card.compact", this.collapsed); this.refresh(cx, { prs: true }); }, { size: 24 });
    const header = h_flex().id("card-head").h(HEAD).flex_none().pl(14).pr(8).gap(10).items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().min_w(0).flex_1().gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(name))
          .when(urgent, (el) => el.child(statusMark(t, lost.length && !members.some((m) => m.status === "blocked") ? "disconnected" : "blocked", 11))))
        .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(sub))))
      .child(this.switcher(t))
      .child(toggle);
    const root = v_flex().id("desk-card").w(WIDTH)
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (this.collapsed) { this.collapsed = false; store.set("card.compact", false); this.refresh(cx, { prs: true }); } this.menu = !this.menu; cx.notify(); });
    if (folded) return root.child(header);

    const subs = this.subagents(members), line = this.lineage(slug, d, members);
    const prs = trees.flatMap((m) => this.prs[m.cwd] ?? []);
    const put = members.filter((m) => settledState(sessionOf(m.address), m.status)).length;
    const providers = (shared("desk.usage")?.providers ?? []).filter((p) => p.windows?.length).length;
    const extra = (this.open ? 120 : 0) + (this.adding ? 34 : 0) + (this.snoozing ? 30 : 0) + (lost.length ? 90 : 0);
    const { level, max } = this.plan({ team: members.length - put + subs.length, settled: put, extra, running: line.running.length, previous: line.previous.length,
      trees: trees.length, prs: prs.length, usage: providers });

    const parts = this.menu ? [this.menuView(t)] : [
      ...(level.team !== "off" ? [this.teamSection(t, d, members, subs, level.team)] : []),
      ...(level.lineage !== "off" ? [this.lineageSection(t, line, level.lineage)] : []),
      ...(level.changes !== "off" ? [this.changesSection(t, trees, level.changes)] : []),
      ...(level.prs !== "off" ? [this.prsSection(t, prs, level.prs)] : []),
      ...(level.usage !== "off" ? [this.usageSection(t, level.usage)] : []),
    ];
    const body = v_flex().id(`card-body-${slug}`).max_h(Math.max(160, max)).overflow_y_scrollbar().pb(PAD).border_t(1).border_color(t.border)
      .when(lost.length > 0 && !this.menu, (el) => el.child(div().mx(10).mt(8).child(v_flex().gap(5).children(this.desks.workflow.disconnected(t, slug)))))
      .children(parts.flatMap((p, i) => (i ? [div().h(1).mx(14).my(2).bg(t.border), p] : [p])))
      .when(!parts.length, (el) => el.child(this.note(t, "Every section is hidden. Right-click to show some.")));

    // Wrap up while anyone's running; once they're all closed, Delete (click twice).
    const acting = this.desks.acting, deleting = Date.now() < this.desks.confirmDelete;
    const footer = h_flex().h(FOOT).flex_none().px(12).gap(8).items_center().border_t(1).border_color(t.border)
      .child(div().flex_1().text_size(11).text_color(t.dim).child(acting && acting !== "wrap" ? "Working…" : "Right-click to choose sections"))
      .when(members.length > 0, (el) => el.child(button(t, "card-wrap", acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.desks.wrapUp(d, cx),
        { disabled: Boolean(acting), tip: "Each agent flags anything left locally, or cleans up its worktree and closes" })))
      .when(!members.length, (el) => el.child(button(t, "card-del", deleting ? "Click again to delete" : "Delete desk", (_e, cx) => this.desks.deleteDesk(d, cx),
        { iconName: "trash", disabled: Boolean(acting), tip: "Nobody's running. Kept in ~/.herdr/team/.deleted, so it can be put back" })));

    return root.on_mouse_down_out((_e, cx) => { this.collapsed = true; this.menu = false; this.snoozing = null; store.set("card.compact", true); cx.notify(); })
      .child(header).child(body).child(footer);
  }
}
