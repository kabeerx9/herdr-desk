import { div, svg, image } from "gpui-kit";
import { exec } from "herdr";
import { renderBlocks } from "./blocks.js";
import { h_flex, v_flex, TextView } from "gpui-base";
import { button, icon, statusMark, shownStatus } from "./ui.js";
import { KIND, span, summarizeSteps, thoughtLine, subagentHeader, subStatus, subElapsed, snapshotFor, contextMeter, stepKind, currentQuestion, questionLine } from "./model.js";

// The desk chat's thread, drawn from rows model.js derived on reload. Everything here reads
// state; nothing here fetches or derives (desks.js owns both). `o` is the Desks owner.


const EVIDENCE = { verified: "It ran the checks itself", reported: "Passed on from another agent's check", asserted: "Claimed, not checked" };
const CRITERION = { pass: "done", fail: "failed", "n/a": "idle" };

// A done report against its brief's acceptance criteria: one row per criterion. `bare`: inside
// the done card, which draws the outline.
function criteriaList(t, id, criteria, bare = false) {
  return v_flex().id(`${id}-crit`).mt(2).py(4).gap(1).rounded(8).when(!bare, (el) => el.border_1().border_color(t.border)).when(bare, (el) => el.mx(-8))
    .children(criteria.map((c) => h_flex().id(`${id}-crit-${c.id}`).min_h(24).px(8).gap(7).items_center()
      .child(statusMark(t, CRITERION[c.result] ?? "idle", 11))
      .child(div().flex_none().text_size(11).font_semibold().text_color(t.muted).child(c.id))
      .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).tooltip(c.text ?? "").child(c.text ?? ""))
      .when(Boolean(c.note), (el) => el.child(div().flex_none().max_w(220).truncate().text_size(11).text_color(t.dim).tooltip(c.note).child(c.note)))));
}

export const COLUMN = 760;

