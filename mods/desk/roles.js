import { agents, panes, spaces, run, notify, appHome, home, readTextFile, exec, hc } from "herdr";

// Team roles from roles.json, shared by the Team tab, the sidebar and the PR buttons.
// Starting a role opens a tab named after it, so its live agents are the ones in
// tabs with that name.
const FILE = "mods/desk/roles.json";
export const RANK = { blocked: 0, done: 1, working: 2, idle: 3 };
// Herdr's own worktree mod puts checkouts here, so they show up in its picker too.
const WORKTREES = () => `${home()}/.herdr/worktrees`;

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
const inside = (path, dir) => Boolean(path) && (path === dir || path.startsWith(dir + "/"));

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

  byId(id) { return this.list?.find((r) => (r.id ?? r.name.toLowerCase()) === id) ?? null; }
}

// A role's live agents, most urgent first.
export function sessions(role, list = agents()) {
  return list.filter((a) => a.tab_name === role.name).sort((x, y) => RANK[x.status] - RANK[y.status] || y.seq - x.seq);
}

// ── git ───────────────────────────────────────────────────────────────────

async function git(cwd, args) {
  try {
    const r = await exec("git", args, { cwd });
    return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  } catch (e) { return { ok: false, out: "", err: String(e?.message ?? e) }; }
}

// The repo a folder is in: this checkout (top), the main one, its name. null outside git.
export async function repoOf(folder) {
  if (!folder) return null;
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, common: common.out, name: main.split("/").pop() };
}

// Agents that may be editing files in `checkout`. Roles marked "worktree": false
// (CTO, Reviewer: they read, plan and review) don't count.
function editorsIn(checkout, roles) {
  const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
  const readOnly = new Set((roles ?? []).filter((r) => !r.worktree).map((r) => r.name));
  return agents().filter((a) => !readOnly.has(a.tab_name) && inside(cwd.get(a.pane), checkout));
}

// A fresh checkout of HEAD on a new team/<role>-<time> branch.
async function addWorktree(repo, role) {
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const branch = `team/${role.id ?? role.name.toLowerCase()}-${stamp}`;
  const path = `${WORKTREES()}/${repo.name}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  const r = await git(repo.top, ["worktree", "add", "-b", branch, path, "HEAD"]);
  if (!r.ok) throw new Error(r.err || "git worktree add failed");
  return { path, branch };
}

// The folder a role would start in: the project's, else the space's focused terminal.
export function folderOf(space) {
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const mine = panes().filter((p) => tabs.has(p.tab) && p.cwd);
  return (mine.find((p) => p.focused) ?? mine[0])?.cwd ?? space.folder ?? null;
}

// Starts a role in `space` (default: the shown one) or a new space for `project`.
// An editing role whose checkout already has an agent in it gets its own worktree.
export async function startRole(role, { task, project, space, folder, roles } = {}) {
  if (role.prompt && role.promptText === null) {
    notify({ title: `${role.name}: prompt missing`, body: role.prompt, level: "error", timeout: 4000 });
    return false;
  }
  space = space ?? (project ? null : spaces().find((s) => s.active));
  folder = folder ?? project?.folder ?? folderOf(space);
  let note = role.label ?? role.model ?? cliName(role);
  if (role.worktree && folder) {
    const repo = await repoOf(folder);
    const busy = repo ? editorsIn(repo.top, roles) : [];
    if (busy.length) {
      try {
        const wt = await addWorktree(repo, role);
        folder = wt.path;
        note = `Own worktree: ${wt.branch} (from HEAD; uncommitted changes in ${repo.name} aren't in it)`;
      } catch (e) {
        notify({ title: `${role.name}: no worktree`, body: String(e?.message ?? e), level: "error", timeout: 6000 });
        return false;
      }
    }
  }
  const argv = argvFor(role);
  if (space) {
    run("space.select", { id: space.id });
    run("tab.new", { space: space.id, name: role.name, ...(folder ? { folder } : {}), argv, task });
  } else if (project) {
    run("space.new", { name: project.name, folder, tab: role.name, argv, task });
  } else {
    run("tab.new", { name: role.name, ...(folder ? { folder } : {}), argv, task });
  }
  notify({ title: `${role.name} started`, body: note, level: "info", timeout: 4000 });
  return true;
}

// ── briefs ────────────────────────────────────────────────────────────────
// The CTO writes one brief per role to <git common dir>/team/briefs/<role id>.md:
// inside .git, so never committed, and shared by every worktree of the repo.

const BRIEFS_SCRIPT = `
for f in "$@"; do git -C "$f" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; done | sort -u |
while IFS= read -r d; do
  for b in "$d"/team/briefs/*.md; do
    [ -f "$b" ] || continue
    printf '%s\\t%s\\t%s\\t%s\\n' "$d" "$b" "$(stat -f %m "$b")" "$(grep -m1 -v '^[[:space:]]*$' "$b" | sed 's/^#* *//' | cut -c1-160)"
  done
done`;

// Every brief waiting in the given folders' repos: { role, path, common, main, repo, title, at }.
export async function findBriefs(folders) {
  const unique = [...new Set(folders.filter(Boolean))];
  if (!unique.length) return [];
  const r = await exec("sh", ["-c", BRIEFS_SCRIPT, "briefs", ...unique]);
  return r.stdout.split("\n").filter(Boolean).map((line) => {
    const [common, path, mtime, title] = line.split("\t");
    const main = common.endsWith("/.git") ? common.slice(0, -5) : common;
    return { role: path.split("/").pop().replace(/\.md$/, ""), path, common, main, repo: main.split("/").pop(),
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

const briefTask = (path) => `Your brief from the CTO is in ${path}. Read it, then carry it out within the files and contract it gives you.`;

// Starts the brief's role in the brief's repo (a worktree if it's busy).
export async function startBrief(brief, roles, space) {
  const role = roles.byId(brief.role);
  if (!role) return notify({ title: `No role "${brief.role}"`, body: "Brief file names must match a role id in roles.json.", level: "error", timeout: 5000 });
  const sent = await fileBrief(brief, "sent");
  await startRole(role, { task: briefTask(sent), folder: brief.main, space, roles: roles.list });
}

// Hands the brief to a running agent of its role instead.
export async function sendBrief(brief, agent) {
  const sent = await fileBrief(brief, "sent");
  const r = await hc(["send", agent.address, briefTask(sent)]);
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

// The role's colored tile with its icon (or its initial, without one).
export function roleTile(div, svg, t, role, size, dim = false) {
  const color = t[role.color] ?? role.color ?? t.accent;
  return div().size(size).flex_none().rounded(Math.round(size * 0.28)).flex().items_center().justify_center()
    .bg(color + (dim ? "1a" : "26")).text_color(dim ? color + "c0" : color)
    .child(role.icon
      ? svg(`mods/desk/icons/${role.icon}.svg`).size(Math.round(size * 0.58)).flex_none()
      : div().text_size(Math.round(size * 0.42)).font_semibold().child(role.name[0].toUpperCase()));
}
