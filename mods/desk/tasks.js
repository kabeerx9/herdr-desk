import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, panes, run, notify, hc } from "herdr";
import { pill, button, section } from "./ui.js";
import { team, roleTile } from "./roles.js";

// Running team tasks: every live terminal labeled task=<slug> (the CTO and the
// engineers, reviewers and QA it or you started), as a tree by parent. Reviews,
// QA and PRs start only from these buttons or when you ask an agent for them.

const PHASE = { done: ["done", "done"], blocked: ["blocked", "blocked"], update: ["update", "accent"] };
const STATUS = { blocked: "needs you", done: "done", working: "working", idle: "idle" };

const prMessage = () =>
  "Kabeer approved opening a PR for this work. Commit anything left on your branch, push it, and open a PR with gh pr create " +
  "(say what changed, how you verified it, and link the related PR from this task if there is one). Then report the PR URL with team report done.";

const reviewTask = "Review the commits on this branch against its base, and the brief if there is one. Your parent is the engineer who wrote it.";
const qaTask = "Test the work on this branch against its brief: write tests for the intended behaviour and its edge cases, and report what passes and fails. Your parent is the engineer who wrote it.";

// Live team terminals grouped by task, each group as a parent-first tree.
export function taskGroups() {
  const live = terminals().filter((t) => t.state === "live" && t.labels?.task && t.labels?.role);
  const byTask = new Map();
  for (const t of live) byTask.set(t.labels.task, [...(byTask.get(t.labels.task) ?? []), t]);
  return [...byTask].map(([slug, members]) => {
    const addrs = new Set(members.map((m) => m.address));
    const kids = (addr) => members.filter((m) => m.parent === addr);
    const walk = (m, depth) => [{ t: m, depth }, ...kids(m.address).flatMap((k) => walk(k, depth + 1))];
    const roots = members.filter((m) => !m.parent || !addrs.has(m.parent))
      .sort((a, b) => (a.labels.role === "cto" ? -1 : b.labels.role === "cto" ? 1 : (a.created_ms ?? 0) - (b.created_ms ?? 0)));
    return { slug, rows: roots.flatMap((r) => walk(r, 0)) };
  });
}

// Toasts when an agent reports (its phase label changes).
export class PhaseWatch {
  constructor() { this.seen = null; }
  check(roles) {
    const now = new Map();
    for (const t of terminals()) if (t.labels?.phase) now.set(t.address, `${t.labels.phase}\u0000${t.labels.note ?? ""}`);
    if (this.seen) for (const t of terminals()) {
      const key = now.get(t.address);
      if (!key || this.seen.get(t.address) === key) continue;
      const role = roles.byId(t.labels.role);
      notify({ title: `${role?.name ?? t.name ?? t.address} ${t.labels.phase}`, body: t.labels.note ?? "",
        level: t.labels.phase === "blocked" ? "warning" : t.labels.phase === "done" ? "success" : "info", timeout: 6000 });
    }
    this.seen = now;
  }
}

export function tasksView(owner, t) {
  const groups = taskGroups();
  if (!groups.length) return null;
  const status = new Map(agents().map((a) => [a.address, a.status]));
  const cwdOf = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p.cwd]));
  const roles = owner.roles;
  const key = "team-tasks", open = !owner.panel.collapsed[key];

  const act = (id, label, fn, opts) => button(t, id, label, (_e, cx) => {
    if (owner.acting) return;
    owner.acting = id;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await fn(); } catch (e) { notify({ title: label, body: String(e?.message ?? e), level: "error", timeout: 5000 }); }
      owner.acting = null;
      cx.notify();
    });
  }, { ...opts, disabled: Boolean(owner.acting) || opts?.disabled });

  const child = (m, roleId, task) => team([roleId, "--requested", "--share", "--parent", m.address,
    "--repo", cwdOf.get(m.address) ?? m.cwd, "--slug", m.labels.task,
    ...(m.labels["herdr.space"] ? ["--space", m.labels["herdr.space"]] : []), "--task", task]);

  const row = ({ t: m, depth }) => {
    const role = roles.byId(m.labels.role), st = status.get(m.address) ?? m.status, id = `task-${m.address}`;
    const phase = PHASE[m.labels.phase];
    const engineer = role?.worktree && !role?.on_request;
    const cwd = cwdOf.get(m.address) ?? m.cwd ?? "";
    const where = cwd.includes("/.herdr/worktrees/") ? cwd.split("/").slice(-2).join("/") : cwd.split("/").pop();
    return v_flex().id(id).ml(8 + depth * 22).mr(8).px(10).py(7).gap(4).rounded(8).border_1().border_color(t.border).bg(t.raised).mb(3)
      .child(h_flex().gap(8).items_center()
        .child(role ? roleTile(div, svg, t, role, 24) : div().size(24).rounded(7).bg(t.hover))
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(role?.name ?? m.labels.role))
        .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(where))
        .when(Boolean(phase), (el) => el.child(pill(t, phase[0], t[phase[1]] ?? t.accent)))
        // The status adds something only while it's working or waiting on you, or before any report.
        .when(!phase || st === "working" || st === "blocked", (el) => el.child(pill(t, STATUS[st] ?? st ?? "—", t[st] ?? t.dim))))
      .when(Boolean(m.labels.note), (el) => el.child(div().pl(32).text_size(11.5).line_height(1.35).text_color(t.muted).child(m.labels.note)))
      .child(h_flex().pl(32).gap(6).items_center().flex_wrap()
        .child(button(t, `${id}-go`, "Go", () => run("agent.focus", { terminal: m.address })))
        .when(engineer, (el) => el
          .child(act(`${id}-rev`, "Review", () => child(m, "reviewer", reviewTask), { iconName: "sparkles", tip: "Start a Reviewer on this branch; it reports to this engineer" }))
          .child(act(`${id}-qa`, "QA", () => child(m, "qa", qaTask), { tip: "Start QA on this branch; it reports to this engineer" }))
          .child(act(`${id}-pr`, "Open PR", async () => {
            const r = await hc(["send", m.address, prMessage()]);
            if (r.code !== 0) throw new Error(r.stderr.trim() || "couldn't send (is it waiting on you?)");
            run("agent.focus", { terminal: m.address });
          }, { iconName: "pr", tip: "Ask this engineer to push its branch and open a PR" }))));
  };

  return v_flex().pb(4)
    .child(section(t, key, "Tasks", groups.length, open, (_e, cx) => owner.panel.toggle(key, cx)))
    .when(open, (el) => el.children(groups.map((g) => {
      const done = g.rows.filter((r) => r.t.labels.phase === "done").length;
      return v_flex().pb(6)
        .child(h_flex().mx(16).mb(4).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(g.slug))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).child(`${done}/${g.rows.length} done`)))
        .children(g.rows.map(row));
    })));
}