const clock = (ms) => {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${new Date().toDateString() === d.toDateString() ? "" : `${d.getDate()}/${d.getMonth() + 1} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const STEP_ICON = { read: "book", search: "book", command: "terminal", edit: "pages", web: "fetch", agent: "sparkles", other: "play" };
export const stepIcon = (tool) => STEP_ICON[stepKind(tool)];

const gapTop = (o) => (o.wide ? 28 : 20);
export const FACE = 24;
// An author's face or name; for a live member, a link to its own conversation (its route).
function who(o, t, id, address, el) {
  return h_flex().id(id).flex_none().gap(8).items_center().rounded(6)
    .when(Boolean(address), (x) => x.cursor_pointer().tooltip("Open its own conversation")
      .hover((s) => s.opacity(0.8)).on_click((_e, cx) => o.openRoute(address, cx)))
    .child(el);
}
// "Read 9 files" → "read 9 files": the tail of "Worked for 2m 13s · …".
const lower = (text) => (text ? text[0].toLowerCase() + text.slice(1) : "");
// A member's live state in words and colour, for the team card and the @ menu.
export const LIVE = {
  working: { word: "Working", color: "working", mark: "working" }, blocked: { word: "Needs you", color: "blocked", mark: "blocked" },
  done: { word: "Done", color: "done", mark: "done" }, idle: { word: "Idle", color: "dim", mark: null }, left: { word: "Finished", color: "dim", mark: null },
};
export function liveState(t, state, size = 11) {
  const s = LIVE[state] ?? LIVE.idle, color = t[s.color] ?? t.dim;
  return h_flex().flex_none().gap(5).items_center().text_size(11.5).font_medium().text_color(color)
    .when(Boolean(s.mark), (el) => el.child(statusMark(t, s.mark, size))).child(s.word);
}
// A member's state as LIVE knows it: live status first, then what it last reported.
export function memberState(member, reported) {
  if (member) return member.status === "blocked" ? "blocked" : member.status === "working" ? "working"
    : member.phase === "done" || member.status === "done" ? "done" : "idle";
  return reported === "done" ? "done" : "left";
}
const nameOf = (o, id) => (id === "kabeer" ? "You" : o.roles.byId(id)?.name ?? id);

// Each drawn row is measured, so the minimap can find a prompt's offset.
export function measured(o, slug, key, el) {
  return div().id(`row-${slug}-${key}`).w_full().flex_none().when(o.wide, (x) => x.max_w(COLUMN))
    .on_size_change((size, cx) => o.rowMeasured(slug, key, size.height, cx)).child(el);
}

function quietLine(id, t, text, tip) {
  return h_flex().id(id).justify_center().pt(14).pb(2)
    .child(div().max_w_4_5().truncate().text_size(11).text_color(t.dim).when(Boolean(tip), (el) => el.tooltip(tip)).child(text));
}

function tool(t, id, name, tip, onClick, color) {
  return h_flex().id(id).size(26).flex_none().items_center().justify_center().rounded(7)
    .cursor_pointer().text_color(color ?? t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_click(onClick).child(icon(name, 14));
}

function copyButton(o, t, id, text) {
  const done = o.copied === id;
  return tool(t, `${id}-copy`, done ? "check" : "copy", done ? "Copied" : "Copy", (_e, cx) => o.copy(id, text, cx), done ? t.done : null);
}

// Your message: a raised bubble on the right; who it went to and when show on hover.
// Attached files: a thumbnail per image, a name chip per anything else. Click opens it; in the
// composer `remove` adds a ×.
export function attachmentList(t, id, files, { remove = null, thumb = 64, end = false } = {}) {
  const shut = (f, i) => remove ? h_flex().id(`${id}-x${i}`).absolute().top(-5).right(-5).size(18).items_center().justify_center().rounded(9)
    .bg(t.popover).border_1().border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
    .tooltip("Remove").on_click((_e, cx) => { cx.stop_propagation(); remove(f, cx); }).child(svg("mods/workspace-chrome/x.svg").size(10)) : null;
  const open = (f) => () => exec("open", [f.path]);
  return h_flex().id(id).gap(8).flex_wrap().items_center().when(end, (el) => el.justify_end()).children(files.map((f, i) => (f.kind === "image"
    ? div().id(`${id}-${i}`).relative().size(thumb).flex_none().rounded(10).border_1().border_color(t.border).cursor_pointer().tooltip(f.name).on_click(open(f))
      .child(image(f.path).size_full().rounded(10)).when(remove, (el) => el.child(shut(f, i)))
    : h_flex().id(`${id}-${i}`).relative().h(40).max_w(240).px(10).gap(8).flex_none().items_center().rounded(10).border_1().border_color(t.border)
      .bg(t.raised).text_color(t.muted).cursor_pointer().tooltip(f.name).on_click(open(f))
      .child(icon("pages", 14)).child(div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(f.name)).when(remove, (el) => el.child(shut(f, i))))));
}

export function mineBubble(o, t, id, text, meta, { ok = false, failed = null, open = null, attachments = null } = {}) {
  const hovered = o.hoverMsg === id, size = o.wide ? 14 : 13;
  return v_flex().id(id).items_end().gap(4).pt(gapTop(o))
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .when(Boolean(attachments?.length), (el) => el.child(div().max_w_4_5().child(attachmentList(t, `${id}-files`, attachments, { thumb: 128, end: true }))))
    .when(Boolean(text), (el) => el.child(div().max_w_4_5().px(14).py(9).rounded(18).bg(t.raised).border_1().border_color(t.border)
      .text_size(size).line_height(1.55).text_color(t.foreground).child(text)))
    .child(h_flex().h(22).gap(6).items_center().text_size(11).text_color(t.dim).when(!hovered, (el) => el.opacity(0))
      .child(copyButton(o, t, id, text))
      .child(meta)
      .when(ok, (el) => el.child(icon("check", 11).text_color(t.dim))))
    .when(Boolean(failed), (el) => el.child(notDelivered(t, `${id}-nd`, failed, open)));
}

// A slash command you sent: a compact chip, not a bubble.
export function commandChip(o, t, id, text, meta, { failed = null, open = null } = {}) {
  const hovered = o.hoverMsg === id;
  return v_flex().id(id).items_end().gap(3).pt(o.wide ? 18 : 14)
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(11).text_color(t.dim).when(!hovered, (el) => el.opacity(0)).child(meta))
      .child(h_flex().max_w(420).h(26).px(9).gap(6).items_center().rounded(8).border_1().border_color(failed ? t.blocked : t.input)
        .text_size(12).text_color(t.foreground)
        .child(icon("terminal", 12).text_color(t.dim))
        .child(div().min_w(0).truncate().font_family("JetBrains Mono").child(text))))
    .when(Boolean(failed), (el) => el.child(notDelivered(t, `${id}-nd`, failed, open)));
}

// `open`: a recipient had a dialog open in its terminal (nothing was typed into it); the
// terminal is one click away, to close the dialog before sending again.
function notDelivered(t, id, failed, open) {
  return h_flex().max_w_4_5().gap(6).items_center()
    .child(statusMark(t, "failed", 11))
    .child(div().text_size(11.5).line_height(1.4).text_color(t.muted)
      .child(open ? `Not delivered to ${failed}. Close it there, then send again.` : `Not delivered to ${failed}. Send it again once they're free.`))
    .when(Boolean(open), (el) => el.child(textLink(t, `${id}-open`, "Open terminal", open)));
}

function textLink(t, id, label, onClick) {
  return div().id(id).flex_none().text_size(11.5).text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
    .on_click((_e, cx) => onClick(cx)).child(label);
}

const RESULT_LINES = 14;

// What a slash command printed (/context, /cost, /status), captured from the agent's screen:
// a compact monospace card under the command chip; past RESULT_LINES it folds behind "Show all".
export function commandResult(o, t, id, who, command, text, meta) {
  const lines = String(text ?? "").split("\n"), open = o.expanded.has(id), long = lines.length > RESULT_LINES;
  const shown = long && !open ? lines.slice(0, RESULT_LINES) : lines;
  const hovered = o.hoverMsg === id;
  return v_flex().id(id).items_end().gap(3).pt(6)
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .child(v_flex().w_full().max_w(620).px(12).py(8).gap(0).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .child(h_flex().h(20).mb(4).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(icon("terminal", 11))
        .child(div().min_w(0).truncate().child(`${who} · ${command}`))
        .child(div().flex_1())
        .child(div().when(!hovered, (el) => el.opacity(0)).child(meta))
        .child(div().when(!hovered, (el) => el.opacity(0)).child(copyButton(o, t, id, text ?? ""))))
      .children(shown.map((line, i) => div().id(`${id}-l${i}`).h(16).min_w(0).truncate().font_family("JetBrains Mono")
        .text_size(11.5).line_height(1.4).text_color(t.foreground).child(line || " ")))
      .when(long, (el) => el.child(div().id(`${id}-all`).mt(4).text_size(11.5).text_color(t.accent).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { open ? o.expanded.delete(id) : o.expanded.add(id); cx.notify(); })
        .child(open ? "Show less" : `Show all ${lines.length} lines`))));
}

