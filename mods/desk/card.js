import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, terminals, agents, exec, appHome, notify } from "herdr";
import { icon, button, pill, statusMark, shownStatus, iconButton, offMain, mostUrgent, ROW, cardCollapsed, setCardCollapsed } from "./ui.js";
import { agentIcon, agentCli } from "./roles.js";
import { runtimeData, openDesk, sessionOf, refreshRuntime } from "./workflows.js";
import { Desks, deskMembers, showTerminals, openTerminal } from "./desks.js";
import { finishedRoles } from "./model.js";

// The desk card: the column at the chat's right (layouts/desk-chat.json, "desk-card"), docked so
// it never covers the chat. It shows the desk as a pipeline: Design, Plan, Build, Review, Gate,
// Pull request. Each stage lists who is in it and opens to their rows. ui.js syncCardColumn
// hides the column when no desk is open or the card is collapsed; the rail brings it back.
// It follows the desk the chat shows (shared "desk.view").

// One line per worktree: branch, base, commits ahead, uncommitted files, and the shortstat of
// everything since it left the base (committed or not). Reads take no git locks.
const GIT = `cd "$1" 2>/dev/null || exit 0
g() { git --no-optional-locks -c core.fsmonitor=false "$@"; }
b=$(g symbolic-ref --short -q HEAD || g rev-parse --short HEAD) || exit 0
# The base it left: fewest commits ahead of (dev before main, or a dev branch shows all of dev).
base=$(g rev-parse --abbrev-ref -q origin/HEAD 2>/dev/null); best=$([ -n "$base" ] && g rev-list --count "$base"..HEAD 2>/dev/null)
for c in origin/dev origin/develop origin/main origin/master; do
  [ "$c" = "origin/$b" ] && continue
  n=$(g rev-list --count "$c"..HEAD 2>/dev/null) || continue
  if [ -z "$best" ] || [ "$n" -lt "$best" ]; then base=$c; best=$n; fi
done
mb=""; [ -n "$base" ] && mb=$(g merge-base HEAD "$base" 2>/dev/null)
ahead=0; [ -n "$mb" ] && ahead=$(g rev-list --count "$mb"..HEAD)
dirty=$(g status --porcelain | wc -l | tr -d ' ')
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$b" "\${base#origin/}" "$ahead" "$dirty" "$(g diff --shortstat \${mb:-HEAD} 2>/dev/null)"`;

