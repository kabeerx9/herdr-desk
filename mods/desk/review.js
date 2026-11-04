import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, appHome, home, readTextFile, setShared } from "herdr";
import { button, empty, icon, pill, section } from "./ui.js";

const MODES = ["working", "staged", "branch"];
const label = (mode) => ({ working: "Working", staged: "Staged", branch: "Branch" }[mode]);
const short = (path) => path.split("/").at(-1);
const clip = (text, limit = 700) => text.length > limit ? `${text.slice(0, limit)}…` : text;

// A focused, read-only diff pane. The parent decides where it is rendered and gives it a session
// target; request() only drafts a message in the Desk composer, it never sends one.
export class ReviewView {
  init(cx) {
    this.mode = "working"; this.data = null; this.target = null; this.selected = null;
    this.loading = false; this.error = null; this.filesOpen = true; this.reportsOpen = false;
    this.reports = []; this.sequence = 0; this.hunk = null;
  }

  open(target, cx) {
    this.target = target;
    this.selected = null; this.hunk = null; this.data = null;
    this.refresh(cx);
  }

  refresh(cx) {
    if (!this.target?.repo) return;
    const sequence = ++this.sequence;
    this.loading = true; this.error = null;
    const args = [`${appHome()}/bin/desk_review.py`, "--repo", this.target.repo, "--mode", this.mode];
    if (this.selected) args.push("--path", this.selected);
    cx.spawn(async (cx) => {
      try {
        const result = await exec("python3", args);
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
        const data = JSON.parse(result.stdout);
        const reports = await this.readReports();
        if (sequence !== this.sequence) return;
        this.data = data; this.reports = reports;
      } catch (error) {
        if (sequence !== this.sequence) return;
        this.error = String(error?.message ?? error);
        this.data = null;
      } finally {
        if (sequence !== this.sequence) return;
        this.loading = false;
        cx.notify();
      }
    });
  }

  async readReports() {
    let messages = this.target?.messages ?? [];
    if (this.target?.task) {
      try {
        const text = await readTextFile(`${home()}/.herdr/team/${this.target.task}.jsonl`);
        messages = String(text ?? "").split("\n").filter(Boolean).slice(-80).map((line) => JSON.parse(line));
      } catch {}
    }
    return messages.filter((m) => ["done", "blocked", "flag", "say"].includes(m.kind) && m.from !== "kabeer")
      .slice(-6).map((m) => ({ from: m.from, kind: m.kind, text: clip(m.text ?? "", 420) }));
  }

  choose(path, cx) {
    this.selected = this.selected === path ? null : path;
    this.hunk = null; this.data = null;
    this.refresh(cx);
  }

  request(kind) {
    if (!this.target) return;
    const scope = this.hunk ? ` for \`${this.selected}\` at ${this.hunk.header}` : this.selected ? ` for \`${this.selected}\`` : " for the selected changes";
    const excerpt = clip(this.hunk?.text ?? this.data?.diff ?? "", 1600);
    const instruction = kind === "fix" ? `Please investigate and fix the review finding${scope}.` : `Explain the reasoning behind these changes${scope}.`;
    const text = `${instruction}\n\nReview context:\n\`\`\`diff\n${excerpt}\n\`\`\``;
    setShared("desk.compose", { task: this.target.task, address: this.target.address, role: this.target.role, text, at: Date.now() });
    if (this.target.task) setShared("desk.view", this.target.task);
    setShared("desk.tab", "desks");
    setShared("desk.review", null);
  }

