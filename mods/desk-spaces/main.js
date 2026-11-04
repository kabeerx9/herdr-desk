// The Desk sidebar, as a thread list: Space (a project) → its Desks → each desk's Members.
// Laid out as T3 Code's sidebar: a space is a project folder header (its repo, else its name; a
// worktree space nests under its repo by branch). A desk is a thread row: its title, then its
// state ("Working", "Done") or its age. Members show only under a desk with a team: role, session
// title, a mark. Agents outside any desk are thread rows; ones put away sit on a Settled shelf.
// One selected row (`selected`; in light a white card with a hairline), `hover` under the pointer.
// Rows never re-sort under the pointer. Right-click a space for its menu; drag one to reorder.
//
// Shared state: a desk row sets "desk.view" = slug and "desk.route" = null (the team chat);
// a member row sets "desk.view" = its desk and "desk.route" = { task, address } (its own
// conversation). In the terminals view a member row focuses its pane instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, pickFolder, exec, hc, theme, shared, setShared, watchFolder, window, layout, agents, terminals, setAgentOrder, readTextFile, appHome, home, notify, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const mac = () => window()?.platform === "macos";

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 280) : mac() ? 76 : 44 });
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const CLEAR = "#00000000";

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// The Desk's one status mark set (mods/desk/ui.js statusMark), kept the same here: a mod can't
// import another's files, but it can draw its icons.
const MARKS = ["working", "blocked", "done", "idle", "queued", "failed", "disconnected"];
const MARK_COLOR = { working: "working", blocked: "blocked", done: "done", idle: "dim", queued: "muted", failed: "blocked", disconnected: "dim" };
function statusMark(t, status, size = 12) {
  const kind = MARKS.includes(status) ? status : "idle";
  const el = svg(`mods/desk/icons/marks/${kind}.svg`).size(size).flex_none().text_color(t[MARK_COLOR[kind]] ?? t.dim);
  return kind === "working" ? el.spin(900) : el;
}
// T3's sidebar geometry: a 32px folder header, 36px thread rows whose titles line up past the
// folder's icon (10 inset + 16 icon + 10 gap), 6px radius, 14px titles, 12px meta.
const FOLDER_H = 32, THREAD_H = 36, MEMBER_H = 32, INSET = 10, TITLE_X = 36;
// T3 light: a zinc-50 sidebar whose selected row is a white card with a hairline ring.
const light = () => !settings().dark;
const mutedFg = (t) => (light() ? t.dim : t.muted);
// A thread's state in its time slot, as T3 shows it: an icon and a word, in the state's colour.
const STATE = {
  working: ["Working", "working"], blocked: ["Needs you", "blocked"], failed: ["Failed", "blocked"],
  done: ["Done", "done"], queued: ["Queued", "muted"], disconnected: ["Offline", "dim"],
};
const DOT = { working: "working", blocked: "blocked", failed: "blocked", done: "done" };
const URGENCY = ["blocked", "failed", "working", "queued", "done", "disconnected", "idle"];
function mostUrgent(statuses) {
  let best = null;
  for (const s of statuses) if (s && (best === null || URGENCY.indexOf(s) < URGENCY.indexOf(best))) best = s;
  return best;
}
const offMain = (branch) => Boolean(branch) && !["main", "master", "trunk", "HEAD"].includes(branch);
const ago = (ms) => {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const wc = (name, size = 14) => svg(`mods/workspace-chrome/${name}.svg`).size(size).flex_none();
const dk = (name, size = 14) => svg(`mods/desk/icons/${name}.svg`).size(size).flex_none();

// The Desk runtime (bin/team state, polled by the Desk's rail into shared "desk.runtime"):
// session titles and settle / snooze. Controls hide until the runtime reports the fields.
const runtime = () => shared("desk.runtime") ?? { sessions: [] };
const sessionOf = (address) => (runtime().sessions ?? []).find((s) => s.address === address && s.state !== "finished") ?? null;
const triageOn = () => !shared("desk.triage.off") && (runtime().sessions ?? []).some((s) => "settled_at" in s || "snoozed_until" in s);
function putAway(session, status) {
  if (!session || status === "working" || status === "blocked") return false;
  return (session.snoozed_until ?? 0) > Date.now() || Boolean(session.settled_at);
}
function snoozeOptions(now = Date.now()) {
  const at = (days, hour) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };
  const tonight = at(0, 19);
  return [{ id: "1h", label: "1 hour", until: now + 3600000 },
    ...(tonight - now > 3600000 ? [{ id: "tonight", label: "Tonight", until: tonight }] : []),
    { id: "tomorrow", label: "Tomorrow", until: at(1, 9) }];
}
function triage(cx, action, address, until) {
  const args = action === "snooze" ? ["snooze", "--address", address, "--until-ms", String(until)] : [action, "--address", address];
  cx.spawn(async (cx) => {
    const r = await exec(`${appHome()}/bin/team`, args).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) {
      let why = (r.stderr || r.stdout || "").trim();
      try { why = JSON.parse(why).error ?? why; } catch {}
      if (/invalid choice|unrecognized|unknown command|usage:/i.test(why)) setShared("desk.triage.off", true);
      else notify({ title: "Couldn't update that agent", body: why.slice(0, 200), level: "error", timeout: 6000 });
    } else setShared("desk.runtime.dirty", Date.now());
    cx.notify();
  });
}