// The header matches the chat's top band (desks.js), so the two hairlines meet in one line.
const HEAD = 44, FOOT = 44, NODE = 18, SECTION = 28;
// Which stage a role works in; a role not listed here builds.
const STAGE_OF = { architect: "design", cto: "plan", researcher: "plan", reviewer: "review", qa: "review" };
const STAGES = [
  { id: "design", title: "Design and diagnose", hint: "The Architect joins for design calls and hard bugs" },
  { id: "plan", title: "Plan and brief", hint: "The CTO plans and writes the briefs" },
  { id: "build", title: "Build", hint: "Engineers start after the plan" },
  { id: "review", title: "Review", hint: "A Reviewer checks each engineer's work" },
  { id: "gate", title: "Gate", hint: "Passes on zero blocking findings" },
  { id: "pr", title: "Pull request", hint: "Only when you ask" },
];
const ENGINEERS = new Set(["frontend", "backend", "worker"]);
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
    this.stopping = null;  // { id, until }: Stop asks once more
    this.stageOpen = {};   // stage id → true/false once clicked; unset follows the stage's state
    this.shelf = { previous: false };
    this.key = "";
    this.lineKey = null; this.lineCache = null;
    cx.timer.every(3000, (cx) => { if (this.watchKey() !== this.key) this.refresh(cx); });
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.timer.every(120000, (cx) => this.refresh(cx, { prs: true }));
    this.refresh(cx, { prs: true });
    // Docked: the chat has nothing to keep clear of.
    const inset = shared("desk.cardInset");
    if (inset?.right || inset?.top) setShared("desk.cardInset", { right: 0, top: 0 });
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
    if (!slug || cardCollapsed()) return cx.notify();
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

  // A section's title: 12 semibold, its count or summary dim at the right, then an optional action.
  head(t, id, title, meta, extra) {
    return h_flex().id(`card-sec-${id}`).h(SECTION).flex_none().pl(14).pr(extra ? 8 : 14).gap(6).items_center()
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child(title))
      .child(div().flex_1())
      .when(Boolean(meta), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(meta)))
      .when(Boolean(extra), (el) => el.child(extra));
  }

  // A folded group ("Previous · 3").
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
      const row = { id: `ln-${x.slug}`, desk: true, kind, name, status: ms.length ? mostUrgent(ms.map((m) => m.status)) ?? "idle" : "idle",
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
      name: r.name, muted: !r.stop, mark: statusMark(t, shownStatus(r.status, r.address ?? r.stop?.[0]), 12), actions,
      onClick: r.open ? () => r.open() : null, tip: r.name,
    });
  }

  // ── sections ──────────────────────────────────────────────────────────────

  // A member's face: its role's avatar with the program's mark (roles.js agentIcon).
  face(t, m, role, size = 18) {
    return agentIcon(t, { role: role ?? m.role, cli: agentCli({ session: sessionOf(m.address), role }), ring: t.background }, size);
  }

  // One member: its row, and its actions under it when opened.
  memberRows(t, d, m) {
    const role = this.roles.byId(m.role), open = this.open === m.address, s = sessionOf(m.address), id = `ag-${m.address}`;
    const more = iconButton(t, `${id}-more`, open ? "chevron-down" : "chevron", open ? "Hide its actions" : "Its actions: compact, fresh start, review, QA, PR",
      (_e, cx) => { this.open = open ? null : m.address; cx.notify(); }, { color: open ? t.foreground : undefined });
    const jobs = shared("desk.jobs")?.task === d.slug ? shared("desk.jobs").by?.[m.address]?.length ?? 0 : 0;
    const g = this.git[m.cwd], stat = role?.worktree && g && (g.adds || g.dels) ? this.stat(t, g.adds, g.dels, g.dirty) : null;
    const rows = [this.row(t, id, {
      lead: this.face(t, m, role), name: role?.name ?? m.role,
      meta: jobs ? `${jobs} job${jobs === 1 ? "" : "s"} running` : m.status === "blocked" ? "needs you" : null,
      metaColor: m.status === "blocked" && !jobs ? t.blocked : undefined, rest: stat,
      mark: statusMark(t, shownStatus(m.status ?? "idle", m.address), 12), actions: [more],
      // Its own conversation (a route of this desk); the terminal stays one click away in its actions.
      onClick: () => { showTerminals(false); setShared("desk.view", d.slug); setShared("desk.route", { task: d.slug, address: m.address }); },
      tip: [m.note ?? s?.title, "Open its conversation"].filter(Boolean).join(" · "),
    })];
    if (open) rows.push(div().mx(4).mb(4).rounded(8).bg(t.raised).child(this.desks.memberDetail(t, m, d, true)));
    return rows;
  }

  // A worktree's diff line, under Build.
  changeRow(t, m) {
    const g = this.git[m.cwd], role = this.roles.byId(m.role), read = m.cwd in this.git;
    const lead = h_flex().w(18).flex_none().justify_center().child(icon("branch", 13).text_color(t.dim));
    if (read && !g) return null;
    const meta = g ? [g.ahead ? `↑${g.ahead}` : null, g.dirty ? `${g.dirty} uncommitted` : null].filter(Boolean).join(" · ") : "…";
    const tip = g ? [`${plural(g.files, "file")} changed since ${g.base || "HEAD"}`, g.branch, "Open the diff"].filter(Boolean).join(" · ") : "Reading git…";
    return this.row(t, `ch-${m.address}`, { lead, name: g && offMain(g.branch, g.base) ? g.branch : `${role?.name ?? m.role}'s changes`, meta, muted: true,
      rest: g && (g.adds || g.dels) ? this.stat(t, g.adds, g.dels, g.dirty) : div().text_size(11).text_color(t.dim).child(g ? "clean" : ""),
      onClick: () => this.openChanges(m), tip });
  }

  stat(t, adds, dels, dirty) {
    return h_flex().flex_none().gap(5).text_size(11.5).font_medium()
      .when(Boolean(dirty), (el) => el.child(div().size(5).rounded(3).bg(t.blocked)).tooltip(`${dirty} uncommitted`))
      .child(div().text_color(t.ansi2).child(`+${adds}`)).child(div().text_color(t.ansi1).child(`−${dels}`));
  }

  prRow(t, p) {
    const color = p.state === "MERGED" ? t.ansi5 : p.state === "OPEN" ? t.ansi2 : t.dim;
    return this.row(t, `pr-${p.number}`, { lead: h_flex().w(18).flex_none().justify_center().child(icon("pr", 13).text_color(color)), name: p.title, muted: p.state !== "OPEN",
      rest: div().text_size(11).text_color(t.dim).child(`#${p.number}`), onClick: () => exec("open", [p.url]),
      tip: `${p.state === "MERGED" ? "Merged" : p.state === "OPEN" ? "Open" : "Closed"} · ${p.url}` });
  }

  // The add-member menu: one chip per role (a second engineer of a role gets "+1").
  adder(t, d, members) {
    const present = new Set(members.map((m) => m.role));
    return h_flex().px(14).pt(8).pb(8).gap(5).flex_wrap().border_t(1).border_color(t.border)
      .children((this.roles.list ?? []).map((r) => this.desks.chip(t, `cadd-${r.id}`, false, `${r.name}${present.has(r.id) ? " +1" : ""}`,
        (_e, cx) => { this.adding = false; this.desks.busy(`add-${r.id}`, () => this.desks.addMember(r, d), cx); },
        agentIcon(t, { role: r }, 16))));
  }

  // ── the pipeline ──────────────────────────────────────────────────────────

  // Each stage: its state (ok, now, wait, idle), one line saying who is in it, and its rows.
  stages(t, d, members, subs, trees, prs) {
    const slug = d.slug, live = new Set(members.map((m) => m.address));
    const finished = finishedRoles(runtimeData().sessions, slug, live);
    const stageOf = (role) => STAGE_OF[role] ?? "build";
    const word = (m) => (m.status === "blocked" ? "needs you" : m.status === "working" ? "working" : "idle");
    const out = {};
    for (const st of STAGES.slice(0, 4)) {
      const ms = members.filter((m) => stageOf(m.role) === st.id), done = finished.filter((f) => stageOf(f.role) === st.id);
      const state = ms.some((m) => m.status === "blocked") ? "wait" : ms.some((m) => m.status === "working") ? "now" : ms.length || done.length ? "ok" : "idle";
      const names = [...ms.map((m) => `${this.roles.byId(m.role)?.name ?? m.role} ${word(m)}`),
        ...done.map((f) => `${this.roles.byId(f.role)?.name ?? f.role}${f.count > 1 ? ` ×${f.count}` : ""} finished`)];
      const rows = [...ms.flatMap((m) => this.memberRows(t, d, m)),
        ...done.map((f) => { const role = this.roles.byId(f.role), name = role?.name ?? f.role;
          return this.row(t, `done-${f.role}`, { lead: this.face(t, { address: f.address, role: f.role }, role), muted: true,
            name: f.count > 1 ? `${name} ×${f.count}` : name, meta: "finished", mark: statusMark(t, "done", 12, { still: true }), tip: f.titles.join(" · ") || `${name} finished here` }); })];
      out[st.id] = { state, sub: names.join(" · "), rows, needs: ms.filter((m) => m.status === "blocked").length };
    }
    // Build also holds its sub-agents and each worktree's diff.
    const app = new Map(agents().map((a) => [a.address, a]));
    out.build.rows.push(
      ...subs.map((s) => { const a = app.get(s.address);
        return this.row(t, `sub-${s.address}`, { indent: 12, lead: h_flex().w(18).flex_none().justify_center().child(icon("sparkles", 13).text_color(t.dim)),
          name: s.name || a?.app || s.program?.name || s.address, muted: true, mark: statusMark(t, shownStatus(a?.status ?? "idle", s.address), 12),
          onClick: () => openTerminal(s.address, { peek: true }), tip: "Sub-agent: peek at its terminal" }); }),
      ...trees.filter((m) => this.roles.byId(m.role)?.worktree).map((m) => this.changeRow(t, m)).filter(Boolean));
    // The gate: the CTO's latest gate line in the chat.
    const gate = [...(this.desks.messages ?? [])].reverse().find((m) => m.kind === "gate");
    const gateState = !gate ? "idle" : /\bpass/i.test(gate.text) ? "ok" : /escalat/i.test(gate.text) ? "wait" : "now";
    out.gate = { state: gateState, sub: gate ? firstLine(gate.text) : "", needs: 0,
      rows: gate ? [div().mx(6).px(8).py(6).rounded(6).bg(t.raised).text_size(11.5).line_height(1.45).text_color(t.muted).child(gate.text)] : [] };
    const open = prs.filter((p) => p.state === "OPEN"), merged = prs.filter((p) => p.state === "MERGED");
    out.pr = { state: open.length ? "now" : merged.length ? "ok" : "idle", needs: 0,
      sub: prs.length ? [open.length && `${open.length} open`, merged.length && `${merged.length} merged`].filter(Boolean).join(" · ") || plural(prs.length, "pull request") : "",
      rows: prs.map((p) => this.prRow(t, p)) };
    return out;
  }

  // The node on the line: a check when done, the live mark while it runs or waits, its number at rest.
  node(t, state, n) {
    const ring = state === "ok" ? t.done : state === "now" ? t.working : state === "wait" ? t.blocked : t.input;
    return h_flex().size(NODE).flex_none().items_center().justify_center().rounded(NODE / 2).bg(t.chrome).border_1().border_color(ring)
      .child(state === "ok" ? icon("check", 10).text_color(t.done)
        : state === "now" ? statusMark(t, "working", 10)
        : state === "wait" ? statusMark(t, "blocked", 10)
        : div().text_size(9.5).text_color(t.dim).child(String(n)));
  }

  stage(t, st, i, s, last) {
    const open = this.stageOpen[st.id] ?? (s.state === "now" || s.state === "wait");
    const live = s.state !== "idle", can = s.rows.length > 0;
    return h_flex().id(`stage-${st.id}`).flex_none().items_start().pl(12).pr(6).gap(8)
      .child(v_flex().w(NODE).flex_none().self_stretch().items_center().pt(8)
        .child(this.node(t, s.state, i + 1))
        .when(!last, (el) => el.child(div().w(1).flex_1().min_h(6).mt(2).bg(t.border))))
      .child(v_flex().min_w(0).flex_1().pb(last ? 4 : 8)
        .child(v_flex().id(`stage-head-${st.id}`).px(6).py(7).rounded(7)
          .when(can, (el) => el.cursor_pointer().hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => { this.stageOpen[st.id] = !open; cx.notify(); }))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_none().text_size(12.5).font_semibold().text_color(live ? t.foreground : t.muted).child(st.title))
            .when(s.needs > 0, (el) => el.child(pill(t, `${s.needs} need${s.needs === 1 ? "s" : ""} you`, t.blocked)))
            .child(div().flex_1())
            .when(can, (el) => el.child(icon(open ? "chevron-down" : "chevron", 10).text_color(t.dim))))
          .child(div().pt(2).text_size(11.5).line_height(1.35).text_color(t.dim).child(s.sub || st.hint)))
        .when(open && can, (el) => el.child(v_flex().mx(-6).pt(2).children(s.rows))));
  }

  // The desk's parent, forks and side questions.
  relatedSection(t, line) {
    const running = line.running.filter((r) => r.desk), previous = line.previous.filter((r) => r.desk);
    if (!running.length && !previous.length) return null;
    const rows = running.map((r) => this.lineRow(t, r));
    if (previous.length) {
      rows.push(this.shelfRow(t, "lineage-prev", "Previous", previous.length, this.shelf.previous, () => { this.shelf.previous = !this.shelf.previous; }));
      if (this.shelf.previous) rows.push(...previous.map((r) => this.lineRow(t, r)));
    }
    return v_flex().child(div().h(1).flex_none().mx(14).my(6).bg(t.border))
      .child(this.head(t, "related", "Related desks", running.length ? `${running.length} running` : null)).children(rows);
  }

  // One 44px row: the title (13 semibold), its dim meta, and the button that folds the column away.
  header(t, title, meta, mark) {
    return h_flex().id("card-head").h(HEAD).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().min_w(0).flex_1().gap(6).items_center()
        .child(div().min_w(0).flex_shrink_1().truncate().text_size(13).font_semibold().text_color(t.foreground).child(title))
        .when(Boolean(mark), (el) => el.child(mark))
        .when(Boolean(meta), (el) => el.child(div().flex_shrink_0().max_w(110).truncate().text_size(11).text_color(t.dim).child(meta))))
      .child(iconButton(t, "card-collapse", "collapse", "Hide this panel (the rail brings it back)", () => setCardCollapsed(true), { size: 24 }));
  }

  render(_cx) {
    const t = theme(), slug = this.slug, d = slug ? this.desks.desk(slug) : null;
    const root = v_flex().id("desk-card").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).overflow_hidden();
    // Nothing to show: ui.js has hidden the column (or is about to).
    if (!d || cardCollapsed()) return root;

    const members = deskMembers(slug), trees = this.worktrees();
    const [name, when] = d.name.includes(" · ") ? d.name.split(" · ") : [d.name, null];
    const lost = (runtimeData().sessions ?? []).filter((s) => s.task === slug && s.state === "disconnected");
    const where = d.project && d.project !== name ? d.project : when;
    const mark = lost.length ? statusMark(t, "disconnected", 11) : null;
    const subs = this.subagents(members), line = this.lineage(slug, d, members);
    const prs = trees.flatMap((m) => this.prs[m.cwd] ?? []);
    const stages = this.stages(t, d, members, subs, trees, prs);
    const related = this.relatedSection(t, line);

    const body = v_flex().id(`card-body-${slug}`).flex_1().min_h(0).overflow_y_scrollbar().pt(8).pb(8)
      .when(lost.length > 0, (el) => el.child(div().mx(10).mb(8).child(v_flex().gap(5).children(this.desks.workflow.disconnected(t, slug)))))
      .children(STAGES.map((st, i) => this.stage(t, st, i, stages[st.id], i === STAGES.length - 1)))
      .when(Boolean(related), (el) => el.child(related));

    // Wrap up while anyone's running; once they're all closed, Delete (asks in a dialog).
    const acting = this.desks.acting;
    const footer = h_flex().h(FOOT).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
      .child(button(t, "card-add", this.adding ? "Cancel" : "Add member", (_e, cx) => { this.adding = !this.adding; cx.notify(); },
        { iconName: this.adding ? "minus" : "plus", variant: "ghost", tip: "Bring someone in now. The CTO also brings people in when the work needs them." }))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(acting && acting !== "wrap" ? "Working…" : ""))
      .when(members.length > 0, (el) => el.child(button(t, "card-wrap", acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.desks.wrapUp(d, cx),
        { disabled: Boolean(acting), tip: "Each agent flags anything left locally, or cleans up its worktree and closes" })))
      .when(!members.length, (el) => el.child(button(t, "card-del", "Delete desk", () => this.desks.askDelete(d),
        { iconName: "trash", disabled: Boolean(acting), tip: "Nobody's running. Kept in ~/.herdr/team/.deleted, so it can be put back" })));

    return root.child(this.header(t, name, where, mark)).child(body)
      .when(this.adding, (el) => el.child(this.adder(t, d, members))).child(footer);
  }
}