// A quiet line for what a command did ("CTO started a new conversation"), with "Open terminal"
// when the terminal is where it continues (a picker, a dialog that wouldn't close).
export function commandNote(o, t, id, m, meta) {
  return h_flex().id(id).justify_center().pt(10).pb(2).gap(8).items_center()
    .when(Boolean(m.failed), (el) => el.child(statusMark(t, "failed", 11)))
    .child(div().max_w_4_5().truncate().text_size(11).text_color(t.dim).child(`${m.text ?? ""} · ${meta}`))
    .when(Boolean(m.terminal && m.address), (el) => el.child(textLink(t, `${id}-open`, "Open terminal", () => o.openTerminal(m.address))));
}

// One message row. Yours is a quiet bubble on the right; theirs is full-width prose under a
// calm name row; a finished turn opens with a "Worked for" fold over its steps.
export function messageRow(o, t, slug, row, ctx) {
  const m = row.m, id = `msg-${slug}-${row.key}`;
  if (row.type === "permission") {
    const end = o.model.permitDone.get(m.id);
    const how = !end ? "waiting for you" : end === "allow" ? "you allowed it" : end === "always" ? "you allowed it from now on"
      : end === "deny" ? "you denied it" : "answered in its terminal";
    return quietLine(id, t, `${nameOf(o, m.from)} asked to use ${m.tool}: ${(m.detail ?? "").split("\n")[0].slice(0, 80)} · ${how} · ${clock(m.at)}`, m.detail ?? "");
  }
  if (row.type === "question") {
    const { asked, how } = questionLine(m, o.model.permitDone.get(m.id), o.model.answered.get(m.id));
    return quietLine(id, t, `${nameOf(o, m.from)} asked: ${asked} · ${how} · ${clock(m.at)}`, (m.questions ?? []).map((q) => q.question).join("\n"));
  }
  if (row.type === "event") {
    const who = nameOf(o, m.from);
    if (m.kind === "compact") return quietLine(id, t, `${who} ${m.text}${m.trigger === "auto" ? " (Claude did it on its own)" : ""} · ${clock(m.at)}`);
    if (m.kind === "fresh") return quietLine(id, t, `${(m.text ?? "").split(". Handoff")[0]} · ${clock(m.at)}`, m.text ?? "");
    // The CTO (or another member) bringing people in: a team card under its message.
    if (m.kind === "start" && m.from !== "kabeer" && o.roles.byId(m.from)) return teamCard(o, t, id, m, ctx);
    const names = (m.roles ?? [m.role]).map((r) => nameOf(o, r));
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? m.text;
    return quietLine(id, t, `${m.kind === "desk" ? `${who} started this desk${m.project ? ` in ${m.project}` : ""}` : `${who} added ${list}`} · ${clock(m.at)}`);
  }
  const hovered = o.hoverMsg === id, size = o.wide ? 14 : 13;
  if (row.type === "result") return commandResult(o, t, id, nameOf(o, m.from), m.command ?? "", m.text ?? "", clock(m.at));
  if (row.type === "note") return commandNote(o, t, id, m, clock(m.at));
  if (row.type === "mine" || row.type === "command") {
    const to = (m.to ?? []).map((r) => nameOf(o, r)).join(", ");
    const ok = Boolean(m.delivered?.length && !m.failed?.length);
    const dialog = (m.failed ?? []).find((f) => f.dialog && f.address);
    const opts = { ok, attachments: m.attachments ?? null, failed: m.failed?.length ? m.failed.map((f) => `${nameOf(o, f.role)} (${f.why})`).join("; ") : null,
      open: dialog ? () => o.openTerminal(dialog.address) : null };
    return row.type === "command" ? commandChip(o, t, id, m.text ?? "", `To ${to} · ${clock(m.at)}`, opts)
      : mineBubble(o, t, id, m.text ?? "", `To ${to} · ${clock(m.at)}`, opts);
  }

  const role = o.roles.byId(m.from), kind = KIND[m.kind], aside = row.aside;
  const latest = ctx.index === o.model.lastReply;
  const live = latest ? ctx.members.find((x) => x.address === m.address) ?? ctx.members.find((x) => x.role === m.from) : null;
  const offer = m.kind === "context" ? ctx.members.find((x) => x.address === m.address && o.overLimit(x)) ?? null : null;
  const to = m.to?.length ? m.to.map((r) => nameOf(o, r)).join(", ") : null;
  const long = row.long && !o.expanded.has(id);
  const face = aside ? 20 : FACE;
  const link = m.address && ctx.members.some((x) => x.address === m.address) ? m.address : null;
  const copy = () => copyButton(o, t, id, m.text);  // an element is single-use: one per place it shows

  // The finished turn: "Worked for 2m 13s · read 4 files, ran 2 commands", folded.
  const snap = row.worked && !aside ? snapshotFor(row, o.snapshots) : null;
  const summary = snap ? snap.summary || summarizeSteps(snap.steps) : "";
  const canOpen = Boolean(snap && (snap.steps?.length || snap.subagents?.length));
  const open = canOpen && o.folds.has(id);
  const fold = row.worked && !aside ? h_flex().id(`${id}-fold`).h(22).gap(6).items_center().text_size(12).text_color(t.dim)
    .when(canOpen, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? o.folds.delete(id) : o.folds.add(id); cx.notify(); }))
    .child(div().min_w(0).truncate().child(`Worked for ${span(row.worked)}${summary ? ` · ${lower(summary)}` : ""}`))
    .when(canOpen, (el) => el.child(icon(open ? "chevron-down" : "chevron", 11))) : null;

  const body = v_flex().gap(4)
    .child(div().when(long, (el) => el.max_h(132).overflow_hidden())
      .text_size(aside ? size - 1 : size).line_height(1.6).text_color(aside ? t.muted : t.foreground)
      .child(aside ? TextView.markdown(`${id}-md`, m.text ?? "").selectable(true) : renderBlocks(t, `${id}-md`, m.text ?? "", { size, onReply: latest ? (text, cx) => { o.input.set_value(text); o.send(cx); } : null })))
    .when(long, (el) => el.child(div().id(`${id}-more`).text_size(12).text_color(t.accent).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { o.expanded.add(id); cx.notify(); }).child("Show more")));

  // A done report with a diff is a card: the report, its criteria, then what changed.
  const diff = m.kind === "done" && m.diff?.files ? m.diff : null;
  const report = diff
    ? v_flex().px(12).pt(10).pb(8).gap(6).rounded(12).border_1().border_color(t.border)
      .child(body)
      .when(Boolean(m.criteria?.length), (el) => el.child(criteriaList(t, id, m.criteria, true)))
      .child(diffFooter(o, t, id, m, slug, ctx.members))
    : v_flex().gap(6).child(body).when(Boolean(m.criteria?.length), (el) => el.child(criteriaList(t, id, m.criteria)));

  const nameRow = h_flex().h(face).gap(8).items_center()
    .child(who(o, t, `${id}-who`, link, div().flex_none().text_size(aside ? 12 : 12.5).font_semibold().text_color(aside ? t.muted : t.foreground).child(role?.name ?? m.from)))
    .when(Boolean(to), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`to ${to}`)))
    .when(Boolean(kind), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(t.muted)
      .when(Boolean(kind.mark), (x) => x.child(statusMark(t, kind.mark, 11, { still: true }))).child(kind.word)))
    // How "done" was established: checked by the agent itself, passed on, or only claimed.
    .when(Boolean(m.evidence), (el) => el.child(evidenceLabel(t, `${id}-ev`, m.evidence)))
    .child(div().flex_none().text_size(11.5).text_color(t.dim).child(clock(m.at)))
    .child(div().flex_1())
    .when(!latest, (el) => el.child(div().when(!hovered, (x) => x.opacity(0)).child(copy())));

  const column = v_flex().min_w(0).flex_1().gap(6)
    .when(!row.grouped, (el) => el.child(nameRow))
    .when(Boolean(fold), (el) => el.child(fold))
    .when(open, (el) => el.child(v_flex().gap(6).pb(4)
      .when(Boolean(snap.steps?.length), (x) => x.child(stepList(t, `${id}-steps`, snap.steps, { live: false })))
      .when(Boolean(snap.subagents?.length), (x) => x.child(subagents(o, t, `${id}-subs`, snap.subagents, ctx.now, link)))))
    .child(report)
    .when(latest, (el) => el.child(h_flex().ml(-5).gap(2)
      .child(copy())
      .when(Boolean(live), (el) => el.child(tool(t, `${id}-term`, "terminal", `Open ${role?.name ?? m.from}'s terminal`, () => o.openTerminal(live.address))))))
    .when(Boolean(offer), (el) => el.child(h_flex().pt(2).gap(6)
      .child(button(t, `${id}-compact`, o.acting === `compact-${offer.address}` ? "Compacting…" : "Compact", (_e, cx) => o.compact(offer, cx),
        { primary: true, disabled: Boolean(o.acting) || offer.status === "working",
          tip: offer.status === "working" ? "Once its turn ends" : "Claude's /compact: same session, the history becomes a summary" }))));

  // Consecutive messages from one agent share its face: the later ones keep the column, not the face.
  return v_flex().id(id).relative().pt(row.grouped ? 8 : aside ? 16 : gapTop(o))
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .child(h_flex().w_full().items_start().gap(10)
      .child(row.grouped ? div().w(face).flex_none() : who(o, t, `${id}-face`, link, o.face(t, m.from, m.address, face)))
      .child(column))
    .when(row.grouped && !latest, (el) => el.child(div().absolute().top(4).right(0).when(!hovered, (x) => x.opacity(0)).child(copy())));
}