// desk-chat's center is a stack: the chat, or the shown tab's terminals (mods/desk/desks.js
// has the same switch; mods can't import each other's files).
const chatLayout = () => shared("layout") === "desk-chat";
const chatView = () => chatLayout() && !shared("deskchat.terminals");
function showTerminals(on) {
  if (!chatLayout()) return;
  setShared("deskchat.terminals", on);
  run("layout.select", { stack: "center", child: on ? "main" : "chat" });
  run(on ? "layout.show" : "layout.hide", { id: "tabs" });
}

// Desks' own names and last activity: the first line of each ~/.herdr/team/<slug>.jsonl
// (its {kind:"desk", name, project}) and the file's mtime.
const TEAM = () => `${home()}/.herdr/team`;
const DESKS_SH = `cd "$1" 2>/dev/null || exit 0
for f in *.jsonl; do [ -f "$f" ] || continue
  printf '%s\\t%s\\t%s\\n' "\${f%.jsonl}" "$(stat -f %m "$f")" "$(head -n1 "$f")"
done`;
// "shotgun · Nov 4 18:02": the name a desk gets when nobody named it.
const AUTO_NAME = /^(.*) · [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}$/;

// Agents in a space, desk members first (CTO first), then by who needs you. `labels` are their
// terminals' (role=, task= from bin/team); `roles` is mods/desk/roles.json's list by id.
const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
function spaceAgents(w, all, labels) {
  return all.filter((a) => a.space === w.id).map((a) => ({ a, l: labels.get(a.address) ?? {} }))
    .sort((x, y) => (x.l.role ? 0 : 1) - (y.l.role ? 0 : 1) || (x.l.role === "cto" ? -1 : y.l.role === "cto" ? 1 : 0)
      || (RANK[x.a.status] ?? 9) - (RANK[y.a.status] ?? 9) || x.a.seq - y.a.seq);
}

// A role's glyph, one colour (the text's): no tinted tiles.
function roleGlyph(t, role, size = 14, color) {
  const el = role?.icon ? svg(`mods/desk/icons/${role.icon}.svg`) : svg("mods/desk/icons/terminal.svg");
  return el.size(size).flex_none().text_color(color ?? t.dim);
}

// A popup menu's row (space menu, add-to-desk).
function menuItem(t, id, lead, label, onClick, tail) {
  return h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick)
    .child(h_flex().w(16).flex_none().justify_center().text_color(t.dim).child(lead))
    .child(div().flex_1().truncate().child(label))
    .when(Boolean(tail), (el) => el.child(tail));
}

