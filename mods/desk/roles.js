import { image } from "gpui-kit";
import { agents, terminals, panes, spaces, run, notify, appHome, home, readTextFile, exec, hc } from "herdr";

// Team roles from roles.json, shared by the Team tab, the sidebar and the PR buttons.
// Every role starts through bin/team (the same launcher the CTO uses), which labels
// its terminal role=<id> task=<slug> and gives it its own tab.
const FILE = "mods/desk/roles.json";
export const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
const TEAM = () => `${appHome()}/bin/team`;
const WORKTREES = () => `${home()}/.herdr/worktrees`;

export const cliName = (role) => (role.cli === "codex" ? "Codex" : !role.cli || role.cli === "claude" ? "Claude Code" : role.cli);
const inside = (path, dir) => Boolean(path) && (path === dir || path.startsWith(dir + "/"));

export class Roles {
  constructor() { this.list = null; this.error = null; this.raw = null; }

  // Re-reads roles.json when it changed; cheap enough to poll. (bin/team reads the prompts.)
  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/${FILE}`);
        if (text === this.raw) return;
        this.raw = text;
        if (text === null) throw new Error(`${FILE} not found`);
        const data = JSON.parse(text);
        this.list = (data.roles ?? []).map((r) => ({ ...r, id: r.id ?? r.name.toLowerCase() }));
        this.freshLimit = Number(data.fresh_at) || 250000;
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  byId(id) { return this.list?.find((r) => r.id === id) ?? null; }
  // Context size (tokens) past which a role should start fresh; bin/team reads the same numbers.
  freshAt(id) { return Number(this.byId(id)?.fresh_at) || this.freshLimit || 250000; }
}

// Live terminals' labels by address.
export function labelsByAddress() {
  return new Map(terminals().map((t) => [t.address, t.labels ?? {}]));
}

// A role's live agents, most urgent first: labeled role=<id>, or (started before
// labels) in a tab named after the role.
export function sessions(role, list = agents(), labels = labelsByAddress()) {
  return list.filter((a) => {
    const r = labels.get(a.address)?.role;
    return r ? r === role.id : a.tab_name === role.name;
  }).sort((x, y) => RANK[x.status] - RANK[y.status] || y.seq - x.seq);
}

// The folder a role would start in: the space's focused terminal, else its folder.
export function folderOf(space) {
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const mine = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  return (mine.find((p) => p.focused) ?? mine[0])?.cwd ?? space.folder ?? null;
}

// Runs `team start`; resolves with its JSON, or notifies and resolves null.
export async function team(args) {
  let r;
  try { r = await exec(TEAM(), ["start", ...args, "--by", "desk"]); }
  catch (e) { r = { code: 1, stdout: "", stderr: String(e?.message ?? e) }; }
  if (r.code !== 0) {
    let msg = r.stderr.trim() || r.stdout.trim();
    try { msg = JSON.parse(msg).error ?? msg; } catch {}
    notify({ title: "Couldn't start the role", body: msg, level: "error", timeout: 6000 });
    return null;
  }
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

// A task's thread name from its first words: "Add cursor pagination to picks" → add-cursor-pagination-to-picks.
const slugOf = (task) => task.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 5).join("-").slice(0, 40);

// Starts a role from the Desk: in `space` (default: the shown one), or a new space for `project`.
export async function startRole(role, { task, project, space, folder } = {}) {
  space = space ?? (project ? null : spaces().find((s) => s.active));
  folder = folder ?? project?.folder ?? folderOf(space) ?? home();
  const args = [role.id, "--repo", folder, "--no-parent", "--requested"];
  if (space && !space.machine) args.push("--space", space.id);
  if (task) args.push("--task", task, "--slug", slugOf(task));
  const out = await team(args);
  if (!out) return false;
  if (space) run("space.select", { id: space.id });
  notify({ title: `${role.name} started`, body: out.note ?? role.label ?? role.model ?? cliName(role), level: "info", timeout: 4000 });
  return true;
}

// ── briefs ────────────────────────────────────────────────────────────────
// The CTO writes one brief per role to <git common dir>/team/briefs/<role id>.md:
// inside .git, so never committed, and shared by every worktree of the repo.

const BRIEFS_SCRIPT = `
for f in "$@"; do git -C "$f" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; done | sort -u |
while IFS= read -r d; do
  for b in "$d"/team/briefs/*.md "$d"/team/briefs/*/*.md; do
    [ -f "$b" ] || continue
    printf '%s\\t%s\\t%s\\t%s\\n' "$d" "$b" "$(stat -f %m "$b")" "$(grep -m1 -v '^[[:space:]]*$' "$b" | sed 's/^#* *//' | cut -c1-160)"
  done
done`;

// Every brief waiting in the given folders' repos: { role, desk, path, common, main, repo, title, at }.
// A desk's CTO writes team/briefs/<desk>/<role>.md; team/briefs/<role>.md has no desk.
export async function findBriefs(folders) {
  const unique = [...new Set(folders.filter(Boolean))];
  if (!unique.length) return [];
  const r = await exec("sh", ["-c", BRIEFS_SCRIPT, "briefs", ...unique]);
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [common, path, mtime, title] = line.split("\t");
    const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
    const parts = path.split("/"), desk = parts.at(-2) === "briefs" ? null : parts.at(-2);
    return { role: parts.at(-1).replace(/\.md$/, ""), desk, path, common, main, repo: main.split("/").pop(),
      title: title || "(empty brief)", at: Number(mtime) * 1000 };
  }).sort((a, b) => b.at - a.at);
}

// Moves a brief out of the queue (team/sent/ or team/dismissed/) and returns where it went.
export async function fileBrief(brief, to) {
  const dir = `${brief.common}/team/${to}`;
  const dest = `${dir}/${brief.role}-${Date.now()}.md`;
  const r = await exec("sh", ["-c", 'mkdir -p "$1" && mv "$2" "$3"', "file", dir, brief.path, dest]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't move the brief");
  return dest;
}

// Starts the brief's role in the brief's repo (bin/team moves the brief to sent/).
export async function startBrief(brief, roles, space, { slug, parent } = {}) {
  const role = roles.byId(brief.role);
  if (!role) return notify({ title: `No role "${brief.role}"`, body: "Brief file names must match a role id in roles.json.", level: "error", timeout: 5000 });
  const args = [role.id, "--repo", brief.main, "--brief", brief.path, ...(parent ? ["--parent", parent] : ["--no-parent"]), "--requested"];
  if (slug ?? brief.desk) args.push("--slug", slug ?? brief.desk);
  if (space && !space.machine) args.push("--space", space.id);
  const out = await team(args);
  if (out) notify({ title: `${role.name} started`, body: out.note ?? brief.title, level: "info", timeout: 4000 });
}

// Hands the brief to a running agent of its role instead.
export async function sendBrief(brief, agent) {
  const sent = await fileBrief(brief, "sent");
  const r = await hc(["send", agent.address, `Your brief is in ${sent}. Read it, then carry it out within the files and contract it gives you.`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "hc send failed");
  run("agent.focus", { terminal: agent.address });
}

// A role's running agents working in the brief's repo (its main checkout or one of its worktrees).
export function sessionsInRepo(role, brief) {
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  return sessions(role).filter((a) => {
    const c = cwd.get(a.pane);
    return inside(c, brief.main) || inside(c, `${WORKTREES()}/${brief.repo}`);
  });
}

// The role's face (its avatar, round), else its colored tile with its icon or initial.
export function roleTile(div, svg, t, role, size, dim = false) {
  const color = t[role.color] ?? role.color ?? t.accent;
  if (role.avatar) return div().size(size).flex_none().rounded(size / 2).overflow_hidden().bg(color + "26")
    .when(dim, (el) => el.opacity(0.55))
    .child(image(`mods/desk/${role.avatar}`).size(size));
  return div().size(size).flex_none().rounded(Math.round(size * 0.28)).flex().items_center().justify_center()
    .bg(color + (dim ? "1a" : "26")).text_color(dim ? color + "c0" : color)
    .child(role.icon
      ? svg(`mods/desk/icons/${role.icon}.svg`).size(Math.round(size * 0.58)).flex_none()
      : div().text_size(Math.round(size * 0.42)).font_semibold().child(role.name[0].toUpperCase()));
}
