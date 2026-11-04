import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, InputState, Input, TextView } from "gpui-base";
import { terminals, agents, panes, spaces, exec, home, appHome, readTextFile, watchFolder, notify, run, shared, setShared, hc, playSound, pickFolder } from "herdr";
import { pill, button, empty, icon, statusBadge } from "./ui.js";
import { Roles, roleTile, team, folderOf, findBriefs, startBrief, fileBrief } from "./roles.js";

// Desks: each one an independent team (its own agents, thread and worktrees) that
// bin/team keeps in ~/.herdr/team/<desk>.jsonl and on its agents' task=<desk> labels.
// The tab shows the list of desks, a form to start one, and a desk: who's in it,
// its thread, and a composer with @mentions. You talk to the CTO unless you @ someone;
// the CTO can ask engineers in the chat (team say --to) and sees everything posted.

const DIR = () => `${home()}/.herdr/team`;
const TEAM = () => `${appHome()}/bin/team`;
const STATUS = { blocked: "needs you", done: "done", working: "working", idle: "idle" };
const KIND = { done: ["done", "done"], blocked: ["blocked", "blocked"], update: ["update", "accent"], flag: ["left locally", "blocked"],
  finish: ["wrapped up", "dim"], ask: ["asks", "accent"], answer: ["answers", "done"], route: ["passes on", "accent"], context: ["long context", "blocked"] };
const EVENTS = ["desk", "start", "fresh", "compact", "permission", "permission-done"];
// How long bin/team waits on a permission request before Claude asks in its terminal instead.
const PERMIT_WAIT = 540000;
const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
// The reading column of the chat when it's the main view (layouts/desk-chat.json).
const COLUMN = 760;

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

// "Worked for 9m 38s": from the message that started an agent's turn to its reply.
const span = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

