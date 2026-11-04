import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, spaces, theme, run, props, notify, home, shared, setShared, nextCommand } from "herdr";
import { icon, tileColor, ago, pill, button, section, empty, card } from "./ui.js";
import { GitPanel } from "./git.js";
import { TABS, currentTab, setOpen } from "./tabs.js";
import { Rail } from "./rail.js";
import { inboxView } from "./inbox.js";
import { Sidebar } from "./sidebar.js";
import { startRole } from "./roles.js";
import { Desks } from "./desks.js";
import { UsagePopover } from "./usage.js";

const ME = "kabeerx9";
// Lessons, explainers and Throughline reviews: newest first, as "mtime\tpath\ttitle".
const PAGES_SCRIPT = `
{ find "$HOME/learning" "$HOME/Desktop/Full-Stack-Ownership-Course/lessons" -maxdepth 3 -name '*.html' -not -path '*/assets/*' -not -path '*/example/*'
  # Throughline writes into <repo>/.git/throughline (worktrees: .git/worktrees/*/throughline). Globs, not a deep find.
  for g in "$HOME"/Desktop/work "$HOME"/Desktop/projects; do
    for f in "$g"/*/.git/throughline/*/throughline.html "$g"/*/*/.git/throughline/*/throughline.html \
             "$g"/*/*/*/.git/throughline/*/throughline.html "$g"/*/*/*/.git/worktrees/*/throughline/*/throughline.html; do
      [ -f "$f" ] && printf '%s\n' "$f"
    done
  done
} 2>/dev/null | while IFS= read -r f; do
  printf '%s\\t%s\\t%s\\n' "$(stat -f %m "$f")" "$f" "$(head -c 4096 "$f" | grep -o -m1 '<title>[^<]*' | sed 's/<title>//; s/ · Throughline$//')"
done | sort -rn | head -150`;
const PR_FIELDS = "number,title,author,isDraft,reviewDecision,url,additions,deletions,updatedAt,statusCheckRollup,headRefName";

const RESUME =
  "Where were we? Read git status, the current branch, recent commits, my open PRs and any handoff docs, " +
  "then tell me where we left off and the next step. Don't change anything yet.";
const REVIEW = (repo, pr) =>
  `Review PR #${pr.number} in ${repo} by ${pr.author.login} ("${pr.title}"). Read-only: use gh pr view/diff, check out nothing. ` +
  "Explain what it does and how the flow works, what I might not have considered, risks, and whether it's mergeable.";
const FOLLOW_UP = (repo, pr) =>
  `Check my PR #${pr.number} in ${repo} ("${pr.title}"): CI status, review comments and merge conflicts. ` +
  "Summarize what's blocking it and propose fixes. Don't push anything without asking.";
const WORK = (repo, issue) =>
  `Work on issue #${issue.number} in ${repo} ("${issue.title}"). Read it with gh issue view ${issue.number} -R ${repo}, ` +
  "explore the relevant code, then propose a plan and wait for my go before editing.";

