import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { exec, appHome, home, readTextFile, writeTextFile, setShared, notify } from "herdr";
import { button, empty, icon, section, ROW } from "./ui.js";
import { runTeam } from "./workflows.js";

// The review pane: one agent's changes as a diff you can comment on, line by line, then send
// back as one batch (bin/team review-send). Modes: Last turn (since the agent's turn began:
// refs/worktree/desk/turn-base), Working, Staged, Branch. Keys while the pane has focus:
// j/k files, ]/[ hunks, c comment, n/N comments, s send, Esc cancels a comment.
// Click a line number to comment on it; shift-click another to cover the range.

const MODES = [["turn", "Last turn"], ["working", "Working"], ["staged", "Staged"], ["branch", "Branch"]];
const WINDOW = 500;   // diff rows drawn at once, from the current position
const short = (path) => path.split("/").at(-1);
const clip = (text, limit = 700) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const span = (c) => c.start === c.end ? `L${c.start}` : `L${c.start}-L${c.end}`;

// The diff, read once per load: every line with its file, side and numbers, plus where each
// file and hunk starts.
function parseDiff(text) {
  const lines = [], hunks = [], files = new Map();
  let path = null, old = 0, now = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = / b\/(.*)$/.exec(raw)?.[1] ?? path;
      if (!files.has(path)) files.set(path, lines.length);
      lines.push({ kind: "file", text: path, path });
      continue;
    }
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || /^(index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(raw)) {
      if (raw.startsWith("Binary files")) lines.push({ kind: "meta", text: raw, path });
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      old = Number(h[1]); now = Number(h[2]);
      hunks.push(lines.length);
      lines.push({ kind: "hunk", text: raw, path });
      continue;
    }
    if (path === null) continue;
    if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), path, new: now++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), path, old: old++ });
    else if (raw.startsWith("\\")) lines.push({ kind: "meta", text: raw, path });
    else if (raw.startsWith(" ") || raw === "") { if (raw === "" && !lines.length) continue; lines.push({ kind: "ctx", text: raw.slice(1), path, old: old++, new: now++ }); }
    else lines.push({ kind: "meta", text: raw, path });
  }
  return { lines, hunks, files };
}
// A line's comment anchor: the new side when it has one, else the old.
const anchor = (l) => (l.new !== undefined ? { side: "new", n: l.new } : l.old !== undefined ? { side: "old", n: l.old } : null);

// A read-only diff with line comments. The parent decides where it is rendered and gives it a
// session target; Explain / Ask to fix only draft a message in the Desk composer.
export class ReviewView {
  init(cx) {
    this.mode = "working"; this.data = null; this.target = null; this.selected = null;
    this.loading = false; this.error = null; this.filesOpen = true; this.reportsOpen = false;
    this.reports = []; this.sequence = 0; this.hunk = null;
    this.parsed = null; this.from = 0;           // first diff row drawn
    this.noTurn = false;                         // the runtime has no --mode turn yet
    this.comments = []; this.current = -1;       // [{ id, path, side, start, end, text, excerpt }]
    this.draft = null; this.pick = null;         // the comment being written; the last clicked line
    this.sending = false; this.failed = null;    // { error, file } after a send that didn't go
    this.commentsOpen = true;
    this.focus = cx.focus_handle();
    this.box = TextareaState.new({ placeholder: "Comment on these lines. Enter saves, Shift+Enter for a new line", rows: 2 });
    this.box.set_auto_grow(2, 8);
    this.box.on("submit", (e, cx) => { if (!e.shift) this.saveDraft(cx); });
    this.box.on("change", (_e, cx) => cx.notify());
  }

  open(target, cx) {
    const same = this.target?.address && this.target.address === target?.address;
    this.target = target;
    this.selected = null; this.hunk = null; this.data = null; this.parsed = null; this.from = 0; this.draft = null;
    if (!same) { this.comments = []; this.current = -1; this.failed = null; }
    // From an agent: what it just did. From a worktree: everything uncommitted.
    if (target?.address && !this.noTurn) this.mode = "turn";
    this.focus.focus();
    this.refresh(cx);
  }

