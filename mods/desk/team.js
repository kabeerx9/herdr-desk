import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { agents, spaces, run, notify, appHome, readTextFile } from "herdr";
import { icon, pill, button, section, empty, card } from "./ui.js";

// The Team tab: one card per role in roles.json (a name, a CLI, a model and a
// role prompt). Starting a role opens a tab named after it, so its live agents
// are the ones in tabs with that name.
const ROLES = "mods/desk/roles.json";
const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const LABEL = { blocked: "needs you", done: "done", working: "working", idle: "idle" };

// What starts a role: the CLI, its model, and the role prompt as a system prompt.
function argvFor(role, prompt) {
  if (Array.isArray(role.argv)) return role.argv;
  const extra = role.args ?? [];
  if (role.cli === "codex") {
    // -c values parse as TOML; a JSON string is a valid TOML basic string.
    return ["codex", ...(role.model ? ["-m", role.model] : []),
      ...(prompt ? ["-c", `developer_instructions=${JSON.stringify(prompt)}`] : []), ...extra];
  }
  return ["claude", ...(role.model ? ["--model", role.model] : []),
    ...(prompt ? ["--append-system-prompt", prompt] : []), ...extra];
}

export class Team {
  constructor(panel, cx) {
    this.panel = panel;
    this.roles = null;
    this.error = null;
    this.raw = null;
    this.target = null; // null: the space you're in; else a project name
    try { this.target = JSON.parse(localStorage.getItem("team.target")); } catch {}
    this.task = TextareaState.new({ placeholder: "Task for the role you start (optional)…", rows: 3 });
    this.task.set_auto_grow(2, 8);
    this.task.on("change", (_e, cx) => cx.notify());
    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/${ROLES}`);
        if (text === this.raw) return;
        this.raw = text;
        if (text === null) throw new Error(`${ROLES} not found`);
        const roles = JSON.parse(text).roles ?? [];
        // Read each role's prompt file now, so starting one is instant.
        this.roles = await Promise.all(roles.map(async (r) => ({
          ...r,
          promptText: r.prompt ? (await readTextFile(`${appHome()}/mods/desk/${r.prompt}`))?.trim() ?? null : null,
        })));
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Where a started role goes: the shown space, or a project's space (made if missing).
  where() {
    const project = this.target && this.panel.projects().find((p) => p.name === this.target);
    if (project) return { project, space: this.panel.spaceFor(project) };
    return { project: null, space: spaces().find((s) => s.active) ?? null };
  }

  sessions(role) {
    return agents().filter((a) => a.tab_name === role.name)
      .sort((x, y) => RANK[x.status] - RANK[y.status] || y.seq - x.seq);
  }

  start(role, cx) {
    if (role.prompt && role.promptText === null) {
      notify({ title: `${role.name}: prompt missing`, body: role.prompt, level: "error", timeout: 4000 });
      return;
    }
    const argv = argvFor(role, role.promptText);
    const task = this.task.value().trim() || undefined;
    const { project, space } = this.where();
    if (space) {
      run("space.select", { id: space.id });
      run("tab.new", { space: space.id, name: role.name, ...(project ? { folder: project.folder } : {}), argv, task });
    } else if (project) {
      run("space.new", { name: project.name, folder: project.folder, tab: role.name, argv, task });
    } else {
      run("tab.new", { name: role.name, argv, task });
    }
    if (task) this.task.set_value("");
    notify({ title: `${role.name} started`, body: role.label ?? role.model ?? role.cli, level: "info", timeout: 2500 });
    cx.notify();
  }

  setTarget(name, cx) {
    this.target = name;
    try { localStorage.setItem("team.target", JSON.stringify(name)); } catch {}
    cx.notify();
  }

  // ── view ──────────────────────────────────────────────────────────────────

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

  roleCard(t, role, cx) {
    const id = `role-${role.id ?? role.name}`, hovered = this.panel.hovered === id;
    const color = t[role.color] ?? role.color ?? t.accent;
    const live = this.sessions(role), top = live[0];
    const where = [...new Set(live.map((a) => a.space_name))].join(", ");
    return card(t, id, hovered).cursor_pointer()
      .on_hover((h, cx) => this.panel.hover(id, h, cx))
      .on_click((_e, cx) => (top ? run("agent.focus", { terminal: top.address }) : this.start(role, cx)))
      .child(h_flex().gap(10).items_start()
        .child(div().size(30).flex_none().rounded(8).flex().items_center().justify_center()
          .bg(color + "26").text_color(color).text_size(12).font_semibold()
          .child(role.name.slice(0, role.name.length <= 3 ? 3 : 1).toUpperCase()))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().gap(6).items_center()
            .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(role.name))
            .child(div().flex_1())
            .when(Boolean(top), (el) => el.child(pill(t, live.length > 1 ? `${LABEL[top.status]} · ${live.length}` : LABEL[top.status], t[top.status] ?? t.dim))))
          .when(Boolean(role.title), (el) => el.child(div().text_size(11.5).line_height(1.35).text_color(t.muted).child(role.title)))
          .child(h_flex().gap(6).items_center().min_h(24)
            .child(pill(t, role.cli === "codex" ? "Codex" : role.cli === "claude" || !role.cli ? "Claude Code" : role.cli, color))
            .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(role.label ?? role.model ?? "default model"))
            .when(Boolean(where) && !hovered, (el) => el.child(div().flex_1()).child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(where)))
            .when(hovered, (el) => el.child(div().flex_1())
              .when(Boolean(top), (el) => el.child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: top.address }))))
              .child(button(t, `${id}-start`, top ? "New" : "Start", (_e, cx) => this.start(role, cx), { iconName: "play", primary: !top }))))));
  }

  render(t, cx) {
    if (this.error) return v_flex().py(8).child(empty(t, `Couldn't read roles: ${this.error}`));
    if (!this.roles) return v_flex().py(8).child(empty(t, "Loading roles…"));
    const key = "team-roles", open = !this.panel.collapsed[key];
    return v_flex().pb(10)
      .child(this.targetPicker(t))
      .child(div().mx(12).mt(10).mb(6)
        .child(Textarea.new(this.task).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground)))
      .child(section(t, key, "Roles", this.roles.length, open, (_e, cx) => this.panel.toggle(key, cx)))
      .when(open, (el) => el.child(v_flex().gap(2).children(this.roles.map((r) => this.roleCard(t, r, cx)))))
      .child(div().mx(16).mt(8).text_size(11).text_color(t.dim).line_height(1.4)
        .child("Click a role to go to it, or start it if it isn't running. Edit roles in mods/desk/roles.json."));
  }
}