// Right-click on a space: the ways in (its terminals, a new one, a new desk), then Herdr's own
// space menu (rename, worktrees, close) under More.
class SpaceMenu {
  render() {
    const t = theme(), { overlay, space } = props(), chat = chatLayout();
    const go = (fn) => () => { closeOverlay(overlay); run("space.select", { id: space }); fn(); };
    return v_flex().id("space-menu").w_full().p(4).gap(1).bg(t.popover)
      .child(menuItem(t, "sm-terms", dk("terminal"), chat ? "Show its terminals" : "Open", go(() => showTerminals(true))))
      .child(menuItem(t, "sm-new-term", dk("plus"), "New terminal", go(() => { showTerminals(true); run("tab.new", { space }); })))
      .when(chat, (el) => el.child(menuItem(t, "sm-desk", wc("square-pen"), "New desk here", go(() => {
        setShared("desk.here", { space, at: Date.now() }); setShared("desk.view", "new"); setShared("desk.route", null); showTerminals(false);
      }))))
      .child(div().h(1).mx(6).my(3).bg(t.border))
      .child(menuItem(t, "sm-more", dk("chevron"), "More…", () => {
        closeOverlay(overlay);
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: space } } });
      }));
  }
}

// "Add to desk" on an agent started outside one: which role it joins as (bin/team join labels it,
// tells it how the desk works, and tells the CTO).
class JoinMenu {
  render() {
    const t = theme(), { overlay, address, task, name, roles } = props();
    const join = (r) => (_e, cx) => {
      if (this.busy) return;
      this.busy = r.id;
      cx.notify();
      cx.spawn(async () => {
        const out = await exec(`${appHome()}/bin/team`, ["join", "--task", task, "--address", address, "--role", r.id]);
        if (out.code !== 0) {
          let why = out.stderr.trim();
          try { why = JSON.parse(why).error ?? why; } catch {}
          notify({ title: "Couldn't add it to the desk", body: why.slice(0, 200), level: "error", timeout: 6000 });
        }
        closeOverlay(overlay);
      });
    };
    return v_flex().id("join-menu").w_full().p(4).gap(1).bg(t.popover)
      .child(div().px(8).pt(6).pb(4).text_size(11).text_color(t.dim).truncate().child(`Add ${name} to the desk as`))
      .children(roles.map((r) => menuItem(t, `jm-${r.id}`, roleGlyph(t, r, 14), r.name, join(r),
        this.busy === r.id ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().spin(900) : null)));
  }
}

// A 28px header control (T3's sidebar header icon button): a 16px icon, the muted label colour,
// the hover fill under it.
function iconButton(t, id, name, tip, onClick) {
  return h_flex().id(id).size(28).flex_none().items_center().justify_center().rounded(6)
    .text_color(mutedFg(t)).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(onClick).child(wc(name, 16));
}