const EVIDENCE_COLOR = { verified: "done", reported: "muted", asserted: "dim" };
function evidenceLabel(t, id, evidence) {
  const color = t[EVIDENCE_COLOR[evidence]] ?? t.dim;
  return div().id(id).flex_none().h(18).px(6).flex().items_center().rounded(5).border_1().border_color(color)
    .text_size(11).font_medium().text_color(color).tooltip(EVIDENCE[evidence] ?? "").child(evidence);
}

// Under a done report with a diff: "+A −D · N files · branch", then Open diff and Review.
function diffFooter(o, t, id, m, slug, members) {
  const x = m.diff, member = members.find((y) => y.address === m.address) ?? null, d = o.desk(slug);
  const reviewing = o.acting === `rev-${m.address}`;
  return v_flex().mx(-12).mt(4)
    .child(div().h(1).bg(t.border))
    .child(h_flex().px(12).pt(8).gap(10).items_center()
      .child(h_flex().flex_none().gap(6).font_family("JetBrains Mono").text_size(12)
        .child(div().text_color(t.done).child(`+${x.added ?? 0}`))
        .child(div().text_color(t.blocked).child(`−${x.removed ?? 0}`)))
      .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.dim)
        .child(`${x.files} file${x.files === 1 ? "" : "s"}${x.branch ? ` · ${x.branch}` : ""}`))
      .child(button(t, `${id}-diff`, "Open diff", (_e, cx) => d && o.openReview({ address: m.address, role: m.from, cwd: member?.cwd ?? x.cwd }, d, cx),
        { variant: "ghost", disabled: !d, tip: "Its changes against where the branch left its base" }))
      .child(button(t, `${id}-review`, reviewing ? "Starting…" : "Review", (_e, cx) => d && member && o.requestReview(member, d, cx),
        { disabled: !member || !d || Boolean(o.acting), tip: member ? "A Reviewer on this branch; it reports to this engineer" : "It has left the desk" })));
}

