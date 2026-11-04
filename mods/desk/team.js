import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { spaces, run, notify, exec, shared, setShared } from "herdr";
import { pill, button, section, empty, card, ago } from "./ui.js";
import { Roles, sessions, startRole, roleTile, cliName, findBriefs, startBrief, sendBrief, fileBrief, sessionsInRepo, folderOf } from "./roles.js";

// The Team tab: one card per role in roles.json, a place to start it, and a task to give it.
const LABEL = { blocked: "needs you", done: "done", working: "working", idle: "idle" };

export class Team {
  constructor(panel, cx) {
    this.panel = panel;
    this.roles = new Roles();
    this.target = null; // null: the space you're in; else a project name
    try { this.target = JSON.parse(localStorage.getItem("team.target")); } catch {}
    this.task = TextareaState.new({ placeholder: "Task for the role you start (optional)…", rows: 3 });
    this.task.set_auto_grow(2, 8);
    this.task.on("change", (_e, cx) => cx.notify());
    this.briefs = [];
    this.seen = null; // brief paths already announced
    this.acting = null;
    this.load(cx);
    this.scan(cx);
    cx.timer.every(6000, (cx) => this.scan(cx));
  }

  load(cx) { this.roles.load(cx); }

  // Briefs the CTO left in any project's or open space's repo.
  scan(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const folders = [...this.panel.projects().map((p) => p.folder), ...spaces().filter((s) => !s.machine).map(folderOf)];
        this.briefs = await findBriefs(folders);
      } catch { this.briefs = []; }
      this.scanning = false;
      const fresh = this.briefs.filter((b) => this.seen && !this.seen.has(b.path));
      if (fresh.length) notify({ title: `${fresh.length} new brief${fresh.length > 1 ? "s" : ""} from the CTO`,
        body: fresh.map((b) => `${this.roles.byId(b.role)?.name ?? b.role} · ${b.repo}`).join(", "), level: "info", timeout: 5000 });
      this.seen = new Set(this.briefs.map((b) => b.path));
      if ((shared("desk.counts")?.team ?? 0) !== this.briefs.length) setShared("desk.counts", { ...shared("desk.counts"), team: this.briefs.length });
      cx.notify();
    });
  }

  // The space and project a brief's repo already has, if any.
  placeOf(brief) {
    const project = this.panel.projects().find((p) => p.folder === brief.main || p.folder.startsWith(brief.main + "/"));
    const space = project ? this.panel.spaceFor(project)
      : spaces().find((s) => !s.machine && (folderOf(s) ?? "").startsWith(brief.main));
    return { project: project ?? { name: brief.repo, folder: brief.main }, space };
  }

  act(brief, what, cx) {
    if (this.acting) return;
    this.acting = brief.path;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (what === "start") {
          const { space } = this.placeOf(brief);
          await startBrief(brief, this.roles, space ?? null);
        } else if (what === "dismiss") {
          await fileBrief(brief, "dismissed");
        } else {
          await sendBrief(brief, what);
        }
      } catch (e) {
        notify({ title: "Brief not handed off", body: String(e?.message ?? e), level: "error", timeout: 5000 });
      }
      this.acting = null;
      this.scan(cx);
    });
  }

  start(role, cx) {
    const project = this.target && this.panel.projects().find((p) => p.name === this.target);
    const task = this.task.value().trim() || undefined;
    if (task) this.task.set_value("");
    startRole(role, { task, project, space: project ? this.panel.spaceFor(project) : undefined, roles: this.roles.list });
    cx.notify();
  }

  setTarget(name, cx) {
    this.target = name;
    try { localStorage.setItem("team.target", JSON.stringify(name)); } catch {}
    cx.notify();
  }

  targetPicker(t) {
    const current = spaces().find((s) => s.active);
    const chip = (key, label) => {
      const on = this.target === key;
      return div().id(`tt-${key ?? "here"}`).h(22).px(8).flex().items_center().rounded(11).cursor_pointer().text_size(11)
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : "#00000000")
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setTarget(key, cx)).child(label);
    };
    return v_flex().mx(12).mt(10).gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child("STARTS IN"))
      .child(h_flex().gap(5).flex_wrap()
        .child(chip(null, `Current${current ? ` · ${current.name}` : ""}`))
        .children(this.panel.projects().map((p) => chip(p.name, p.name))));
  }

  briefCard(t, brief) {
    const role = this.roles.byId(brief.role), id = `brief-${brief.path}`, busy = this.acting === brief.path;
    const waiting = role ? sessionsInRepo(role, brief).filter((a) => a.status !== "working") : [];
    const tile = role ? roleTile(div, svg, t, role, 32) : div().size(32).flex_none().rounded(9).bg(t.raised);
    return card(t, id, false).border_color(t.border).bg(t.raised).mb(4)
      .child(h_flex().gap(10).items_start()
        .child(tile)
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).items_center()
            .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(role?.name ?? brief.role))
            .child(div().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`· ${brief.repo}`))
            .child(div().flex_1())
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(new Date(brief.at)))))
          .child(div().text_size(12).line_height(1.35).text_color(t.foreground).child(brief.title))
          .child(h_flex().pt(3).gap(6).items_center().flex_wrap()
            .child(button(t, `${id}-start`, busy ? "Starting…" : `Start ${role?.name ?? ""}`.trim(), (_e, cx) => this.act(brief, "start", cx),
              { iconName: "play", primary: true, disabled: busy || !role }))
            .when(waiting.length > 0, (el) => el.child(button(t, `${id}-send`, `Send to ${waiting[0].space_name}`,
              (_e, cx) => this.act(brief, waiting[0], cx), { disabled: busy, tip: `Hand it to the ${role.name} already open there` })))
            .child(div().flex_1())
            .child(button(t, `${id}-open`, null, () => exec("open", ["-t", brief.path]), { iconName: "pages", tip: "Read the brief" }))
            .child(button(t, `${id}-x`, null, (_e, cx) => this.act(brief, "dismiss", cx), { iconName: "minus", tip: "Dismiss", disabled: busy })))));
  }

  roleCard(t, role) {
    const id = `role-${role.id ?? role.name}`, hovered = this.panel.hovered === id;
    const color = t[role.color] ?? role.color ?? t.accent;
    const live = sessions(role), top = live[0];
    const where = [...new Set(live.map((a) => a.space_name))].join(", ");
    return card(t, id, hovered).cursor_pointer()
      .on_hover((h, cx) => this.panel.hover(id, h, cx))
      .on_click((_e, cx) => (top ? run("agent.focus", { terminal: top.address }) : this.start(role, cx)))
      .child(h_flex().gap(10).items_start()
        .child(roleTile(div, svg, t, role, 32))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).items_center()
            .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(role.name))
            .child(div().flex_1())
            .when(Boolean(top), (el) => el.child(pill(t, live.length > 1 ? `${LABEL[top.status]} · ${live.length}` : LABEL[top.status], t[top.status] ?? t.dim))))
          .when(Boolean(role.title), (el) => el.child(div().text_size(11.5).line_height(1.35).text_color(t.muted).child(role.title)))
          .child(h_flex().gap(6).items_center().min_h(24)
            .child(pill(t, cliName(role), color))
            .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(role.label ?? role.model ?? "default model"))
            .when(Boolean(where) && !hovered, (el) => el.child(div().flex_1()).child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(where)))
            .when(hovered, (el) => el.child(div().flex_1())
              .when(Boolean(top), (el) => el.child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: top.address }))))
              .child(button(t, `${id}-start`, top ? "New" : "Start", (_e, cx) => this.start(role, cx), { iconName: "play", primary: !top }))))));
  }

  render(t) {
    const { list, error } = this.roles;
    if (error) return v_flex().py(8).child(empty(t, `Couldn't read roles: ${error}`));
    if (!list) return v_flex().py(8).child(empty(t, "Loading roles…"));
    const key = "team-roles", open = !this.panel.collapsed[key];
    return v_flex().pb(10)
      .child(this.targetPicker(t))
      .child(div().mx(12).mt(10).mb(6)
        .child(Textarea.new(this.task).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground)))
      .when(this.briefs.length > 0, (el) => el
        .child(section(t, "team-briefs", "Briefs from the CTO", this.briefs.length, !this.panel.collapsed["team-briefs"], (_e, cx) => this.panel.toggle("team-briefs", cx)))
        .when(!this.panel.collapsed["team-briefs"], (el) => el.child(v_flex().children(this.briefs.map((b) => this.briefCard(t, b))))))
      .child(section(t, key, "Roles", list.length, open, (_e, cx) => this.panel.toggle(key, cx)))
      .when(open, (el) => el.child(v_flex().gap(2).children(list.map((r) => this.roleCard(t, r)))))
      .child(div().mx(16).mt(8).text_size(11).text_color(t.dim).line_height(1.4)
        .child("Click a role to go to it, or start it if it isn't running. Ask the CTO for a plan and its briefs show up here. Edit roles in mods/desk/roles.json."));
  }
}