  setMode(mode, cx) {
    this.mode = mode; this.selected = null; this.hunk = null; this.data = null; this.from = 0; this.draft = null;
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
        if (result.code !== 0) {
          const why = result.stderr.trim() || result.stdout.trim();
          // The runtime doesn't know Last turn yet: hide it and show the working tree.
          if (this.mode === "turn" && /invalid choice/i.test(why)) {
            this.noTurn = true; this.mode = "working"; this.loading = false;
            return this.refresh(cx);
          }
          let message = why; try { message = JSON.parse(why).error ?? why; } catch {}
          throw new Error(message);
        }
        const data = JSON.parse(result.stdout);
        const reports = await this.readReports();
        if (sequence !== this.sequence) return;
        this.data = data; this.reports = reports;
        this.parsed = parseDiff(data.diff ?? "");
        this.from = Math.min(this.from, Math.max(0, this.parsed.lines.length - 1));
        if (this.jumpTo) { const c = this.jumpTo; this.jumpTo = null; this.reveal(c); }
      } catch (error) {
        if (sequence !== this.sequence) return;
        this.error = String(error?.message ?? error);
        this.data = null; this.parsed = null;
      } finally {
        if (sequence === this.sequence) { this.loading = false; cx.notify(); }
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
    this.hunk = null; this.data = null; this.from = 0; this.draft = null;
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

  // ── comments ──────────────────────────────────────────────────────────────

  // A line number was clicked: start a comment there, or with shift, stretch the last pick to here.
  clickLine(index, shift, cx) {
    const l = this.parsed?.lines[index], a = l && anchor(l);
    if (!a) return;
    let from = index;
    if (shift && this.pick !== null && this.parsed.lines[this.pick]?.path === l.path) from = this.pick;
    else this.pick = index;
    const lo = Math.min(from, index), hi = Math.max(from, index);
    this.startDraft(lo, hi, null, cx);
  }

  startDraft(lo, hi, editing, cx) {
    const lines = this.parsed.lines.slice(lo, hi + 1).filter((l) => anchor(l));
    if (!lines.length) return;
    const nums = lines.map((l) => anchor(l)), side = nums.some((x) => x.side === "new") ? "new" : "old";
    const on = nums.filter((x) => x.side === side).map((x) => x.n);
    this.draft = { lo, hi, path: lines[0].path, side, start: Math.min(...on), end: Math.max(...on), editing,
      excerpt: lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`).join("\n").slice(0, 1200) };
    this.box.set_value(editing ? this.comments.find((c) => c.id === editing)?.text ?? "" : "");
    this.box.focus();
    cx.notify();
  }

  saveDraft(cx) {
    const text = this.box.value().trim(), d = this.draft;
    if (!d) return;
    if (!text) { this.draft = null; this.focus.focus(); return cx.notify(); }
    if (d.editing) this.comments = this.comments.map((c) => (c.id === d.editing ? { ...c, text } : c));
    else this.comments = [...this.comments, { id: `c${Date.now()}`, path: d.path, side: d.side, start: d.start, end: d.end, text, excerpt: d.excerpt }]
      .sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
    this.draft = null; this.failed = null;
    this.focus.focus();
    cx.notify();
  }

  edit(c, cx) {
    const at = this.lineOf(c);
    if (at === null) { this.reveal(c, cx); return; }
    this.startDraft(at.lo, at.hi, c.id, cx);
  }
  remove(c, cx) { this.comments = this.comments.filter((x) => x.id !== c.id); this.current = -1; cx.notify(); }

  // Where a comment sits in the loaded diff (rows lo..hi), or null when its file isn't shown.
  lineOf(c) {
    const ls = this.parsed?.lines ?? [];
    let lo = null, hi = null;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i], a = anchor(l);
      if (l.path !== c.path || !a || a.side !== c.side || a.n < c.start || a.n > c.end) continue;
      if (lo === null) lo = i; hi = i;
    }
    return lo === null ? null : { lo, hi };
  }

  // Bring a comment into view: its file loaded, the window starting a little above it.
  reveal(c, cx) {
    const at = this.lineOf(c);
    if (at) { this.from = Math.max(0, at.lo - 3); return cx?.notify(); }
    if (cx && this.selected !== c.path) { this.jumpTo = c; this.selected = c.path; this.data = null; this.from = 0; this.refresh(cx); }
  }

  step(list, dir) { return list.length ? (this.current + dir + list.length) % list.length : -1; }

  batch() {
    if (!this.comments.length) return "";
    return this.comments.map((c) => `### \`${c.path}\` ${c.side === "old" ? "(removed) " : ""}${span(c)}\n\n\`\`\`diff\n${c.excerpt}\n\`\`\`\n\n${c.text}\n`).join("\n");
  }

  // Send the comments (or, with none, an approval) to the agent. The batch is a file under
  // ~/.herdr/team/.review/; on failure it stays there and the comments stay here.
  send(cx) {
    const address = this.target?.address;
    if (!address || this.sending) return;
    const text = this.batch(), dir = `${home()}/.herdr/team/.review`, file = `${dir}/${address}-${Date.now()}.md`;
    const approve = !this.comments.length;
    this.sending = true; this.failed = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", dir]);
        await writeTextFile(file, text, null);
        await runTeam(["review-send", "--address", address, "--file", file]);
        notify({ title: approve ? "Approved" : `Sent ${this.comments.length} comment${this.comments.length === 1 ? "" : "s"}`,
          body: approve ? "The agent was told you approved the changes." : "Pasted into the agent's input; it sends when you press Enter there.", level: "success", timeout: 5000 });
        this.comments = []; this.current = -1;
      } catch (e) {
        this.failed = { error: String(e?.message ?? e), file };
      } finally { this.sending = false; cx.notify(); }
    });
  }

  copyBatch(cx) {
    const file = this.failed?.file;
    if (!file) return;
    cx.spawn(async () => {
      const r = await exec("sh", ["-c", 'pbcopy < "$1"', "copy", file]);
      notify({ title: r.code === 0 ? "Batch copied" : "Couldn't copy", body: r.code === 0 ? "Paste it into the agent's terminal." : file, level: r.code === 0 ? "success" : "error", timeout: 4000 });
    });
  }

  // ── keys ──────────────────────────────────────────────────────────────────

  key(e, cx) {
    if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) return;
    if (this.draft) {
      if (e.key === "escape") { this.draft = null; this.focus.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    const k = e.key_char ?? e.key, p = this.parsed, files = this.data?.files ?? [];
    const hunkAt = () => { let h = -1; for (let i = 0; i < (p?.hunks.length ?? 0); i++) if (p.hunks[i] <= this.from + 3) h = i; return h; };
    if (k === "j" || k === "k") {
      if (!files.length) return;
      const at = files.findIndex((f) => f.path === this.selected);
      const next = files[(at + (k === "j" ? 1 : -1) + files.length) % files.length] ?? files[0];
      if (next.path !== this.selected) this.choose(next.path, cx);
    } else if (k === "]" || k === "[") {
      if (!p?.hunks.length) return;
      const h = hunkAt(), next = k === "]" ? Math.min(p.hunks.length - 1, h + 1) : Math.max(0, h - (p.hunks[h] >= this.from ? 1 : 0));
      this.from = Math.max(0, p.hunks[next] - 1);
    } else if (k === "c") {
      if (!p?.lines.length) return;
      // The first changed line at or after where the view starts.
      let i = this.from; while (i < p.lines.length && !["add", "del"].includes(p.lines[i].kind)) i++;
      if (i >= p.lines.length) i = this.from;
      this.pick = i; this.startDraft(i, i, null, cx);
    } else if (k === "n" || k === "N") {
      if (!this.comments.length) return;
      this.current = this.step(this.comments, k === "n" ? 1 : -1);
      this.reveal(this.comments[this.current], cx);
    } else if (k === "s") {
      if (this.comments.length) this.send(cx);
    } else return;
    cx.stop_propagation(); cx.notify();
  }

  // ── drawing ───────────────────────────────────────────────────────────────

  fileRow(t, file) {
    const selected = this.selected === file.path, n = this.comments.filter((c) => c.path === file.path).length;
    const color = file.status === "deleted" ? t.ansi1 : file.status === "added" || file.status === "untracked" ? t.ansi2 : t.muted;
    return h_flex().id(`review-file-${file.path}`).h(ROW).mx(6).px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .bg(selected ? t.selected : "#00000000").hover((el) => el.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => this.choose(file.path, cx))
      .tooltip(file.path)
      .child(div().w(3).h(14).rounded(2).flex_none().bg(color))
      .child(div().min_w(0).flex_shrink_1().truncate().text_size(12).text_color(t.foreground).child(short(file.path)))
      .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.dim).child(file.path === short(file.path) ? "" : file.path.slice(0, -short(file.path).length)))
      .when(n > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.accent).child(icon("chat", 11)).child(String(n))))
      .child(file.binary ? div().flex_none().text_size(11).text_color(t.dim).child("binary")
        : h_flex().flex_none().gap(4).text_size(11).child(div().text_color(t.ansi2).child(file.added ? `+${file.added}` : ""))
          .child(div().text_color(t.ansi1).child(file.removed ? `−${file.removed}` : "")));
  }

  commentCard(t, c) {
    const on = this.comments[this.current]?.id === c.id;
    return v_flex().id(`rc-${c.id}`).mx(4).my(4).px(10).py(7).gap(4).rounded(8).border_1().border_color(on ? t.accent : t.border).bg(t.raised)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().min_w(0).flex_1().truncate().child(`${short(c.path)} ${span(c)}`))
        .child(button(t, `rc-${c.id}-e`, "Edit", (_e, cx) => this.edit(c, cx)))
        .child(button(t, `rc-${c.id}-d`, null, (_e, cx) => this.remove(c, cx), { iconName: "trash", tip: "Delete comment" })))
      .child(div().text_size(12).line_height(1.5).text_color(t.foreground).child(c.text));
  }

  draftBox(t) {
    const d = this.draft;
    return v_flex().mx(4).my(4).p(8).gap(6).rounded(8).border_1().border_color(t.accent).bg(t.surface)
      .child(div().text_size(11).text_color(t.dim).child(`${short(d.path)} ${span(d)}${d.editing ? " · editing" : ""}`))
      .child(Textarea.new(this.box).w_full().text_size(12).px(8).py(6).rounded(6).bg(t.background))
      .child(h_flex().gap(6).justify_end()
        .child(button(t, "rd-cancel", "Cancel", (_e, cx) => { this.draft = null; this.focus.focus(); cx.notify(); }, { tip: "Esc" }))
        .child(button(t, "rd-save", d.editing ? "Save" : "Comment", (_e, cx) => this.saveDraft(cx), { primary: true, disabled: !this.box.value().trim(), tip: "Enter" })));
  }

  diffRows(t) {
    const p = this.parsed, rows = [], end = Math.min(p.lines.length, this.from + WINDOW);
    const covered = new Map();   // row → comment ending there (drawn under it)
    const marked = new Set();
    for (const c of this.comments) {
      const at = this.lineOf(c);
      if (!at) continue;
      for (let i = at.lo; i <= at.hi; i++) marked.add(i);
      covered.set(at.hi, [...(covered.get(at.hi) ?? []), c]);
    }
    const d = this.draft;
    if (this.from > 0) rows.push(h_flex().id("review-above").h(24).px(8).items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.accent)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.from = 0; cx.notify(); }).child(`${this.from} lines above · show from the top`));
    for (let i = this.from; i < end; i++) {
      const l = p.lines[i];
      if (l.kind === "file") {
        rows.push(h_flex().id(`rf-${i}`).h(ROW).mt(i ? 8 : 0).px(8).gap(6).items_center().rounded(6).bg(t.raised)
          .text_size(11.5).font_semibold().text_color(t.foreground).child(icon("pages", 12).text_color(t.dim)).child(l.text));
        continue;
      }
      if (l.kind === "hunk") {
        const hunkText = () => { const out = [l.text]; for (let j = i + 1; j < p.lines.length && !["hunk", "file"].includes(p.lines[j].kind); j++) out.push(p.lines[j].text); return out.join("\n"); };
        const selected = this.hunk?.header === l.text;
        rows.push(div().id(`review-hunk-${i}`).px(8).py(3).cursor_pointer().rounded(4).bg(selected ? t.selected : "#00000000")
          .text_size(11).text_color(t.dim).hover((s) => s.text_color(t.muted)).child(l.text)
          .tooltip("Select this hunk for Explain / Ask to fix")
          .on_click((_e, cx) => { this.hunk = selected ? null : { header: l.text, text: hunkText() }; cx.notify(); }));
        continue;
      }
      if (l.kind === "meta") { rows.push(div().px(8).text_size(11).text_color(t.dim).child(l.text)); continue; }
      const tone = l.kind === "add" ? t.ansi2 : l.kind === "del" ? t.ansi1 : null;
      const inDraft = d && i >= d.lo && i <= d.hi;
      const bg = inDraft ? t.accent + "2a" : marked.has(i) ? t.accent + "14" : tone ? tone + "12" : "#00000000";
      const num = (n) => div().w(34).flex_none().text_size(10.5).text_color(t.dim).child(n === undefined ? "" : String(n));
      rows.push(h_flex().id(`rl-${i}`).min_h(18).items_start().bg(bg)
        .child(h_flex().id(`rl-${i}-n`).flex_none().gap(2).pl(4).cursor_pointer().hover((s) => s.text_color(t.accent))
          .tooltip("Comment on this line (shift-click to cover a range)")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((e, cx) => { cx.stop_propagation(); this.clickLine(i, e.modifiers.shift, cx); })
          .child(num(l.old)).child(num(l.new)))
        .child(div().w(12).flex_none().text_size(11).text_color(tone ?? t.dim).child(l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""))
        .child(div().min_w(0).flex_1().text_size(11).line_height(1.5).text_color(tone ? t.foreground : t.muted).child(l.text || " ")));
      for (const c of covered.get(i) ?? []) if (!(d?.editing === c.id)) rows.push(this.commentCard(t, c));
      if (d && i === d.hi) rows.push(this.draftBox(t));
    }
    if (end < p.lines.length) rows.push(h_flex().id("review-below").h(24).px(8).items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.accent)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.from = end; cx.notify(); }).child(`${p.lines.length - end} more lines`));
    return rows;
  }

  render(t) {
    const data = this.data, modes = MODES.filter(([m]) => m !== "turn" || !this.noTurn);
    const seg = h_flex().flex_none().p(2).gap(2).rounded(8).bg(t.raised).children(modes.map(([mode, label]) => {
      const on = this.mode === mode;
      return h_flex().id(`review-${mode}`).h(22).px(8).items_center().rounded(6).text_size(11.5).font_medium()
        .bg(on ? t.background : "#00000000").text_color(on ? t.foreground : t.muted)
        .when(!on && !this.loading, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)))
        .on_click((_e, cx) => { if (!on && !this.loading) this.setMode(mode, cx); })
        .child(label);
    }));
    const n = this.comments.length, canSend = Boolean(this.target?.address) && !this.sending;
    const head = h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(button(t, "review-back", null, () => setShared("desk.review", null), { iconName: "back", tip: "Back to chat" }))
      .child(div().min_w(0).flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground)
        .child(data?.root?.split("/").at(-1) ?? this.target?.repo?.split("/").at(-1) ?? "Review"))
      .child(seg)
      .child(button(t, "review-refresh", null, (_e, cx) => this.refresh(cx), { iconName: "refresh", tip: "Refresh" }));
    const root = v_flex().id("review").size_full().min_h(0).track_focus(this.focus)
      .on_mouse_down("left", () => { if (!this.draft) this.focus.focus(); })
      .on_key_down((e, cx) => this.key(e, cx))
      .child(head);
    if (this.loading && !data) return root.child(empty(t, "Reading changes…"));
    if (this.error) return root.child(empty(t, this.error));
    if (!data) return root.child(empty(t, "Pick an agent or a worktree to review its changes."));

    const action = h_flex().h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(button(t, "review-explain", "Explain", () => this.request("explain"), { disabled: !data.diff, tip: "Draft a question in the Desk chat" }))
      .child(button(t, "review-fix", "Ask to fix", () => this.request("fix"), { disabled: !data.diff, tip: "Draft a fix request in the Desk chat" }))
      .when(data.truncated, (el) => el.child(div().text_size(11).text_color(t.blocked).child("Diff truncated")))
      .child(div().flex_1())
      .when(n === 0, (el) => el.child(button(t, "review-approve", this.sending ? "Sending…" : "Approve", (_e, cx) => this.send(cx),
        { disabled: !canSend, tip: this.target?.address ? "Tell the agent you approved these changes" : "No agent to send to" })))
      .when(n > 0, (el) => el.child(button(t, "review-send", this.sending ? "Sending…" : `Send ${n} comment${n === 1 ? "" : "s"}`, (_e, cx) => this.send(cx),
        { primary: true, disabled: !canSend, tip: this.target?.address ? "Paste them into the agent's input (s)" : "No agent to send to" })));
    const failed = this.failed ? v_flex().mx(10).mt(8).px(10).py(8).gap(6).rounded(8).border_1().border_color(t.blocked)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Not sent. Your comments are kept."))
      .child(div().text_size(11.5).line_height(1.5).text_color(t.muted).child(`${this.failed.error}\nThe batch is saved at ${this.failed.file.replace(home(), "~")}. Copy it and paste it into the agent's terminal, or send again.`))
      .child(h_flex().gap(6).child(button(t, "review-copy", "Copy batch", (_e, cx) => this.copyBatch(cx), { iconName: "copy" }))
        .child(button(t, "review-retry", "Send again", (_e, cx) => this.send(cx), { disabled: !canSend }))) : null;
    const files = v_flex().max_h(196).flex_none().overflow_y_scrollbar().pb(4)
      .child(section(t, "review-files", "Files", data.files.length, this.filesOpen, (_e, cx) => { this.filesOpen = !this.filesOpen; cx.notify(); }))
      .when(this.filesOpen, (el) => el.children(data.files.map((file) => this.fileRow(t, file))));
    const comments = n ? v_flex().max_h(180).flex_none().overflow_y_scrollbar().border_t(1).border_color(t.border).pb(4)
      .child(section(t, "review-comments", "Comments", n, this.commentsOpen, (_e, cx) => { this.commentsOpen = !this.commentsOpen; cx.notify(); }))
      .when(this.commentsOpen, (el) => el.children(this.comments.map((c, i) => h_flex().id(`rcl-${c.id}`).h(ROW).mx(6).px(8).gap(8).items_center().rounded(8).cursor_pointer()
        .bg(i === this.current ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.current = i; this.reveal(c, cx); cx.notify(); })
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${short(c.path)} ${span(c)}`))
        .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).child(c.text.split("\n")[0]))))) : null;
    const hint = div().px(12).py(5).flex_none().text_size(10.5).text_color(t.dim).border_t(1).border_color(t.border)
      .child("j/k files · ]/[ hunks · c comment · n/N comments · s send · click a line number to comment");
    const diff = v_flex().flex_1().min_h(0).px(6).py(6).overflow_y_scrollbar().bg(t.background)
      .children(this.parsed?.lines.length ? this.diffRows(t) : [div().p(8).text_size(11.5).text_color(t.dim)
        .child(this.mode === "turn" ? "Nothing changed in the agent's last turn." : "No changes in this view.")]);
    const reports = this.reports.length ? v_flex().max_h(140).flex_none().overflow_y_scrollbar()
      .child(section(t, "review-reports", "Reports", this.reports.length, this.reportsOpen, (_e, cx) => { this.reportsOpen = !this.reportsOpen; cx.notify(); }))
      .when(this.reportsOpen, (el) => el.px(10).pb(8).gap(5).children(this.reports.map((report) =>
        div().rounded(8).px(8).py(6).bg(t.raised).text_size(11.5).line_height(1.45).text_color(t.muted).child(`${report.from}: ${report.text}`)))) : null;
    return root.child(action).when(Boolean(failed), (el) => el.child(failed)).child(files)
      .when(Boolean(comments), (el) => el.child(comments)).child(diff)
      .when(Boolean(reports), (el) => el.child(reports)).child(hint);
  }
}