// Under the message where the CTO brought people in: one row per member, its task and live state.
export function teamCard(o, t, id, m, ctx) {
  const list = m.members ?? [{ role: m.role, address: m.address ?? null, task_line: m.task_line ?? null }];
  return v_flex().id(id).pt(10).pl(FACE + 10)
    .child(div().pb(6).text_size(11.5).text_color(t.dim).child(`${nameOf(o, m.from)} brought in ${list.length === 1 ? nameOf(o, list[0].role) : `${list.length} people`} · ${clock(m.at)}`))
    .child(v_flex().w_full().max_w(600).rounded(12).border_1().border_color(t.border).overflow_hidden()
      .children(list.map((x, i) => {
        const member = x.address ? ctx.members.find((y) => y.address === x.address) : null;
        const state = memberState(member, x.address ? o.model.reports?.get(x.address) : null);
        return h_flex().id(`${id}-${x.address ?? i}`).h(38).px(12).gap(10).items_center()
          .when(i > 0, (el) => el.border_t(1).border_color(t.border))
          .when(Boolean(member), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Open its own conversation")
            .on_click((_e, cx) => o.openRoute(member.address, cx)))
          .child(o.face(t, x.role, x.address, 20))
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(nameOf(o, x.role)))
          .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.muted).child(x.task_line ?? ""))
          .child(liveState(t, state));
      })));
}

// A member stopped at a Claude permission prompt: who, what it wants to run, and the answer.
// `c`: { address, role, title, subject, error, busy }. Enter in an empty composer is Allow.
const ASKS = { "Bash command": "wants to run a command", "Edit file": "wants to edit a file", "Write file": "wants to write a file",
  "Create file": "wants to create a file", "Read file": "wants to read a file", Bash: "wants to run a command", Edit: "wants to edit a file", Write: "wants to write a file",
  "Run command": "wants to run a command", "Edit files": "wants to edit files", "Trust folder": "asks to work in this folder without approvals" };

