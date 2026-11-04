import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, InputState, Input, TextView } from "gpui-base";
import { terminals, agents, panes, spaces, exec, home, appHome, readTextFile, watchFolder, notify, run, shared, setShared, hc, playSound, pickFolder, settings, window as appWindow } from "herdr";
import { button, empty, icon, statusMark } from "./ui.js";
import { Roles, roleTile, team, folderOf, findBriefs, startBrief, fileBrief } from "./roles.js";
import { WorkflowControls, runtimeData, runTeam, refreshRuntime, openDesk } from "./workflows.js";
import { ReviewView } from "./review.js";
import { ThreadViewport } from "./thread.js";
import { buildRows, windowStart, WINDOW, splitPoll, summarizeSteps, statusLines, rowOffsets, activePrompt, kTokens, parseTranscript, buildRouteRows } from "./model.js";
import { COLUMN, measured, messageRow, liveRows, statusLineRows, headerStrip } from "./timeline.js";
import { routeKey, routeHeader, routeRow, routeEmpty, commandMenu } from "./route.js";
import { commandsFor, slashQuery, matchCommands, resolveCommand, menuKey, mentionQuery, matchMentions } from "./commands.js";
import { minimap } from "./minimap.js";

// Desks: each one an independent team (its own agents, thread and worktrees) that
// bin/team keeps in ~/.herdr/team/<desk>.jsonl and on its agents' task=<desk> labels.
// The tab shows the list of desks, a form to start one, and a desk: who's in it,
// its thread, and a composer with @mentions. You talk to the CTO unless you @ someone;
// the CTO can ask engineers in the chat (team say --to) and sees everything posted.

const DIR = () => `${home()}/.herdr/team`;
const TEAM = () => `${appHome()}/bin/team`;
const STATUS = { blocked: "needs you", done: "done", working: "working", idle: "idle" };
// How long bin/team waits on a permission request before Claude asks in its terminal instead.
const PERMIT_WAIT = 540000;
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
// One exec per working agent per wake: its step tail, then (if supported) its timeline.
const POLL = `tail -n 60 "$1" 2>/dev/null; printf '\\n\\036\\n'; [ "$3" = 1 ] && "$2" timeline --address "$4" 2>/dev/null; exit 0`;

// In the desk-chat layout the center is a stack: the chat, or the shown tab's terminals.
// Anything that jumps to a terminal switches the stack first; other layouts just focus it.
export const chatLayout = () => shared("layout") === "desk-chat";
export function showTerminals(on = true) {
  if (!chatLayout()) return;
  setShared("deskchat.terminals", on);
  run("layout.select", { stack: "center", child: on ? "main" : "chat" });
  run(on ? "layout.show" : "layout.hide", { id: "tabs" });
}
export function openTerminal(address, { peek = false } = {}) {
  showTerminals(true);
  run(peek ? "terminal.peek" : "agent.focus", { terminal: address });
}


// A desk's live agents, parents before their children.
export function deskMembers(slug) {
  const status = new Map(agents().map((a) => [a.address, a.status]));
  const disconnected = new Set((runtimeData().sessions ?? []).filter((s) => ["disconnected", "finished", "recovering"].includes(s.state)).map((s) => s.address));
  const live = terminals().filter((t) => t.state === "live" && t.labels?.task === slug && t.labels?.role && !disconnected.has(t.address))
    .map((t) => ({ address: t.address, role: t.labels.role, parent: t.parent, status: status.get(t.address) ?? t.status?.state ?? t.status ?? null,
      phase: t.labels.phase, note: t.labels.note, awaiting: t.labels.awaiting ?? null, space: t.labels["herdr.space"], cwd: t.cwd, created: t.created_ms ?? 0,
      ctx: Number(t.labels.ctx) || null, handingOff: (t.labels.awaiting ?? "").startsWith("fresh") }));
  const addrs = new Set(live.map((m) => m.address));
  const depth = (m) => {
    const seen = new Set([m.address]); let n = 0;
    while (m.parent && addrs.has(m.parent) && !seen.has(m.parent)) { seen.add(m.parent); m = live.find((x) => x.address === m.parent); n++; }
    return n;
  };
  return live.map((m) => ({ ...m, depth: depth(m) }))
    .sort((a, b) => (a.role === "cto" ? -1 : b.role === "cto" ? 1 : a.depth - b.depth || a.created - b.created));
}