// A desk's live agents, parents before their children.
export function deskMembers(slug) {
  const status = new Map(agents().map((a) => [a.address, a.status]));
  const live = terminals().filter((t) => t.state === "live" && t.labels?.task === slug && t.labels?.role)
    .map((t) => ({ address: t.address, role: t.labels.role, parent: t.parent, status: status.get(t.address) ?? t.status?.state ?? t.status ?? null,
      phase: t.labels.phase, note: t.labels.note, awaiting: t.labels.awaiting ?? null, space: t.labels["herdr.space"], cwd: t.cwd, created: t.created_ms ?? 0,
      ctx: Number(t.labels.ctx) || null, handingOff: (t.labels.awaiting ?? "").startsWith("fresh") }));
  const addrs = new Set(live.map((m) => m.address));
  const depth = (m) => (m.parent && addrs.has(m.parent) ? 1 + depth(live.find((x) => x.address === m.parent)) : 0);
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

    this.input = TextareaState.new({ placeholder: "Message the desk…  type @ to mention someone", rows: 2 });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => { this.trackMention(); cx.notify(); });
    this.input.on("submit", (e, cx) => {
      if (e.shift) return;
      if (this.mention && this.suggestions().length) return this.pickMention(this.suggestions()[0], cx);
      this.send(cx);
    });

    this.newName = InputState.new({ placeholder: "Name (optional), e.g. Health check" });
    this.newTask = TextareaState.new({ placeholder: "What should the team do? It goes to the CTO, or to everyone you picked if there's no CTO.", rows: 4 });
    this.newTask.set_auto_grow(3, 10);
    this.newTask.on("change", (_e, cx) => cx.notify());
    this.newTarget = store.get("desks.target", null);
    this.newRoles = new Set(["cto"]);

    this.roles.load(cx);
    cx.timer.every(5000, (cx) => this.roles.load(cx));
    cx.timer.every(2500, () => { if (this.toasts) this.watch.check(this.roles); });
    cx.timer.every(8000, (cx) => this.scanBriefs(cx));
    // Another mod can open a desk (shared "desk.view": the sidebar, the spaces list); load it.
    // "desk.here" (a space picked in the spaces list) points a new desk at that space.
    cx.timer.every(400, (cx) => {
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
      for (;;) { await watchFolder(DIR()); await this.reload(cx); }
    });
  }

  // ── state ─────────────────────────────────────────────────────────────────

  get view() { return this.fixed ?? shared("desk.view") ?? "list"; }
  go(view, cx) {
    setShared("desk.view", view);
    this.addOpen = false; this.detailsOpen = false; this.confirmDelete = 0; this.mention = null;
    if (view !== "list" && view !== "new") this.markRead(view);
    this.reload(cx);
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
          at: Number(mtime) * 1000, n: Number(n), last: tail };
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
      if (open && (this.onScreen() || this.fixed || this.wide)) this.markRead(open.slug);
      this.publish();
    } catch { this.messages = []; }
    cx.notify();
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
    const local = spaces().filter((s) => !s.machine).map((s) => ({ s, at: folderOf(s) ?? "" })).filter((x) => x.at);
    return local.find((x) => x.at === folder)?.s
      ?? local.filter((x) => folder.startsWith(x.at + "/")).sort((a, b) => b.at.length - a.at.length)[0]?.s
      ?? null;
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
      try { await fn(); } catch (e) { notify({ title: "Something went wrong", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 6000 }); }
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
      const r = await exec("sh", ["-c", 'mkdir -p "$1/.deleted" && mv "$1/$2.jsonl" "$1/.deleted/$2-$3.jsonl" && rm -f "$1/$2.cursors.json"', "del", DIR(), d.slug, String(Date.now())]);
      if (r.code !== 0) throw new Error(r.stderr.trim());
      delete this.read[d.slug]; store.set("desks.read", this.read);
      setShared("desk.view", "list");
    }, cx);
  }

  // ── mentions ──────────────────────────────────────────────────────────────

  trackMention() {
    const v = this.input.value();
    const m = /(^|\s)@([a-z]*)$/i.exec(v);
    this.mention = m ? { start: v.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
  }

  suggestions() {
    if (!this.mention) return [];
    const present = [...new Set(this.members().map((m) => m.role))];
    const options = [...present.map((id) => this.roles.byId(id)).filter(Boolean), ...(present.length > 1 ? [{ id: "all", name: "Everyone" }] : [])];
    return options.filter((o) => o.id.startsWith(this.mention.q) || o.name.toLowerCase().startsWith(this.mention.q));
  }

  pickMention(option, cx) {
    const v = this.input.value();
    this.input.replace_range_with_token({ start: this.mention.start, end: v.length }, { id: option.id, text: `@${option.id}`, label: option.name });
    this.input.replace(" ");
    this.mention = null;
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
    const { roles } = this.recipients(members);
    if (!roles.length) return notify({ title: "Nobody's here", body: "Add someone to this desk first.", level: "warning", timeout: 4000 });
    const to = members.filter((m) => roles.includes(m.role)).flatMap((m) => ["--to", `${m.address}:${m.role}`]);
    this.input.set_value("");
    this.mention = null;
    this.busy("send", async () => {
      const r = await exec(TEAM(), ["post", "--task", d.slug, ...to, text]);
      if (r.code !== 0) { this.input.set_value(text); throw new Error(r.stderr.trim() || r.stdout.trim()); }
      const rec = JSON.parse(r.stdout);
      if (rec.failed?.length) notify({ title: "Not delivered to everyone", body: rec.failed.map((f) => `${this.roles.byId(f.role)?.name ?? f.role}: ${f.why}`).join("\n"), level: "warning", timeout: 7000 });
    }, cx);
  }

  // ── pieces ────────────────────────────────────────────────────────────────

  dot(t, status, size = 8) {
    if (!status) return null;
    if (status === "working") return svg("mods/workspace-chrome/spinner.svg").size(size + 3).flex_none().text_color(t.working).spin(900);
    return div().size(size).flex_none().rounded(size / 2).bg(status === "idle" ? t.dim : t[status] ?? t.dim);
  }

  avatar(t, role, status, size = 24) {
    const tile = role ? roleTile(div, svg, t, role, size) : div().size(size).rounded(7).bg(t.raised);
    const mark = status && status !== "idle" ? (status === "working"
      ? div().absolute().right(-3).bottom(-3).size(11).rounded(6).bg(t.chrome).flex().items_center().justify_center().child(this.dot(t, status, 7))
      : div().absolute().right(-2).bottom(-2).size(10).rounded(5).border(2).border_color(t.chrome).bg(t[status] ?? t.dim)) : null;
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
          .when(Boolean(top?.status === "blocked"), (el) => el.child(pill(t, "needs you", t.blocked)))
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

  // The thread, after AI-chat conventions: your turns are a muted bubble on the right (at most
  // 4/5 wide); agents' turns are full-width Markdown with no bubble, under one name row per run
  // of messages; agent-to-agent asides are smaller; long ones fold behind "Show more".
  message(t, m, i, prev) {
    const id = `msg-${i}`;
    if (m.kind === "permission") {
      const who = this.roles.byId(m.from)?.name ?? m.from, end = this.permitDone?.get(m.id);
      const how = !end ? "waiting for you" : end === "allow" ? "you allowed it" : end === "always" ? "you allowed it from now on"
        : end === "deny" ? "you denied it" : "answered in its terminal";
      return h_flex().id(id).justify_center().pt(10).pb(2)
        .child(div().max_w_4_5().truncate().text_size(11).text_color(end === "deny" ? t.blocked : t.dim).tooltip(m.detail ?? "")
          .child(`${who} asked to use ${m.tool}: ${(m.detail ?? "").split("\n")[0].slice(0, 80)} · ${how} · ${clock(m.at)}`));
    }
    if (m.kind === "compact") {
      const who = this.roles.byId(m.from)?.name ?? m.from;
      return h_flex().id(id).justify_center().pt(10).pb(2)
        .child(div().max_w_4_5().truncate().text_size(11).text_color(t.dim)
          .child(`${who} ${m.text}${m.trigger === "auto" ? " (Claude did it on its own)" : ""} · ${clock(m.at)}`));
    }
    if (m.kind === "fresh") {
      return h_flex().id(id).justify_center().pt(10).pb(2)
        .child(div().max_w_4_5().truncate().text_size(11).text_color(t.dim).tooltip(m.text ?? "")
          .child(`${(m.text ?? "").split(". Handoff")[0]} · ${clock(m.at)}`));
    }
    if (m.kind === "desk" || m.kind === "start") {
      const who = m.from === "kabeer" ? "You" : this.roles.byId(m.from)?.name ?? m.from;
      const names = (m.roles ?? [m.role]).map((r) => this.roles.byId(r)?.name ?? r);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? m.text;
      const text = m.kind === "desk" ? `${who} started this desk${m.project ? ` in ${m.project}` : ""}` : `${who} added ${list}`;
      return h_flex().id(id).justify_center().pt(10).pb(2)
        .child(div().max_w_4_5().truncate().text_size(11).text_color(t.dim).child(`${text} · ${clock(m.at)}`));
    }
    const hovered = this.hoverMsg === id;
    const side = ["ask", "answer", "route", "done", "blocked", "update", "flag"].includes(m.kind);
    const long = side && (m.text ?? "").length > 600 && !this.expanded.has(id);
    const size = this.wide ? 14 : 13;
    const body = (size, color = t.foreground) => v_flex().gap(4)
      .child(div().when(long, (el) => el.max_h(120).overflow_hidden())
        .text_size(size).line_height(1.6).text_color(color).child(TextView.markdown(`${id}-md`, m.text).selectable(true)))
      .when(long, (el) => el.child(div().id(`${id}-more`).text_size(12).text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.expanded.add(id); cx.notify(); }).child("Show more")));
    const tool = (key, name, tip, onClick, color) => h_flex().id(`${id}-${key}`).size(26).flex_none().items_center().justify_center().rounded(7)
      .cursor_pointer().text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click(onClick).child(icon(name, 14));
    const copy = tool("copy", this.copied === id ? "check" : "copy", this.copied === id ? "Copied" : "Copy",
      (_e, cx) => this.copy(id, m.text, cx), this.copied === id ? t.done : null);

    // Yours: a dark bubble on the right, who it went to underneath.
    if (m.from === "kabeer") {
      const to = (m.to ?? []).map((r) => this.roles.byId(r)?.name ?? r).join(", ");
      const ok = Boolean(m.delivered?.length && !m.failed?.length);
      return v_flex().id(id).items_end().gap(3).pt(this.wide ? 26 : 18)
        .on_hover((h, cx) => this.hoverOn(id, h, cx))
        // Plain text: Markdown views keep their own dark text, unreadable on the dark bubble.
        .child(div().max_w_4_5().px(15).py(10).rounded(18).bg(t.solid)
          .text_size(size).line_height(1.55).text_color(t.solid_foreground).child(m.text ?? ""))
        .child(h_flex().h(24).gap(6).items_center().text_size(11).text_color(t.dim)
          .when(hovered, (el) => el.child(copy))
          .child(`To ${to} · ${clock(m.at)}`)
          .when(ok, (el) => el.child(icon("check", 12).text_color(t.done))))
        .when(Boolean(m.failed?.length), (el) => el.child(div().max_w_4_5().text_size(11).line_height(1.4).text_color(t.blocked)
          .child(`Not delivered to ${m.failed.map((f) => `${this.roles.byId(f.role)?.name ?? f.role} (${f.why})`).join("; ")}. Send it again once they're free.`)));
    }

    // Theirs: no bubble. A turn opens with a name row ("Frontend · Worked for 3m 12s") and a
    // hairline; the text runs the column's full width; the latest reply keeps its tools out.
    const role = this.roles.byId(m.from), kind = KIND[m.kind];
    // A long-context note offers Compact while that agent is still running and still over its limit.
    const offer = m.kind === "context" ? this.members().find((x) => x.address === m.address && this.overLimit(x)) ?? null : null;
    const aside = ["ask", "answer", "route"].includes(m.kind);
    const to = m.to?.length ? m.to.map((r) => (r === "kabeer" ? "You" : this.roles.byId(r)?.name ?? r)).join(", ") : null;
    // One name row per run: the same author, a plain message, within five minutes.
    const grouped = !aside && !kind && prev && prev.from === m.from && !KIND[prev.kind] && !EVENTS.includes(prev.kind) && m.at - prev.at < 300000;
    const name = role?.name ?? m.from;
    const tile = aside ? 16 : 18;
    const avatar = role ? roleTile(div, svg, t, role, tile) : div().size(tile).flex_none().rounded(5).bg(t.raised);
    const latest = i === this.lastReply;
    const live = latest ? this.members().find((x) => x.address === m.address) ?? this.members().find((x) => x.role === m.from) : null;
    const meta = m.worked ? `Worked for ${span(m.worked)}` : clock(m.at);
    return v_flex().id(id).relative().gap(6).pt(grouped ? 6 : aside ? 14 : this.wide ? 26 : 18)
      .on_hover((h, cx) => this.hoverOn(id, h, cx))
      .when(!grouped, (el) => el.child(h_flex().h(22).gap(7).items_center()
        .child(avatar)
        .child(div().flex_none().text_size(aside ? 12 : 12.5).font_semibold().text_color(aside ? t.muted : t.foreground).child(name))
        .when(Boolean(to), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`→ ${to}`)))
        .when(Boolean(kind), (el) => el.child(pill(t, kind[0], t[kind[1]] ?? t.accent)))
        .child(div().id(`${id}-meta`).flex_none().text_size(11.5).text_color(t.dim).tooltip(clock(m.at)).child(meta))
        .child(aside ? div().flex_1() : div().flex_1().ml(4).h(1).bg(t.border))
        .when(hovered && !latest, (el) => el.child(copy))))
      .when(grouped && hovered && !latest, (el) => el.child(div().absolute().top(2).right(0).child(copy)))
      .child(div().pl(aside ? tile + 7 : 0).child(body(aside ? size - 1 : size, aside ? t.muted : t.foreground)))
      .when(latest, (el) => el.child(h_flex().ml(-5).gap(2)
        .child(copy)
        .when(Boolean(live), (el) => el.child(tool("term", "terminal", `Open ${name}'s terminal`, () => openTerminal(live.address))))))
      .when(Boolean(offer), (el) => el.child(h_flex().pt(2).gap(6)
        .child(button(t, `${id}-compact`, this.acting === `compact-${offer.address}` ? "Compacting…" : "Compact", (_e, cx) => this.compact(offer, cx),
          { primary: true, disabled: Boolean(this.acting) || offer.status === "working",
            tip: offer.status === "working" ? "Once its turn ends" : "Claude's /compact: same session, the history becomes a summary" }))));
  }

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

  // Three dots breathing out of step (native loops, so no re-render drives them).
  dots(t) {
    return h_flex().h(20).gap(4).items_center().children([820, 960, 1100].map((period) =>
      div().size(6).rounded(3).bg(t.dim).loop("opacity", { from: 0.25, to: 1, period })));
  }

  // Where the reply will appear: who's working now, under their name like a message. "Replying"
  // while they owe the chat a reply (bin/team labels them awaiting=… until their turn ends).
  activity(t, members) {
    return members.filter((m) => m.status === "working" || m.status === "blocked").map((m) => {
      const role = this.roles.byId(m.role), name = role?.name ?? m.role, id = `act-${m.address}`;
      const blocked = m.status === "blocked";
      const caption = blocked ? "needs you in its terminal" : this.waitingFor?.has(m.address) ? "waiting for your answer below" : m.handingOff ? "writing a handoff for a fresh session" : m.awaiting ? "replying" : `working${m.note ? ` · ${m.note}` : ""}`;
      return v_flex().id(id).gap(6).pt(this.wide ? 26 : 18)
        .child(h_flex().h(22).gap(7).items_center()
          .child(this.avatar(t, role, null, 18))
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(name))
          .child(div().min_w(0).flex_1().truncate().text_size(11.5).text_color(blocked ? t.blocked : t.dim).child(caption))
          .when(blocked, (el) => el.child(button(t, `${id}-go`, "Open terminal", () => openTerminal(m.address), { primary: true, tip: "It's waiting on a prompt only its terminal can answer" }))))
        .child(blocked ? icon("alert", 15).text_color(t.blocked) : this.dots(t));
    });
  }

  // A desk with nothing said yet: what it's for, and who answers.
  emptyThread(t, members) {
    const lead = members.some((m) => m.role === "cto") ? "the CTO" : members.length ? "everyone here" : null;
    return v_flex().id("thread-empty").py(28).gap(6).items_center()
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("What should the team work on?"))
      .child(div().max_w(300).text_size(12).line_height(1.5).text_color(t.muted).text_center()
        .child(lead ? `Messages go to ${lead}. Type @ to talk to someone directly.` : "Add someone to this desk, then tell them what you need."));
  }

  memberDetail(t, m, d) {
    const role = this.roles.byId(m.role), id = `md-${m.address}`;
    const engineer = role?.worktree && !role?.on_request;
    const cwd = panes().find((p) => p.terminal === m.address)?.cwd ?? m.cwd ?? "";
    const where = cwd.includes("/.herdr/worktrees/") ? cwd.split("/").pop() : cwd.split("/").pop();
    const child = (roleId, task) => team([roleId, "--requested", "--share", "--parent", m.address, "--repo", cwd || d.folder,
      "--slug", d.slug, ...(m.space ? ["--space", m.space] : []), "--task", task]);
    return v_flex().id(id).ml(10 + m.depth * 18).mr(10).mb(4).px(10).py(7).gap(5).rounded(8).bg(t.raised)
      .child(h_flex().gap(8).items_center()
        .child(this.avatar(t, role, m.status, 22))
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(role?.name ?? m.role))
        .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(where))
        .child(statusBadge(t, m.status) ?? div()))
      .when(Boolean(m.note), (el) => el.child(div().pl(30).text_size(11.5).line_height(1.35).text_color(t.muted).child(m.note)))
      .when(Boolean(m.ctx), (el) => el.child(div().pl(30).text_size(11).text_color(this.overLimit(m) ? t.blocked : t.dim)
        .child(`${kTokens(m.ctx)} tokens of context${this.overLimit(m) ? `, past the ${kTokens(this.roles.freshAt(m.role))} limit: compact it when it's free` : ""}`)))
      .child(h_flex().pl(30).gap(6).flex_wrap()
        .child(button(t, `${id}-go`, "Go", () => openTerminal(m.address)))
        .when(role?.cli !== "codex", (el) => el
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
          }, cx), { iconName: "pr", disabled: Boolean(this.acting), tip: "Ask it to push its branch and open a PR" }))));
  }

  deskView(t, d) {
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
            .on_click(() => openTerminal(m.address))
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

    const said = this.messages.some((m) => !EVENTS.includes(m.kind));
    // Consecutive "started X" events by one person read as one line: "You added CTO, Frontend and Backend".
    const shown = [];
    // Permission requests: how each ended (bin/team's permission-done), and the ones still waiting.
    this.permitDone = new Map(this.messages.filter((m) => m.kind === "permission-done").map((m) => [m.re, m.decision]));
    const live = new Set(members.map((m) => m.address));
    const waiting = this.messages.filter((m) => m.kind === "permission" && !this.permitDone.has(m.id) && live.has(m.address) && Date.now() - m.at < PERMIT_WAIT);
    this.waitingFor = new Set(waiting.map((m) => m.address));
    for (const m of this.messages) {
      if (m.kind === "permission-done") continue;
      const last = shown.at(-1);
      if (m.kind === "start" && last?.kind === "start" && last.from === m.from && m.at - last.at < 600000) {
        shown[shown.length - 1] = { ...last, roles: [...(last.roles ?? [last.role]), m.role] };
      } else shown.push(m);
    }
    // How long each reply took: from the first message that reached that agent (yours, or an
    // agent's ask) since its last reply. The latest reply keeps its tools in view.
    const started = new Map();
    this.lastReply = -1;
    shown.forEach((m, i) => {
      if (EVENTS.includes(m.kind) || m.kind === "context") return;
      if (m.from === "kabeer" || m.kind === "ask" || m.kind === "route") {
        for (const r of m.to ?? []) if (!started.has(r)) started.set(r, m.at);
        if (m.from === "kabeer") return;
      }
      if (started.has(m.from)) { m.worked = m.at - started.get(m.from); started.delete(m.from); }
      if (m.kind !== "ask") this.lastReply = i;
    });
    const col = (el) => (this.wide ? div().w_full().max_w(COLUMN).child(el) : el);
    const rows = shown.map((m, i) => col(this.message(t, m, i, shown[i - 1])));
    const thread = v_flex().id("desk-thread").flex_1().min_h(0).px(this.wide ? 28 : 16).pb(12).overflow_y_scrollbar().flex_col_reverse()
      .when(this.wide, (el) => el.items_center())
      .children([...this.activity(t, members).map(col).reverse(), ...(said ? [] : [col(this.emptyThread(t, members))]), ...rows.reverse()]);

    // The composer, one frame: mention suggestions above it; the text; then who it goes to and a
    // round send button inside the frame.
    const sugg = this.suggestions();
    const text = this.input.value().trim();
    const canSend = Boolean(text) && to.length > 0 && !this.acting;
    const composer = v_flex().px(12).pt(8).pb(this.wide ? 18 : 12).gap(6).when(this.wide, (el) => el.w_full().max_w(COLUMN + 24))
      .children(waiting.map((m) => this.permitCard(t, d, m)))
      .when(sugg.length > 0, (el) => el.child(h_flex().gap(5).flex_wrap()
        .children(sugg.map((o, i) => this.chip(t, `sg-${o.id}`, i === 0, o.name, (_e, cx) => this.pickMention(o, cx),
          o.id === "all" ? icon("team", 13) : roleTile(div, svg, t, o, 16))))))
      .child(v_flex().rounded(18).border_1().border_color(t.input).bg(t.background).shadow_sm()
        .child(Textarea.new(this.input).w_full().px(14).pt(12).pb(4).text_size(this.wide ? 14 : 13).text_color(t.foreground)
          .token((ctx) => {
            const role = this.roles.byId(ctx.token.id);
            const color = role ? t[role.color] ?? t.accent : t.accent;
            return h_flex().h(ctx.line_height).px(5).items_center().rounded(5).bg(color + "24").text_color(color).font_medium()
              .child(`@${ctx.token.label ?? ctx.token.text}`);
          }))
        .child(h_flex().px(10).pb(10).gap(6).items_center()
          .child(h_flex().min_w(0).flex_1().gap(5).items_center().text_size(11.5).text_color(t.dim)
            .when(to.length > 0, (el) => el.child(div().flex_none().child("To"))
              .children(to.map((r) => {
                const role = this.roles.byId(r);
                return h_flex().flex_none().h(22).pl(2).pr(7).gap(5).items_center().rounded(11).bg(t.raised).text_color(t.foreground)
                  .when(Boolean(role), (el) => el.child(roleTile(div, svg, t, role, 18))).child(role?.name ?? r);
              }))
              .when(implicit, (el) => el.child(div().min_w(0).truncate().child("· @ to choose"))))
            .when(!to.length, (el) => el.child(div().truncate().child("Nobody here yet: add someone above"))))
          .child(h_flex().id("desk-send").size(30).flex_none().items_center().justify_center().rounded(15)
            .bg(canSend ? t.solid : t.raised).text_color(canSend ? t.solid_foreground : t.dim)
            .when(canSend, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)))
            .tooltip(canSend ? "Send (Enter) · new line: Shift+Enter" : to.length ? "Type a message" : "Add someone first")
            .on_click((_e, cx) => { if (canSend) this.send(cx); })
            .child(this.acting === "send" ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : icon("arrow-up", 14)))));

    // As the main view the header, details and briefs sit in the reading column too; the thread
    // scrolls full width so its scrollbar stays at the window's edge.
    const band = (el) => (this.wide ? h_flex().w_full().flex_none().justify_center().child(el.w_full().max_w(COLUMN + 24)) : el);
    return v_flex().size_full().min_h(0)
      // As the main view, the desk's controls live in the floating card (card.js), not up here.
      .when(!this.wide, (el) => el.child(header))
      .when(Boolean(details) && !this.wide, (el) => el.child(details))
      .when(this.wide, (el) => el.child(div().h(14).flex_none()))
      .when(Boolean(briefs), (el) => el.child(band(briefs)))
      .child(thread)
      .child(band(composer));
  }

  render(t) {
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