// A permission card's buttons: the prompt's own options as its CLI drew them (one per kind), else
// Allow / Always allow / Deny for a hook request with nothing on screen. Allow is the default.
const KIND_BUTTON = { allow: "Allow", always: "Always allow", deny: "Deny" };
const KIND_TIP = { allow: "Allow this once", always: "The CLI's own “don't ask again” option for this prompt", deny: null };
export function cardChoices(c) {
  const seen = new Set(), from = c.options?.length ? c.options : ["allow", "always", "deny"].map((kind) => ({ kind }));
  return from.filter((o) => KIND_BUTTON[o.kind] && !seen.has(o.kind) && seen.add(o.kind))
    .map((o) => ({ kind: o.kind, label: o.button ?? KIND_BUTTON[o.kind], tip: o.button ? o.label : KIND_TIP[o.kind],
      primary: o.kind === "allow", ghost: o.kind === "deny" }));
}
export function approvalCard(o, t, c, { enter = false } = {}) {
  const id = `ap-${c.address}`, name = nameOf(o, c.role), busy = o.acting === id;
  const what = ASKS[c.title] ?? (c.title ? `wants to use ${c.title.replace(/ command$/, "")}` : "is asking for permission");
  return v_flex().id(id).pt(gapTop(o))
    .child(v_flex().w_full().px(12).py(12).gap(10).rounded(12).border_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(o.face(t, c.role, c.address, FACE))
        .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(`${name} ${what}`))
        .child(statusMark(t, "blocked", 12)))
      .when(Boolean(c.subject), (el) => el.child(div().id(`${id}-cmd`).max_h(132).overflow_y_scrollbar().px(10).py(8).rounded(8)
        .border_1().border_color(t.border).font_family("JetBrains Mono").text_size(12).line_height(1.5).text_color(t.foreground)
        .child(c.subject)))
      .when(Boolean(c.error), (el) => el.child(h_flex().gap(6).items_center()
        .child(statusMark(t, "failed", 11))
        .child(div().min_w(0).flex_1().text_size(12).line_height(1.4).text_color(t.muted).child(c.error))))
      .child(h_flex().gap(6).items_center()
        .children(cardChoices(c).map((b) => button(t, `${id}-${b.kind}`,
          b.primary && busy ? "Answering…" : b.primary && enter ? `${b.label} ↵` : b.label, (_e, cx) => o.approve(c, b.kind, cx),
          { primary: b.primary, disabled: Boolean(o.acting), ...(b.ghost ? { variant: "ghost" } : {}),
            ...(b.tip || (b.primary && enter) ? { tip: [b.tip, b.primary && enter ? "Enter in an empty message box" : null].filter(Boolean).join(" · ") } : {}) })))
        .child(div().flex_1())
        .child(button(t, `${id}-term`, "Open terminal", () => o.openTerminal(c.address), { variant: "ghost", tip: "Look at it in its terminal first" }))));
}

// A question the CTO asked with AskUserQuestion, answered right here. One question at a time:
// click an option, or type your own answer in the message box.
export function questionCard(o, t, m) {
  const id = `qa-${m.id}`, answers = o.questionAnswers[m.id] ?? {}, q = currentQuestion(m.questions, answers);
  const total = m.questions?.length ?? 0, at = total - Object.keys(answers).length, picks = o.questionPicks[m.id] ?? [];
  const sending = !q || o.acting === id;
  return v_flex().id(id).pt(gapTop(o))
    .child(v_flex().w_full().px(12).py(12).gap(10).rounded(12).border_1().border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(o.face(t, m.from, m.address, FACE))
        .child(div().min_w(0).flex_1().truncate().text_size(12.5).font_semibold().text_color(t.foreground)
          .child(`${nameOf(o, m.from)} asks you${q?.header ? ` · ${q.header}` : ""}${total > 1 ? ` · ${total - at + 1} of ${total}` : ""}`))
        .child(statusMark(t, "blocked", 12)))
      .when(sending, (el) => el.child(div().text_size(13).text_color(t.muted).child("Sending your answer…")))
      .when(!sending, (el) => el
        .child(div().text_size(14).line_height(1.45).text_color(t.foreground).child(q.question))
        .child(v_flex().gap(6).children(q.options.map((opt, i) => {
          const on = q.multiSelect && picks.includes(opt.label);
          return v_flex().id(`${id}-o${total - at}-${i}`).px(10).py(8).gap(2).rounded(8).border_1().border_color(on ? t.foreground : t.border)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => (q.multiSelect ? o.toggleQuestionPick(m, opt.label, cx) : o.answerQuestion(m, opt.label, cx)))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(`${on ? "✓ " : ""}${opt.label}`))
            .when(Boolean(opt.description), (x) => x.child(div().text_size(12).line_height(1.4).text_color(t.muted).child(opt.description)));
        })))
        .child(h_flex().gap(6).items_center()
          .when(q.multiSelect, (x) => x.child(button(t, `${id}-next`, "Answer", (_e, cx) => o.answerQuestion(m, picks.join(", "), cx), { primary: true, disabled: !picks.length || Boolean(o.acting) })))
          .child(div().min_w(0).flex_1().text_size(12).text_color(t.dim).child("Or type your own answer in the message box."))
          .child(button(t, `${id}-term`, "Open terminal", () => o.openTerminal(m.address), { variant: "ghost" })))));
}