// The sidebar's top (the layout's "brand" block, which drags the window): room for the macOS
// window buttons, then the fold. Search and "new" sit in the list's own header row below.
class Top {
  render() {
    const t = theme(), collapsed = narrow();
    if (collapsed && mac() && !window()?.fullscreen) return div().size_full().bg(t.chrome);
    return h_flex().size_full().bg(t.chrome).pr(8).items_center()
      .pl(mac() && !window()?.fullscreen && !collapsed ? 80 : 8)
      .child(div().flex_1())
      .child(iconButton(t, "top-fold", "sidebar", collapsed ? "Show the sidebar" : "Hide the sidebar", () => toggleSidebar()));
  }
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.spaceMenu) { this.part = new SpaceMenu(); return; }
    if (props()?.joinMenu) { this.part = new JoinMenu(); return; }
    if (props()?.top) { this.part = new Top(); return; }
    this.hoverRow = null;
    this.snoozing = null; // the agent row whose snooze times show
    this.shelves = new Set(); // spaces whose Settled shelf is open
    this.order = {}; // space -> its agents' order at the last draw
    this.pointerIn = false;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.closed = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]")); // spaces folded shut
    this.roles = new Map(); // role id → { name, icon }, from the Desk's roles.json
    this.rolesRaw = null;
    this.deskInfo = new Map(); // slug → { name, project, at }
    this.loadRoles(cx);
    cx.timer.every(5000, (cx) => this.loadRoles(cx));
    this.loadDesks(cx);
    cx.timer.every(6000, (cx) => { if (window().active) this.loadDesks(cx); });
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  loadRoles(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/mods/desk/roles.json`);
        if (!text || text === this.rolesRaw) return;
        this.rolesRaw = text;
        this.roles = new Map((JSON.parse(text).roles ?? []).map((r) => [r.id ?? r.name.toLowerCase(), r]));
        cx.notify();
      } catch {}
    });
  }

  loadDesks(cx) {
    if (this.loadingDesks) return;
    this.loadingDesks = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DESKS_SH, "desks", TEAM()]);
        const next = new Map();
        for (const line of r.stdout.split("\n").filter(Boolean)) {
          const [slug, mtime, first] = line.split("\t");
          let head = null;
          try { head = JSON.parse(first); } catch {}
          next.set(slug, { name: head?.kind === "desk" ? head.name ?? slug : slug, project: head?.project ?? null, at: Number(mtime) * 1000 });
        }
        const changed = [...next].some(([k, v]) => { const o = this.deskInfo.get(k); return !o || o.name !== v.name || o.at !== v.at; });
        this.deskInfo = next;
        if (changed) cx.notify();
      } catch {} finally { this.loadingDesks = false; }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (this.dirty?.size) {
      const repos = new Set([...this.dirty].map((r) => JSON.stringify([null, r])));
      this.dirty.clear();
      for (const k of Object.keys(this.git)) if (repos.has(this.git[k]?.repo)) due.add(k);
    }
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          // A commit or checkout writes a burst of files: collect them, and checkNew's
          // 250ms tick refreshes each repo once for the whole burst.
          if (this.watching.has(repo)) (this.dirty ??= new Set()).add(repo);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // ── what a click does ──────────────────────────────────────────────────────

  // A space header: switch to it. In the chat view, also open its first desk (else the new-desk
  // page aimed at it). In the terminal view a click only switches.
  pick(w, firstDesk) {
    run("space.select", { id: w.id });
    if (!chatView()) return;
    setShared("desk.route", null);
    if (firstDesk) return setShared("desk.view", firstDesk);
    setShared("desk.here", { space: w.id, at: Date.now() });
    setShared("desk.view", "new");
  }

  // A desk row: its team chat. The terminal view stays where it is (the card follows the desk).
  openDesk(w, slug) {
    run("space.select", { id: w.id });
    setShared("desk.view", slug);
    setShared("desk.route", null);
  }

  // A member row: in the chat view its own conversation (the chat renders "desk.route");
  // in the terminal view (and other layouts) its pane.
  openMember(a, l) {
    if (l.task && chatView()) {
      run("space.select", { id: a.space });
      setShared("desk.view", l.task);
      return setShared("desk.route", { task: l.task, address: a.address });
    }
    showTerminals(true);
    run("pane.focus", { pane: a.pane });
  }

  newDeskHere(space) {
    if (!chatLayout()) return run("tab.new", space ? { space } : {});
    if (space) run("space.select", { id: space });
    setShared("desk.here", { space: space ?? undefined, at: Date.now() });
    setShared("desk.view", "new");
    setShared("desk.route", null);
    showTerminals(false);
  }

  // A new session in desk-chat: pick a folder and the main chat starts a desk there with the CTO
  // (team opens its space, or reuses the folder's). Other machines and layouts get a plain space.
  newSession(m, cx) {
    if (m || !chatLayout()) return run("space.new", m ? { machine: m } : {});
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Choose a folder for a new desk" });
      if (!folder) return;
      setShared("desk.start", { folder, at: Date.now() });
      setShared("desk.route", null);
      showTerminals(false);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 200, height: 150, props: { spaceMenu: true, space: w.id } });
  }

  joinMenu(a, name, desk) {
    const taken = new Set(desk.roles);
    const roles = [...this.roles.entries()].map(([id, r]) => ({ id, name: r.name, icon: r.icon }))
      .filter((r) => !(r.id === "cto" && taken.has("cto")));
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 220, height: 40 + roles.length * 29,
      props: { joinMenu: true, address: a.address, task: desk.slug, name, roles } });
  }

  toggleSpace(id) {
    this.closed.has(id) ? this.closed.delete(id) : this.closed.add(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.closed]));
  }

  // ── rows ───────────────────────────────────────────────────────────────────

  // Every row: full width, a 6px radius. Selected is the one fill (in light, T3's white card with
  // a hairline ring on the zinc sidebar); hover the quieter one.
  rowBase(t, id, { selected = false, pl = INSET, h = THREAD_H, tip } = {}) {
    return h_flex().id(id).relative().h(h).flex_none().pl(pl).pr(INSET).gap(10).items_center().rounded(6).cursor_pointer()
      .bg(selected ? (light() ? t.canvas : t.selected) : CLEAR)
      .when(selected && light(), (el) => el.border_1().border_color(t.border))
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_hover((h, cx) => {
        if (h) this.hoverRow = id; else if (this.hoverRow === id) this.hoverRow = null;
        cx.notify();
      });
  }

  // A small square control inside a row (fold, new desk, settle, snooze); stops the row's press.
  rowButton(t, id, iconEl, tip, onClick, on = false, size = 24) {
    return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : mutedFg(t)).hover((s) => s.text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(iconEl);
  }

  // T3's time slot: a state (icon + word, its colour) while there is one, else the age; on hover
  // the row's actions take the slot.
  trailing(t, { status, at, tools = [] }) {
    const slot = h_flex().h(24).min_w(32).flex_none().justify_end().items_center();
    if (tools.length) return slot.gap(0).children(tools);
    const state = STATE[status];
    if (state) return slot.gap(4).text_size(12).font_medium().text_color(t[state[1]] ?? t.dim)
      .child(statusMark(t, status, 12)).child(div().child(state[0]));
    return slot.when(Boolean(at), (el) => el.text_size(12).text_color(t.dim).child(ago(at)));
  }

  // Settle and snooze for an agent's session (nothing while it works or needs you); "back" for
  // one put away.
  triageTools(t, a, id, put) {
    const session = sessionOf(a.address);
    if (!session || !triageOn() || ["working", "blocked"].includes(a.status)) return [];
    if (put) return [this.rowButton(t, `${id}-back`, dk("back", 12), "Bring it back", (cx) => triage(cx, "unsettle", a.address))];
    return [this.rowButton(t, `${id}-snooze`, dk("clock", 12), "Snooze", () => { this.snoozing = this.snoozing === id ? null : id; }, this.snoozing === id),
      this.rowButton(t, `${id}-settle`, dk("check", 12), "Settle: put it away until it has new work", (cx) => triage(cx, "settle", a.address))];
  }

  // The snooze times, a row under the one whose clock was pressed.
  snoozeRow(t, a, id, pl) {
    return h_flex().id(`${id}-times`).h(32).flex_none().pl(pl).pr(INSET).gap(4).items_center()
      .children(snoozeOptions().map((o) => div().id(`${id}-snz-${o.id}`).h(24).px(8).flex().items_center().rounded(6).cursor_pointer()
        .border_1().border_color(t.border).text_size(12).text_color(mutedFg(t)).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.snoozing = null; triage(cx, "snooze", a.address, o.until); }).child(o.label)));
  }

  // A desk: a T3 thread row. Its title (medium; regular and muted once it has nothing new), then
  // its state or age. A desk of one is that agent's thread, so its hover carries settle / snooze.
  deskRow(t, w, desk, x) {
    const id = `desk-${desk.slug}`, hovered = this.hoverRow === id;
    const route = shared("desk.route");
    const selected = chatView() && shared("desk.view") === desk.slug && !(route?.address && route.task === desk.slug && desk.members.length > 1);
    const info = this.deskInfo.get(desk.slug);
    const solo = desk.members.length === 1 ? desk.members[0].a : null;
    const tools = hovered && solo ? this.triageTools(t, solo, id, false) : [];
    const recede = !selected && desk.status === "idle";
    const row = this.rowBase(t, id, { selected, pl: TITLE_X + x, tip: desk.full })
      .on_click(() => this.openDesk(w, desk.slug))
      .child(div().min_w(0).flex_1().truncate().text_size(14).when(!recede, (el) => el.font_medium())
        .text_color(recede ? (hovered ? t.foreground : mutedFg(t)) : t.foreground).child(desk.title))
      .child(this.trailing(t, { status: desk.status, at: info?.at, tools }));
    return this.snoozing === id && solo ? [row, this.snoozeRow(t, solo, id, TITLE_X + x)] : [row];
  }

  // One agent row: a member of a desk with a team (a quieter 32px row under its desk: role, then
  // its session title, its state as a mark), or an agent outside any desk (a thread row of its own).
  agentRow(t, { a, l }, g, ps, desk, { put = false, deskTitle = null, x = 0 } = {}) {
    const role = l.role ? this.roles.get(l.role) : null;
    const member = Boolean(role && l.task) && !put;
    const session = sessionOf(a.address);
    const fallback = role?.name ?? ((/^\d+$/.test(a.tab_name) ? a.title || a.program?.name : a.tab_name) || "Agent");
    const title = session?.title && session.title !== deskTitle ? session.title : null;
    const id = `agent-${a.address}`, hovered = this.hoverRow === id;
    const route = shared("desk.route");
    const selected = role && l.task && chatView() ? route?.address === a.address : Boolean(a.focused) && !chatView();
    const pane = ps.find((p) => p.pane === a.pane);
    const branch = pane?.branch && g?.branch && pane.branch !== g.branch && offMain(pane.branch) ? pane.branch : null;
    const canJoin = !(role && l.task) && desk && !a.space.includes("/");
    const tools = hovered ? [
      ...(canJoin ? [this.rowButton(t, `${id}-join`, dk("plus", 12), "Add to the desk", () => this.joinMenu(a, session?.title || fallback, desk))] : []),
      ...this.triageTools(t, a, id, put)] : [];
    const name = role && l.task ? role.name : session?.title || fallback;
    const tip = [session?.title ? `${fallback} · ${session.title}` : fallback, branch].filter(Boolean).join(" · ");
    const recede = !selected && (a.status === "idle" || put);
    const pl = (member ? TITLE_X + 16 : TITLE_X) + x;
    const row = this.rowBase(t, id, { selected, pl, h: member ? MEMBER_H : THREAD_H, tip })
      .on_click(() => this.openMember(a, l))
      .when(canJoin, (el) => el.on_mouse_down("right", () => this.joinMenu(a, name, desk)));
    const body = member
      ? row.child(h_flex().min_w(0).flex_1().gap(8).items_center()
          .child(div().flex_none().max_w(120).truncate().text_size(13).text_color(selected || hovered ? t.foreground : mutedFg(t)).child(name))
          .when(Boolean(title), (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_size(13).text_color(t.dim).child(title))))
        .child(tools.length ? this.trailing(t, { tools }) : h_flex().w(16).flex_none().justify_end()
          .when(Boolean(STATE[a.status]), (el) => el.child(statusMark(t, a.status, 12))))
      : row.child(div().min_w(0).flex_1().truncate().text_size(14).when(!recede, (el) => el.font_medium())
          .text_color(recede ? (hovered ? t.foreground : mutedFg(t)) : t.foreground).child(name))
        .child(this.trailing(t, { status: put ? null : a.status, tools }));
    return this.snoozing === id && !put ? [body, this.snoozeRow(t, a, id, pl)] : [body];
  }

  // While the pointer is over the list, a space's agents keep the order they had; new ones go last.
  held(space, kids) {
    const before = this.order[space];
    if (this.pointerIn && before) {
      const at = new Map(before.map((a, i) => [a, i]));
      kids = [...kids].sort((x, y) => (at.get(x.a.address) ?? 1e9) - (at.get(y.a.address) ?? 1e9));
    }
    this.order[space] = kids.map((k) => k.a.address);
    return kids;
  }

  // A desk's title: the name it was given; an automatic one ("shotgun · Nov 4 18:02") gives way
  // to its CTO's session title, else its time.
  deskTitle(slug, members) {
    const name = this.deskInfo.get(slug)?.name ?? slug;
    const auto = AUTO_NAME.exec(name);
    if (!auto) return name;
    const lead = members.find((k) => k.l.role === "cto") ?? members[0];
    return sessionOf(lead?.a.address)?.title || name.slice(auto[1].length + 3);
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: false });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      for (const k of list.filter((k) => nested(k) && k.g.repo === r.g.repo)) out.push({ ...k, tree: true });
    }
    return out;
  }

  // The tree, under a quiet header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const all = agents(), labels = new Map(terminals().map((x) => [x.address, x.labels ?? {}])), ps = panes();
    const order = [];
    const draw = (r) => {
      const kids = this.held(r.w.id, spaceAgents(r.w, all, labels));
      if (collapsed) { order.push(...kids.map((k) => k.a.address)); return [this.compact(r, t, kids)]; }
      const shelf = kids.filter((k) => putAway(sessionOf(k.a.address), k.a.status));
      const live = kids.filter((k) => !shelf.includes(k));
      const members = live.filter((k) => k.l.role && k.l.task), outside = live.filter((k) => !(k.l.role && k.l.task));
      // Desks in the order their first member comes; each with its members.
      const desks = [];
      for (const k of members) {
        let d = desks.find((x) => x.slug === k.l.task);
        if (!d) desks.push(d = { slug: k.l.task, members: [] });
        d.members.push(k);
      }
      for (const d of desks) {
        d.title = this.deskTitle(d.slug, d.members);
        d.full = this.deskInfo.get(d.slug)?.name ?? d.slug;
        d.status = mostUrgent(d.members.map((k) => k.a.status)) ?? "idle";
        d.roles = d.members.map((k) => k.l.role);
      }
      const joinTo = desks[0] ?? null;
      const shut = this.closed.has(r.w.id);
      const head = this.header(r, t, { desks, shut, count: desks.length + outside.length, status: mostUrgent(kids.map((k) => k.a.status)) });
      if (shut) { order.push(...kids.map((k) => k.a.address)); return [head]; }
      const x = r.tree ? 16 : 0; // a worktree's rows sit under its own (indented) header
      const open = this.shelves.has(r.w.id);
      const shelfId = `shelf-${r.w.id}`;
      // T3's shelf header: a quiet 12px label, its count, a chevron that turns.
      const shelfRow = this.rowBase(t, shelfId, { pl: TITLE_X + x, h: FOLDER_H })
        .on_click((_e, cx) => { open ? this.shelves.delete(r.w.id) : this.shelves.add(r.w.id); cx.notify(); })
        .child(div().flex_1().text_size(12).font_medium().text_color(t.dim).child("Settled"))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(String(shelf.length)))
        .child(wc(`chevron-${open ? "down" : "right"}`, 12).text_color(t.dim));
      const out = [head];
      for (const d of desks) {
        out.push(...this.deskRow(t, r.w, d, x));
        // Members show only for a desk with a team: a desk of one is that agent's thread, and its
        // row already says how it is.
        for (const k of d.members) {
          order.push(k.a.address);
          if (d.members.length > 1) out.push(...this.agentRow(t, k, r.g, ps, d, { deskTitle: d.title, x }));
        }
      }
      for (const k of outside) { order.push(k.a.address); out.push(...this.agentRow(t, k, r.g, ps, joinTo, { x })); }
      if (shelf.length) out.push(shelfRow);
      for (const k of shelf) { order.push(k.a.address); if (open) out.push(...this.agentRow(t, k, r.g, ps, joinTo, { put: true, x })); }
      return out;
    };
    // A space and its worktree spaces are one group, with room above the next.
    const groups = (list) => {
      if (collapsed) return list.flatMap(draw);
      const chunks = [];
      for (const r of list) (r.tree && chunks.length ? chunks[chunks.length - 1] : chunks[chunks.push([]) - 1]).push(r);
      return chunks.map((c, ci) => v_flex().id(`group-${c[0].w.id}`).flex_none().when(ci > 0, (el) => el.mt(8)).children(c.flatMap(draw)));
    };
    // Keyboard order follows the list (Herdr's next/previous agent).
    const finish = (list) => { setAgentOrder(order); return list; };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(FOLDER_H).flex_none().px(INSET).flex().items_center().text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return finish(loading(null) && !rows.length ? [loadingRow(null)] : groups(rows));
    const machineNames = [null, ...remote];
    return finish(machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(FOLDER_H).mt(8).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12).font_medium().text_color(t.dim)
        .cursor_pointer().hover(s => s.text_color(t.muted))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(wc(m ? "server" : "monitor", 12))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(this.rowButton(t, `machine-add-${m ?? "local"}`, wc("plus", 12), "New space there", (cx) => this.newSession(m, cx))))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.working : t.dim))
          .child(wc(`chevron-${folded ? "right" : "down"}`, 12)));
      const empty = this.rowBase(t, `machine-new-${m ?? "local"}`).on_click((_e, cx) => this.newSession(m, cx))
        .child(wc("plus", 12).text_color(t.dim)).when(!collapsed, el => el.child(div().text_size(12).text_color(t.dim).child("New space there")));
      return [head, ...(folded ? [] : mine.length ? groups(mine) : [loading(m) ? loadingRow(m) : empty])];
    }));
  }

  // A space: T3's project folder header. Its icon and name (14 medium); a chevron at the end folds
  // it; folded, a dot for what needs you and the count of what's inside (the count gives way to
  // "new desk" under the pointer). A click opens it; drag one to reorder; right-click for its menu.
  header({ w, i, g, tree }, t, { desks, shut, status, count }) {
    const id = `space-${w.id}`, hovered = this.hoverRow === id;
    const ps = panes();
    const title = tree ? (g?.branch ?? w.name) : g?.name ?? (w.name === "~" ? "Home" : w.name);
    const extra = !tree && w.named && g && w.name.toLowerCase() !== g.name.toLowerCase() ? w.name : null;
    const behind = [g?.ahead ? `↑${g.ahead}` : "", g?.behind ? `↓${g.behind}` : ""].join(" ").trim();
    const tip = [extra, place(w, ps), !tree && offMain(g?.branch) ? g.branch : null, behind].filter(Boolean).join(" · ");
    const fold = this.rowButton(t, `${id}-fold`, wc(`chevron-${shut ? "right" : "down"}`, 12), shut ? "Show its desks" : "Fold",
      () => this.toggleSpace(w.id), false, 20);
    const dot = shut ? DOT[status] : null;
    return this.rowBase(t, id, { pl: INSET + (tree ? 16 : 0), h: FOLDER_H, tip: tip || undefined })
      .pr(4)
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(6).right(6).h(2).rounded(1).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => { this.pressed = i; this.over = i; })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) { this.over = over; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed, over = this.over;
        this.pressed = null; this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) this.pick(w, desks[0]?.slug);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(wc(tree ? "branch" : "folder", 16).text_color(t.dim))
      .child(div().min_w(0).flex_1().truncate().text_size(14).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(dot), (el) => el.child(div().size(6).rounded(3).flex_none().bg(t[dot])))
      .when(shut && count > 0 && !hovered, (el) => el.child(div().flex_none().text_size(12).text_color(mutedFg(t)).child(String(count))))
      .when(hovered, (el) => el.child(this.rowButton(t, `${id}-new`, wc(chatLayout() ? "square-pen" : "plus", 14), chatLayout() ? "New desk here" : "New terminal",
        () => this.newDeskHere(w.id))))
      .child(fold);
  }

  // The narrow rail: each space as its number and mark.
  compact({ w, i }, t, kids) {
    const status = mostUrgent(kids.map((k) => k.a.status)) ?? w.status;
    return v_flex().id(`space-${w.id}`).h(34).flex_none().items_center().justify_center().gap(2).rounded(6).cursor_pointer()
      .bg(w.active ? t.selected : CLEAR).when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .tooltip(w.name)
      .on_click(() => this.pick(w, kids.find((k) => k.l.task)?.l.task))
      .child(div().text_size(12).font_medium().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(h_flex().h(10).items_center().when(Boolean(status) && status !== "idle", (el) => el.child(statusMark(t, status, 9))));
  }

  render() {
    if (this.part) return this.part.render();
    const t = theme();
    const collapsed = narrow();
    const chat = chatLayout();
    // T3's header row: a search field (here, the picker) and the two "new" buttons.
    const search = h_flex().id("search").h(32).flex_1().min_w(0).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .text_color(mutedFg(t)).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("mod.open", { name: "picker" }))
      .child(wc("search", 16)).child(div().flex_1().truncate().text_size(14).font_medium().child("Search"));
    const head = h_flex().flex_none().px(8).gap(4).items_center()
      .child(search)
      .child(iconButton(t, "space-new", "folder-plus", chat ? "New desk in another folder" : "New space", (_e, cx) => this.newSession(null, cx)))
      .child(iconButton(t, "new-desk", chat ? "square-pen" : "plus", chat ? "New desk" : "New terminal", () => this.newDeskHere(null)));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(14)
      .when(!collapsed, (el) => el.child(head))
      .when(collapsed, (el) => el.child(h_flex().flex_none().h(34).justify_center()
        .child(this.rowButton(t, "unfold", wc("sidebar", 14), "Show the sidebar", () => toggleSidebar()))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(8).pt(8).pb(16).overflow_y_scrollbar()
        .on_hover((inside, cx) => { this.pointerIn = inside; if (!inside) { this.snoozing = null; this.hoverRow = null; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