const clock = (ms) => {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${new Date().toDateString() === d.toDateString() ? "" : `${d.getDate()}/${d.getMonth() + 1} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const parse = (text) => (text ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// slug \t mtime \t lines \t first line \t last line, per thread, newest first.
const LIST = `cd "$1" 2>/dev/null || exit 0
for f in *.jsonl; do [ -f "$f" ] || continue
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${f%.jsonl}" "$(stat -f %m "$f")" "$(wc -l < "$f" | tr -d ' ')" "$(head -n1 "$f")" "$(tail -n1 "$f")"
done | sort -t "$(printf '\\t')" -k2 -rn`;

// Toasts once per report: an agent's phase label changing.
class PhaseWatch {
  constructor() { this.seen = null; }
  check(roles) {
    const now = new Map();
    for (const t of terminals()) if (t.labels?.phase) now.set(t.address, `${t.labels.phase}\u0000${t.labels.note ?? ""}`);
    if (this.seen) for (const t of terminals()) {
      const key = now.get(t.address);
      if (!key || this.seen.get(t.address) === key) continue;
      notify({ title: `${roles.byId(t.labels.role)?.name ?? t.name} ${t.labels.phase} · ${t.labels.task ?? ""}`, body: t.labels.note ?? "",
        level: t.labels.phase === "blocked" ? "warning" : t.labels.phase === "done" ? "success" : "info", timeout: 6000 });
    }
    this.seen = now;
  }
}

export class Desks {
  // panel: the Desk panel (projects, spaceFor, hover state). fixed: a desk this view always shows (a pane).
  // wide: the chat is the window's main view (centered column, roomier type).
  constructor(panel, cx, { fixed = null, toasts = false, wide = false } = {}) {
    this.panel = panel;
    this.fixed = fixed;
    this.wide = wide;
    this.toasts = toasts;
    this.roles = new Roles();
    this.desks = [];
    this.messages = [];
    this.briefs = [];
    this.counts = null;        // lines per desk last seen by the watcher (toasts)
    this.read = store.get("desks.read", {});  // lines per desk you've seen (unread badges)
    this.acting = null;
    this.addOpen = false;
    this.detailsOpen = false;
    this.confirmDelete = 0;
    this.mention = null;       // { start, q } while typing @…
    this.hoverMsg = null;      // the message under the pointer (its copy button shows)
    this.copied = null;        // the message just copied (its check shows for 2s)
    this.expanded = new Set(); // long messages opened with "Show more"
    this.watch = new PhaseWatch();
    this.workflow = new WorkflowControls(this);
    this.review = new ReviewView();
    this.review.init(cx);
    this.sendMode = "now";
    this.composeAt = 0; this.reviewAt = 0; this.reviewOpen = false;
    this.drafts = {}; this.draftDesk = null;
    this.thread = new ThreadViewport(cx);
    this.thread.onMeasure = (key, cx) => this.trySeek(key, cx, true);
    // Derived thread (model.js buildRows), rebuilt on reload; row objects cached by id + text.
    this.model = buildRows([]); this.rowCache = new Map(); this.cacheDesk = null;
    this.windowFrom = {};      // desk -> first drawn row (the window holds still while you read)
    this.rowH = new Map();     // "desk:row" -> measured height (window px), for the minimap
    this.drawnKeys = {};       // desk -> keys of the rows drawn last frame, in order
    this.seekKey = null;       // { slug, key, tries } while a minimap jump waits for layout
    this.folds = new Set();    // finished turns opened to their steps
    this.toolsOpen = new Set(); this.subsOpen = new Set(); this.queueShown = false;

    // Two composers: the team chat's (with @mentions) and a member route's (direct to that member).
    // Both open the slash menu on a leading "/".
    this.teamInput = TextareaState.new({ placeholder: "Message the team · / for commands", rows: 2 });
    this.routeInput = TextareaState.new({ placeholder: "Message it directly · / for commands", rows: 2 });
    this.input = this.teamInput;
    for (const state of [this.teamInput, this.routeInput]) {
      state.set_auto_grow(2, 6);
      state.on("change", (_e, cx) => { if (state === this.teamInput) this.trackMention(); this.trackSlash(); cx.notify(); });
      state.on("submit", (e, cx) => {
        if (e.shift) return;
        const menu = this.slashItems();
        if (menu) { if (menu.length) this.pickCommand(menu[Math.min(this.slashIndex, menu.length - 1)], cx, true); else this.send(cx); return; }
        const sugg = state === this.teamInput ? this.suggestions() : [];
        if (sugg.length) return this.pickMention(sugg[Math.min(this.mentionIndex, sugg.length - 1)], cx);
        this.send(cx);
      });
    }
    this.slashQ = null; this.slashIndex = 0; this.slashShut = null;
    this.mentionIndex = 0; this.mentionShut = null;  // the highlighted @ suggestion; the value Esc closed it on
    // The textarea's own bindings run before key listeners, so the open menu binds its keys in a
    // context the composer declares only while it's open, one level above the input.
    if (!globalThis.deskSlashKeys) try {
      globalThis.deskSlashKeys = true;
      const keys = { up: "desk_slash_up", down: "desk_slash_down", tab: "desk_slash_tab", escape: "desk_slash_escape" };
      cx.bind_keys(Object.entries(keys).flatMap(([keystroke, action]) => [
        { keystroke, action, context: "DeskSlashOpen > Input" }, { keystroke, action, context: "DeskSlashOpen" }]));
    } catch {}
    // Member routes: address -> { data (parsed team transcript), sig, at, working }; rows derived on fetch.
    this.routeData = {}; this.routeRows = { rows: [], prompts: [] }; this.routeCache = new Map(); this.routeShown = null;
    this.routeDrafts = {};

    this.newName = InputState.new({ placeholder: "Name (optional), e.g. Health check" });
    this.newTask = TextareaState.new({ placeholder: "What should the team do? It goes to the CTO, or to everyone you picked if there's no CTO.", rows: 4 });
    this.newTask.set_auto_grow(3, 10);
    this.newTask.on("change", (_e, cx) => cx.notify());
    this.newTarget = store.get("desks.target", null);
    this.newRoles = new Set(["cto"]);

    // What each working agent is doing: its tool calls this turn, from bin/team's PreToolUse hook
    // (~/.herdr/team/.activity/<address>.jsonl). Polled only while someone in the open desk works.
    this.steps = {};                                   // address -> [{ at, tool, text }]
    this.stepsSeen = {};                               // address -> ms the newest row was first drawn (for its fade-in)
    this.timelines = {};                               // address -> parsed `team timeline` (kept after the turn for context)
    this.timelineSig = {}; this.noTimeline = {};       // last JSON seen; when it last failed (retry after a minute)
    this.snapshots = store.get("desks.turns", {});     // address -> [{ first, ended, steps, summary, subagents }] of finished turns
    // One shared clock for every elapsed label: only the primary copy ticks, only while a desk
    // agent works and the window is in front. setShared redraws every copy.
    cx.timer.every(1000, () => {
      if (!(this.wide || (!chatLayout() && this.toasts)) || !appWindow().active) return;
      const desk = new Set(terminals().filter((x) => x.labels?.task && x.labels?.role).map((x) => x.address));
      if (agents().some((a) => a.status === "working" && desk.has(a.address))) setShared("desk.tick", Math.floor(Date.now() / 1000));
    });
    // Woken by the hook's writes; the slow timer only clears feeds of agents that stopped.
    cx.timer.every(4000, (cx) => { this.pollSteps(cx); this.pollRoute(cx); });
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", `${DIR()}/.activity`]);
      for (;;) { await watchFolder(`${DIR()}/.activity`); this.pollSteps(cx); this.pollRoute(cx); }
    });

    this.roles.load(cx);
    cx.timer.every(5000, (cx) => this.roles.load(cx));
    cx.timer.every(2500, () => { if (this.toasts) this.watch.check(this.roles); });
    cx.timer.every(8000, (cx) => this.scanBriefs(cx));
    // Another mod can open a desk (shared "desk.view": the sidebar, the spaces list); load it.
    // "desk.here" (a space picked in the spaces list) points a new desk at that space.
    cx.timer.every(400, (cx) => {
      const primary = this.wide || (!chatLayout() && this.toasts);
      const compose = primary && shared("desk.compose");
      if (compose?.at && compose.at !== this.composeAt) {
        this.composeAt = compose.at;
        this.syncDraft(compose.task ?? this.view);
        setShared("desk.compose", null);
        this.directTarget = compose.address ?? null; this.directTask = compose.task ?? null;
        if (compose.task) openDesk(compose.task);
        const note = `${compose.role ? `@${compose.role} ` : ""}${compose.text ?? ""}`;
        this.input.set_value([this.input.value().trim(), note].filter(Boolean).join("\n\n"));
        this.sendMode = "now";
        this.input.focus();
      }
      const side = primary && shared("desk.side");
      if (side?.at && side.at !== this.sideAt) { this.sideAt = side.at; this.workflow.question.set_value(""); cx.notify(); }
      const review = primary && shared("desk.review");
      if (review?.at && review.at !== this.reviewAt) {
        this.reviewAt = review.at; this.reviewOpen = true;
        this.review.open({ ...review, messages: this.messages }, cx);
      }
      // A route belongs to its desk: another desk shown (the sidebar sets desk.view) clears it.
      // Only when desk.view changes: a sidebar member click writes desk.view, then desk.route.
      const route = shared("desk.route");
      if (this.viewSeen !== this.view) {
        if (primary && route && !this.fixed && this.viewSeen !== undefined && route.task !== this.view) setShared("desk.route", null);
        this.viewSeen = this.view;
      }
      const shownRoute = route && route.task === this.view ? route.address : null;
      if (shownRoute !== this.routeShown) this.switchRoute(shownRoute, cx);
      const here = shared("desk.here")?.at ?? 0;
      if (here !== this.hereAt) { this.hereAt = here; if (this.loaded !== undefined) { this.newTarget = null; cx.notify(); } }
      if (this.loaded !== undefined && this.view !== this.loaded) this.reload(cx);
      // The spaces list's "+" asks for a desk in a folder (shared "desk.start"); the main chat
      // starts it with the CTO and clears the request, so it runs once.
      const ask = this.wide && shared("desk.start");
      if (ask?.folder && this.roles.list && !this.acting) {
        setShared("desk.start", null);
        const cto = this.roles.list.filter((r) => r.id === "cto");
        if (cto.length) {
          this.starting = ask.folder;
          this.busy("new", () => this.startDesk(ask.folder, cto).finally(() => { this.starting = null; }), cx);
        }
      }
    });
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR()]);
      await this.reload(cx);
      // macOS watches recursively: .activity/ (every tool call), .runtime.json and the locks
      // change many times a second while agents work. Only a desk's thread file is news.
      for (;;) {
        const changed = await watchFolder(DIR());
        if (!changed.some((p) => p === DIR() || p === `${DIR()}/` || /^[^/.][^/]*\.jsonl$/.test(p.slice(DIR().length + 1)))) continue;
        await this.reload(cx);
      }
    });
  }

  // ── state ─────────────────────────────────────────────────────────────────

  get view() { return this.fixed ?? shared("desk.view") ?? "list"; }
  go(view, cx) {
    setShared("desk.view", view);
    if (shared("desk.route")) setShared("desk.route", null);
    this.addOpen = false; this.detailsOpen = false; this.confirmDelete = 0; this.mention = null;
    this.syncDraft(view);
    if (view !== "list" && view !== "new") this.markRead(view);
    this.reload(cx);
  }
  syncDraft(task) {
    if (this.draftDesk === task) return;
    if (this.draftDesk) this.drafts[this.draftDesk] = { text: this.teamInput.value(), address: this.directTarget, task: this.directTask };
    const draft = task && this.drafts[task];
    this.draftDesk = task;
    this.directTarget = draft?.address ?? null; this.directTask = draft?.task ?? null;
    this.teamInput.set_value(draft?.text ?? "");
    this.mention = null;
  }

  desk(slug = this.view) { return this.desks.find((d) => d.slug === slug) ?? null; }
  // The open desk is in front of you: the panel's Desks tab, or the chat as the main view.
  onScreen() { return shared("desk.tab") === "desks" || (chatLayout() && !shared("deskchat.terminals")); }

  markRead(slug) {
    const d = this.desk(slug);
    if (d && this.read[slug] !== d.n) { this.read[slug] = d.n; store.set("desks.read", this.read); this.publish(); }
  }
  unread(d) { return Math.max(0, d.n - (this.read[d.slug] ?? (this.read[d.slug] === undefined ? d.n : 0))); }
  publish() {
    const n = this.desks.reduce((sum, d) => sum + this.unread(d), 0);
    if ((shared("desk.counts")?.desks ?? 0) !== n) setShared("desk.counts", { ...shared("desk.counts"), desks: n });
  }

  async reload(cx) {
    this.loaded = this.view;
    try {
      const r = await exec("sh", ["-c", LIST, "list", DIR()]);
      const desks = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [slug, mtime, n, first, last] = line.split("\t");
        let head = null, tail = null;
        try { head = JSON.parse(first); } catch {}
        try { tail = JSON.parse(last); } catch {}
        const meta = head?.kind === "desk" ? head : {};
        return { slug, name: meta.name ?? slug, folder: meta.folder ?? null, project: meta.project ?? null,
          parent_task: meta.parent_task ?? null, at: Number(mtime) * 1000, n: Number(n), last: tail };
      });
      // Toast what agents say in desks you aren't looking at.
      if (this.toasts && this.counts) for (const d of desks) {
        const before = this.counts[d.slug];
        if (before === undefined || d.n <= before) continue;
        const looking = d.slug === this.view && this.onScreen();
        for (const m of parse(await readTextFile(`${DIR()}/${d.slug}.jsonl`)).slice(before)) {
          // A permission request rings even when you're looking: an agent is stopped until you answer.
          if (m.kind === "permission" && looking) { playSound("blocked"); continue; }
          if (m.kind === "permission") {
            playSound("blocked");
            notify({ title: `${this.roles.byId(m.from)?.name ?? m.from} asks to use ${m.tool} · ${d.name}`, body: `${(m.detail ?? "").slice(0, 140)}\nClick to answer in the chat`,
              level: "warning", timeout: 15000, action: { name: `desk.open-${d.slug}` } });
          }
          if (!looking && m.from !== "kabeer" && (m.kind === "say" || m.kind === "flag")) {
            notify({ title: `${this.roles.byId(m.from)?.name ?? m.from} · ${d.name}`, body: m.text.slice(0, 160), level: m.kind === "flag" ? "warning" : "info", timeout: 6000 });
          }
        }
      }
      this.counts = Object.fromEntries(desks.map((d) => [d.slug, d.n]));
      this.desks = desks;
      const open = this.desk();
      this.messages = open ? parse(await readTextFile(`${DIR()}/${open.slug}.jsonl`)) : [];
      this.derive(open?.slug ?? null);
      if (open && (this.onScreen() || this.fixed || this.wide)) this.markRead(open.slug);
      this.publish();
      if (this.routeShown) { this.deriveRoute(); this.pollRoute(cx, true); }
    } catch { this.messages = []; this.derive(null); }
    cx.notify();
  }

  // Rows for the open desk, derived once per reload (never in render).
  derive(slug) {
    if (this.cacheDesk !== slug) { this.rowCache = new Map(); this.cacheDesk = slug; }
    this.model = buildRows(this.messages, this.rowCache);
  }

  // A desk's live agents, parents before their children.
  members(slug = this.view) { return deskMembers(slug); }

  scanBriefs(cx) {
    const d = this.desk();
    if (!d?.folder) { this.briefs = []; return; }
    cx.spawn(async (cx) => {
      try { this.briefs = (await findBriefs([d.folder])).filter((b) => b.desk === d.slug); } catch { this.briefs = []; }
      cx.notify();
    });
  }

  projectList() { return this.panel?.projects?.() ?? shared("desk.projects") ?? []; }

  // Where the new-desk form points: a folder you picked ("folder:<path>"), a project, or the
  // space you're in (null).
  targetFolder() {
    const t = this.newTarget;
    if (typeof t === "string" && t.startsWith("folder:")) return t.slice(7);
    return (t && this.projectList().find((p) => p.name === t)?.folder) || folderOf(spaces().find((s) => s.active));
  }
  pickTarget(target, cx) { this.newTarget = target; store.set("desks.target", target); cx.notify(); }

  // macOS's own folder picker; the last few picks stay as chips.
  chooseFolder(cx) {
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Choose the folder this desk works in" });
      if (!folder) return;
      const recent = [folder, ...store.get("desks.folders", []).filter((f) => f !== folder)].slice(0, 4);
      store.set("desks.folders", recent);
      this.pickTarget(`folder:${folder}`, cx);
    });
  }

  // Where a desk's agents start: its project's space, else a space whose folder is the desk's
  // folder, else the nearest space the folder is inside of. Never a space that merely lives
  // somewhere under the folder (a desk in ~/Desktop must not land in ~/Desktop/work/shotgun).
  // None: bin/team opens a new one there.
  spaceFor(folder) {
    if (!folder) return null;
    const project = this.projectList().find((p) => folder === p.folder || folder.startsWith(p.folder + "/"));
    const fromProject = project && this.panel?.spaceFor(project);
    if (fromProject) return fromProject;
    // Only a space at exactly this folder: an ancestor's (~/Desktop for ~/Desktop/work/shotgun)
    // isn't this desk's, so null lets bin/team open a new space here.
    return spaces().find((s) => !s.machine && folderOf(s) === folder) ?? null;
  }

  async addMember(role, d, task) {
    const space = this.spaceFor(d.folder);
    // With a CTO in the desk, newcomers report to it (and it can wait on them).
    const cto = role.id !== "cto" && this.members(d.slug).find((m) => m.role === "cto");
    const args = [role.id, "--repo", d.folder ?? home(), "--slug", d.slug, ...(cto ? ["--parent", cto.address] : ["--no-parent"]), "--requested", "--by", "desk"];
    if (space) args.push("--space", space.id);
    if (task) args.push("--task", task);
    const out = await team(args);
    if (out && space) run("space.select", { id: space.id });
    return out;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  busy(id, fn, cx) {
    if (this.acting) return;
    this.acting = id;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(cx); } catch (e) { notify({ title: "Something went wrong", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 6000 }); }
      this.acting = null;
      await this.reload(cx);
    });
  }

  // The name of a running desk in the repo the form points at, if any.
  sameRepo() {
    const folder = this.targetFolder();
    const other = folder && this.desks.find((d) => d.folder && (folder === d.folder || folder.startsWith(`${d.folder}/`)) && this.members(d.slug).length);
    return other?.name ?? null;
  }

  createDesk(cx) {
    const name = this.newName.value().trim(), task = this.newTask.value().trim();
    const folder = this.targetFolder() ?? home();
    const chosen = (this.roles.list ?? []).filter((r) => this.newRoles.has(r.id));
    if (!chosen.length) return notify({ title: "Pick who joins", body: "Choose at least one role for the desk.", level: "warning", timeout: 4000 });
    this.busy("new", async () => {
      await this.startDesk(folder, chosen, { name, task });
      this.newName.set_value(""); this.newTask.set_value("");
    }, cx);
  }

  // A desk in `folder` with these roles, opened once its first member is running. The task, if
  // any, goes to the CTO (or to everyone when there is no CTO).
  async startDesk(folder, roles, { name = "", task = "" } = {}) {
    const r = await exec(TEAM(), ["new-desk", "--repo", folder, ...(name || task ? ["--name", name || task.split(/\s+/).slice(0, 6).join(" ")] : [])]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
    const desk = { ...JSON.parse(r.stdout), folder };
    const lead = roles.find((c) => c.id === "cto");
    for (const role of roles) await this.addMember(role, desk, task && (!lead || role === lead) ? task : undefined);
    setShared("desk.view", desk.slug);
  }

  wrapUp(d, cx) {
    // Children first, so a shared worktree is free when its owner wraps up.
    const order = [...this.members(d.slug)].sort((a, b) => b.depth - a.depth);
    if (!order.length) return;
    this.busy("wrap", async () => {
      const results = [];
      for (const m of order) {
        const r = await exec(TEAM(), ["finish", "--address", m.address]);
        try { results.push(JSON.parse(r.stdout)); } catch { results.push({ finished: false }); }
      }
      const kept = results.filter((x) => !x.finished).length;
      notify({ title: `Wrapped up ${d.name}`, body: kept ? `${kept} flagged something left locally; see the thread.` : "Everyone's closed and their worktrees are cleaned up.",
        level: kept ? "warning" : "success", timeout: 6000 });
    }, cx);
  }

  // A long context: the agent writes a handoff, then a new session of it takes over (bin/team fresh).
  freshStart(m, cx) {
    this.busy(`fresh-${m.address}`, async () => {
      const r = await exec(TEAM(), ["fresh", "--address", m.address]);
      if (r.code !== 0) { let msg = r.stderr.trim(); try { msg = JSON.parse(msg).error ?? msg; } catch {} throw new Error(msg); }
      notify({ title: `${this.roles.byId(m.role)?.name ?? m.role} is writing a handoff`, body: "A fresh session takes over when it's done.", level: "info", timeout: 5000 });
    }, cx);
  }

  // Claude's /compact: same session, its history swapped for a summary (bin/team compact).
  compact(m, cx) {
    this.busy(`compact-${m.address}`, async () => {
      const r = await exec(TEAM(), ["compact", "--address", m.address]);
      if (r.code !== 0) { let msg = r.stderr.trim(); try { msg = JSON.parse(msg).error ?? msg; } catch {} throw new Error(msg); }
    }, cx);
  }

  overLimit(m) { return Boolean(m.ctx) && m.ctx >= this.roles.freshAt(m.role); }

  deleteDesk(d, cx) {
    if (this.members(d.slug).length) return notify({ title: "Wrap up first", body: "This desk still has agents running.", level: "warning", timeout: 4000 });
    if (Date.now() > this.confirmDelete) { this.confirmDelete = Date.now() + 4000; cx.notify(); cx.timer.after(4100, (cx) => cx.notify()); return; }
    this.busy("delete", async () => {
      // Kept in .deleted/ (outside the list), so a deleted desk can be put back by moving it.
      const r = await exec("sh", ["-c", 'mkdir -p "$1/.deleted" && mv "$1/$2.jsonl" "$1/.deleted/$2-$3.jsonl" && rm -f "$1/$2.cursors.json" "$1/$2.lock"', "del", DIR(), d.slug, String(Date.now())]);
      if (r.code !== 0) throw new Error(r.stderr.trim());
      delete this.read[d.slug]; store.set("desks.read", this.read);
      setShared("desk.view", "list");
    }, cx);
  }


  // ── member routes ─────────────────────────────────────────────────────────
  // shared("desk.route") = { task, address }: the chat shows that member's own conversation.

  // The live member the open route shows, or null (no route, another desk, or it stopped).
  routeMember(slug = this.view) {
    const r = shared("desk.route");
    if (!r || r.task !== slug) return null;
    return this.members(slug).find((m) => m.address === r.address) ?? null;
  }
  get route() { return this.routeShown ? this.routeMember() : null; }
  openRoute(address, cx) {
    if (!address || this.view === "list" || this.view === "new") return;
    setShared("desk.route", { task: this.view, address });
    this.switchRoute(address, cx);
  }
  closeRoute(cx) { setShared("desk.route", null); this.switchRoute(null, cx); }
  // The composer, drafts and rows follow the shown route; its transcript is fetched at once.
  switchRoute(address, cx) {
    if (address === this.routeShown) return;
    if (this.routeShown) this.routeDrafts[this.routeShown] = this.routeInput.value();
    this.routeShown = address;
    this.input = address ? this.routeInput : this.teamInput;
    if (address) this.routeInput.set_value(this.routeDrafts[address] ?? "");
    this.slashQ = null; this.mention = null;
    this.routeCache = new Map();
    this.deriveRoute();
    if (address) { this.thread.latest(routeKey(address)); this.pollRoute(cx, true); }
    cx.notify();
  }
  deriveRoute() {
    const a = this.routeShown, data = a ? this.routeData[a]?.data : null;
    const working = a ? agents().find((x) => x.address === a)?.status === "working" : false;
    // Slash commands sent to it and what came of them, from the desk chat.
    const outcomes = a ? this.messages.filter((m) => m.address === a || (m.kind === "command" && m.delivered_to?.includes(a))) : [];
    this.routeRows = buildRouteRows(data?.turns ?? [], this.routeCache, { working, outcomes });
  }
  // Woken with the step feed (every hook write, a 4s fallback) and on thread reloads; never from
  // render. While it works: at most once a second. Idle: once after the turn ends, then every 30s.
  pollRoute(cx, force = false) {
    const a = this.routeShown;
    if (!a || this.routePolling) return;
    const seen = this.routeData[a], now = Date.now();
    const working = agents().find((x) => x.address === a)?.status === "working";
    if (!force && seen) {
      if (now - seen.at < 1000) return;
      if (!working && !seen.working && now - seen.at < 30000) return;
    }
    this.routePolling = true;
    cx.spawn(async (cx) => {
      let entry = { data: seen?.data ?? null, sig: seen?.sig ?? null, at: Date.now(), working };
      try {
        const r = await exec(TEAM(), ["transcript", "--address", a, "--limit", "120"]);
        if (r.code !== 0) {
          let why = r.stderr.trim(); try { why = JSON.parse(why).error ?? why; } catch {}
          entry = { ...entry, data: entry.data ?? { supported: true, turns: [], error: why.slice(0, 160) } };
        } else if (r.stdout.trim() !== entry.sig) {
          entry = { ...entry, data: parseTranscript(r.stdout) ?? { supported: true, turns: [], error: "unreadable output" }, sig: r.stdout.trim() };
        }
      } catch (e) { entry = { ...entry, data: entry.data ?? { supported: true, turns: [], error: String(e?.message ?? e).slice(0, 160) } }; }
      finally { this.routePolling = false; }
      const changed = entry.sig !== seen?.sig || !seen || entry.working !== seen.working;
      this.routeData[a] = entry;
      if (a === this.routeShown && changed) { this.deriveRoute(); cx.notify(); }
    });
  }
  nameOfAddress(address) {
    const m = terminals().find((x) => x.address === address);
    const role = m?.labels?.role && this.roles.byId(m.labels.role);
    return role?.name ?? m?.labels?.role ?? address;
  }

  // ── slash commands ────────────────────────────────────────────────────────

  trackSlash() {
    const v = this.input.value(), q = slashQuery(v);
    if (q !== this.slashQ) this.slashIndex = 0;
    this.slashQ = q;
    if (this.slashShut !== null && this.slashShut !== v) this.slashShut = null;
  }
  // Who a command goes to: the route's member, else the message's recipients.
  slashTargets() {
    const route = this.route;
    if (route) return [route];
    const members = this.members(), { roles } = this.recipients(members);
    return members.filter((m) => roles.includes(m.role));
  }
  slashCli() {
    const clis = [...new Set(this.slashTargets().map((m) => this.roles.byId(m.role)?.cli ?? "claude"))];
    return clis.length === 1 ? clis[0] : null;
  }
  // The open menu's items, or null when it's closed.
  slashItems() {
    if (this.slashQ === null || this.slashShut === this.input.value()) return null;
    return matchCommands(commandsFor(this.slashCli()), this.slashQ);
  }
  // ↑/↓ move, Tab completes, Esc closes; Enter arrives as the textarea's submit.
  slashKey(e, cx) {
    const items = this.slashItems();
    if (!items) return this.mentionKey(e, cx);
    const key = e.key.toLowerCase() === "arrowup" ? "up" : e.key.toLowerCase() === "arrowdown" ? "down" : e.key.toLowerCase();
    if (key === "enter") return;
    const step = menuKey(key, this.slashIndex, items.length);
    if (!step) return;
    cx.stop_propagation();
    if (step.index !== undefined) this.slashIndex = step.index;
    if (step.complete && items.length) this.completeCommand(items[Math.min(this.slashIndex, items.length - 1)]);
    if (step.close) this.slashShut = this.input.value();
    cx.notify();
  }
  completeCommand(c) {
    this.input.set_value(`/${c.name}${c.args ? " " : ""}`);
    this.trackSlash(); this.input.focus();
  }
  // Picked from the menu: commands that take arguments complete for typing (unless Enter picked
  // the exact name); the rest run at once.
  pickCommand(c, cx, enter = false) {
    if (c.args && (!enter || this.input.value().trim() !== `/${c.name}`)) { this.completeCommand(c); cx.notify(); return; }
    this.input.set_value(""); this.slashQ = null;
    this.runSlash(`/${c.name}`, cx);
  }
  runSlash(text, cx) {
    const d = this.desk();
    if (!d) return;
    const targets = this.slashTargets(), cli = this.slashCli();
    const it = resolveCommand(text, cli);
    const one = targets[0];
    const need = () => { notify({ title: "Who for?", body: "Open a member's conversation, or @mention one person.", level: "warning", timeout: 4000 }); };
    if (it?.kind === "desk") {
      if (it.action === "queue") { this.sendMode = this.sendMode === "queue" ? "now" : "queue"; cx.notify(); return; }
      if (it.action === "wrap") return this.wrapUp(d, cx);
      if (targets.length !== 1) return need();
      if (it.action === "fresh") return this.freshStart(one, cx);
      if (it.action === "terminal") return openTerminal(one.address);
      if (it.action === "changes") return this.openReview(one, d, cx);
      return;
    }
    if (!targets.length) return notify({ title: "Nobody's here", body: "Resume or add an agent first.", level: "warning", timeout: 4000 });
    // A picker is driven in one terminal at a time.
    if (it?.mode === "interactive" && targets.length !== 1) return need();
    const to = targets.flatMap((m) => ["--to", `${m.address}:${m.role}`]);
    const mode = it?.mode ? ["--mode", it.mode] : [];
    this.thread.latest(this.route ? routeKey(this.route.address) : d.slug);
    // The runtime types it, then waits for what came of it (a result, a dialog, a new
    // conversation) and posts that to the chat; it answers within a few seconds.
    this.busy("send", async (cx) => {
      const r = await exec(TEAM(), ["post", "--raw", "--task", d.slug, ...to, ...mode, "--", text]);
      let rec = null; try { rec = JSON.parse(r.stdout); } catch {}
      if (rec?.failed?.length) notify({ title: `${text.split(" ")[0]} not delivered`, body: rec.failed.map((f) => `${this.roles.byId(f.role)?.name ?? f.role}: ${f.why}`).join("\n"), level: "warning", timeout: 7000 });
      else if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't send the command");
      for (const a of rec?.peek ?? []) openTerminal(a, { peek: true });
      // A new conversation: drop what the route showed and read the new one now.
      for (const a of rec?.cleared ?? []) { delete this.routeData[a]; if (a === this.routeShown) { this.routeCache = new Map(); this.deriveRoute(); } }
      if (this.routeShown) { this.pollRoute(cx, true); cx.timer.after(1500, (cx) => this.pollRoute(cx, true)); }
    }, cx);
  }

  // ── mentions ──────────────────────────────────────────────────────────────

  trackMention() {
    const v = this.input.value(), m = mentionQuery(v);
    if (m?.q !== this.mention?.q || m?.start !== this.mention?.start) this.mentionIndex = 0;
    this.mention = m;
    if (this.mentionShut !== null && this.mentionShut !== v) this.mentionShut = null;
  }

  // The open @ menu's options (empty when it's closed or Esc shut it).
  suggestions() {
    if (!this.mention || this.input !== this.teamInput || this.mentionShut === this.input.value()) return [];
    const present = [...new Set(this.members().map((m) => m.role))];
    const options = [...present.map((id) => this.roles.byId(id)).filter(Boolean), ...(present.length > 1 ? [{ id: "all", name: "Everyone" }] : [])];
    return matchMentions(options, this.mention.q);
  }
  // ↑/↓ move the highlight, Tab completes it, Esc closes; Enter arrives as the textarea's submit.
  mentionKey(e, cx) {
    const items = this.suggestions();
    if (!items.length) return;
    const key = e.key.toLowerCase() === "arrowup" ? "up" : e.key.toLowerCase() === "arrowdown" ? "down" : e.key.toLowerCase();
    if (key === "enter") return;
    const step = menuKey(key, Math.min(this.mentionIndex, items.length - 1), items.length);
    if (!step) return;
    cx.stop_propagation();
    if (step.index !== undefined) this.mentionIndex = step.index;
    if (step.complete) return this.pickMention(items[Math.min(this.mentionIndex, items.length - 1)], cx);
    if (step.close) this.mentionShut = this.input.value();
    cx.notify();
  }

  pickMention(option, cx) {
    const v = this.input.value();
    this.input.replace_range_with_token({ start: this.mention.start, end: v.length }, { id: option.id, text: `@${option.id}`, label: option.name });
    this.input.replace(" ");
    this.mention = null; this.mentionIndex = 0;
    this.input.focus();
    cx.notify();
  }

  // Mentioned roles (chips, or typed @role), else the CTO, else everyone in the desk.
  recipients(members) {
    const present = [...new Set(members.map((m) => m.role))];
    const content = this.input.content();
    const named = [...content.tokens.map((s) => s.token.id),
      ...[...content.text.matchAll(/(^|\s)@([a-z]+)\b/g)].map((m) => m[2])].filter((r) => r === "all" || present.includes(r));
    if (named.includes("all")) return { roles: present, implicit: false };
    if (named.length) return { roles: [...new Set(named)], implicit: false };
    return { roles: present.includes("cto") ? ["cto"] : present, implicit: true };
  }

  send(cx) {
    const d = this.desk(), members = this.members(), text = this.input.content().text.trim();
    if (!d || !text || this.acting) return;
    if (/^\/[\w:-]/.test(text)) { this.input.set_value(""); this.slashQ = null; return this.runSlash(text, cx); }
    const route = this.route;
    if (route) {
      const queuedR = this.sendMode === "queue";
      this.thread.latest(routeKey(route.address));
      this.input.set_value("");
      return this.busy("send", async (cx) => {
        try {
          const rec = await runTeam([queuedR ? "queue" : "post", "--task", d.slug, "--to", `${route.address}:${route.role}`, "--", text]);
          if (rec.failed?.length) notify({ title: "Not delivered", body: rec.failed.map((f) => f.why).join("\n"), level: "warning", timeout: 7000 });
          refreshRuntime(cx, true);
          cx.timer.after(1200, (cx) => this.pollRoute(cx, true));
        } catch (e) { this.input.set_value(text); throw e; }
      }, cx);
    }
    const { roles } = this.recipients(members);
    if (!roles.length) return notify({ title: "Nobody's here", body: "Resume or add an agent first.", level: "warning", timeout: 4000 });
    const direct = this.directTask === d.slug && members.find((m) => m.address === this.directTarget && roles.includes(m.role));
    const targets = direct ? [direct] : members.filter((m) => roles.includes(m.role));
    const to = targets.flatMap((m) => ["--to", `${m.address}:${m.role}`]);
    const queued = this.sendMode === "queue";
    this.thread.latest(d.slug);
    this.input.set_value(""); this.mention = null;
    this.busy("send", async (cx) => {
      try {
        const rec = await runTeam([queued ? "queue" : "post", "--task", d.slug, ...to, "--", text]);
        if (rec.failed?.length) notify({ title: "Not delivered to everyone", body: rec.failed.map((f) => `${this.roles.byId(f.role)?.name ?? f.role}: ${f.why}`).join("\n"), level: "warning", timeout: 7000 });
        refreshRuntime(cx, true);
      } catch (e) { this.input.set_value(text); throw e; }
    }, cx);
  }

  openReview(m, d, cx) {
    const request = { repo: m.cwd || d.folder, address: m.address, role: m.role, task: d.slug, at: Date.now() };
    setShared("desk.review", request);
    showTerminals(false);
    if (!this.wide && !chatLayout()) { this.reviewOpen = true; this.review.open({ ...request, messages: this.messages }, cx); }
  }

  // ── pieces ────────────────────────────────────────────────────────────────

  avatar(t, role, status, size = 24) {
    const tile = role ? roleTile(div, svg, t, role, size) : div().size(size).rounded(7).bg(t.raised);
    const mark = status && status !== "idle"
      ? div().absolute().right(-3).bottom(-3).size(12).rounded(6).bg(t.chrome).flex().items_center().justify_center().child(statusMark(t, status, 10)) : null;
    return div().relative().flex_none().child(tile).when(Boolean(mark), (el) => el.child(mark));
  }

  chip(t, id, on, label, onClick, lead) {
    return h_flex().id(id).h(24).px(9).gap(6).items_center().rounded(12).cursor_pointer().text_size(11.5).flex_none()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : "#00000000")
      .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click(onClick).when(Boolean(lead), (el) => el.child(lead)).child(label);
  }

  // "CTO working · Frontend done · Backend needs you": a desk at a glance, most urgent first.
  nowLine(members) {
    const word = (m) => (m.status === "blocked" ? "needs you" : m.status === "working" ? "working" : m.phase === "done" || m.status === "done" ? "done" : "idle");
    return [...members].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))
      .map((m) => `${this.roles.byId(m.role)?.name ?? m.role} ${word(m)}`).join(" · ");
  }

  // ── list ──────────────────────────────────────────────────────────────────

  listView(t) {
    const cards = this.desks.map((d) => {
      const members = this.members(d.slug), unread = this.unread(d), id = `dk-${d.slug}`;
      const top = [...members].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9))[0];
      const last = d.last && d.last.kind !== "desk"
        ? `${d.last.from === "kabeer" ? "You" : this.roles.byId(d.last.from)?.name ?? d.last.from}: ${d.last.text}` : "No messages yet";
      return v_flex().id(id).mx(10).mb(6).px(12).py(10).gap(7).rounded(10).border_1().border_color(t.border).bg(t.raised)
        .cursor_pointer().hover((s) => s.border_color(t.input).bg(t.hover)).on_click((_e, cx) => this.go(d.slug, cx))
        .child(h_flex().gap(8).items_center()
          .child(div().min_w(0).truncate().text_size(13.5).font_semibold().text_color(t.foreground).child(d.name))
          .when(Boolean(top?.status === "blocked"), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.muted).child(statusMark(t, "blocked", 11)).child("needs you")))
          .child(div().flex_1())
          .when(unread > 0, (el) => el.child(div().min_w(18).h(18).px(5).rounded(9).bg(t.accent).text_color(t.accent_foreground)
            .text_size(10.5).font_semibold().flex().items_center().justify_center().child(String(unread))))
          .child(div().text_size(11).text_color(t.dim).child(ago(d.at))))
        .child(h_flex().gap(6).items_center()
          .child(h_flex().gap(4).flex_none().children(members.slice(0, 6).map((m) => this.avatar(t, this.roles.byId(m.role), m.status, 20))))
          .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(members.length ? t.muted : t.dim).child(members.length ? this.nowLine(members) : "nobody running"))
          .when(Boolean(d.project), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(d.project))))
        .child(div().text_size(11.5).line_height(1.4).text_color(t.muted).max_h(34).overflow_hidden().child(last.slice(0, 180)));
    });
    return v_flex().id("desks-list").size_full().min_h(0).overflow_y_scrollbar().pb(10)
      .child(h_flex().px(14).pt(12).pb(10).items_center()
        .child(v_flex().gap(2)
          .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Desks"))
          .child(div().text_size(11.5).text_color(t.dim).child("Each desk is its own team: agents, chat and worktrees.")))
        .child(div().flex_1())
        .child(button(t, "desk-new", "New desk", (_e, cx) => this.go("new", cx), { iconName: "plus", primary: true })))
      .when(!this.desks.length, (el) => el.child(v_flex().mx(10).mt(6).px(16).py(18).gap(10).items_center().rounded(12).border_1().border_color(t.border)
        .child(icon("team", 22).text_color(t.dim))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("No desks yet"))
        .child(div().text_size(12).line_height(1.45).text_color(t.muted).text_center()
          .child("Start a desk, tell the CTO what you want, and it brings in Frontend, Backend and the rest."))
        .child(button(t, "desk-new-empty", "Start a desk", (_e, cx) => this.go("new", cx), { iconName: "plus", primary: true }))))
      .children(cards);
  }

  // ── new desk ──────────────────────────────────────────────────────────────

  newView(t) {
    const current = spaces().find((s) => s.active);
    const label = (text) => div().pt(14).pb(6).text_size(11).font_semibold().text_color(t.muted).child(text);
    const projects = this.projectList();
    const roles = this.roles.list ?? [];
    const here = this.targetFolder();
    const picked = typeof this.newTarget === "string" && this.newTarget.startsWith("folder:") ? this.newTarget.slice(7) : null;
    const base = (f) => f.replace(/\/+$/, "").split("/").pop() || f;
    const where = picked ? base(picked) : this.newTarget ?? current?.name;
    const recent = store.get("desks.folders", []).filter((f) => !projects.some((p) => p.folder === f));
    const inside = (a, b) => a === b || a.startsWith(`${b}/`);
    // Desks for this folder, or for the repo it's inside (a worktree, a subfolder); not every desk under ~.
    const earlier = here ? this.desks.filter((d) => d.folder && inside(here, d.folder)) : [];
    return v_flex().id("desk-new-form").size_full().min_h(0).overflow_y_scrollbar().px(14).pb(14)
      .child(h_flex().pt(10).pb(4).gap(6).items_center()
        .child(button(t, "new-back", null, (_e, cx) => this.go("list", cx), { iconName: "back", tip: "All desks" }))
        .child(div().text_size(15).font_semibold().text_color(t.foreground)
          .child(where ? `New desk in ${where}` : "New desk")))
      .when(earlier.length > 0, (el) => el.child(label(`EARLIER DESKS HERE · ${earlier.length}`))
        .children(earlier.slice(0, 5).map((d) => {
          const running = this.members(d.slug).length;
          return h_flex().id(`ed-${d.slug}`).h(32).px(10).gap(8).items_center().rounded(8).cursor_pointer()
            .border_1().border_color(t.border).mb(4).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.go(d.slug, cx))
            .child(icon("chat", 13).text_color(t.dim))
            .child(div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(d.name))
            .child(div().flex_none().text_size(11).text_color(running ? t.done : t.dim).child(running ? `${running} running` : ago(d.at)));
        })))
      .child(label("NAME"))
      .child(Input.new(this.newName).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(label("PROJECT"))
      .child(h_flex().gap(5).flex_wrap()
        .child(this.chip(t, "np-here", this.newTarget === null, `Current${current ? ` · ${current.name}` : ""}`, (_e, cx) => this.pickTarget(null, cx)))
        .children(projects.map((p) => this.chip(t, `np-${p.name}`, this.newTarget === p.name, p.name, (_e, cx) => this.pickTarget(p.name, cx))))
        .children(recent.map((f, i) => this.chip(t, `np-f${i}`, picked === f, base(f), (_e, cx) => this.pickTarget(`folder:${f}`, cx), icon("projects", 12))))
        .child(this.chip(t, "np-choose", false, "Choose folder…", (_e, cx) => this.chooseFolder(cx), icon("plus", 12))))
      .when(Boolean(picked), (el) => el.child(div().pt(6).truncate().text_size(11).text_color(t.dim).child(picked.replace(home(), "~"))))
      .when(Boolean(this.sameRepo()), (el) => el.child(div().pt(6).text_size(11).line_height(1.4).text_color(t.blocked)
        .child(`${this.sameRepo()} also works in this repo. That's fine: each engineer gets its own worktree, but keep the two desks off the same files.`)))
      .child(label("WHO JOINS"))
      .child(h_flex().gap(5).flex_wrap().children(roles.filter((r) => !r.on_request).map((r) => {
        const on = this.newRoles.has(r.id);
        return this.chip(t, `nr-${r.id}`, on, r.name, (_e, cx) => { on ? this.newRoles.delete(r.id) : this.newRoles.add(r.id); cx.notify(); }, roleTile(div, svg, t, r, 16, !on));
      })))
      .child(div().pt(5).text_size(11).text_color(t.dim).child("Reviewer and QA join later, when you ask for them."))
      .child(label("FIRST MESSAGE"))
      .child(Textarea.new(this.newTask).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(h_flex().pt(14).gap(8).items_center()
        .child(button(t, "new-start", this.acting === "new" ? "Starting…" : "Start desk", (_e, cx) => this.createDesk(cx),
          { iconName: "play", primary: true, disabled: Boolean(this.acting) || !this.newRoles.size }))
        .child(button(t, "new-cancel", "Cancel", (_e, cx) => this.go("list", cx))));
  }

  // ── a desk ────────────────────────────────────────────────────────────────

  // A permission request, on top of the composer: who, the tool, exactly what (the command, the
  // file), and the answer. Claude waits on it; with no answer in time it asks in its terminal.
  permitCard(t, d, m) {
    const role = this.roles.byId(m.from), id = `pm-${m.id}`, busy = this.acting === id;
    // Claude's own three: Yes; Yes, and don't ask again for <its rule>; No, and tell it what to do
    // instead (whatever is in the message box goes with the No).
    const why = this.input.value().trim();
    const answer = (decision) => (_e, cx) => this.busy(id, async () => {
      const r = await exec(TEAM(), ["permit", "--task", d.slug, m.id, decision, ...(decision === "deny" && why ? ["--message", why] : [])]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't answer");
      if (decision === "deny" && why) this.input.set_value("");
    }, cx);
    const left = Math.max(0, Math.round((PERMIT_WAIT - (Date.now() - m.at)) / 60000));
    const rule = typeof m.always === "string" ? m.always : null;
    return v_flex().id(id).px(12).py(10).gap(8).rounded(14).border_1().border_color(t.blocked + "59").bg(t.blocked + "0f")
      .child(h_flex().gap(7).items_center()
        .child(role ? roleTile(div, svg, t, role, 18) : icon("alert", 15).text_color(t.blocked))
        .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_medium().text_color(t.foreground)
          .child(`${role?.name ?? m.from} wants to use ${m.tool}`))
        .child(div().id(`${id}-left`).flex_none().text_size(11).text_color(t.dim)
          .tooltip("Then it asks in its terminal instead").child(left ? `${left} min left` : "about to ask in its terminal")))
      .child(div().id(`${id}-detail`).max_h(110).overflow_y_scrollbar().px(10).py(7).rounded(8).bg(t.background).border_1().border_color(t.border)
        .text_size(12).line_height(1.45).text_color(t.foreground).child(m.detail ?? ""))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(button(t, `${id}-allow`, busy ? "Answering…" : "Yes", answer("allow"), { primary: true, disabled: Boolean(this.acting), tip: "Allow this once" }))
        .when(Boolean(m.always), (el) => el.child(button(t, `${id}-always`, rule ? `Yes, don't ask again for ${rule.length > 40 ? `${rule.slice(0, 40)}…` : rule}` : "Yes, don't ask again",
          answer("always"), { disabled: Boolean(this.acting), tip: rule ? `Saves Claude's rule: ${rule}` : "Saves the rule Claude suggests" })))
        .child(button(t, `${id}-deny`, why ? "No, and tell it what you typed" : "No", answer("deny"),
          { disabled: Boolean(this.acting), tip: why ? `It gets: "${why.slice(0, 80)}"` : "Type in the message box first to tell it what to do instead" }))
        .child(div().flex_1())
        .child(button(t, `${id}-term`, "Terminal", () => openTerminal(m.address), { iconName: "terminal", tip: "Look at what it's doing first" })));
  }

  hoverOn(id, on, cx) {
    if (on) this.hoverMsg = id;
    else if (this.hoverMsg === id) this.hoverMsg = null;
    cx.notify();
  }

  copy(id, text, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "$1" | pbcopy', "copy", text ?? ""]);
      if (r.code !== 0) return notify({ title: "Couldn't copy", body: r.stderr.trim(), level: "error", timeout: 4000 });
      this.copied = id;
      cx.notify();
      cx.timer.after(2000, (cx) => { if (this.copied === id) { this.copied = null; cx.notify(); } });
    });
  }

  openTerminal(address) { openTerminal(address); }

  // ── live turns: steps and timelines ───────────────────────────────────────
  // Woken by the activity watcher (every hook write) and a 4s fallback; never from render. One
  // exec per working agent per wake: the tail of its step feed and `team timeline` together.
  // Only a copy that drew the thread recently polls (the card builds a Desks too).
  pollSteps(cx) {
    const d = this.view !== "list" && this.view !== "new" ? this.desk(this.view) : null;
    if (!d || this.polling || Date.now() - (this.drawnAt ?? 0) > 15000) return;
    const working = this.members(d.slug).filter((m) => m.status === "working").map((m) => m.address);
    let ended = false;
    for (const a of new Set([...Object.keys(this.steps), ...Object.keys(this.timelines).filter((a) => this.timelines[a]?.turn?.working)]))
      if (!working.includes(a)) { this.endTurn(a); ended = true; }
    if (ended) cx.notify();
    if (!working.length) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        for (const a of working) {
          const ask = Date.now() - (this.noTimeline[a] ?? 0) > 60000;
          let out = "";
          try { out = (await exec("sh", ["-c", POLL, "poll", `${DIR()}/.activity/${a}.jsonl`, TEAM(), ask ? "1" : "0", a])).stdout; } catch {}
          const { steps, timeline } = splitPoll(out);
          const before = this.steps[a];
          if (!before || before.length !== steps.length || before.at(-1)?.at !== steps.at(-1)?.at) { this.steps[a] = steps; changed = true; }
          if (!ask) continue;
          if (!timeline) { this.noTimeline[a] = Date.now(); continue; }
          const sig = JSON.stringify(timeline);
          if (sig !== this.timelineSig[a]) { this.timelineSig[a] = sig; this.timelines[a] = timeline; changed = true; }
        }
      } finally { this.polling = false; }
      if (changed) { cx.notify(); cx.timer.after(40, (cx) => cx.notify()); }  // the second frame lets a new step ease in
    });
  }

  // A turn ended: keep what we saw of it for the reply's "Worked for" fold (the hook deletes
  // the step file at Stop). The timeline stays for its context size.
  endTurn(a) {
    const steps = this.steps[a] ?? [], tl = this.timelines[a];
    const live = tl?.turn?.working !== false ? tl : null;
    const subagents = live?.subagents ?? [];
    if (steps.length || subagents.length) {
      const snap = { first: steps[0]?.at ?? live?.turn?.started_ms ?? Date.now(), ended: Date.now(), steps: steps.slice(-60),
        summary: live?.tools?.summary || summarizeSteps(steps), subagents };
      this.snapshots[a] = [snap, ...(this.snapshots[a] ?? [])].slice(0, 8);
      const keep = Object.entries(this.snapshots).sort((x, y) => (y[1][0]?.ended ?? 0) - (x[1][0]?.ended ?? 0)).slice(0, 24);
      this.snapshots = Object.fromEntries(keep);
      store.set("desks.turns", this.snapshots);
    }
    delete this.steps[a]; delete this.stepsSeen[a]; this.toolsOpen.delete(a);
    if (tl?.turn) this.timelines[a] = { ...tl, turn: { ...tl.turn, working: false } };
  }

  // The newest step's time while it is on its first frames (it eases in), else null.
  freshStep(a) {
    const newest = this.steps[a]?.at(-1)?.at;
    if (!newest) return null;
    if (this.stepsSeen[a]?.at !== newest) this.stepsSeen[a] = { at: newest, drawn: Date.now() };
    return Date.now() - this.stepsSeen[a].drawn < 30 ? newest : null;
  }

  // ── minimap and window ───────────────────────────────────────────────────
  rowMeasured(slug, key, height, cx) {
    this.rowH.set(`${slug}:${key}`, height);
    if (this.seekKey?.slug === slug) this.trySeek(slug, cx, false);
  }
  offsets(slug) {
    const keys = this.drawnKeys[slug] ?? [], heights = new Map();
    for (const k of keys) { const h = this.rowH.get(`${slug}:${k}`); if (h !== undefined) heights.set(k, h); }
    return rowOffsets(keys, heights, ThreadViewport.top(settings().zoom || 1));
  }
  jumpTo(slug, key, cx) {
    const list = slug.startsWith("route-") ? this.routeRows.rows : this.model.rows;
    const s = this.thread.state(slug), index = list.findIndex((r) => r.key === key);
    if (index < 0) return;
    if (index < (this.windowFrom[slug] ?? 0)) { s.following = false; this.windowFrom[slug] = Math.max(0, index - 2); }
    this.seekKey = { slug, key, tries: 0 };
    this.trySeek(slug, cx, false, true);
    cx.notify();
  }
  // Seek once the target's offset is known and reachable; after two content measures, take
  // what layout gives (a prompt in the last screen can't reach the top).
  trySeek(slug, cx, measure, now = false) {
    const want = this.seekKey;
    if (!want || want.slug !== slug) return;
    const y = this.offsets(slug).get(want.key);
    if (y === undefined) return;
    const s = this.thread.state(slug), target = Math.max(0, y - 8 * (settings().zoom || 1));
    if (measure) want.tries++;
    if (target > s.max + 1 && !now && want.tries < 2) return;
    s.move(target); this.seekKey = null; cx.notify();
  }
  showEarlier(slug, cx) {
    const s = this.thread.state(slug);
    s.following = false; s.anchorBottom();
    this.windowFrom[slug] = Math.max(0, (this.windowFrom[slug] ?? 0) - WINDOW);
    cx.notify();
  }
  statusAction(action, cx) {
    if (action.kind === "terminal") return openTerminal(action.arg);
    if (action.kind === "resume") {
      const session = (runtimeData().sessions ?? []).find((x) => x.id === action.arg);
      if (session) this.workflow.recover(session, cx);
      return;
    }
    if (action.kind === "queue") { this.queueShown = !this.queueShown; cx.notify(); }
  }

  // A desk with nothing said yet: what it's for, and who answers.
  emptyThread(t, members) {
    const lead = members.some((m) => m.role === "cto") ? "the CTO" : members.length ? "everyone here" : null;
    return v_flex().id("thread-empty").py(28).gap(6).items_center()
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("What should the team work on?"))
      .child(div().max_w(300).text_size(12).line_height(1.5).text_color(t.muted).text_center()
        .child(lead ? `Messages go to ${lead}. Type @ to talk to someone directly.` : "Add someone to this desk, then tell them what you need."));
  }

  memberDetail(t, m, d, compact = false) {
    const role = this.roles.byId(m.role), id = `md-${m.address}`;
    const engineer = role?.worktree && !role?.on_request;
    const cwd = panes().find((p) => p.terminal === m.address)?.cwd ?? m.cwd ?? "";
    const where = cwd.includes("/.herdr/worktrees/") ? cwd.split("/").pop() : cwd.split("/").pop();
    const child = (roleId, task) => team([roleId, "--requested", "--share", "--parent", m.address, "--repo", cwd || d.folder,
      "--slug", d.slug, ...(m.space ? ["--space", m.space] : []), "--task", task]);
    return v_flex().id(id).ml(compact ? 0 : 10 + m.depth * 18).mr(compact ? 0 : 10).mb(4).px(10).py(7).gap(5).rounded(8).bg(t.raised)
      .when(!compact, el => el.child(h_flex().gap(8).items_center()
        .child(this.avatar(t, role, m.status, 22))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(role?.name ?? m.role))
        .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(where))
        .child(statusMark(t, m.status, 12))))
      .when(Boolean(m.note), (el) => el.child(div().pl(compact ? 0 : 30).text_size(11.5).line_height(1.35).text_color(t.muted).child(m.note)))
      .when(Boolean(m.ctx), (el) => el.child(div().pl(compact ? 0 : 30).text_size(11).text_color(this.overLimit(m) ? t.blocked : t.dim)
        .child(`${kTokens(m.ctx)} tokens of context${this.overLimit(m) ? `, past the ${kTokens(this.roles.freshAt(m.role))} limit: compact it when it's free` : ""}`)))
      .child(h_flex().pl(compact ? 0 : 30).gap(6).flex_wrap()
        .child(button(t, `${id}-go`, "Go", () => openTerminal(m.address)))
        .child(button(t, `${id}-changes`, "Changes", (_e, cx) => this.openReview(m, d, cx), { iconName: "branch", tip: "Review this agent's worktree" }))
        .when(role?.cli === "claude" || !role?.cli, (el) => el
          .child(button(t, `${id}-compact`, "Compact", (_e, cx) => this.compact(m, cx),
            { primary: this.overLimit(m), disabled: Boolean(this.acting) || m.handingOff || m.status === "working" || m.status === "blocked",
              tip: "Claude's /compact: same session, the history becomes a summary" }))
          .child(button(t, `${id}-fresh`, m.handingOff ? "Handing off…" : "Fresh start", (_e, cx) => this.freshStart(m, cx),
            { disabled: Boolean(this.acting) || m.handingOff || m.status === "working",
              tip: "A new session instead: it writes a handoff, then a new one of it takes over here" })))
        .when(engineer, (el) => el
          .child(button(t, `${id}-rev`, "Review", (_e, cx) => this.busy(`${id}-rev`, () => child("reviewer", "Review the commits on this branch against its base, and the brief if there is one. Your parent is the engineer who wrote it."), cx),
            { iconName: "sparkles", disabled: Boolean(this.acting), tip: "A Reviewer on this branch; it reports to this engineer" }))
          .child(button(t, `${id}-qa`, "QA", (_e, cx) => this.busy(`${id}-qa`, () => child("qa", "Test the work on this branch against its brief: write tests for the intended behaviour and edge cases, and report what passes and fails. Your parent is the engineer who wrote it."), cx),
            { disabled: Boolean(this.acting), tip: "QA on this branch; it reports to this engineer" }))
          .child(button(t, `${id}-pr`, "Open PR", (_e, cx) => this.busy(`${id}-pr`, async () => {
            const r = await hc(["send", m.address, "Kabeer approved opening a PR for this work. Commit anything left on your branch, push it, and open a PR with gh pr create (what changed, how you verified it, and a link to the related PR from this desk if there is one). Then report the PR URL with team report done."]);
            if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't send; is it waiting on you?");
          }, cx), { iconName: "pr", disabled: Boolean(this.acting), tip: "Ask it to push its branch and open a PR" }))))
      .child(div().pl(compact ? 0 : 30).child(this.workflow.actions(t, m)));
  }

  deskView(t, d) {
    this.syncDraft(d.slug);
    const members = this.members(d.slug), present = new Set(members.map((m) => m.role));
    const { roles: to, implicit } = this.recipients(members);
    const deleting = Date.now() < this.confirmDelete;

    const header = v_flex().px(12).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .when(!this.fixed, (el) => el.child(button(t, "desk-back", null, (_e, cx) => this.go("list", cx), { iconName: "back", tip: "All desks" })))
        .child(v_flex().min_w(0).flex_1()
          .child(div().truncate().text_size(14).font_semibold().text_color(t.foreground).child(d.name))
          .child(div().truncate().text_size(11).text_color(t.dim).child([d.project, `${members.length} in the desk`].filter(Boolean).join(" · "))))
        .when(!this.fixed && !this.wide, (el) => el.child(button(t, "desk-pane", null, () => run("pane.split", { direction: "right", mod: "desk", props: { chat: true, task: d.slug } }), { iconName: "pane", tip: "Open beside your terminals" })))
        .when(members.length > 0, (el) => el.child(button(t, "desk-wrap", this.acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.wrapUp(d, cx),
          { disabled: Boolean(this.acting), tip: "Each agent: flags anything left locally, or cleans up its worktree and closes" })))
        .when(!members.length, (el) => el.child(button(t, "desk-del", deleting ? "Delete?" : null, (_e, cx) => this.deleteDesk(d, cx),
          { iconName: "trash", tip: deleting ? "Click again to delete (kept in ~/.herdr/team/.deleted)" : "Delete this desk" }))))
      // Who's here: click to jump to them; + to bring someone in.
      .child(h_flex().gap(5).flex_wrap().items_center()
        .children(members.map((m) => {
          const role = this.roles.byId(m.role);
          return h_flex().id(`mem-${m.address}`).h(28).pl(3).pr(9).gap(6).items_center().rounded(14).cursor_pointer().flex_none()
            .bg(t.raised).hover((s) => s.bg(t.hover))
            .tooltip(`${role?.name ?? m.role}: ${STATUS[m.status] ?? "starting"}${m.ctx ? ` · ${kTokens(m.ctx)} tokens of context` : ""}${this.overLimit(m) ? " (long; compact it from the chat or Details)" : ""}${m.note ? ` · ${m.note}` : ""}`)
            .when(this.routeShown === m.address, (el) => el.bg(t.selected))
            .on_click((_e, cx) => (this.routeShown === m.address ? this.closeRoute(cx) : this.openRoute(m.address, cx)))
            .child(this.avatar(t, role, m.status, 22))
            .child(div().text_size(11.5).text_color(t.foreground).child(role?.name ?? m.role))
            .when(Boolean(m.ctx), (el) => el.child(div().text_size(10.5).text_color(this.overLimit(m) ? t.blocked : t.dim).child(kTokens(m.ctx))));
        }))
        .child(h_flex().id("mem-add").h(28).px(9).gap(5).items_center().rounded(14).cursor_pointer().flex_none()
          .border_1().border_color(t.border).text_color(t.muted).text_size(11.5).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.addOpen = !this.addOpen; cx.notify(); })
          .child(icon("plus", 12)).child(members.length ? "Add" : "Add someone"))
        .when(members.length > 0, (el) => el.child(div().flex_1()).child(div().id("mem-details").text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.detailsOpen = !this.detailsOpen; cx.notify(); })
          .child(this.detailsOpen ? "Hide details" : "Details"))))
      .when(this.addOpen, (el) => el.child(h_flex().gap(5).flex_wrap().pt(2)
        .children((this.roles.list ?? []).map((r) => this.chip(t, `add-${r.id}`, false, `${r.name}${present.has(r.id) ? " +1" : ""}`,
          (_e, cx) => { this.addOpen = false; this.busy(`add-${r.id}`, () => this.addMember(r, d), cx); }, roleTile(div, svg, t, r, 16))))));

    const details = this.detailsOpen && members.length
      ? v_flex().pt(8).pb(4).border_b(1).border_color(t.border).children(members.map((m) => this.memberDetail(t, m, d))) : null;

    const briefs = this.briefs.length ? v_flex().px(12).py(8).gap(6).border_b(1).border_color(t.border)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`BRIEFS WAITING · ${this.briefs.length}`))
      .children(this.briefs.map((b) => {
        const role = this.roles.byId(b.role);
        return h_flex().id(`br-${b.path}`).gap(8).items_center()
          .child(role ? roleTile(div, svg, t, role, 20) : div().size(20))
          .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).child(`${role?.name ?? b.role}: ${b.title}`))
          .child(button(t, `br-${b.path}-go`, "Start", (_e, cx) => this.busy(`br-${b.path}`, () => startBrief(b, this.roles, this.spaceFor(d.folder), { slug: d.slug, parent: members.find((m) => m.role === "cto")?.address }), cx), { iconName: "play", primary: true, disabled: Boolean(this.acting) || !role }))
          .child(button(t, `br-${b.path}-x`, null, (_e, cx) => this.busy(`br-${b.path}`, () => fileBrief(b, "dismissed"), cx), { iconName: "minus", tip: "Dismiss" }));
      })) : null;

    // The thread: rows derived on reload (model.js), drawn as a window of the newest WINDOW. In a
    // member route, that member's own conversation (team transcript) instead of the team chat.
    this.drawnAt = Date.now();
    const route = this.routeShown ? members.find((m) => m.address === this.routeShown) ?? null : null;
    const light = !settings().dark; this.light = light;
    const model = this.model, now = Date.now();
    const key = route ? routeKey(route.address) : d.slug, s = this.thread.state(key);
    const rowsSrc = route ? this.routeRows.rows : model.rows;
    const live = new Set(members.map((m) => m.address));
    const waiting = model.rows.filter((r) => r.type === "permission" && !model.permitDone.has(r.m.id) && live.has(r.m.address) && now - r.m.at < PERMIT_WAIT
      && (!route || r.m.address === route.address)).map((r) => r.m);
    this.waitingFor = new Set(waiting.map((m) => m.address));
    const from = windowStart(rowsSrc.length, { following: s.following, from: this.windowFrom[key] });
    this.windowFrom[key] = from;
    const col = (el) => (this.wide ? div().w_full().max_w(COLUMN).child(el) : el);
    const keys = [], rows = [];
    if (from > 0) {
      keys.push("__earlier");
      rows.push(measured(this, key, "__earlier", h_flex().justify_center().pt(4).pb(8)
        .child(h_flex().id("thread-earlier").h(28).px(12).gap(6).items_center().rounded(14).border_1().border_color(t.border)
          .text_size(12).text_color(t.muted).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.showEarlier(key, cx))
          .child(icon("up", 12)).child(`Show ${Math.min(from, WINDOW)} earlier`))));
    }
    const routeRole = route ? this.roles.byId(route.role) : null;
    if (route) {
      const state = this.routeData[route.address]?.data;
      if (!rowsSrc.length) { keys.push("__empty"); rows.push(measured(this, key, "__empty", routeEmpty(t, routeRole?.name ?? route.role, state))); }
      else if (state?.partial && from === 0) { keys.push("__partial"); rows.push(measured(this, key, "__partial", h_flex().justify_center().pt(4)
        .child(div().text_size(11).text_color(t.dim).child("Earlier messages are in its terminal")))); }
      rowsSrc.slice(from).forEach((row) => {
        keys.push(row.key);
        rows.push(measured(this, key, row.key, routeRow(this, t, key, row, { role: routeRole, now })));
      });
    } else {
      if (!model.said) { keys.push("__empty"); rows.push(measured(this, key, "__empty", this.emptyThread(t, members))); }
      const ctx = { members, now };
      model.rows.slice(from).forEach((row, j) => {
        keys.push(row.key);
        rows.push(measured(this, key, row.key, messageRow(this, t, d.slug, row, { ...ctx, index: from + j })));
      });
    }
    this.drawnKeys[key] = keys;
    // The end of the thread: who's working now, then what's waiting on you or pending.
    const runtime = runtimeData();
    const lost = (runtime.sessions ?? []).filter((x) => x.task === d.slug && ["disconnected", "recovering"].includes(x.state) && (!route || x.address === route.address));
    const queued = (runtime.queue ?? []).filter((q) => q.task === d.slug && !["delivered", "cancelled", "sent"].includes(q.state)
      && (!route || (q.targets ?? []).some((x) => x.address === route.address))).length;
    if (!queued) this.queueShown = false;
    const scope = route ? [route] : members;
    const lines = statusLines({ waiting, blocked: scope.filter((m) => m.status === "blocked" && !this.waitingFor.has(m.address)),
      disconnected: lost, handingOff: scope.filter((m) => m.handingOff && m.status !== "working"), queued, queueOpen: this.queueShown,
      error: shared("desk.runtime.error"), name: (r) => this.roles.byId(r)?.name ?? r });
    const nowLines = statusLineRows(this, t, lines);
    let rail = null;
    if (this.wide) {
      const drawn = new Set(keys), offsets = this.offsets(key);
      const prompts = (route ? this.routeRows.prompts : model.prompts).map((p) => ({ ...p, hidden: !drawn.has(p.key) }));
      rail = minimap(this, t, key, prompts, activePrompt(prompts, offsets, s.offset, s.viewport));
    }
    const thread = this.thread.render(t, key,
      [...rows, ...liveRows(this, t, scope, now).map(col), ...(nowLines ? [col(nowLines)] : [])], this.wide, rail);

    // The composer: a bordered card (T3's): the text, then who it goes to, the send mode and a
    // solid accent send button. The slash menu and @mention suggestions sit just above it.
    const sugg = route ? [] : this.suggestions();
    const menu = this.slashItems();
    const text = this.input.value().trim();
    const toList = route ? [route.role] : to;
    const canSend = Boolean(text) && toList.length > 0 && !this.acting;
    const pill = (r) => {
      const role = this.roles.byId(r);
      return h_flex().flex_none().h(22).pl(2).pr(8).gap(5).items_center().rounded(11).bg(t.raised).text_color(t.foreground)
        .when(Boolean(role), (el) => el.child(roleTile(div, svg, t, role, 18))).child(role?.name ?? r);
    };
    const composer = v_flex().px(12).pt(8).pb(this.wide ? 18 : 12).gap(6).when(this.wide, (el) => el.w_full().max_w(COLUMN + 24))
      .when(Boolean(this.workflow.side) && !route, (el) => el.child(this.workflow.sideForm(t, d.slug)))
      .when(this.queueShown, (el) => el.child(this.workflow.queue(t, d.slug)))
      .children(waiting.map((m) => this.permitCard(t, d, m)))
      .when(Boolean(menu), (el) => el.child(commandMenu(this, t, menu, Math.min(this.slashIndex, Math.max(0, menu.length - 1)))))
      .when(sugg.length > 0 && !menu, (el) => el.child(h_flex().gap(5).flex_wrap()
        .children(sugg.map((o, i) => this.chip(t, `sg-${o.id}`, i === Math.min(this.mentionIndex, sugg.length - 1), o.name, (_e, cx) => this.pickMention(o, cx),
          o.id === "all" ? icon("team", 13) : roleTile(div, svg, t, o, 16))))))
      .child(v_flex().id("composer").rounded(16).border_1().border_color(light ? t.input : t.border).bg(light ? t.background : t.popover)
        .when(Boolean(menu) || sugg.length > 0, (el) => el.key_context("DeskSlashOpen"))
        .on_action("desk_slash_up", (_e, cx) => this.slashKey({ key: "up" }, cx))
        .on_action("desk_slash_down", (_e, cx) => this.slashKey({ key: "down" }, cx))
        .on_action("desk_slash_tab", (_e, cx) => this.slashKey({ key: "tab" }, cx))
        .on_action("desk_slash_escape", (_e, cx) => this.slashKey({ key: "escape" }, cx))
        .on_key_down((e, cx) => this.slashKey(e, cx))
        .child(Textarea.new(this.input).w_full().px(14).pt(12).pb(4).text_size(this.wide ? 14 : 13).text_color(t.foreground)
          .token((ctx) => {
            const role = this.roles.byId(ctx.token.id);
            const color = role ? t[role.color] ?? t.accent : t.accent;
            return h_flex().h(ctx.line_height).px(5).items_center().rounded(5).bg(color + "24").text_color(color).font_medium()
              .child(`@${ctx.token.label ?? ctx.token.text}`);
          }))
        .child(h_flex().px(10).pb(10).gap(6).items_center()
          .child(h_flex().min_w(0).flex_1().gap(5).items_center().text_size(11.5).text_color(t.dim)
            .when(toList.length > 0, (el) => el.child(div().flex_none().child("To")).children(toList.map(pill))
              .when(route !== null, (el) => el.child(div().min_w(0).truncate().child("· directly")))
              .when(!route && implicit, (el) => el.child(div().min_w(0).truncate().child(this.directTarget && this.directTask === d.slug ? `· ${this.directTarget}` : "· @ to mention"))))
            .when(!toList.length, (el) => el.child(div().truncate().child("Nobody here yet: add someone above"))))
          .child(h_flex().id("send-mode").h(28).px(8).gap(5).items_center().rounded(8).flex_none()
            .text_size(11.5).text_color(this.sendMode === "queue" ? t.accent : t.dim).cursor_pointer()
            .hover(style => style.bg(t.hover).text_color(t.foreground))
            .tooltip(this.sendMode === "queue" ? "Queue until the agent is idle. Click to send immediately instead. (/queue)" : "Send immediately. Click to queue until the agent is idle instead. (/queue)")
            .on_click((_e, cx) => { this.sendMode = this.sendMode === "queue" ? "now" : "queue"; cx.notify(); })
            .child(icon(this.sendMode === "queue" ? "clock" : "play", 12))
            .child(this.sendMode === "queue" ? "Queue next" : "Send now"))
          .child(h_flex().id("desk-send").size(30).flex_none().items_center().justify_center().rounded(15)
            .bg(t.accent).text_color(t.accent_foreground).when(!canSend, (el) => el.opacity(0.35))
            .when(canSend, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
            .tooltip(canSend ? `${this.sendMode === "queue" ? "Queue" : "Send"} (Enter) · new line: Shift+Enter` : toList.length ? "Type a message, or / for commands" : "Add someone first")
            .on_click((_e, cx) => { if (canSend) this.send(cx); })
            .child(this.acting === "send" ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : icon("arrow-up", 14)))));

    // As the main view the header, details and briefs sit in the reading column too; the thread
    // scrolls full width so its scrollbar stays at the window's edge.
    const band = (el) => (this.wide ? h_flex().w_full().flex_none().justify_center().child(el.w_full().max_w(COLUMN + 24)) : el);
    const strip = route ? routeHeader(this, t, d, route) : headerStrip(this, t, members, now) ?? div().h(28);
    return v_flex().size_full().min_h(0)
      // As the main view, the desk's controls live in the floating card (card.js), not up here.
      .when(!this.wide, (el) => el.child(header))
      .when(!this.wide && Boolean(route), (el) => el.child(h_flex().px(8).py(4).border_b(1).border_color(t.border).child(strip)))
      .when(Boolean(details) && !this.wide, (el) => el.child(details))
      // The floating card sits in the top band; the strip runs along the band's bottom edge.
      // Opaque and in normal flow: the thread viewport starts below it and clips there.
      .when(this.wide, (el) => el.child(v_flex().h(104).flex_none().justify_end().bg(t.background)
        .child(band(h_flex().px(12).child(div().w_full().pb(4).border_b(1).border_color(t.border).child(strip))))))
      .when(Boolean(d.parent_task) && !route, (el) => el.child(band(h_flex().px(12).py(6).gap(8).items_center()
        .child(button(t, "side-return", "Back to original desk", () => openDesk(d.parent_task), { iconName: "back" }))
        .child(div().text_size(11).text_color(t.dim).child("Separate conversation")))))
      .when(Boolean(briefs) && !route, (el) => el.child(band(briefs)))
      .child(thread)
      .child(band(composer));
  }

  render(t) {
    const request = shared("desk.review");
    if (this.reviewOpen && request?.task === this.view) return this.review.render(t);
    if (request && request.at === this.reviewAt && request.task !== this.view) setShared("desk.review", null);
    if (this.starting) return v_flex().size_full().items_center().justify_center()
      .child(empty(t, `Starting a desk in ${this.starting.split("/").pop() || this.starting}…`));
    const view = this.view;
    const d = view !== "list" && view !== "new" ? this.desk(view) : null;
    if (d) return this.deskView(t, d);
    if (this.fixed) return v_flex().p(14).child(empty(t, "This desk was deleted."));
    const page = view === "new" ? this.newView(t) : this.listView(t);
    return this.wide ? h_flex().size_full().justify_center().pt(18).child(v_flex().h_full().w_full().max_w(COLUMN).child(page)) : page;
  }
}
