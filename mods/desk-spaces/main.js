// Workspace spaces: stable colored avatars, worktrees under their checkout, grouped by
// machine when more than one is known. Each row is one 28px line: the repo its first terminal
// is in now (a name you gave the space after it), its branch only when it's off main,
// ahead/behind only when non-zero, and the Desk's status mark. Its agents hang under it, named
// by their session's title when the runtime has one; Settle / Snooze on hover put a finished
// one on the space's Settled shelf. Rows never re-sort under the pointer. Click to switch,
// right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, pickFolder, exec, hc, theme, shared, setShared, watchFolder, window, layout, agents, terminals, setAgentOrder, readTextFile, appHome, notify } from "herdr";

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

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = () => 28;
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

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
const offMain = (branch) => Boolean(branch) && !["main", "master", "trunk", "HEAD"].includes(branch);

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
function showTerminals(on) {
  if (!chatLayout()) return;
  setShared("deskchat.terminals", on);
  run("layout.select", { stack: "center", child: on ? "main" : "chat" });
  run(on ? "layout.show" : "layout.hide", { id: "tabs" });
}

// Agents in a space, desk members first (CTO first), then by who needs you. `labels` are their
// terminals' (role=, task= from bin/team); `roles` is mods/desk/roles.json's list by id.
const RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
function spaceAgents(w, all, labels) {
  return all.filter((a) => a.space === w.id).map((a) => ({ a, l: labels.get(a.address) ?? {} }))
    .sort((x, y) => (x.l.role ? 0 : 1) - (y.l.role ? 0 : 1) || (x.l.role === "cto" ? -1 : y.l.role === "cto" ? 1 : 0)
      || (RANK[x.a.status] ?? 9) - (RANK[y.a.status] ?? 9) || x.a.seq - y.a.seq);
}

// The Desk's role tile (mods/desk/roles.js roleTile): its avatar, else its initial on its color.
function roleTile(t, role, size, dim) {
  const color = t[role.color] ?? role.color ?? t.accent;
  if (role.avatar && !role.icon) return div().size(size).flex_none().rounded(size / 2).overflow_hidden().bg(color + "26")
    .when(dim, (el) => el.opacity(0.55)).child(image(`mods/desk/${role.avatar}`).size(size));
  return h_flex().size(size).flex_none().rounded(5).items_center().justify_center().bg(color + "26").text_color(color)
    .text_size(Math.round(size * 0.5)).font_semibold().when(dim, el => el.opacity(.55))
    .child(role.icon ? svg(`mods/desk/icons/${role.icon}.svg`).size(Math.round(size * .6)).flex_none() : role.name[0].toUpperCase());
}

// Right-click on a space: the ways in (its terminals, a new one, a new desk), then Herdr's own
// space menu (rename, worktrees, close) under More.
class SpaceMenu {
  render() {
    const t = theme(), { overlay, space } = props(), chat = chatLayout();
    const go = (fn) => () => { closeOverlay(overlay); run("space.select", { id: space }); fn(); };
    const item = (id, iconName, label, onClick) => h_flex().id(id).h(30).px(10).gap(9).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick)
      .child(svg(`mods/desk/icons/${iconName}.svg`).size(14).flex_none().text_color(t.muted)).child(label);
    return v_flex().id("space-menu").w_full().p(4).gap(1).bg(t.popover)
      .child(item("sm-terms", "terminal", chat ? "Show its terminals" : "Open", go(() => showTerminals(true))))
      .child(item("sm-new-term", "plus", "New terminal", go(() => { showTerminals(true); run("tab.new", { space }); })))
      .when(chat, (el) => el.child(item("sm-desk", "team", "New desk here", go(() => {
        setShared("desk.here", { space, at: Date.now() }); setShared("desk.view", "new"); showTerminals(false);
      }))))
      .child(div().h(1).mx(6).my(3).bg(t.border))
      .child(item("sm-more", "chevron", "More…", () => {
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
      .child(div().px(10).pt(6).pb(5).text_size(11.5).text_color(t.dim).truncate().child(`Add ${name} to the desk as`))
      .children(roles.map((r) => h_flex().id(`jm-${r.id}`).h(30).px(10).gap(9).items_center().rounded(6).cursor_pointer()
        .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(join(r))
        .child(roleTile(t, r, 18, false))
        .child(div().flex_1().child(r.name))
        .when(this.busy === r.id, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().spin(900)))));
  }
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.spaceMenu) { this.part = new SpaceMenu(); return; }
    if (props()?.joinMenu) { this.part = new JoinMenu(); return; }
    this.hoverAgent = null;
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
    this.roles = new Map(); // role id → { name, avatar, color }, from the Desk's roles.json
    this.rolesRaw = null;
    this.loadRoles(cx);
    cx.timer.every(5000, (cx) => this.loadRoles(cx));
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

