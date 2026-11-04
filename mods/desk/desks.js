import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, InputState, Input, TextView } from "gpui-base";
import { terminals, agents, panes, spaces, exec, home, appHome, readTextFile, watchFolder, notify, run, shared, setShared, hc } from "herdr";
import { pill, button, empty, icon } from "./ui.js";
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
  finish: ["wrapped up", "dim"], ask: ["asks", "accent"], answer: ["answers", "done"], route: ["passes on", "accent"] };
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

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
  constructor(panel, cx, { fixed = null, toasts = false } = {}) {
    this.panel = panel;
    this.fixed = fixed;
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
        if (before === undefined || d.n <= before || (d.slug === this.view && shared("desk.tab") === "desks")) continue;
        for (const m of parse(await readTextFile(`${DIR()}/${d.slug}.jsonl`)).slice(before)) {
          if (m.from !== "kabeer" && (m.kind === "say" || m.kind === "flag")) {
            notify({ title: `${this.roles.byId(m.from)?.name ?? m.from} · ${d.name}`, body: m.text.slice(0, 160), level: m.kind === "flag" ? "warning" : "info", timeout: 6000 });
          }
        }
      }
      this.counts = Object.fromEntries(desks.map((d) => [d.slug, d.n]));
      this.desks = desks;
      const open = this.desk();
      this.messages = open ? parse(await readTextFile(`${DIR()}/${open.slug}.jsonl`)) : [];
      if (open && (shared("desk.tab") === "desks" || this.fixed)) this.markRead(open.slug);
      this.publish();
    } catch { this.messages = []; }
    cx.notify();
  }

  // A desk's live agents, parents before their children.
  members(slug = this.view) {
    const status = new Map(agents().map((a) => [a.address, a.status]));
    const live = terminals().filter((t) => t.state === "live" && t.labels?.task === slug && t.labels?.role)
      .map((t) => ({ address: t.address, role: t.labels.role, parent: t.parent, status: status.get(t.address) ?? t.status?.state ?? t.status ?? null,
        phase: t.labels.phase, note: t.labels.note, awaiting: t.labels.awaiting ?? null, space: t.labels["herdr.space"], cwd: t.cwd, created: t.created_ms ?? 0 }));
    const addrs = new Set(live.map((m) => m.address));
    const depth = (m) => (m.parent && addrs.has(m.parent) ? 1 + depth(live.find((x) => x.address === m.parent)) : 0);
    return live.map((m) => ({ ...m, depth: depth(m) }))
      .sort((a, b) => (a.role === "cto" ? -1 : b.role === "cto" ? 1 : a.depth - b.depth || a.created - b.created));
  }

  scanBriefs(cx) {
    const d = this.desk();
    if (!d?.folder) { this.briefs = []; return; }
    cx.spawn(async (cx) => {
      try { this.briefs = (await findBriefs([d.folder])).filter((b) => b.desk === d.slug); } catch { this.briefs = []; }
      cx.notify();
    });
  }

  // Where a desk's agents start: its project's space, else the space you're in.
  spaceFor(folder) {
    const project = this.panel?.projects?.().find((p) => folder && (folder === p.folder || folder.startsWith(p.folder + "/")));
    return (project && this.panel.spaceFor(project)) || spaces().find((s) => !s.machine && folder && (folderOf(s) ?? "").startsWith(folder)) || null;
  }

  async addMember(role, d, task) {
    const space = this.spaceFor(d.folder);
    // With a CTO in the desk, newcomers report to it (and it can wait on them).
    const cto = role.id !== "cto" && this.members(d.slug).find((m) => m.role === "cto");
    const args = [role.id, "--repo", d.folder ?? home(), "--slug", d.slug, ...(cto ? ["--parent", cto.address] : ["--no-parent"]), "--requested"];
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
    const project = this.newTarget && this.panel?.projects?.().find((p) => p.name === this.newTarget);
    const folder = project?.folder ?? folderOf(spaces().find((s) => s.active));
    const other = folder && this.desks.find((d) => d.folder && (folder.startsWith(d.folder) || d.folder.startsWith(folder)) && this.members(d.slug).length);
    return other?.name ?? null;
  }

  createDesk(cx) {
    const name = this.newName.value().trim(), task = this.newTask.value().trim();
    const project = this.newTarget && this.panel?.projects?.().find((p) => p.name === this.newTarget);
    const folder = project?.folder ?? folderOf(spaces().find((s) => s.active)) ?? home();
    const chosen = (this.roles.list ?? []).filter((r) => this.newRoles.has(r.id));
    if (!chosen.length) return notify({ title: "Pick who joins", body: "Choose at least one role for the desk.", level: "warning", timeout: 4000 });
    this.busy("new", async () => {
      const r = await exec(TEAM(), ["new-desk", "--repo", folder, ...(name || task ? ["--name", name || task.split(/\s+/).slice(0, 6).join(" ")] : [])]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
      const desk = { ...JSON.parse(r.stdout), folder };
      const lead = chosen.find((c) => c.id === "cto");
      for (const role of chosen) await this.addMember(role, desk, task && (!lead || role === lead) ? task : undefined);
      this.newName.set_value(""); this.newTask.set_value("");
      setShared("desk.view", desk.slug);
    }, cx);
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
    const projects = this.panel?.projects?.() ?? [];
    const roles = this.roles.list ?? [];
    return v_flex().id("desk-new-form").size_full().min_h(0).overflow_y_scrollbar().px(14).pb(14)
      .child(h_flex().pt(10).pb(4).gap(6).items_center()
        .child(button(t, "new-back", null, (_e, cx) => this.go("list", cx), { iconName: "back", tip: "All desks" }))
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("New desk")))
      .child(label("NAME"))
      .child(Input.new(this.newName).h(34).px(10).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(label("PROJECT"))
      .child(h_flex().gap(5).flex_wrap()
        .child(this.chip(t, "np-here", this.newTarget === null, `Current${current ? ` · ${current.name}` : ""}`, (_e, cx) => { this.newTarget = null; store.set("desks.target", null); cx.notify(); }))
        .children(projects.map((p) => this.chip(t, `np-${p.name}`, this.newTarget === p.name, p.name, (_e, cx) => { this.newTarget = p.name; store.set("desks.target", p.name); cx.notify(); }))))
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

  message(t, m, i) {
    const id = `msg-${i}`;
    if (m.kind === "desk" || m.kind === "start") {
      const who = m.from === "kabeer" ? "You" : this.roles.byId(m.from)?.name ?? m.from;
      const text = m.kind === "desk" ? `${who} started this desk${m.project ? ` in ${m.project}` : ""}` : `${who}: ${m.text}`;
      return h_flex().id(id).justify_center().py(4).child(div().px(10).py(3).rounded(10).bg(t.raised).text_size(11).text_color(t.dim).child(`${text} · ${clock(m.at)}`));
    }
    if (m.from === "kabeer") {
      const to = (m.to ?? []).map((r) => this.roles.byId(r)?.name ?? r).join(", ");
      return v_flex().id(id).items_end().gap(3).py(5).pl(40)
        .child(h_flex().gap(4).items_center().text_size(11).text_color(t.dim).child(`You → ${to} · ${clock(m.at)}`)
          .when(Boolean(m.delivered?.length && !m.failed?.length), (el) => el.child(icon("check", 12).text_color(t.done))))
        .child(div().max_w_full().px(11).py(7).rounded(12).bg(t.accent + "26").text_size(12.5).line_height(1.45).text_color(t.foreground)
          .child(TextView.markdown(`${id}-md`, m.text).selectable(true)))
        .when(Boolean(m.failed?.length), (el) => el.child(div().text_size(11).text_color(t.blocked)
          .child(`Not delivered: ${m.failed.map((f) => `${this.roles.byId(f.role)?.name ?? f.role} (${f.why})`).join("; ")}`)));
    }
    const role = this.roles.byId(m.from), kind = KIND[m.kind];
    const to = m.to?.length ? `→ ${m.to.map((r) => (r === "kabeer" ? "You" : this.roles.byId(r)?.name ?? r)).join(", ")}` : null;
    return h_flex().id(id).items_start().gap(9).py(5).pr(28)
      .child(role ? roleTile(div, svg, t, role, 26) : div().size(26).flex_none().rounded(7).bg(t.raised))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(role?.name ?? m.from))
          .when(Boolean(to), (el) => el.child(div().text_size(11).text_color(t.muted).child(to)))
          .when(Boolean(kind), (el) => el.child(pill(t, kind[0], t[kind[1]] ?? t.accent)))
          .child(div().text_size(11).text_color(t.dim).child(clock(m.at))))
        .child(div().max_w_full().px(11).py(7).rounded(12).bg(kind ? (t[kind[1]] ?? t.accent) + "14" : to ? "#00000000" : t.raised)
          .when(Boolean(to), (el) => el.border_1().border_color(t.border))
          .text_size(12.5).line_height(1.45).text_color(t.foreground).child(TextView.markdown(`${id}-md`, m.text).selectable(true))));
  }

  // Three dots breathing out of step (native loops, so no re-render drives them).
  dots(t) {
    return h_flex().gap(4).items_center().children([820, 960, 1100].map((period) =>
      div().size(6).rounded(3).bg(t.muted).loop("opacity", { from: 0.25, to: 1, period })));
  }

  // At the bottom of the thread, like typing dots: who's working right now. "Replying" while
  // they owe the chat a reply (bin/team labels them awaiting=… until their turn ends).
  activity(t, members) {
    return members.filter((m) => m.status === "working" || m.status === "blocked").map((m) => {
      const role = this.roles.byId(m.role), name = role?.name ?? m.role, id = `act-${m.address}`;
      const blocked = m.status === "blocked";
      const replying = !blocked && Boolean(m.awaiting);
      const caption = blocked ? `${name} needs you in its terminal` : replying ? `${name} is replying…` : `${name} is working${m.note ? ` · ${m.note}` : "…"}`;
      return h_flex().id(id).items_center().gap(9).py(4)
        .child(this.avatar(t, role, null, 26))
        .child(h_flex().h(30).px(12).gap(8).items_center().rounded(15).bg(blocked ? t.blocked + "1f" : t.raised)
          .child(blocked ? icon("alert", 14).text_color(t.blocked) : this.dots(t)))
        .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(blocked ? t.blocked : t.dim).child(caption))
        .when(blocked, (el) => el.child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: m.address }), { tip: "Jump to its terminal" })));
    });
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
        .child(div().text_size(11).text_color(t[m.status] ?? t.dim).child(STATUS[m.status] ?? "")))
      .when(Boolean(m.note), (el) => el.child(div().pl(30).text_size(11.5).line_height(1.35).text_color(t.muted).child(m.note)))
      .child(h_flex().pl(30).gap(6).flex_wrap()
        .child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: m.address })))
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
        .when(!this.fixed, (el) => el.child(button(t, "desk-pane", null, () => run("pane.split", { direction: "right", mod: "desk", props: { chat: true, task: d.slug } }), { iconName: "pane", tip: "Open beside your terminals" })))
        .when(members.length > 0, (el) => el.child(button(t, "desk-wrap", this.acting === "wrap" ? "Wrapping up…" : "Wrap up", (_e, cx) => this.wrapUp(d, cx),
          { disabled: Boolean(this.acting), tip: "Each agent: flags anything left locally, or cleans up its worktree and closes" })))
        .when(!members.length, (el) => el.child(button(t, "desk-del", deleting ? "Delete?" : null, (_e, cx) => this.deleteDesk(d, cx),
          { iconName: "trash", tip: deleting ? "Click again to delete (kept in ~/.herdr/team/.deleted)" : "Delete this desk" }))))
      // Who's here: click to jump to them; + to bring someone in.
      .child(h_flex().gap(5).flex_wrap().items_center()
        .children(members.map((m) => {
          const role = this.roles.byId(m.role);
          return h_flex().id(`mem-${m.address}`).h(28).pl(3).pr(9).gap(6).items_center().rounded(14).cursor_pointer().flex_none()
            .bg(t.raised).hover((s) => s.bg(t.hover)).tooltip(`${role?.name ?? m.role}: ${STATUS[m.status] ?? "starting"}${m.note ? ` · ${m.note}` : ""}`)
            .on_click(() => run("agent.focus", { terminal: m.address }))
            .child(this.avatar(t, role, m.status, 22))
            .child(div().text_size(11.5).text_color(t.foreground).child(role?.name ?? m.role));
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

    const thread = v_flex().id("desk-thread").flex_1().min_h(0).px(12).py(8).overflow_y_scrollbar().flex_col_reverse()
      .children([...this.activity(t, members).reverse(), ...this.messages.map((m, i) => this.message(t, m, i)).reverse()]);

    const sugg = this.suggestions();
    const composer = v_flex().px(12).pt(6).pb(10).gap(6).border_t(1).border_color(t.border)
      .when(sugg.length > 0, (el) => el.child(h_flex().gap(5).flex_wrap()
        .children(sugg.map((o, i) => this.chip(t, `sg-${o.id}`, i === 0, o.name, (_e, cx) => this.pickMention(o, cx),
          o.id === "all" ? icon("team", 13) : roleTile(div, svg, t, o, 16))))))
      .child(Textarea.new(this.input).w_full().px(10).py(8).rounded(10).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)
        .token((ctx) => {
          const role = this.roles.byId(ctx.token.id);
          return h_flex().h(ctx.line_height).px(5).gap(3).items_center().rounded(5).bg((role ? t[role.color] ?? t.accent : t.accent) + "2e")
            .text_color(role ? t[role.color] ?? t.accent : t.accent).font_medium().child(`@${ctx.token.label ?? ctx.token.text}`);
        }))
      .child(h_flex().gap(8).items_center()
        .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(to.length
          ? `To ${to.map((r) => this.roles.byId(r)?.name ?? r).join(", ")}${implicit ? " · @ to choose" : ""}`
          : "Nobody here yet: add someone above"))
        .child(button(t, "desk-send", this.acting === "send" ? "Sending…" : "Send", (_e, cx) => this.send(cx),
          { primary: true, disabled: Boolean(this.acting) || !this.input.value().trim() || !to.length })));

    return v_flex().size_full().min_h(0)
      .child(header)
      .when(Boolean(details), (el) => el.child(details))
      .when(Boolean(briefs), (el) => el.child(briefs))
      .child(thread)
      .child(composer);
  }

  render(t) {
    const view = this.view;
    if (view === "new" && !this.fixed) return this.newView(t);
    const d = view !== "list" ? this.desk(view) : null;
    if (d) return this.deskView(t, d);
    if (this.fixed) return v_flex().p(14).child(empty(t, "This desk was deleted."));
    return this.listView(t);
  }
}