// Steps as a quiet list in a hairline box. While live, the newest row eases in once.
export function stepList(t, id, steps, { live = true, fresh = null } = {}) {
  return v_flex().w_full().max_w(600).py(4).rounded(8).border_1().border_color(t.border).children(steps.map((st, i) => {
    const last = live && i === steps.length - 1, isNew = fresh !== null && st.at === fresh;
    return h_flex().id(`${id}-${st.at}-${i}`).h(isNew ? 6 : 24).opacity(isNew ? 0 : 1).overflow_hidden().gap(8).items_center().px(10)
      .transition("height", { duration: 180, easing: "ease-out" }).transition("opacity", { duration: 180, easing: "ease-out" })
      .child(icon(stepIcon(st.tool), 12).text_color(last ? t.working : t.dim))
      .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(last ? t.foreground : t.muted).child(st.text ?? st.tool ?? ""))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(st.at)));
  }));
}

// Subagents: one row each (icon, mark, title, one detail line, elapsed); two or more fold
// under a stacked header ("3 subagents · 2 running").
export function subagents(o, t, id, subs, now, parent = null) {
  const rowOf = (s) => h_flex().id(`${id}-${s.id}`).w_full().max_w(600).py(4).px(4).ml(-4).gap(8).items_center().rounded(8)
    .when(Boolean(parent), (el) => el.cursor_pointer().tooltip("Open the conversation that started it")
      .hover((st) => st.bg(t.hover)).on_click((_e, cx) => o.openRoute(parent, cx)))
    .child(div().relative().flex_none().size(20).rounded(6).border_1().border_color(t.border).flex().items_center().justify_center()
      .child(icon("sparkles", 11).text_color(t.dim)))
    .child(statusMark(t, subStatus(s), 11))
    .child(v_flex().min_w(0).flex_1()
      .child(div().truncate().text_size(12.5).text_color(t.foreground).child(s.title))
      .when(Boolean(s.line), (el) => el.child(div().truncate().text_size(11.5).text_color(s.status === "failed" ? t.muted : t.dim).child(s.line))))
    .child(div().flex_none().text_size(11).text_color(t.dim).child(subElapsed(s, now)));
  if (subs.length === 1) return rowOf(subs[0]);
  const head = subagentHeader(subs), open = o.subsOpen.has(id);
  return v_flex().w_full().gap(2)
    .child(h_flex().id(`${id}-head`).h(26).gap(8).items_center().cursor_pointer().text_size(12).text_color(t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? o.subsOpen.delete(id) : o.subsOpen.add(id); cx.notify(); })
      .child(h_flex().flex_none().children(subs.slice(0, 3).map((s, i) => div().size(18).ml(i ? -8 : 0).rounded(9).border_1().border_color(t.border)
        .bg(t.background).flex().items_center().justify_center().child(statusMark(t, subStatus(s), 10)))))
      .child(div().flex_none().child(head.text))
      .child(icon(open ? "chevron-down" : "chevron", 11)))
    .when(open, (el) => el.child(v_flex().pl(4).children(subs.map(rowOf))));
}

