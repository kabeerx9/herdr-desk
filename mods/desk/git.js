import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, spaces, panes, focused, run, notify } from "herdr";
import { icon, pill, button, section, empty } from "./ui.js";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const PAGER = ["-c", "core.pager=less -R", "-c", "color.ui=always"];
const AI_PROMPT = "Write one git commit subject for this diff: imperative mood, under 60 characters, " +
  "no trailing period, no quotes, no prefix like feat:. Output only the subject.";

// Where the focused terminal is, as the shipped changes panel finds it.
function focusedCwd() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

function parseStatus(out) {
  const [head = "", ...entries] = out.split("\0").filter(Boolean);
  const h = head.replace(/^## /, "");
  const [branch, rest = ""] = h.split("...");
  const upstream = rest.split(" ")[0] || null;
  const staged = [], unstaged = [];
  for (const e of entries) {
    const x = e[0], y = e[1], path = e.slice(3);
    if (e.startsWith("??")) { unstaged.push({ path, code: "U", fresh: true }); continue; }
    if (x !== " ") staged.push({ path, code: x });
    if (y !== " ") unstaged.push({ path, code: y });
  }
  return {
    branch: branch.replace(/^No commits yet on /, ""), upstream,
    ahead: Number(/ahead (\d+)/.exec(h)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(h)?.[1] ?? 0),
    staged, unstaged,
  };
}

export class GitPanel {
  constructor(desk, cx) {
    this.desk = desk;
    this.pin = null;
    this.data = null;
    this.open = { staged: true, changes: true, branches: false, history: true };
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message  (⏎ to commit)" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  cwd() {
    const p = this.pin && this.desk.projects().find((p) => p.name === this.pin);
    return p ? p.folder : focusedCwd();
  }

  refresh(cx) {
    const cwd = this.cwd();
    if (!cwd || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
        if (top.code !== 0) { this.data = { error: "Not a git repository", cwd }; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root });
        const [status, log, branches] = await Promise.all([
          git(["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all"]),
          git(["log", "-15", "--format=%h%x1f%s%x1f%cr%x1f%an"]),
          git(["for-each-ref", "--sort=-committerdate", "--count=10", "--format=%(refname:short)%1f%(committerdate:relative)", "refs/heads"]),
        ]);
        this.data = {
          root, name: root.split("/").pop(), ...parseStatus(status.stdout),
          commits: log.stdout.split("\n").filter(Boolean).map((l) => { const [hash, subject, when, author] = l.split("\x1f"); return { hash, subject, when, author }; }),
          branches: branches.stdout.split("\n").filter(Boolean).map((l) => { const [name, when] = l.split("\x1f"); return { name, when }; }),
        };
      } catch (e) {
        this.data = { error: String(e), cwd };
      } finally {
        this.loading = false;
        this.desk.publishCounts();
        cx.notify();
      }
    });
  }

  // Runs git commands in order; stops and reports on the first failure.
  act(cx, label, steps, after) {
    if (this.busy || !this.data?.root) return;
    const root = this.data.root;
    this.busy = label; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" "));
        }
        after?.();
      } catch (e) {
        this.note = `${label} failed: ${e.message ?? e}`;
      } finally {
        this.busy = null;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  commit(cx) {
    const d = this.data, message = this.message.trim();
    if (!message || !d?.root || (!d.staged.length && !d.unstaged.length)) return;
    // Nothing staged: commit everything, like the shipped Changes panel.
    const steps = d.staged.length ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
    this.act(cx, "Commit", steps, () => { this.message = ""; this.input.set_value(""); });
  }

  push(cx) {
    const d = this.data;
    this.act(cx, "Push", [d.upstream ? ["push"] : ["push", "-u", "origin", d.branch]]);
  }

  suggest(cx) {
    const d = this.data;
    if (!d?.root || this.generating) return;
    this.generating = true; this.note = null;
    const diff = d.staged.length ? "git diff --cached" : "git diff HEAD";
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", `${diff} | head -c 60000 | claude -p --model haiku "$1"`, "sh", AI_PROMPT], { cwd: d.root });
        const line = r.stdout.trim().split("\n").pop()?.replace(/^["'`]|["'`]$/g, "");
        if (r.code !== 0 || !line) throw new Error(r.stderr.trim() || "no answer");
        this.message = line; this.input.set_value(line);
      } catch (e) {
        this.note = `Couldn't write a message: ${e.message ?? e}`;
      } finally {
        this.generating = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Opens a diff or commit in a terminal beside the focused pane; quitting less closes it.
  view(argv) {
    run("terminal.open", { argv, folder: this.data.root, place: focused()?.pane ? "right" : "tab" });
  }

  fileRow(t, f, staged) {
    const id = `${staged ? "s" : "u"}-${f.path}`, hovered = this.desk.hovered === id;
    const parts = f.path.split("/"), name = parts.pop();
    const color = f.code === "D" ? t.ansi1 : f.code === "A" || f.fresh ? t.ansi2 : f.code === "U" && !f.fresh ? t.ansi1 : t.blocked;
    const diff = f.fresh ? ["less", "-R", f.path] : ["git", ...PAGER, "diff", ...(staged ? ["--cached"] : []), "--", f.path];
    return h_flex().id(id).h(26).mx(8).px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(hovered, (el) => el.bg(t.hover))
      .on_hover((h, cx) => this.desk.hover(id, h, cx))
      .on_click(() => this.view(diff))
      .child(div().w(14).flex_none().text_size(11).font_semibold().text_color(color).child(f.fresh ? "?" : f.code))
      .child(h_flex().flex_1().min_w(0).text_size(12.5)
        .child(div().flex_none().text_color(t.foreground).child(name))
        .child(div().ml(6).min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(hovered, (el) => el.child(button(t, `${id}-x`, null,
        (_e, cx) => this.act(cx, staged ? "Unstage" : "Stage", [staged ? ["restore", "--staged", "--", f.path] : ["add", "--", f.path]]),
        { iconName: staged ? "minus" : "plus", tip: staged ? "Unstage" : "Stage" })));
  }

  render(t, cx) {
    const d = this.data;
    const projects = this.desk.projects();
    const picker = h_flex().px(12).pt(10).pb(6).gap(4).flex_wrap()
      .children([{ name: null, label: "Focused" }, ...projects.map((p) => ({ name: p.name, label: p.name }))].map((o) => {
        const on = this.pin === o.name;
        return div().id(`pin-${o.label}`).h(22).px(8).flex().items_center().rounded(11).text_size(11).cursor_pointer()
          .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.input : t.border)
          .on_click((_e, cx) => { this.pin = o.name; this.data = null; this.refresh(cx); cx.notify(); }).child(o.label);
      }));
    if (!d) return v_flex().child(picker).child(empty(t, this.loading ? "Reading git…" : "Focus a terminal in a repo, or pick a project."));
    if (d.error) return v_flex().child(picker).child(empty(t, `${d.error}${d.cwd ? ` · ${d.cwd.replace(/^\/Users\/[^/]+/, "~")}` : ""}`));

    const total = d.staged.length + d.unstaged.length;
    const canCommit = Boolean(this.message.trim()) && total > 0 && !this.busy;
    const head = v_flex().mx(8).p(10).gap(8).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(icon("branch", 14).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(d.branch))
        .when(d.behind > 0, (el) => el.child(pill(t, `↓${d.behind}`, t.ansi4)))
        .when(d.ahead > 0, (el) => el.child(pill(t, `↑${d.ahead}`, t.ansi2))))
      .child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${d.name} · ${d.upstream ?? "no upstream"}${total ? ` · ${total} changed` : " · clean"}`))
      .child(h_flex().gap(6)
        .child(button(t, "g-fetch", "Fetch", (_e, cx) => this.act(cx, "Fetch", [["fetch", "--prune"]]), { iconName: "fetch", disabled: Boolean(this.busy) }))
        .child(button(t, "g-pull", "Pull", (_e, cx) => this.act(cx, "Pull", [["pull", "--ff-only"]]), { iconName: "down", disabled: Boolean(this.busy) || !d.upstream }))
        .child(button(t, "g-push", "Push", (_e, cx) => this.push(cx), { iconName: "up", disabled: Boolean(this.busy) || (d.upstream && !d.ahead), primary: d.ahead > 0 || !d.upstream }))
        .child(div().flex_1())
        .when(Boolean(this.busy), (el) => el.child(icon("refresh", 13).text_color(t.dim).spin(900))));

    const composer = v_flex().mx(8).mt(8).gap(6)
      .child(h_flex().h(32).px(10).items_center().rounded(8).bg(t.background).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .id("g-msg").on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(button(t, "g-ai", this.generating ? "Writing…" : "Write message", (_e, cx) => this.suggest(cx), { iconName: "sparkles", disabled: this.generating || !total }))
        .child(div().flex_1())
        .child(button(t, "g-commit", d.staged.length ? `Commit ${d.staged.length}` : total ? `Commit all ${total}` : "Commit",
          (_e, cx) => this.commit(cx), { iconName: "commit", primary: true, disabled: !canCommit })));

    const toggle = (k) => (_e, cx) => { this.open[k] = !this.open[k]; cx.notify(); };
    return v_flex().pb(12)
      .child(picker)
      .child(head)
      .child(composer)
      .when(Boolean(this.note), (el) => el.child(div().mx(12).mt(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(div().h(6))
      .when(d.staged.length > 0, (el) => el
        .child(section(t, "g-staged", "Staged", d.staged.length, this.open.staged, toggle("staged"),
          button(t, "g-unstage-all", null, (_e, cx) => this.act(cx, "Unstage", [["restore", "--staged", "--", "."]]), { iconName: "minus", tip: "Unstage all" })))
        .when(this.open.staged, (el) => el.children(d.staged.map((f) => this.fileRow(t, f, true)))))
      .child(section(t, "g-changes", "Changes", d.unstaged.length, this.open.changes, toggle("changes"),
        d.unstaged.length ? button(t, "g-stage-all", null, (_e, cx) => this.act(cx, "Stage", [["add", "-A"]]), { iconName: "plus", tip: "Stage all" }) : null))
      .when(this.open.changes, (el) => el.when(!d.unstaged.length, (el) => el.child(div().px(30).py(4).text_size(12).text_color(t.dim).child("Working tree clean")))
        .children(d.unstaged.map((f) => this.fileRow(t, f, false))))
      .child(section(t, "g-branches", "Branches", d.branches.length, this.open.branches, toggle("branches")))
      .when(this.open.branches, (el) => el.children(d.branches.map((b) => {
        const id = `b-${b.name}`, current = b.name === d.branch, hovered = this.desk.hovered === id;
        return h_flex().id(id).h(26).mx(8).px(6).gap(6).items_center().rounded(6)
          .when(hovered && !current, (el) => el.bg(t.hover).cursor_pointer())
          .on_hover((h, cx) => this.desk.hover(id, h, cx))
          .on_click((_e, cx) => { if (!current) this.act(cx, "Checkout", [["switch", b.name]]); })
          .child(icon("branch", 12).text_color(current ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(current ? t.foreground : t.muted).when(current, (el) => el.font_semibold()).child(b.name))
          .child(div().text_size(11).text_color(t.dim).child(b.when.replace(/ ago$/, "")));
      })))
      .child(section(t, "g-history", "History", null, this.open.history, toggle("history")))
      .when(this.open.history, (el) => el.children(d.commits.map((c, i) => {
        const id = `c-${c.hash}`, hovered = this.desk.hovered === id;
        return h_flex().id(id).mx(8).px(6).py(4).gap(8).items_start().rounded(6).cursor_pointer()
          .when(hovered, (el) => el.bg(t.hover))
          .on_hover((h, cx) => this.desk.hover(id, h, cx))
          .on_click(() => this.view(["git", ...PAGER, "show", "--stat", "-p", c.hash]))
          .child(v_flex().pt(4).items_center().child(div().size(7).rounded(4).bg(i === 0 ? t.accent : t.border)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(12.5).text_color(t.foreground).child(c.subject))
            .child(div().text_size(11).text_color(t.dim).truncate().child(`${c.hash} · ${c.author} · ${c.when.replace(/ ago$/, "")}`)));
      })));
  }
}