  fileRow(t, file) {
    const selected = this.selected === file.path;
    const color = file.status === "deleted" ? t.ansi1 : file.status === "added" || file.status === "untracked" ? t.ansi2 : t.accent;
    const count = file.binary ? "binary" : `${file.added ? `+${file.added}` : ""}${file.removed ? ` −${file.removed}` : ""}` || "changed";
    return h_flex().id(`review-file-${file.path}`).h(30).px(8).gap(7).items_center().rounded(6).cursor_pointer()
      .bg(selected ? t.selected : "#00000000").hover((el) => el.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => this.choose(file.path, cx))
      .child(div().w(6).h(18).rounded(3).bg(color))
      .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).child(short(file.path)))
      .child(div().min_w(0).w(110).truncate().text_size(10.5).text_color(t.dim).child(file.path === short(file.path) ? "" : file.path.slice(0, -short(file.path).length)))
      .child(div().flex_none().text_size(10.5).text_color(color).child(count));
  }

  diffRows(t, text) {
    const lines = text.split("\n");
    const rows = []; let active = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith("@@")) {
        active = { header: line, text: line };
        const hunk = active;
        const selected = this.hunk?.header === line;
        rows.push(div().id(`review-hunk-${index}`).px(6).py(3).rounded(4).cursor_pointer().bg(selected ? t.selected : t.raised)
          .text_size(10.5).font_medium().text_color(t.accent).child(line)
          .on_click((_e, cx) => { this.hunk = selected ? null : hunk; cx.notify(); }));
        continue;
      }
      if (active) active.text += `\n${line}`;
      const color = line.startsWith("+") ? t.ansi2 : line.startsWith("-") ? t.ansi1 : line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---") ? t.muted : t.foreground;
      rows.push(div().px(6).text_size(10.5).line_height(1.35).text_color(color).child(line || " "));
    }
    return rows;
  }

  render(t) {
    const data = this.data;
    const head = h_flex().px(10).py(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(icon("branch", 14).text_color(t.accent))
      .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(data?.root?.split("/").at(-1) ?? this.target?.repo?.split("/").at(-1) ?? "Review"))
      .child(button(t, "review-back", "Chat", () => setShared("desk.review", null), { iconName: "back", tip: "Back to chat" }))
      .children(MODES.map((mode) => button(t, `review-${mode}`, label(mode), (_e, cx) => { this.mode = mode; this.selected = null; this.hunk = null; this.data = null; this.refresh(cx); }, { primary: this.mode === mode, disabled: this.loading })))
      .child(button(t, "review-refresh", null, (_e, cx) => this.refresh(cx), { iconName: "refresh", tip: "Refresh review" }));
    if (this.loading) return v_flex().size_full().child(head).child(empty(t, "Reading changes…"));
    if (this.error) return v_flex().size_full().child(head).child(empty(t, this.error));
    if (!data) return v_flex().size_full().child(head).child(empty(t, "Pick an agent or worktree to review."));
    const action = h_flex().px(10).py(7).gap(6).border_b(1).border_color(t.border)
      .child(button(t, "review-explain", "Explain", () => this.request("explain"), { disabled: !data.diff, tip: "Draft a question in the Desk chat" }))
      .child(button(t, "review-fix", "Ask to fix", () => this.request("fix"), { primary: true, disabled: !data.diff, tip: "Draft a fix request in the Desk chat" }))
      .child(div().flex_1())
      .when(data.truncated, (el) => el.child(pill(t, "Diff truncated", t.blocked)));
    const files = v_flex().max_h(190).overflow_y_scrollbar()
      .child(section(t, "review-files", "Files", data.files.length, this.filesOpen, (_e, cx) => { this.filesOpen = !this.filesOpen; cx.notify(); }))
      .when(this.filesOpen, (el) => el.children(data.files.map((file) => this.fileRow(t, file))));
    const diff = v_flex().flex_1().min_h(0).px(10).py(8).overflow_y_scrollbar().bg(t.background)
      .children(data.diff ? this.diffRows(t, data.diff) : [div().text_size(11).text_color(t.dim).child("No changes in this view.")]);
    const reports = this.reports.length ? v_flex().max_h(140).overflow_y_scrollbar()
      .child(section(t, "review-reports", "Reports", this.reports.length, this.reportsOpen, (_e, cx) => { this.reportsOpen = !this.reportsOpen; cx.notify(); }))
      .when(this.reportsOpen, (el) => el.px(10).pb(8).gap(5).children(this.reports.map((report) =>
        div().rounded(6).px(8).py(6).bg(t.raised).text_size(11.5).line_height(1.35).text_color(t.muted).child(`${report.from}: ${report.text}`)))) : null;
    return v_flex().size_full().min_h(0).child(head).child(action).child(files).child(diff).when(Boolean(reports), (el) => el.child(reports));
  }
}