  // Switch to the space. In desk-chat's chat view, also open its desk (the one its agents are
  // in), else the new-desk page aimed at it. In the terminal view a click only switches.
  pick(w) {
    run("space.select", { id: w.id });
    if (!chatLayout() || shared("deskchat.terminals")) return;
    const labels = new Map(terminals().map((x) => [x.address, x.labels ?? {}]));
    const desk = spaceAgents(w, agents(), labels).find((x) => x.l.task)?.l.task;
    if (desk) return setShared("desk.view", desk);
    setShared("desk.here", { space: w.id, at: Date.now() });
    setShared("desk.view", "new");
  }

  // An agent under its space: in the chat view its desk's chat, else (or with no desk) its terminal.
  openAgent(a, l) {
    if (l.task && chatLayout() && !shared("deskchat.terminals")) {
      run("space.select", { id: a.space });
      return setShared("desk.view", l.task);
    }
    showTerminals(true);
    run("pane.focus", { pane: a.pane });
  }

  // One agent under its space, aligned with the space's title. A desk member: its role's avatar
  // and name. An agent outside the desk: plain, with "Add to desk" on hover when the space has one.
  agentRow({ a, l }, g, ps, t, desk, put = false) {
    const role = l.role ? this.roles.get(l.role) : null;
    const member = Boolean(role && l.task);
    const pane = ps.find((p) => p.pane === a.pane);
    const branch = pane?.branch && g?.branch && pane.branch !== g.branch ? pane.branch : null;
    const session = sessionOf(a.address);
    const fallback = role?.name ?? ((/^\d+$/.test(a.tab_name) ? a.title || a.program?.name : a.tab_name) || "Agent");
    const name = session?.title || fallback;
    const idle = a.status === "idle" || put;
    const id = `agent-${a.address}`, hovered = this.hoverAgent === id;
    // Focus only means something where terminals show; there it's a raised row in the group.
    const focused = a.focused && (!chatLayout() || shared("deskchat.terminals"));
    const tint = this.groupOn ? t.accent + "12" : t.hover, sub = this.groupOn ? t.muted : t.dim;
    const canJoin = !member && desk && !a.space.includes("/");
    const triageIcon = (key, file, tip, onClick) => div().id(`${id}-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(this.snoozing === id && key === "snooze" ? t.accent : sub).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`mods/desk/icons/${file}.svg`).size(12));
    const triageable = Boolean(session) && triageOn() && !["working", "blocked"].includes(a.status);
    const tools = hovered && triageable ? h_flex().flex_none().gap(1).children(put
      ? [triageIcon("back", "back", "Bring it back", (cx) => triage(cx, "unsettle", a.address))]
      : [triageIcon("settle", "check", "Settle: put it away until it has new work", (cx) => triage(cx, "settle", a.address)),
         triageIcon("snooze", "clock", "Snooze", (cx) => { this.snoozing = this.snoozing === id ? null : id; cx.notify(); })]) : null;
    const add = canJoin && hovered ? h_flex().id(`${id}-join`).flex_none().h(20).px(7).items_center().rounded(10)
      .text_size(11).font_medium().text_color(t.accent).bg(t.accent + "14").hover((s) => s.bg(t.accent + "26"))
      .on_click((_e, cx) => { cx.stop_propagation(); this.joinMenu(a, name, desk); }).child("Add to desk") : null;
    const row = h_flex().id(id).h(28).flex_none().pl(37).pr(6).gap(8).items_center().rounded(8).cursor_pointer()
      .tooltip(session?.title ? `${fallback} · ${session.title}` : fallback)
      .when(focused, (el) => el.bg(t.chrome).border_1().border_color(t.border))
      .when(!focused, (el) => el.hover((s) => s.bg(tint)))
      .on_hover((h, cx) => { if (h) this.hoverAgent = id; else if (this.hoverAgent === id) this.hoverAgent = null; cx.notify(); })
      .on_click(() => this.openAgent(a, l))
      .when(canJoin, (el) => el.on_mouse_down("right", () => this.joinMenu(a, name, desk)))
      .child(member ? roleTile(t, role, 16, idle)
        : h_flex().size(16).flex_none().items_center().justify_center().child(svg("mods/desk/icons/terminal.svg").size(12).text_color(sub)))
      .child(div().min_w(0).flex_shrink_1().truncate().text_size(12.5)
        .text_color(member ? (idle ? t.muted : t.foreground) : t.muted).child(name))
      .when(Boolean(branch) && offMain(branch), (el) => el.child(h_flex().min_w(0).flex_shrink_1().gap(3).items_center().text_size(11).text_color(sub)
        .child(svg("mods/workspace-chrome/branch.svg").size(10).flex_none()).child(div().min_w(0).truncate().child(branch))))
      .child(div().flex_1())
      .child(add ?? tools ?? h_flex().w(16).flex_none().justify_center().child(statusMark(t, a.status, 12)));
    if (this.snoozing !== id || !triageable || put) return [row];
    return [row, h_flex().id(`${id}-times`).h(28).flex_none().pl(37).pr(6).gap(4).items_center()
      .children(snoozeOptions().map((o) => div().id(`${id}-snz-${o.id}`).h(22).px(7).flex().items_center().rounded(6).cursor_pointer()
        .border_1().border_color(t.border).text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); this.snoozing = null; triage(cx, "snooze", a.address, o.until); }).child(o.label)))];
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

  joinMenu(a, name, desk) {
    const taken = new Set(desk.roles);
    const roles = [...this.roles.entries()].map(([id, r]) => ({ id, name: r.name, avatar: r.avatar, color: r.color }))
      .filter((r) => !(r.id === "cto" && taken.has("cto")));
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 230, height: 40 + roles.length * 31,
      props: { joinMenu: true, address: a.address, task: desk.slug, name, roles } });
  }

  // A new session in desk-chat: pick a folder and the main chat starts a desk there with the CTO
  // (team opens its space, or reuses the folder's). Other machines and layouts get a plain space.
  newSession(m, cx) {
    if (m || !chatLayout()) return run("space.new", m ? { machine: m } : {});
    cx.spawn(async () => {
      const folder = await pickFolder({ prompt: "Choose a folder for a new desk" });
      if (!folder) return;
      setShared("desk.start", { folder, at: Date.now() });
      showTerminals(false);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "desk-spaces", kind: "popup", width: 200, height: 160, props: { spaceMenu: true, space: w.id } });
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
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const all = agents(), labels = new Map(terminals().map((x) => [x.address, x.labels ?? {}])), ps = panes();
    const order = [];
    // A space and the worktree spaces under it are one group: a container that fills when one of
    // them is active, each space's agents hanging off a hairline under its avatar.
    const draw = (r) => {
      const kids = this.held(r.w.id, spaceAgents(r.w, all, labels));
      order.push(...kids.map((k) => k.a.address));
      if (collapsed) return [this.compact(r, t)];
      const shelf = kids.filter((k) => putAway(sessionOf(k.a.address), k.a.status));
      const live = kids.filter((k) => !shelf.includes(k));
      const members = live.filter((k) => k.l.role && k.l.task), outside = live.filter((k) => !(k.l.role && k.l.task));
      // The space's desk (its members' task), so an outside agent can be added to it.
      const desk = members.length ? { slug: members[0].l.task, roles: members.map((k) => k.l.role) } : null;
      const divider = div().pl(37).pt(4).h(22).flex_none().text_size(10.5).text_color(this.groupOn ? t.muted : t.dim).child("Not in a desk");
      const open = this.shelves.has(r.w.id);
      const shelfRow = h_flex().id(`shelf-${r.w.id}`).h(24).flex_none().pl(37).pr(6).gap(5).items_center().rounded(8).cursor_pointer()
        .text_size(11).text_color(this.groupOn ? t.muted : t.dim).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { open ? this.shelves.delete(r.w.id) : this.shelves.add(r.w.id); cx.notify(); })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none()).child(`Settled · ${shelf.length}`);
      return [this.row({ ...r, kids: kids.length }, t),
        ...members.flatMap((k) => this.agentRow(k, r.g, ps, t, desk)),
        ...(desk && outside.length ? [divider] : []),
        ...outside.flatMap((k) => this.agentRow(k, r.g, ps, t, desk)),
        ...(shelf.length ? [shelfRow] : []),
        ...(shelf.length && open ? shelf.flatMap((k) => this.agentRow(k, r.g, ps, t, desk, true)) : [])];
    };
    const groups = (list) => {
      if (collapsed) return list.flatMap(draw);
      const chunks = [];
      for (const r of list) (r.tree && chunks.length ? chunks[chunks.length - 1] : chunks[chunks.push([]) - 1]).push(r);
      return chunks.map((c) => {
        const on = c.some((r) => r.w.active);
        this.groupOn = on;
        return v_flex().id(`group-${c[0].w.id}`).flex_none().p(3).rounded(10)
          .when(on, (el) => el.bg(t.selected))
          .children(c.flatMap(draw));
      });
    };
    // Keyboard order follows the list (Herdr's next/previous agent).
    const finish = (list) => { setAgentOrder(order); return list; };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return finish(loading(null) && !rows.length ? [loadingRow(null)] : groups(rows));
    const machineNames = [null, ...remote];
    return finish(machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.newSession(m, cx); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.newSession(m, cx))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? groups(mine) : [loading(m) ? loadingRow(m) : empty])];
    }));
  }

  // Beside the title: the branch when it's off main (else, with no repo, the folder), then ahead/behind.
  subline(g, w, t) {
    const dim = this.groupOn ? t.muted : t.dim; // on the active group's tint, a step darker
    if (!g) return div().min_w(0).flex_shrink_1().truncate().text_size(11).text_color(dim).child(base(place(w, panes()) ?? "") || "~");
    return h_flex().min_w(0).flex_shrink_1().gap(4).items_center().text_size(11).text_color(dim)
      .when(offMain(g.branch ?? "detached"), (el) => el.child(svg("mods/workspace-chrome/branch.svg").size(10).flex_none())
        .child(div().min_w(0).truncate().child(g.branch ?? "detached")))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, kids = 0 }, t) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    const tint = this.groupOn ? t.accent + "12" : t.hover; // hover, on the group's own surface
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .hover((s) => s.bg(tint))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) this.pick(w);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(tree ? this.worktreeLine(w, g, t, kids) : this.spaceLines(w, g, fill, t, kids));
  }

  // A space: its repo (else its name), and a name you gave it when that says something else.
  // Its agents are listed under it, so the space's own mark only shows when it has none.
  spaceLines(w, g, fill, t, kids) {
    const title = g?.name ?? (w.name === "~" ? "Home" : w.name);
    const extra = w.named && g && w.name.toLowerCase() !== g.name.toLowerCase() ? w.name : null;
    return h_flex().gap(8).items_center()
      .child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10).font_bold().text_color("#ffffff")
        .child([...title][0]?.toUpperCase() ?? "?"))
      .child(div().min_w(0).flex_shrink_1().truncate().text_size(13).font_medium().text_color(t.foreground).child(title))
      .when(Boolean(extra), (el) => el.child(div().min_w(0).flex_shrink_1().truncate().text_size(11).text_color(this.groupOn ? t.muted : t.dim).child(extra)))
      .when(Boolean(g) || (base(place(w, panes()) ?? "") || "~") !== title, (el) => el.child(this.subline(g, w, t)))
      .child(div().flex_1())
      .when(!kids && w.status && w.status !== "idle", (el) => el.child(h_flex().w(16).flex_none().justify_center().child(statusMark(t, w.status, 12))));
  }

  // A worktree under its repo: its branch, ahead/behind, its status.
  worktreeLine(w, g, t, kids) {
    return h_flex().pl(26).gap(6).items_center()
      .child(svg("mods/workspace-chrome/branch.svg").size(11).flex_none().text_color(this.groupOn ? t.muted : t.dim))
      .child(div().min_w(0).flex_1().truncate().text_size(12.5).text_color(t.foreground).child(g?.branch ?? w.name))
      .when((g?.ahead ?? 0) > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when((g?.behind ?? 0) > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`\u2193${g.behind}`)))
      .when(!kids && w.status && w.status !== "idle", (el) => el.child(h_flex().w(16).flex_none().justify_center().child(statusMark(t, w.status, 12))));
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.pick(w))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(statusMark(t, w.status, 10));
  }

  render() {
    if (this.part) return this.part.render();
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(34).pl(19).pr(11).items_center().justify_between().text_size(11.5).font_medium().text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(chatLayout() ? "New desk: pick a folder" : "New space")
          .on_click((_e, cx) => this.newSession(null, cx)).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().id("spaces-list").flex_1().min_h(0).px(8).pb(14).gap(4).overflow_y_scrollbar().mode("always")
        .on_hover((inside, cx) => { this.pointerIn = inside; if (!inside) { this.snoozing = null; cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
