import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { spaces, run } from "herdr";
import { pill, button, section, empty, card } from "./ui.js";
import { Roles, sessions, startRole, roleTile, cliName } from "./roles.js";

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
    this.load(cx);
  }

  load(cx) { this.roles.load(cx); }

  start(role, cx) {
    const project = this.target && this.panel.projects().find((p) => p.name === this.target);
    const task = this.task.value().trim() || undefined;
    const started = startRole(role, { task, project, space: project ? this.panel.spaceFor(project) : undefined });
    if (started && task) this.task.set_value("");
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
      .child(section(t, key, "Roles", list.length, open, (_e, cx) => this.panel.toggle(key, cx)))
      .when(open, (el) => el.child(v_flex().gap(2).children(list.map((r) => this.roleCard(t, r)))))
      .child(div().mx(16).mt(8).text_size(11).text_color(t.dim).line_height(1.4)
        .child("Click a role to go to it, or start it if it isn't running. Edit roles in mods/desk/roles.json."));
  }
}
