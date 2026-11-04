import { agents, spaces, run, notify, appHome, readTextFile } from "herdr";

// Team roles from roles.json, shared by the Team tab and the sidebar's agent list.
// Starting a role opens a tab named after it, so its live agents are the ones in
// tabs with that name.
const FILE = "mods/desk/roles.json";
export const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };

// What starts a role: the CLI, its model, and the role prompt as a system prompt.
function argvFor(role) {
  if (Array.isArray(role.argv)) return role.argv;
  const prompt = role.promptText, extra = role.args ?? [];
  if (role.cli === "codex") {
    // -c values parse as TOML; a JSON string is a valid TOML basic string.
    return ["codex", ...(role.model ? ["-m", role.model] : []),
      ...(prompt ? ["-c", `developer_instructions=${JSON.stringify(prompt)}`] : []), ...extra];
  }
  return ["claude", ...(role.model ? ["--model", role.model] : []),
    ...(prompt ? ["--append-system-prompt", prompt] : []), ...extra];
}

export const cliName = (role) => (role.cli === "codex" ? "Codex" : !role.cli || role.cli === "claude" ? "Claude Code" : role.cli);

export class Roles {
  constructor() { this.list = null; this.error = null; this.raw = null; }

  // Re-reads roles.json (and the prompts) when it changed; cheap enough to poll.
  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/${FILE}`);
        if (text === this.raw) return;
        this.raw = text;
        if (text === null) throw new Error(`${FILE} not found`);
        const roles = JSON.parse(text).roles ?? [];
        this.list = await Promise.all(roles.map(async (r) => ({
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
}

// A role's live agents, most urgent first.
export function sessions(role, list = agents()) {
  return list.filter((a) => a.tab_name === role.name).sort((x, y) => RANK[x.status] - RANK[y.status] || y.seq - x.seq);
}

// Starts a role in `space` (default: the shown one), or in a new space for `project`.
export function startRole(role, { task, project, space } = {}) {
  if (role.prompt && role.promptText === null) {
    notify({ title: `${role.name}: prompt missing`, body: role.prompt, level: "error", timeout: 4000 });
    return false;
  }
  const argv = argvFor(role);
  space = space ?? (project ? null : spaces().find((s) => s.active));
  if (space) {
    run("space.select", { id: space.id });
    run("tab.new", { space: space.id, name: role.name, ...(project ? { folder: project.folder } : {}), argv, task });
  } else if (project) {
    run("space.new", { name: project.name, folder: project.folder, tab: role.name, argv, task });
  } else {
    run("tab.new", { name: role.name, argv, task });
  }
  notify({ title: `${role.name} started`, body: role.label ?? role.model ?? cliName(role), level: "info", timeout: 2500 });
  return true;
}

// The role's colored tile with its icon (or its initial, without one).
export function roleTile(div, svg, t, role, size, dim = false) {
  const color = t[role.color] ?? role.color ?? t.accent;
  return div().size(size).flex_none().rounded(Math.round(size * 0.28)).flex().items_center().justify_center()
    .bg(color + (dim ? "1a" : "26")).text_color(dim ? color + "c0" : color)
    .child(role.icon
      ? svg(`mods/desk/icons/${role.icon}.svg`).size(Math.round(size * 0.58)).flex_none()
      : div().text_size(Math.round(size * 0.42)).font_semibold().child(role.name[0].toUpperCase()));
}