// Who's working now, under their name like a reply to come: the latest thought (breathing
// gently), the current step, a one-line summary of the turn's tools that opens the step feed,
// and any subagents. The elapsed label ticks with the desk's one shared clock.
export function liveRows(o, t, members, now) {
  return members.filter((m) => m.status === "working").map((m) => {
    const role = o.roles.byId(m.role), name = role?.name ?? m.role, id = `live-${m.address}`;
    const steps = o.steps[m.address] ?? [], tl = o.timelines[m.address], current = steps.at(-1);
    const fresh = tl?.turn?.working !== false ? tl : null;
    const started = fresh?.turn?.started_ms ?? o.model.open[m.role] ?? steps[0]?.at ?? null;
    const thought = thoughtLine(fresh?.thought);
    const summary = fresh?.tools?.summary || summarizeSteps(steps);
    const subs = fresh?.subagents ?? [];
    const caption = o.waitingFor?.has(m.address) ? "waiting for your answer below" : m.handingOff ? "writing a handoff for a fresh session"
      : !thought && !current ? (m.awaiting ? "replying" : m.note || "working") : null;
    const open = o.toolsOpen.has(m.address);
    const link = o.route ? null : m.address;
    const column = v_flex().min_w(0).flex_1().gap(6)
      .child(h_flex().h(FACE).gap(8).items_center()
        .child(who(o, t, `${id}-who`, link, div().text_size(12.5).font_semibold().text_color(t.foreground).child(name)))
        .child(statusMark(t, "working", 12))
        .when(Boolean(started), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(span(now - started))))
        .when(Boolean(caption), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(caption))))
      // The live thought shimmers gently until the reply lands.
      .when(Boolean(thought), (el) => el.child(div().max_h(o.wide ? 66 : 60).overflow_hidden()
        .text_size(o.wide ? 13.5 : 12.5).line_height(1.55).text_color(t.muted).loop("opacity", { from: 0.55, to: 1, period: 2200 })
        .child(thought)))
      .when(Boolean(current), (el) => el.child(h_flex().h(22).gap(8).items_center()
        .child(icon(stepIcon(current.tool), 12).text_color(t.working))
        .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).child(current.text ?? current.tool))))
      .when(!thought && !current && !caption, (el) => el.child(dots(t)))
      .when(Boolean(summary), (el) => el.child(v_flex().gap(4)
        .child(h_flex().id(`${id}-tools`).h(22).gap(6).items_center().text_size(12).text_color(t.dim)
          .when(steps.length > 0, (x) => x.cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { open ? o.toolsOpen.delete(m.address) : o.toolsOpen.add(m.address); cx.notify(); }))
          .child(div().min_w(0).truncate().child(`${started ? `Working for ${span(now - started)} · ` : ""}${started ? lower(summary) : summary}`))
          .when(steps.length > 0, (x) => x.child(icon(open ? "chevron-down" : "chevron", 11)))
          .when(Boolean(fresh?.tools?.failed), (x) => x.child(h_flex().flex_none().gap(4).items_center()
            .child(statusMark(t, "failed", 10)).child(`${fresh.tools.failed} failed`))))
        .when(open && steps.length > 0, (x) => x.child(stepList(t, `${id}-feed`, steps.slice(-40), { fresh: o.freshStep(m.address) })))))
      .when(subs.length > 0, (el) => el.child(subagents(o, t, `${id}-subs`, subs, now, link)));
    return v_flex().id(id).pt(gapTop(o))
      .child(h_flex().w_full().items_start().gap(10)
        .child(who(o, t, `${id}-face`, link, o.face(t, m.role, m.address, FACE)))
        .child(column));
  });
}

function dots(t) {
  return h_flex().h(20).gap(4).items_center().children([820, 960, 1100].map((period) =>
    div().size(5).rounded(3).bg(t.dim).loop("opacity", { from: 0.25, to: 1, period })));
}

// The end of the thread: one line per thing that is waiting or pending (T3's ThreadNow).
export function statusLineRows(o, t, lines) {
  if (!lines.length) return null;
  return v_flex().id("thread-now").pt(gapTop(o)).gap(2).children(lines.map((l) => h_flex().id(`now-${l.id}`).min_h(26).gap(8).items_center()
    .child(statusMark(t, l.mark, 12))
    .child(h_flex().min_w(0).flex_1().gap(6).items_center().text_size(12)
      .child(div().flex_none().text_color(t.foreground).child(l.title))
      .when(Boolean(l.detail), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(l.detail))))
    .when(Boolean(l.action), (el) => el.child(div().id(`now-${l.id}-go`).flex_none().text_size(12).font_medium()
      .text_color(l.action.disabled ? t.dim : t.accent)
      .when(!l.action.disabled, (x) => x.cursor_pointer().hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { if (!l.action.disabled) o.statusAction(l.action, cx); })
      .child(l.action.label)))));
}

// Above the thread in the wide chat: the lead's turn timer while working, the context meter
// (only past half), and the model.
export function headerStrip(o, t, members, now) {
  const lead = members.find((m) => m.role === "cto") ?? members[0];
  if (!lead) return null;
  const role = o.roles.byId(lead.role), tl = o.timelines[lead.address];
  const working = lead.status === "working";
  const started = working ? (tl?.turn?.working !== false ? tl?.turn?.started_ms : null) ?? o.model.open[lead.role] ?? o.steps[lead.address]?.[0]?.at : null;
  const meter = contextMeter(tl?.context);
  const color = meter?.level === "red" ? t.blocked : meter?.level === "amber" ? t.ansi3 ?? t.blocked : t.dim;
  const model = role?.label ?? role?.model ?? null;
  return h_flex().id("chat-strip").h(28).gap(10).items_center().text_size(11.5).text_color(t.dim)
    .child(h_flex().flex_none().gap(6).items_center()
      .child(statusMark(t, lead.status === "blocked" ? "blocked" : working ? "working" : shownStatus(lead.status, lead.address) === "done" ? "done" : "idle", 11))
      .child(div().text_color(t.muted).child(role?.name ?? lead.role))
      .when(Boolean(started), (el) => el.child(div().child(`working ${span(now - started)}`))))
    .child(div().flex_1())
    .when(Boolean(meter), (el) => el.child(h_flex().id("chat-ctx").flex_none().gap(6).items_center()
      .tooltip(`${Math.round(meter.pct * 100)}% of the context window`)
      .child(div().w(44).h(4).rounded(2).bg(t.border).overflow_hidden().child(div().h(4).w(Math.max(2, 44 * meter.pct)).rounded(2).bg(color)))
      .child(div().text_color(meter.level === "normal" ? t.dim : color).child(meter.label))))
    .when(Boolean(model), (el) => el.child(div().flex_none().child(model)));
}