// CI rollup → "pass" | "fail" | "pending" | null.
function checks(rollup) {
  if (!rollup?.length) return null;
  const states = rollup.map((c) => c.conclusion || c.state || c.status);
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "fail";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", ""].includes(s ?? ""))) return "pending";
  return "pass";
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// One mod, four parts: the panel (props.projects), its icon rail (props.rail),
// the usage popover the rail opens (props.popover), the sidebar agent list (props.agents),
// and one desk popped out as a pane (props.chat, props.task = the desk).
export default class Desk extends View {
  init(_props, cx) {
    const p = props();
    this.part = p?.popover ? new UsagePopover() : p?.rail ? new Rail() : p?.agents ? new Sidebar() : p?.chat ? new ChatPane() : new Panel();
    this.part.init(p, cx);
    // Only the rail is always shown, so it takes the key commands.
    if (p?.rail) cx.spawn(async (cx) => { for (;;) { this.part.command(await nextCommand()); cx.notify(); } });
  }

  render(cx) { return this.part.render(cx); }
}

// One desk in its own pane, beside the terminals: several can be open at once.
class ChatPane {
  init(p, cx) { this.chat = new Desks(null, cx, { fixed: p.task }); }
  render(cx) {
    const t = theme();
    return v_flex().id("chat-pane").size_full().bg(t.chrome).text_color(t.foreground).child(this.chat.render(t));
  }
}

class Panel {
  get tab() { return currentTab(); }

  init(_props, cx) {
    this.pages = null;
    this.issueFilter = store.get("issueFilter", "all");
    this.collapsed = store.get("collapsed", {});
    this.hovered = null;
    this.status = {};
    this.reviews = []; this.mine = []; this.issues = {};
    this.git = new GitPanel(this, cx);
    this.desks = new Desks(this, cx, { toasts: true });
    cx.timer.every(15000, (cx) => this.refreshStatus(cx));
    cx.timer.every(120000, (cx) => this.refreshGitHub(cx));
    cx.timer.every(8000, (cx) => { if (this.tab === "git") this.git.refresh(cx); });
    cx.timer.every(60000, (cx) => { if (this.tab === "pages") this.refreshPages(cx); });
    this.refreshStatus(cx);
    this.refreshGitHub(cx);
    this.git.refresh(cx);
    this.refreshPages(cx);
  }

  refreshPages(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", PAGES_SCRIPT]);
        this.pages = r.stdout.split("\n").filter(Boolean).map((l) => {
          const [mtime, path, title] = l.split("\t");
          const kind = path.endsWith("/throughline.html") ? "throughline" : path.includes("/lessons/") ? "lesson" : "explainer";
          const repo = /\/([^/]+)\/\.git\//.exec(path)?.[1] ?? (kind === "throughline" ? path.split("/").slice(-2, -1)[0] : null);
          return { mtime: Number(mtime) * 1000, path, kind, repo,
            title: title?.trim() || path.split("/").pop().replace(/\.html$/, "").replace(/-/g, " ") };
        });
      } catch { this.pages = []; }
      cx.notify();
    });
  }

  // Badge counts for the rail, written only when they change.
  publishCounts() {
    const d = this.git.data;
    const counts = {
      prs: this.reviews.length,
      issues: Object.values(this.issues).reduce((n, l) => n + (l?.length ?? 0), 0),
      git: d?.staged ? d.staged.length + d.unstaged.length : 0,
    };
    const all = { ...shared("desk.counts"), ...counts };  // desks publishes its own count
    if (JSON.stringify(all) !== JSON.stringify(shared("desk.counts"))) setShared("desk.counts", all);
  }

  projects() {
    return (props()?.projects ?? []).map((p) => ({ ...p, folder: p.folder.replace(/^~/, home()) }));
  }

  hover(id, on, cx) {
    if (on) this.hovered = id;
    else if (this.hovered === id) this.hovered = null;
    cx.notify();
  }

  refreshStatus(cx) {
    cx.spawn(async (cx) => {
      await Promise.all(this.projects().map(async (p) => {
        try {
          const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "--branch"], { cwd: p.folder });
          const [head = "", ...rest] = r.stdout.split("\n").filter(Boolean);
          this.status[p.name] = {
            branch: head.replace(/^## /, "").split("...")[0],
            dirty: rest.length,
            ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0),
            behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0),
          };
        } catch { this.status[p.name] = null; }
      }));
      cx.notify();
    });
  }

  refreshGitHub(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const json = async (args) => {
        const r = await exec("gh", args);
        if (r.code !== 0) throw new Error(r.stderr.trim());
        return JSON.parse(r.stdout || "[]");
      };
      const projects = this.projects().filter((p) => p.repo);
      const reviews = [], mine = [], issues = {};
      await Promise.all(projects.map(async (p) => {
        try {
          for (const pr of await json(["pr", "list", "-R", p.repo, "--state", "open", "--json", PR_FIELDS])) {
            if (pr.author.login === ME) mine.push({ project: p, repo: p.repo, pr });
            else if (p.reviews && !pr.isDraft) reviews.push({ project: p, repo: p.repo, pr });
          }
        } catch {}
        try {
          issues[p.name] = await json(["issue", "list", "-R", p.repo, "--state", "open", "--limit", "30",
            "--json", "number,title,labels,assignees,updatedAt,url"]);
        } catch { issues[p.name] = null; }
      }));
      // PRs of mine in repos that aren't projects (no CI rollup from search).
      try {
        const known = new Set(projects.map((p) => p.repo.toLowerCase()));
        for (const pr of await json(["search", "prs", "--author", ME, "--state", "open", "--limit", "20",
          "--json", "number,title,repository,url,updatedAt,isDraft"])) {
          const repo = pr.repository.nameWithOwner;
          if (!known.has(repo.toLowerCase())) mine.push({ project: null, repo, pr: { ...pr, author: { login: ME } } });
        }
      } catch {}
      const recent = (a, b) => new Date(b.pr.updatedAt) - new Date(a.pr.updatedAt);
      this.reviews = reviews.sort(recent);
      this.mine = mine.sort(recent);
      this.issues = issues;
      this.fetchedAt = Date.now();
      this.loading = false;
      this.publishCounts();
      cx.notify();
    });
  }

  spaceFor(p) {
    return spaces().find((s) => !s.machine && s.folder && (s.folder === p.folder || s.folder.startsWith(p.folder + "/")));
  }

  openProject(p) {
    const s = this.spaceFor(p);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { name: p.name, folder: p.folder });
  }

  agent(p, name, task) {
    const s = this.spaceFor(p);
    if (s) {
      run("space.select", { id: s.id });
      run("tab.new", { space: s.id, name, folder: p.folder, argv: ["claude"], task });
    } else {
      run("space.new", { name: p.name, folder: p.folder, argv: ["claude"], task });
    }
    notify({ title: name, body: p.name, level: "info", timeout: 2500 });
  }

  // Reviews go to the Reviewer role (its own model and prompt) when roles.json has one.
  review(p, repo, pr) {
    const reviewer = this.desks.roles.byId("reviewer");
    if (!reviewer) return this.agent(p, `review #${pr.number}`, REVIEW(repo, pr));
    startRole(reviewer, { project: p, space: this.spaceFor(p), task: REVIEW(repo, pr), roles: this.desks.roles.list });
  }

  select(tab, cx) {
    setShared("desk.tab", tab);
    if (tab === "git") this.git.refresh(cx);
    if (tab === "pages") this.refreshPages(cx);
    if (tab === "desks") this.desks.reload(cx);
    cx.notify();
  }

  toggle(key, cx) {
    this.collapsed[key] = !this.collapsed[key];
    store.set("collapsed", this.collapsed);
    cx.notify();
  }

  // ── header ────────────────────────────────────────────────────────────────

  header(t) {
    const tab = TABS.find((x) => x.id === this.tab);
    const iconButton = (id, name, tip, onClick, spin) =>
      div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(tip).on_click(onClick).child(spin ? icon(name, 13).text_color(t.muted).spin(900) : icon(name, 13).text_color(t.muted));
    return h_flex().flex_none().h(42).pl(14).pr(8).gap(4).items_center().border_b(1).border_color(t.border)
      .child(icon(tab.icon, 14).text_color(t.accent))
      .child(div().ml(4).text_size(13).font_semibold().text_color(t.foreground).child(tab.label))
      .child(div().flex_1())
      .when(Boolean(this.fetchedAt), (el) => el.child(div().mr(2).text_size(11).text_color(t.dim)
        .child(this.loading ? "syncing" : `synced ${ago(new Date(this.fetchedAt))}`)))
      .child(iconButton("refresh", "refresh", "Refresh",
        (_e, cx) => { this.refreshStatus(cx); this.refreshGitHub(cx); this.git.refresh(cx); this.refreshPages(cx); }, this.loading))
      .child(iconButton("collapse", "collapse", "Collapse (⌘⇧J)", () => setOpen(false)));
  }

  // ── pages ─────────────────────────────────────────────────────────────────

  pagesView(t) {
    if (!this.pages) return empty(t, "Finding pages…");
    const groups = [
      ["throughline", "Throughline reviews", "pr"],
      ["explainer", "Explainers", "sparkles"],
      ["lesson", "Course lessons", "book"],
    ];
    return v_flex().py(8).children(groups.map(([kind, title, iconName]) => {
      const key = `pages-${kind}`, open = !this.collapsed[key], all = this.pages.filter((p) => p.kind === kind);
      const shown = this.collapsed[`${key}-more`] ? all : all.slice(0, 8);
      return v_flex().pb(4)
        .child(section(t, key, title, all.length, open, (_e, cx) => this.toggle(key, cx)))
        .when(open && !all.length, (el) => el.child(empty(t, "None yet.")))
        .when(open, (el) => el.children(shown.map((p) => {
          const id = `pg-${p.path}`, hovered = this.hovered === id;
          return h_flex().id(id).mx(8).px(8).py(6).gap(10).items_start().rounded(8).cursor_pointer()
            .when(hovered, (el) => el.bg(t.hover))
            .on_hover((h, cx) => this.hover(id, h, cx))
            .on_click(() => exec("open", [p.path]))
            .child(div().pt(1).child(icon(iconName, 14).text_color(kind === "throughline" ? t.accent : kind === "lesson" ? t.ansi5 : t.blocked)))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(12.5).line_height(1.35).text_color(t.foreground).child(p.title))
              .child(div().text_size(11).text_color(t.dim).truncate()
                .child([p.repo, ago(new Date(p.mtime)) + " ago"].filter(Boolean).join(" · "))));
        })))
        .when(open && all.length > 8, (el) => el.child(div().id(`${key}-more`).mx(16).py(4).text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click((_e, cx) => this.toggle(`${key}-more`, cx))
          .child(this.collapsed[`${key}-more`] ? "Show fewer" : `Show all ${all.length}`)));
    }));
  }

  // ── projects ──────────────────────────────────────────────────────────────

  projectsView(t) {
    return v_flex().py(8).gap(2).children(this.projects().map((p) => {
      const g = this.status[p.name], space = this.spaceFor(p), id = `p-${p.name}`, hovered = this.hovered === id;
      const prs = this.reviews.filter((r) => r.project === p || r.project?.name === p.name).length;
      const mine = this.mine.filter((r) => r.project?.name === p.name).length;
      const issues = this.issues[p.name]?.length ?? 0;
      const tile = tileColor(t, p.name);
      const counts = [prs && `${prs} to review`, mine && `${mine} mine`, issues && `${issues} issues`].filter(Boolean).join(" · ");
      return card(t, id, hovered).cursor_pointer()
        .on_hover((h, cx) => this.hover(id, h, cx))
        .on_click(() => this.openProject(p))
        .child(h_flex().gap(10).items_center()
          .child(div().size(30).flex_none().rounded(8).flex().items_center().justify_center()
            .bg(tile + "26").text_color(tile).text_size(13).font_semibold().child(p.name[0].toUpperCase()))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(6).items_center()
              .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(space?.active ? t.foreground : t.muted).child(p.name))
              .when(Boolean(space?.status), (el) => el.child(pill(t, space.status, t[space.status]))))
            .child(h_flex().gap(5).items_center().text_size(11).text_color(t.dim)
              .child(icon("branch", 11))
              .child(div().min_w(0).truncate().child(g ? g.branch : "—"))
              .when(Boolean(g?.dirty), (el) => el.child(pill(t, `${g.dirty} changed`, t.blocked)))
              .when(Boolean(g?.ahead), (el) => el.child(pill(t, `↑${g.ahead}`, t.ansi2)))
              .when(Boolean(g?.behind), (el) => el.child(pill(t, `↓${g.behind}`, t.ansi4))))))
        .when(Boolean(counts) || hovered, (el) => el.child(h_flex().pl(40).gap(6).items_center().min_h(24)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(counts))
          .when(hovered, (el) => el
            .child(button(t, `${id}-git`, null, (_e, cx) => { this.git.pin = p.name; this.git.data = null; this.select("git", cx); }, { iconName: "branch", tip: "Git" }))
            .child(button(t, `${id}-resume`, "Resume", () => this.agent(p, "where were we", RESUME), { iconName: "history" })))));
    }));
  }

  // ── pull requests ─────────────────────────────────────────────────────────

  prRow(t, item, review) {
    const { pr, repo, project } = item, id = `pr-${repo}-${pr.number}`, hovered = this.hovered === id;
    const ci = checks(pr.statusCheckRollup);
    const state = pr.isDraft ? t.dim : pr.reviewDecision === "APPROVED" ? t.ansi2 : pr.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : t.accent;
    const meta = [review ? pr.author.login : null, repo.split("/")[1], pr.headRefName, pr.updatedAt && ago(pr.updatedAt)].filter(Boolean).join(" · ");
    return card(t, id, hovered).cursor_pointer()
      .on_hover((h, cx) => this.hover(id, h, cx))
      .on_click(() => exec("open", [pr.url]))
      .child(h_flex().gap(8).items_start()
        .child(div().pt(2).child(icon("pr", 14).text_color(state)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(12.5).text_color(t.foreground).line_height(1.35).child(`${pr.title}`))
          .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
            .child(div().flex_none().child(`#${pr.number}`))
            .child(div().min_w(0).truncate().child(meta)))
          .child(h_flex().gap(5).items_center()
            .when(pr.additions !== undefined, (el) => el
              .child(div().text_size(11).text_color(t.ansi2).child(`+${pr.additions}`))
              .child(div().text_size(11).text_color(t.ansi1).child(`−${pr.deletions}`)))
            .when(ci === "pass", (el) => el.child(pill(t, "checks ✓", t.ansi2)))
            .when(ci === "fail", (el) => el.child(pill(t, "checks ✗", t.ansi1)))
            .when(ci === "pending", (el) => el.child(pill(t, "checks …", t.blocked)))
            .when(pr.reviewDecision === "APPROVED", (el) => el.child(pill(t, "approved", t.ansi2)))
            .when(pr.reviewDecision === "CHANGES_REQUESTED", (el) => el.child(pill(t, "changes requested", t.ansi1)))
            .when(Boolean(pr.isDraft), (el) => el.child(pill(t, "draft", t.dim)))
            .child(div().flex_1())
            .when(hovered && Boolean(project), (el) => el.child(review
              ? button(t, `${id}-a`, "Review", () => this.review(project, repo, pr), { iconName: "sparkles" })
              : button(t, `${id}-a`, "Follow up", () => this.agent(project, `#${pr.number} follow-up`, FOLLOW_UP(repo, pr)), { iconName: "sparkles" }))))));
  }

  prsView(t) {
    const k1 = "prs-review", k2 = "prs-mine";
    return v_flex().py(8)
      .child(section(t, k1, "Needs your review", this.reviews.length, !this.collapsed[k1], (_e, cx) => this.toggle(k1, cx)))
      .when(!this.collapsed[k1], (el) => this.reviews.length
        ? el.children(this.reviews.map((r) => this.prRow(t, r, true)))
        : el.child(empty(t, this.loading ? "Loading…" : "Nothing waiting on you.")))
      .child(div().h(6))
      .child(section(t, k2, "Yours", this.mine.length, !this.collapsed[k2], (_e, cx) => this.toggle(k2, cx)))
      .when(!this.collapsed[k2], (el) => this.mine.length
        ? el.children(this.mine.map((r) => this.prRow(t, r, false)))
        : el.child(empty(t, this.loading ? "Loading…" : "No open PRs.")));
  }

  // ── issues ────────────────────────────────────────────────────────────────

  issuesView(t) {
    const filter = h_flex().mx(12).mt(10).mb(4).p(2).gap(2).rounded(7).bg(t.raised).border_1().border_color(t.border)
      .children([["all", "All open"], ["mine", "Assigned to me"]].map(([k, label]) => {
        const on = this.issueFilter === k;
        return div().id(`if-${k}`).flex_1().h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_size(11).bg(on ? t.background : "#00000000").text_color(on ? t.foreground : t.muted)
          .on_click((_e, cx) => { this.issueFilter = k; store.set("issueFilter", k); cx.notify(); }).child(label);
      }));
    const groups = this.projects().filter((p) => p.repo).map((p) => {
      const all = this.issues[p.name];
      const list = (all ?? []).filter((i) => this.issueFilter === "all" || i.assignees.some((a) => a.login === ME));
      return { p, list, failed: all === null };
    }).filter((g) => g.list.length || g.failed);
    const body = groups.length ? groups.map(({ p, list, failed }) => {
      const key = `iss-${p.name}`, open = !this.collapsed[key];
      return v_flex()
        .child(section(t, key, p.name, failed ? "!" : list.length, open, (_e, cx) => this.toggle(key, cx)))
        .when(open && failed, (el) => el.child(empty(t, "Couldn't load issues (are they enabled?)")))
        .when(open, (el) => el.children(list.map((i) => {
          const id = `i-${p.name}-${i.number}`, hovered = this.hovered === id;
          return card(t, id, hovered).cursor_pointer()
            .on_hover((h, cx) => this.hover(id, h, cx))
            .on_click(() => exec("open", [i.url]))
            .child(h_flex().gap(8).items_start()
              .child(div().pt(2).child(icon("issue", 14).text_color(t.ansi2)))
              .child(v_flex().flex_1().min_w(0).gap(4)
                .child(div().text_size(12.5).text_color(t.foreground).line_height(1.35).child(i.title))
                .child(h_flex().gap(5).items_center().flex_wrap()
                  .child(div().text_size(11).text_color(t.dim).child(`#${i.number} · ${ago(i.updatedAt)}`))
                  .children(i.labels.slice(0, 3).map((l) => pill(t, l.name, `#${l.color}`).text_color(t.muted).bg(`#${l.color}40`)))
                  .when(i.assignees.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`@${i.assignees.map((a) => a.login).join(", @")}`)))
                  .child(div().flex_1())
                  .when(hovered, (el) => el.child(button(t, `${id}-w`, "Work on it", () => this.agent(p, `#${i.number}`, WORK(p.repo, i)), { iconName: "sparkles" }))))));
        })));
    }) : [empty(t, this.loading ? "Loading…" : this.issueFilter === "mine" ? "Nothing assigned to you." : "No open issues.")];
    return v_flex().pb(8).child(filter).children(body);
  }

  render(cx) {
    const t = theme();
    const view = { inbox: () => inboxView(this, t), desks: () => this.desks.render(t), projects: () => this.projectsView(t), prs: () => this.prsView(t),
      issues: () => this.issuesView(t), git: () => this.git.render(t, cx), pages: () => this.pagesView(t) }[this.tab];
    return v_flex().id("desk").size_full().bg(t.chrome).text_color(t.foreground)
      .child(this.header(t))
      // Desks scroll their own thread and keep the composer at the bottom.
      .child(this.tab === "desks" ? v_flex().flex_1().min_h(0).child(view())
        : div().id("desk-body").flex_1().min_h(0).overflow_y_scrollbar().child(view()));
  }
}
