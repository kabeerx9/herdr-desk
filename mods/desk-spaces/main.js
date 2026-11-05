// The Desk sidebar ("Needs you + tree"): search and one compose button; then, only while some
// agent is blocked, a pinned "Needs you" list (one two-line row per blocked agent, any desk);
// then the tree Project → Desks → Members. A new session is a desk with only its CTO: one row
// (the CTO's face, the desk's title, its state). Once the CTO brings others in, a folded desk
// shows their faces as a stack and an unfolded one lists them under a guide line. Agents outside
// any desk are desk-like rows. One selected fill (`selected`), `hover` under the pointer, no
// borders. Rows never re-sort under the pointer. Right-click a project for its menu; drag one
// to reorder.
//
// Shared state: a desk row sets "desk.view" = slug and "desk.route" = null (the team chat);
// a member row sets "desk.view" = its desk and "desk.route" = { task, address } (its own
// conversation). In the terminals view a member row focuses its pane instead.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { withKept, removeBlockers } from "./kept.js";
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
  if (kind === "working") return el.spin(900);
  if (kind === "blocked") return el.loop("opacity", { from: 0.45, to: 1, period: 1400 });
  return el;
}
// Geometry (the approved "Needs you + tree" prototype): 28px project headers, 32px desk rows,
// 28px member rows indented under a 1px guide, 44px two-line "Needs you" rows; radius 7.
const FOLDER_H = 28, THREAD_H = 32, MEMBER_H = 28, NEED_H = 44, INSET = 9, RADIUS = 7;
const MEMBER_X = 34, GUIDE_X = 16; // a member's face and the guide line, from the row's left
// Faces: 18 on desk rows, 16 on member rows, 22 on "Needs you" rows, 15 in a desk's face stack.
const FACE = 18, MEMBER_FACE = 16, NEED_FACE = 22, STACK_FACE = 15;
const mutedFg = (t) => t.muted;
// A row's state slot: a mark and (where the row has room) a word, in the state's colour.
// Done-and-unread is a dot; idle says nothing.
const STATE = {
  working: ["Working", "working"], blocked: ["Needs you", "blocked"], failed: ["Failed", "blocked"],
  queued: [null, "muted"], disconnected: [null, "dim"],
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
// session titles and which CLI each one runs.
const runtime = () => shared("desk.runtime") ?? { sessions: [] };
const sessionOf = (address) => (runtime().sessions ?? []).find((s) => s.address === address && s.state !== "finished") ?? null;

// Faces. A copy of mods/desk/roles.js agentCli / programIcon / agentIcon (a mod can't import
// another's files): keep the two the same.
const PROGRAMS = new Set(["claude", "codex", "gemini", "copilot", "cursor", "opencode", "amp", "kimi", "grok", "qoder", "kiro", "crush"]);
const AVATARS = new Set(["cto", "backend", "frontend", "qa", "reviewer"]);
const programKey = (cli) => {
  const k = String(cli ?? "").toLowerCase().split("/").pop();
  return k.startsWith("claude") ? "claude" : k;
};
function agentCli({ session, labels, agent, role } = {}) {
  const roleCli = typeof role === "object" ? role?.cli : null;
  return session?.role_config?.cli ?? session?.cli ?? labels?.cli
    ?? (agent?.program?.agent ? agent.program.key : null) ?? roleCli ?? null;
}
function programIcon(cli, size = 16, t) {
  const key = programKey(cli);
  if (PROGRAMS.has(key)) return image(`icons/${key}.svg`).size(size).flex_none();
  return svg("icons/agent.svg").size(size).flex_none().text_color(t?.dim ?? "#8a8a8a");
}
function agentIcon(t, { role, cli, ring } = {}, size = 18) {
  const avatar = typeof role === "string" ? (AVATARS.has(role) ? `avatars/${role}.png` : null) : role?.avatar ?? null;
  if (!avatar) return cli ? programIcon(cli, size, t) : svg("icons/agent.svg").size(size).flex_none().text_color(t.dim);
  const face = image(`mods/desk/${avatar}`).size(size).flex_none().rounded_full();
  if (!cli) return div().size(size).flex_none().child(face);
  const badge = Math.max(8, Math.round(size * 0.45)), pad = size >= 24 ? 2 : 1, box = badge + pad * 2;
  return div().relative().size(size).flex_none().child(face)
    .child(div().absolute().right(-pad - 1).bottom(-pad - 1).size(box).rounded_full().bg(ring ?? t.background)
      .flex().items_center().justify_center().child(programIcon(cli, badge, t)));
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
const SEED_SH = `cd "$1/.deleted" 2>/dev/null || exit 0
for f in *.jsonl; do [ -f "$f" ] && head -n1 "$f"; done`;
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
      }))
      .when(Boolean(props().folder), (el) => el.child(removeItem(this, t, overlay, props().folder)));
  }
}

// Removing closes the project's terminals, so it takes a second click. The list that owns the
// projects does the work: a popup is another copy of this mod.
function removeItem(menu, t, overlay, folder) {
  return menuItem(t, "sm-remove", wc("x", 13), menu.sure ? "Click again to remove" : "Remove from sidebar", (_e, cx) => {
    if (!menu.sure) { menu.sure = true; cx.notify(); return; }
    setShared("spaces.remove", { folder, at: Date.now() });
    closeOverlay(overlay);
  });
}

// Right-click on a kept project with no space: start in it, or take it off the list.
class FolderMenu {
  render() {
    const t = theme(), { overlay, folder } = props();
    return v_flex().id("folder-menu").w_full().p(4).gap(1).bg(t.popover)
      .child(menuItem(t, "fm-desk", wc("square-pen"), "New desk here", () => {
        closeOverlay(overlay);
        setShared("desk.start", { folder, at: Date.now() }); setShared("desk.route", null); showTerminals(false);
      }))
      .child(div().h(1).mx(6).my(3).bg(t.border))
      .child(removeItem(this, t, overlay, folder));
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
      .children(roles.map((r) => menuItem(t, `jm-${r.id}`, agentIcon(t, { role: r }, 16), r.name, join(r),
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
    if (props()?.folderMenu) { this.part = new FolderMenu(); return; }
    if (props()?.joinMenu) { this.part = new JoinMenu(); return; }
    if (props()?.top) { this.part = new Top(); return; }
    this.hoverRow = null;
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
    this.deskOpen = new Set(JSON.parse(localStorage.getItem("desks.open") ?? "[]")); // desks showing their members
    // Projects that stay listed with no terminals. Null until the first look seeds it from the desks.
    this.kept = JSON.parse(localStorage.getItem("projects.kept") ?? "null");
    this.closing = new Set(); // spaces being removed: not kept again on their way out
    this.removeAt = shared("spaces.remove")?.at ?? 0;
    // Done-and-unread: when each agent was last seen done-new (doneAt) and when Kabeer last looked at it
    // (seenAt). Herdr's own "done" lasts until the next turn and counts as seen only when the terminal is
    // focused, which the Desk chat never does, so the sidebar keeps its own read state.
    this.doneAt = JSON.parse(localStorage.getItem("agents.doneAt") ?? "{}");
    this.seenAt = JSON.parse(localStorage.getItem("agents.seenAt") ?? "{}");
    this.lastStatus = null;
    this.lastView = shared("desk.view") ?? null;
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
          next.set(slug, { name: head?.kind === "desk" ? head.name ?? slug : slug, project: head?.project ?? null, folder: head?.folder ?? null, at: Number(mtime) * 1000 });
        }
        const changed = [...next].some(([k, v]) => { const o = this.deskInfo.get(k); return !o || o.name !== v.name || o.at !== v.at || o.folder !== v.folder; });
        this.deskInfo = next;
        if (!this.kept) await this.seedKept(cx);
        if (changed) cx.notify();
      } catch {} finally { this.loadingDesks = false; }
    });
  }

  // The first look: every folder a desk ever ran in, deleted desks too.
  async seedKept(cx) {
    const r = await exec("sh", ["-c", SEED_SH, "seed", TEAM()]);
    let kept = [];
    for (const d of this.deskInfo.values()) kept = withKept(kept, d.folder, home());
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      try { kept = withKept(kept, JSON.parse(line).folder, home()); } catch {}
    }
    this.saveKept(kept);
    cx.notify();
  }

  saveKept(kept) {
    if (kept === this.kept) return;
    this.kept = kept;
    localStorage.setItem("projects.kept", JSON.stringify(kept));
  }

  // Remember every local project on screen.
  keepSeen(rows, synth) {
    if (!this.kept) return;
    let kept = this.kept;
    for (const r of rows) if (!r.w.machine && !r.tree && !r.g?.linked && !this.closing.has(r.w.id)) kept = withKept(kept, r.w.folder, home());
    for (const s of synth) kept = withKept(kept, s.folder, home());
    this.saveKept(kept);
  }

  // "Remove from sidebar": close the project's spaces and forget it. Its folder and desks stay.
  removeProject(folder, cx) {
    const ps = panes(), mine = spaces().filter((s) => !s.machine && (s.folder === folder || place(s, ps) === folder));
    const running = removeBlockers(folder, mine, agents(), terminals(), (slug) => this.deskInfo.get(slug)?.folder ?? null);
    if (running.length) return notify({ title: "Wrap up first", body: "This project still has agents running.", level: "warning", timeout: 4000 });
    for (const s of mine) { this.closing.add(s.id); run("space.close", { id: s.id }); }
    this.saveKept((this.kept ?? []).filter((f) => f !== folder));
    cx.notify();
  }

  checkNew(cx) {
    const now = Date.now();
    const remove = shared("spaces.remove");
    if (remove?.at && remove.at !== this.removeAt) { this.removeAt = remove.at; this.removeProject(remove.folder, cx); }
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (this.dirty?.size) {
      const repos = new Set([...this.dirty].map((r) => JSON.stringify([null, r])));
      this.dirty.clear();
      for (const k of Object.keys(this.git)) if (repos.has(this.git[k]?.repo)) due.add(k);
    }
    if (due.size) this.refreshGit(due, cx);
    if (this.trackSeen(now)) cx.notify();
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Notes when an agent turns done, and marks what Kabeer is looking at as seen: the open desk's
  // members in the chat, the open member route, or a focused terminal. True when a dot changes.
  trackSeen(now) {
    const all = agents();
    const first = this.lastStatus === null;
    const last = this.lastStatus ?? {};
    let changed = false, dirty = false;
    const next = {};
    for (const a of all) {
      next[a.address] = a.status;
      if (a.status === "done" && last[a.address] !== "done") {
        // On startup, a done agent counts as already read (no dot storm after a restart).
        if (first) { if (!this.doneAt[a.address]) { this.seenAt[a.address] = now; dirty = true; } }
        else { this.doneAt[a.address] = now; dirty = changed = true; }
      }
    }
    this.lastStatus = next;
    const unread = all.filter((a) => this.unread(a)).map((a) => a.address).sort();
    if (JSON.stringify(unread) !== JSON.stringify(shared("desk.unread") ?? null)) setShared("desk.unread", unread);
    if (window()?.active) {
      const looking = new Set();
      const route = shared("desk.route"), view = shared("desk.view");
      const labels = new Map(terminals().map((x) => [x.address, x.labels ?? {}]));
      if (chatView()) {
        if (route?.address) looking.add(route.address);
        else if (view) for (const a of all) if (labels.get(a.address)?.task === view) looking.add(a.address);
      } else for (const a of all) if (a.focused) looking.add(a.address);
      for (const addr of looking) {
        if (this.unread({ address: addr, status: next[addr] })) changed = true;
        if ((this.seenAt[addr] ?? 0) < now - 1000) { this.seenAt[addr] = now; dirty = true; }
      }
    }
    if (dirty) {
      const live = new Set(all.map((a) => a.address));
      for (const m of [this.doneAt, this.seenAt]) for (const k of Object.keys(m)) if (!live.has(k)) delete m[k];
      localStorage.setItem("agents.doneAt", JSON.stringify(this.doneAt));
      localStorage.setItem("agents.seenAt", JSON.stringify(this.seenAt));
    }
    return changed;
  }

  unread(a) { return a.status === "done" && (this.doneAt[a.address] ?? 0) > (this.seenAt[a.address] ?? 0); }
  // The status a row shows: done that's been read reads as idle.
  st(a) { return a.status === "done" && !this.unread(a) ? "idle" : a.status; }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    // Desks' own folders (a desk shows under its folder's project, whatever space it sits in).
    for (const d of this.deskInfo.values()) if (d.folder) keys.add(JSON.stringify([null, d.folder]));
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
    this.setDeskOpen(slug, true);
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
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 200, height: 190, props: { spaceMenu: true, space: w.id, folder: w.machine ? null : w.folder } });
  }

  joinMenu(a, name, desk) {
    const taken = new Set(desk.roles);
    const roles = [...this.roles.entries()].map(([id, r]) => ({ id, name: r.name, avatar: r.avatar }))
      .filter((r) => !(r.id === "cto" && taken.has("cto")));
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 220, height: 40 + roles.length * 29,
      props: { joinMenu: true, address: a.address, task: desk.slug, name, roles } });
  }

  setDeskOpen(slug, open) {
    if (this.deskOpen.has(slug) === open) return;
    open ? this.deskOpen.add(slug) : this.deskOpen.delete(slug);
    localStorage.setItem("desks.open", JSON.stringify([...this.deskOpen].slice(-200)));
  }

  toggleSpace(id) {
    this.closed.has(id) ? this.closed.delete(id) : this.closed.add(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.closed]));
  }

  // ── rows ───────────────────────────────────────────────────────────────────

  // Every row: full width, radius 7, no border. Selected is the one fill (t.selected); hover the
  // quieter t.hover.
  rowBase(t, id, { selected = false, pl = INSET, h = THREAD_H, tip } = {}) {
    return h_flex().id(id).relative().h(h).flex_none().pl(pl).pr(8).gap(8).items_center().rounded(RADIUS).cursor_pointer()
      .bg(selected ? t.selected : CLEAR)
      .when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .on_hover((h, cx) => {
        if (h) this.hoverRow = id; else if (this.hoverRow === id) this.hoverRow = null;
        cx.notify();
      });
  }

  // A small square control inside a row (fold, new desk, add to desk); stops the row's press.
  rowButton(t, id, iconEl, tip, onClick, on = false, size = 24) {
    return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(6)
      .text_color(on ? t.foreground : mutedFg(t)).hover((s) => s.text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); cx.notify(); })
      .child(iconEl);
  }

  // The status slot: working = spinner + "Working", blocked = pulsing mark + "Needs you" (mark only
  // when `word` is off), done-and-unread = a 6px dot, idle nothing. On hover the age takes the slot,
  // and a row's own actions (`tools`) take it from both.
  trailing(t, { status, at, tools = [], word = true, hovered = false }) {
    const slot = h_flex().h(24).min_w(16).flex_none().justify_end().items_center().gap(5);
    if (tools.length) return slot.gap(0).children(tools);
    if (hovered && at) return slot.text_size(11.5).text_color(t.dim).child(ago(at));
    if (status === "done") return slot.child(div().size(6).rounded(3).flex_none().bg(t.done));
    const state = STATE[status];
    if (!state) return slot;
    return slot.text_size(11.5).font_medium().text_color(t[state[1]] ?? t.dim)
      .child(statusMark(t, status, 11)).when(word && Boolean(state[0]), (el) => el.child(div().child(state[0])));
  }

  // The ring under a face's program badge: the row's own fill, so the badge reads as cut out.
  ring(t, selected) {
    return selected ? t.selected : t.chrome;
  }

  // The desk's other members as overlapping faces (15px, -5px overlap, a 1.5px ring in the
  // sidebar's colour), shown while the desk is folded.
  faceStack(t, members, selected) {
    const ring = this.ring(t, selected), box = STACK_FACE + 3, step = box - 5, shown = members.slice(0, 5);
    // Fixed width with absolutely placed faces: the overlap never leaks into the row's layout.
    return div().relative().flex_none().h(box).w(box + step * (shown.length - 1)).children(shown.map((k, i) => {
      const role = k.l.role ? this.roles.get(k.l.role) : null;
      const avatar = role?.avatar ?? (AVATARS.has(k.l.role) ? `avatars/${k.l.role}.png` : null);
      const inner = avatar ? image(`mods/desk/${avatar}`).size(STACK_FACE).flex_none().rounded_full()
        : programIcon(agentCli({ session: sessionOf(k.a.address), labels: k.l, agent: k.a, role }), STACK_FACE, t);
      return div().absolute().top(0).left(step * i).size(box).rounded_full().bg(ring).p(1.5).child(inner);
    }));
  }

  // Is this desk's row the selected one (its team chat shown, not one member's route)?
  deskSelected(slug, members) {
    const route = shared("desk.route");
    return chatView() && shared("desk.view") === slug && !(route?.address && route.task === slug && members > 1);
  }

  // A desk: its lead's face (the CTO, with its program badge), its title, then — folded with a
  // team — its other members' faces, then its state (mark only beside a face stack). Idle desks
  // recede unless selected. Clicking the selected desk folds or unfolds its members.
  deskRow(t, w, desk, x) {
    const id = `desk-${desk.slug}`, hovered = this.hoverRow === id;
    const selected = this.deskSelected(desk.slug, desk.members.length);
    const info = this.deskInfo.get(desk.slug);
    const others = desk.members.filter((k) => k !== desk.lead);
    const stack = others.length > 0 && !desk.open;
    const recede = !selected && desk.status === "idle";
    return [this.rowBase(t, id, { selected, pl: INSET + x, tip: desk.full })
      .on_click((_e, cx) => {
        if (selected && others.length) { this.setDeskOpen(desk.slug, !desk.open); cx.notify(); }
        else this.openDesk(w, desk.slug);
      })
      .child(this.face(t, desk.lead, FACE, selected))
      .child(div().min_w(0).flex_1().truncate().text_size(13).when(!recede, (el) => el.font_medium())
        .text_color(recede ? (hovered ? t.foreground : t.muted) : t.foreground).child(desk.title))
      .when(stack, (el) => el.child(this.faceStack(t, others, selected)))
      .child(this.trailing(t, { status: desk.status, at: info?.at, word: !stack, hovered }))];
  }

  // An agent's face: its role's avatar with its program's badge, else the program's mark.
  face(t, k, size, selected) {
    if (!k) return div().size(size).flex_none();
    const role = k.l.role ? this.roles.get(k.l.role) : null;
    const cli = agentCli({ session: sessionOf(k.a.address), labels: k.l, agent: k.a, role });
    return agentIcon(t, { role, cli, ring: this.ring(t, selected) }, size);
  }

  // What an agent is called: its role's name, else its tab's name or its program.
  agentName(k) {
    const { a, l } = k, role = l.role ? this.roles.get(l.role) : null;
    return role?.name ?? ((/^\d+$/.test(a.tab_name) ? a.title || a.program?.name : a.tab_name) || "Agent");
  }

  // Is this agent's own row the selected one (its route in the chat, its pane elsewhere)?
  agentSelected(a, member) {
    return member && chatView() ? shared("desk.route")?.address === a.address : Boolean(a.focused) && !chatView();
  }

  // A member of a desk with a team: under its unfolded desk, indented past a 1px guide line; its
  // face, role name, a dim one-line session title, and its state as a mark.
  memberRow(t, k, g, ps, { deskTitle = null, x = 0 } = {}) {
    const { a, l } = k;
    const session = sessionOf(a.address);
    const name = this.agentName(k);
    const title = session?.title && session.title !== deskTitle ? session.title : null;
    const id = `agent-${a.address}`, hovered = this.hoverRow === id;
    const selected = this.agentSelected(a, true);
    const pane = ps.find((p) => p.pane === a.pane);
    const branch = pane?.branch && g?.branch && pane.branch !== g.branch && offMain(pane.branch) ? pane.branch : null;
    const tip = [session?.title ? `${name} · ${session.title}` : name, branch].filter(Boolean).join(" · ");
    return [this.rowBase(t, id, { selected, pl: MEMBER_X + x, h: MEMBER_H, tip })
      .on_click(() => this.openMember(a, l))
      .child(div().absolute().left(GUIDE_X + x).top(0).bottom(0).w(1).bg(t.border))
      .child(this.face(t, k, MEMBER_FACE, selected))
      .child(h_flex().min_w(0).flex_1().gap(6).items_center().text_size(12.5)
        .child(div().flex_none().max_w(120).truncate().text_color(selected || hovered ? t.foreground : t.muted).child(name))
        .when(Boolean(title), (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_color(t.dim).child(title))))
      .child(this.trailing(t, { status: this.st(a), word: false }))];
  }

  // An agent outside any desk: a desk-like row of its own (its face and title), so nothing
  // disappears; on hover, "add to the desk".
  agentRow(t, k, g, ps, desk, { x = 0 } = {}) {
    const { a, l } = k;
    const session = sessionOf(a.address);
    const fallback = this.agentName(k);
    const id = `agent-${a.address}`, hovered = this.hoverRow === id;
    const selected = this.agentSelected(a, false);
    const pane = ps.find((p) => p.pane === a.pane);
    const branch = pane?.branch && g?.branch && pane.branch !== g.branch && offMain(pane.branch) ? pane.branch : null;
    const canJoin = desk && !a.space.includes("/");
    const name = session?.title || fallback;
    const tools = hovered && canJoin ? [this.rowButton(t, `${id}-join`, dk("plus", 12), "Add to the desk", () => this.joinMenu(a, name, desk))] : [];
    const tip = [session?.title ? `${fallback} · ${session.title}` : fallback, branch].filter(Boolean).join(" · ");
    const recede = !selected && this.st(a) === "idle";
    return [this.rowBase(t, id, { selected, pl: INSET + x, tip })
      .on_click(() => this.openMember(a, l))
      .when(Boolean(canJoin), (el) => el.on_mouse_down("right", () => this.joinMenu(a, name, desk)))
      .child(this.face(t, k, FACE, selected))
      .child(div().min_w(0).flex_1().truncate().text_size(13).when(!recede, (el) => el.font_medium())
        .text_color(recede ? (hovered ? t.foreground : t.muted) : t.foreground).child(name))
      .child(this.trailing(t, { status: this.st(a), tools }))];
  }

  // "Needs you": every blocked agent, any desk, pinned under search. Two lines: what it's asking
  // (the runtime's open permission/question/blocked report, else its session title, else
  // "Waiting for you"), then "Role · Desk". A click routes like its own row in the tree.
  needsYou(t, all, labels) {
    const blocked = all.filter((a) => a.status === "blocked");
    if (!blocked.length) return [];
    const byDesk = new Map();
    for (const a of all) {
      const l = labels.get(a.address) ?? {};
      if (l.role && l.task) (byDesk.get(l.task) ?? byDesk.set(l.task, []).get(l.task)).push({ a, l });
    }
    const asks = new Map();
    for (const item of runtime().attention ?? []) {
      if (!item.address || item.kind === "done" || !item.text || asks.has(item.address)) continue;
      asks.set(item.address, item.text);
    }
    const sp = spaces();
    const kids = this.held("__needs", blocked.map((a) => ({ a, l: labels.get(a.address) ?? {} })).sort((x, y) => x.a.seq - y.a.seq));
    const rows = kids.map((k) => {
      const { a, l } = k, inDesk = Boolean(l.role && l.task);
      const members = inDesk ? byDesk.get(l.task) ?? [k] : [];
      const lead = members.find((m) => m.l.role === "cto") ?? members[0];
      const asDesk = inDesk && (members.length < 2 || lead?.a.address === a.address);
      const session = sessionOf(a.address);
      const line1 = String(asks.get(a.address) ?? session?.title ?? "Waiting for you").split("\n").find((s) => s.trim())?.trim() || "Waiting for you";
      const where = inDesk ? this.deskTitle(l.task, members) : (sp.find((s) => s.id === a.space)?.name ?? "");
      const line2 = [this.agentName(k), where].filter(Boolean).join(" · ");
      const selected = asDesk ? this.deskSelected(l.task, members.length) : this.agentSelected(a, inDesk);
      const id = `need-${a.address}`;
      return this.rowBase(t, id, { selected, h: NEED_H, tip: line1 })
        .on_click(() => asDesk ? this.openDesk({ id: a.space }, l.task) : this.openMember(a, l))
        .child(this.face(t, k, NEED_FACE, selected))
        .child(v_flex().min_w(0).flex_1().gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(line1))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(line2)))
        .child(h_flex().flex_none().items_center().child(statusMark(t, "blocked", 11)));
    });
    return [
      h_flex().id("needs-head").h(26).mt(4).flex_none().px(10).gap(6).items_center().text_size(11.5).font_semibold().text_color(t.dim)
        .child(div().child("Needs you")).child(div().font_medium().child(String(rows.length))),
      v_flex().id("needs-list").flex_none().mt(2).mb(6).children(rows),
      div().id("needs-divider").h(1).flex_none().mx(8).mb(8).mt(2).bg(t.border),
    ];
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

  // Which project each desk shows under: its own record's folder (where `team` started it), not
  // the Herdr space its terminals happen to sit in. A desk whose folder no space matches gets a
  // project group of its own (`synth`), after the real spaces. Agents outside a desk stay with
  // their space. Returns, per real space and per synthesized folder, its desks and agents.
  plan(rows, all, labels, ps) {
    const bySpace = new Map(), synth = new Map(); // space id → slot; folder → slot
    const homeOf = new Map(); // folder → real row it belongs to
    // The folder a space was made in first (a stray terminal that cd'd elsewhere doesn't move it),
    // then where its first terminal is now.
    for (const pick of [(r) => r.w.folder, (r) => place(r.w, ps)])
      for (const r of rows) { const f = r.w.machine ? null : pick(r); if (f && !homeOf.has(f)) homeOf.set(f, r); }
    const deskMap = new Map();
    for (const r of rows) {
      const kids = this.held(r.w.id, spaceAgents(r.w, all, labels));
      const slot = { kids, desks: [], outside: kids.filter((k) => !(k.l.role && k.l.task)), joinTo: null };
      bySpace.set(r.w.id, slot);
      for (const k of kids) {
        if (!(k.l.role && k.l.task)) continue;
        let d = deskMap.get(k.l.task);
        if (!d) {
          deskMap.set(k.l.task, d = { slug: k.l.task, members: [] });
          const folder = r.w.machine ? null : this.deskInfo.get(d.slug)?.folder ?? null;
          const home = folder ? homeOf.get(folder) : r;
          if (home) bySpace.get(home.w.id)?.desks.push(d) ?? (d.pending = home);
          else {
            if (!synth.has(folder)) synth.set(folder, { folder, desks: [], outside: [], kids: [] });
            synth.get(folder).desks.push(d);
          }
        }
        d.members.push(k);
        slot.joinTo ??= d;
      }
    }
    // A desk headed for a space drawn later than its first member's.
    for (const d of deskMap.values()) if (d.pending) { bySpace.get(d.pending.w.id).desks.push(d); delete d.pending; }
    for (const d of deskMap.values()) {
      d.title = this.deskTitle(d.slug, d.members);
      d.full = this.deskInfo.get(d.slug)?.name ?? d.slug;
      d.status = mostUrgent(d.members.map((k) => this.st(k.a))) ?? "idle";
      d.roles = d.members.map((k) => k.l.role);
      d.lead = d.members.find((k) => k.l.role === "cto") ?? d.members[0];
      d.space = { id: d.lead.a.space };
      d.open = this.deskOpen.has(d.slug);
    }
    for (const s of synth.values()) s.kids = s.desks.flatMap((d) => d.members);
    // Kept projects with nothing running: their header stays, ready for a new desk.
    for (const f of this.kept ?? []) if (!homeOf.has(f) && !synth.has(f)) synth.set(f, { folder: f, desks: [], outside: [], kids: [] });
    return { bySpace, synth: [...synth.values()] };
  }

  // A project's name for a folder: its repo's name when it's in one, else the folder's name.
  folderName(folder) {
    const g = this.git[JSON.stringify([null, folder])];
    return g?.name ?? base(folder);
  }

  // The tree, under a quiet header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const all = agents(), labels = new Map(terminals().map((x) => [x.address, x.labels ?? {}])), ps = panes();
    const order = [];
    const plan = collapsed ? null : this.plan(rows, all, labels, ps);
    if (plan) this.keepSeen(rows, plan.synth);
    // The same project name for two folders: each header says which (its parent folder, dim).
    const titles = new Map();
    const titleOf = (r) => r.synth ? this.folderName(r.folder) : r.tree ? null : r.g?.name ?? (r.w.name === "~" ? "Home" : r.w.name);
    const folderOf = (r) => r.synth ? r.folder : place(r.w, ps);
    const synthRows = (plan?.synth ?? []).map((s) => ({ synth: true, folder: s.folder, key: `folder:${s.folder}`, slot: s }));
    for (const r of [...rows, ...synthRows]) {
      const name = titleOf(r), f = folderOf(r);
      if (!name || !f) continue;
      (titles.get(name) ?? titles.set(name, new Set()).get(name)).add(f);
    }
    const hint = (r) => {
      const name = titleOf(r), f = folderOf(r);
      return name && f && titles.get(name)?.size > 1 ? base(f.replace(/\/[^/]*\/?$/, "")) || "/" : null;
    };
    const draw = (r) => {
      if (collapsed) {
        const kids = this.held(r.w.id, spaceAgents(r.w, all, labels));
        order.push(...kids.map((k) => k.a.address));
        return [this.compact(r, t, kids)];
      }
      const slot = r.synth ? r.slot : plan.bySpace.get(r.w.id);
      const { desks, outside, joinTo } = slot;
      const shown = [...desks.flatMap((d) => d.members), ...outside];
      const shutKey = r.synth ? r.key : r.w.id;
      const shut = this.closed.has(shutKey);
      const info = { desks, shut, count: desks.length + outside.length, status: mostUrgent(shown.map((k) => this.st(k.a))), hint: hint(r) };
      const head = r.synth ? this.folderHeader(r, t, info) : this.header(r, t, info);
      if (shut) { order.push(...shown.map((k) => k.a.address)); return [head]; }
      const x = r.tree ? 16 : 0; // a worktree's rows sit under its own (indented) header
      const out = [head];
      for (const d of desks) {
        out.push(...this.deskRow(t, d.space, d, x));
        // Members show only for a desk with a team, unfolded: the lead is the desk row itself (its
        // team chat), so the rows under it are the others.
        for (const k of d.members) {
          order.push(k.a.address);
          if (d.members.length > 1 && d.open && k !== d.lead) out.push(...this.memberRow(t, k, r.g, ps, { deskTitle: d.title, x }));
        }
      }
      for (const k of outside) { order.push(k.a.address); out.push(...this.agentRow(t, k, r.g, ps, joinTo, { x })); }
      return out;
    };
    // A space and its worktree spaces are one group, with room above the next.
    const groups = (list) => {
      if (collapsed) return list.flatMap(draw);
      const chunks = [];
      for (const r of list) (r.tree && chunks.length ? chunks[chunks.length - 1] : chunks[chunks.push([]) - 1]).push(r);
      return chunks.map((c, ci) => v_flex().id(`group-${c[0].synth ? c[0].key : c[0].w.id}`).flex_none().when(ci > 0, (el) => el.mt(10)).children(c.flatMap(draw)));
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
    if (!remote.length) return finish(loading(null) && !rows.length ? [loadingRow(null)] : groups([...rows, ...synthRows]));
    const machineNames = [null, ...remote];
    return finish(machineNames.flatMap((m) => {
      const mine = [...rows.filter((r) => (r.w.machine ?? null) === m), ...(m === null ? synthRows : [])];
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
  header({ w, i, g, tree }, t, { desks, shut, status, count, hint }) {
    const id = `space-${w.id}`, hovered = this.hoverRow === id;
    const ps = panes();
    const title = tree ? (g?.branch ?? w.name) : g?.name ?? (w.name === "~" ? "Home" : w.name);
    const extra = !tree && w.named && g && w.name.toLowerCase() !== g.name.toLowerCase() ? w.name : null;
    const behind = [g?.ahead ? `↑${g.ahead}` : "", g?.behind ? `↓${g.behind}` : ""].join(" ").trim();
    const tip = [extra, place(w, ps), !tree && offMain(g?.branch) ? g.branch : null, behind].filter(Boolean).join(" · ");
    const fold = this.rowButton(t, `${id}-fold`, wc(`chevron-${shut ? "right" : "down"}`, 12), shut ? "Show its desks" : "Fold",
      () => this.toggleSpace(w.id), false, 20);
    const dot = shut ? DOT[status] : null;
    return this.rowBase(t, id, { pl: 10 + (tree ? 16 : 0), h: FOLDER_H, tip: tip || undefined })
      .pr(4).gap(8)
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
      .child(wc(tree ? "branch" : "folder", 14).text_color(t.muted))
      .child(this.headerTail(t, id, { title, hint, dot, shut, count, hovered, fold,
        onNew: () => this.newDeskHere(w.id), newTip: chatLayout() ? "New desk here" : "New terminal" }));
  }

  // A header's name (and, when two folders share it, its parent folder, dim), then the folded
  // dot and count, then on hover "new desk here" and the fold chevron.
  headerTail(t, id, { title, hint, dot, shut, count, hovered, fold, onNew, newTip }) {
    return h_flex().min_w(0).flex_1().gap(8).items_center()
      .child(h_flex().min_w(0).flex_1().gap(6).items_center()
        .child(div().min_w(0).flex_shrink_1().truncate().text_size(12).font_semibold().text_color(t.muted).child(title))
        .when(Boolean(hint), (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_size(12).text_color(t.dim).child(hint))))
      .when(Boolean(dot), (el) => el.child(div().size(6).rounded(3).flex_none().bg(t[dot])))
      .when(shut && count > 0, (el) => el.child(div().flex_none().text_size(12).font_medium().text_color(t.dim).child(String(count))))
      .when(hovered, (el) => el.child(this.rowButton(t, `${id}-new`, wc(chatLayout() ? "square-pen" : "plus", 13), newTip, onNew, false, 20)).child(fold))
      .when(!hovered, (el) => el.child(div().w(20).flex_none()));
  }

  // A project no Herdr space is in (a desk started in a folder whose terminals sit in another
  // space): the same header look, no drag (reorder is for real spaces), no space menu. "New desk
  // here" starts a desk in its folder; folding is kept by folder.
  folderHeader(r, t, { desks, shut, status, count, hint }) {
    const id = `folder-${r.folder}`, hovered = this.hoverRow === id;
    const fold = this.rowButton(t, `${id}-fold`, wc(`chevron-${shut ? "right" : "down"}`, 12), shut ? "Show its desks" : "Fold",
      () => this.toggleSpace(r.key), false, 20);
    const start = () => { setShared("desk.start", { folder: r.folder, at: Date.now() }); setShared("desk.route", null); showTerminals(false); };
    return this.rowBase(t, id, { pl: 10, h: FOLDER_H, tip: r.folder }).pr(4).gap(8)
      // Starting an agent spends tokens, so an empty project's row does nothing; its "+" starts one.
      .on_click(() => { if (desks[0]) this.openDesk(desks[0].space, desks[0].slug); })
      .on_mouse_down("right", () => openOverlay({ mod: "desk-spaces", kind: "popup", width: 200, height: 110, props: { folderMenu: true, folder: r.folder } }))
      .child(wc("folder", 14).text_color(t.muted))
      .child(this.headerTail(t, id, { title: this.folderName(r.folder), hint, dot: shut ? DOT[status] : null, shut, count, hovered, fold,
        onNew: start, newTip: "New desk here" }));
  }

  // The narrow rail: each space as its number and mark.
  compact({ w, i }, t, kids) {
    const status = mostUrgent(kids.map((k) => this.st(k.a))) ?? w.status;
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
    // The header row: a search field (the picker) and one "new desk" compose button.
    const search = h_flex().id("search").h(30).flex_1().min_w(0).px(10).gap(8).items_center().rounded(8).cursor_pointer()
      .border_1().border_color(t.border).bg(t.background).text_color(t.dim).hover((s) => s.text_color(t.muted))
      .on_click(() => run("mod.open", { name: "picker" }))
      .child(wc("search", 13)).child(div().flex_1().truncate().text_size(13).child("Search"));
    const compose = h_flex().id("new-desk").size(30).flex_none().items_center().justify_center().rounded(8)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(chat ? "New desk" : "New terminal")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.newDeskHere(null))
      .child(wc(chat ? "square-pen" : "plus", 15));
    const head = h_flex().flex_none().h(44).pl(12).pr(10).gap(6).items_center().child(search).child(compose);
    // Selecting a desk (from anywhere: this list, the chat, a toast) unfolds it.
    const view = shared("desk.view") ?? null;
    if (view !== this.lastView) { this.lastView = view; if (view && view !== "new") this.setDeskOpen(view, true); }
    const needs = collapsed ? [] : this.needsYou(t, agents(), new Map(terminals().map((x) => [x.address, x.labels ?? {}])));
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .when(!collapsed, (el) => el.child(head))
      .when(collapsed, (el) => el.child(h_flex().flex_none().h(34).justify_center()
        .child(this.rowButton(t, "unfold", wc("sidebar", 14), "Show the sidebar", () => toggleSidebar()))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(collapsed ? 8 : 6).pt(4).pb(12).overflow_y_scrollbar()
        .on_hover((inside, cx) => { this.pointerIn = inside; if (!inside) { this.hoverRow = null; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children([...needs, ...this.grouped(t, collapsed)]));
  }
}
