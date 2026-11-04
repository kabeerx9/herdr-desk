import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { button, icon, statusMark } from "./ui.js";
import { roleTile } from "./roles.js";
import { KIND, span, summarizeSteps, thoughtLine, subagentHeader, subStatus, subElapsed, snapshotFor, contextMeter, stepKind } from "./model.js";

// The desk chat's thread, drawn from rows model.js derived on reload. Everything here reads
// state; nothing here fetches or derives (desks.js owns both). `o` is the Desks owner.


const EVIDENCE = { verified: "It ran the checks itself", reported: "Passed on from another agent's check", asserted: "Claimed, not checked" };
const CRITERION = { pass: "done", fail: "failed", "n/a": "idle" };

// A done report against its brief's acceptance criteria: one row per criterion.
function criteriaList(t, id, criteria, indent) {
  return v_flex().id(`${id}-crit`).ml(indent).mt(2).py(4).gap(1).rounded(8).border_1().border_color(t.border)
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
const avatarOf = (t, role, size) => (role ? roleTile(div, svg, t, role, size) : div().size(size).flex_none().rounded(size / 2).bg(t.raised));
// An author's avatar and name; for a live member, a link to its own conversation (its route).
function who(o, t, id, address, avatar, name) {
  return h_flex().id(id).flex_none().gap(8).items_center().rounded(6)
    .when(Boolean(address), (el) => el.cursor_pointer().tooltip("Open its own conversation")
      .hover((s) => s.opacity(0.8)).on_click((_e, cx) => o.openRoute(address, cx)))
    .child(avatar).child(name);
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
export function mineBubble(o, t, id, text, meta, { ok = false, failed = null } = {}) {
  const hovered = o.hoverMsg === id, size = o.wide ? 14 : 13;
  return v_flex().id(id).items_end().gap(4).pt(gapTop(o))
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .child(div().max_w_4_5().px(14).py(9).rounded(18).bg(t.raised).border_1().border_color(t.border)
      .text_size(size).line_height(1.55).text_color(t.foreground).child(text))
    .child(h_flex().h(22).gap(6).items_center().text_size(11).text_color(t.dim).when(!hovered, (el) => el.opacity(0))
      .child(copyButton(o, t, id, text))
      .child(meta)
      .when(ok, (el) => el.child(icon("check", 11).text_color(t.dim))))
    .when(Boolean(failed), (el) => el.child(notDelivered(t, failed)));
}

// A slash command you sent: a compact chip, not a bubble.
export function commandChip(o, t, id, text, meta, { failed = null } = {}) {
  const hovered = o.hoverMsg === id;
  return v_flex().id(id).items_end().gap(3).pt(o.wide ? 18 : 14)
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(11).text_color(t.dim).when(!hovered, (el) => el.opacity(0)).child(meta))
      .child(h_flex().max_w(420).h(26).px(9).gap(6).items_center().rounded(8).border_1().border_color(failed ? t.blocked : t.input)
        .text_size(12).text_color(t.foreground)
        .child(icon("terminal", 12).text_color(t.dim))
        .child(div().min_w(0).truncate().font_family("JetBrains Mono").child(text))))
    .when(Boolean(failed), (el) => el.child(notDelivered(t, failed)));
}

function notDelivered(t, failed) {
  return h_flex().max_w_4_5().gap(6).items_center()
    .child(statusMark(t, "failed", 11))
    .child(div().text_size(11.5).line_height(1.4).text_color(t.muted).child(`Not delivered to ${failed}. Send it again once they're free.`));
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
  if (row.type === "event") {
    const who = nameOf(o, m.from);
    if (m.kind === "compact") return quietLine(id, t, `${who} ${m.text}${m.trigger === "auto" ? " (Claude did it on its own)" : ""} · ${clock(m.at)}`);
    if (m.kind === "fresh") return quietLine(id, t, `${(m.text ?? "").split(". Handoff")[0]} · ${clock(m.at)}`, m.text ?? "");
    const names = (m.roles ?? [m.role]).map((r) => nameOf(o, r));
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? m.text;
    return quietLine(id, t, `${m.kind === "desk" ? `${who} started this desk${m.project ? ` in ${m.project}` : ""}` : `${who} added ${list}`} · ${clock(m.at)}`);
  }
  const hovered = o.hoverMsg === id, size = o.wide ? 14 : 13;
  if (row.type === "mine" || row.type === "command") {
    const to = (m.to ?? []).map((r) => nameOf(o, r)).join(", ");
    const ok = Boolean(m.delivered?.length && !m.failed?.length);
    const opts = { ok, failed: m.failed?.length ? m.failed.map((f) => `${nameOf(o, f.role)} (${f.why})`).join("; ") : null };
    return row.type === "command" ? commandChip(o, t, id, m.text ?? "", `To ${to} · ${clock(m.at)}`, opts)
      : mineBubble(o, t, id, m.text ?? "", `To ${to} · ${clock(m.at)}`, opts);
  }

  const role = o.roles.byId(m.from), kind = KIND[m.kind], aside = row.aside;
  const latest = ctx.index === o.model.lastReply;
  const live = latest ? ctx.members.find((x) => x.address === m.address) ?? ctx.members.find((x) => x.role === m.from) : null;
  const offer = m.kind === "context" ? ctx.members.find((x) => x.address === m.address && o.overLimit(x)) ?? null : null;
  const to = m.to?.length ? m.to.map((r) => nameOf(o, r)).join(", ") : null;
  const long = row.long && !o.expanded.has(id);
  const tile = aside ? 16 : 18, indent = aside ? tile + 8 : 0;
  const copy = copyButton(o, t, id, m.text);

  // The finished turn: "Worked for 2m 13s · Read 4 files, ran 2 commands", folded.
  const snap = row.worked && !aside ? snapshotFor(row, o.snapshots) : null;
  const summary = snap ? snap.summary || summarizeSteps(snap.steps) : "";
  const canOpen = Boolean(snap && (snap.steps?.length || snap.subagents?.length));
  const open = canOpen && o.folds.has(id);
  const fold = row.worked && !aside ? h_flex().id(`${id}-fold`).h(22).gap(6).items_center().text_size(12).text_color(t.dim)
    .when(canOpen, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { open ? o.folds.delete(id) : o.folds.add(id); cx.notify(); }))
    .child(canOpen ? icon(open ? "chevron-down" : "chevron", 11) : icon("clock", 11))
    .child(div().flex_none().child(`Worked for ${span(row.worked)}`))
    .when(Boolean(summary), (el) => el.child(div().min_w(0).truncate().child(`· ${summary}`))) : null;

  const body = v_flex().gap(4).pl(indent)
    .child(div().when(long, (el) => el.max_h(132).overflow_hidden())
      .text_size(aside ? size - 1 : size).line_height(1.6).text_color(aside ? t.muted : t.foreground)
      .child(TextView.markdown(`${id}-md`, m.text ?? "").selectable(true)))
    .when(long, (el) => el.child(div().id(`${id}-more`).text_size(12).text_color(t.accent).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { o.expanded.add(id); cx.notify(); }).child("Show more")));

  return v_flex().id(id).relative().gap(6).pt(row.grouped ? 8 : aside ? 16 : gapTop(o))
    .on_hover((h, cx) => o.hoverOn(id, h, cx))
    .when(!row.grouped, (el) => el.child(h_flex().h(22).gap(8).items_center()
      .child(who(o, t, `${id}-who`, m.address && ctx.members.some((x) => x.address === m.address) ? m.address : null,
        avatarOf(t, role, tile), div().flex_none().text_size(aside ? 12 : 13).font_semibold().text_color(aside ? t.muted : t.foreground).child(role?.name ?? m.from)))
      .when(Boolean(to), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(`to ${to}`)))
      .when(Boolean(kind), (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(12).text_color(t.muted)
        .when(Boolean(kind.mark), (x) => x.child(statusMark(t, kind.mark, 11))).child(kind.word)))
      // How "done" was established: checked by the agent itself, passed on, or only claimed.
      .when(Boolean(m.evidence), (el) => el.child(div().id(`${id}-ev`).flex_none().text_size(11)
        .text_color(m.evidence === "verified" ? t.done : m.evidence === "reported" ? t.muted : t.dim)
        .tooltip(EVIDENCE[m.evidence] ?? "").child(m.evidence)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(clock(m.at)))
      .child(div().flex_1())
      .when(!latest, (el) => el.child(div().when(!hovered, (x) => x.opacity(0)).child(copy)))))
    .when(row.grouped && !latest, (el) => el.child(div().absolute().top(4).right(0).when(!hovered, (x) => x.opacity(0)).child(copy)))
    .when(Boolean(fold), (el) => el.child(fold))
    .when(open, (el) => el.child(v_flex().gap(6).pb(4)
      .when(Boolean(snap.steps?.length), (x) => x.child(stepList(t, `${id}-steps`, snap.steps, { live: false })))
      .when(Boolean(snap.subagents?.length), (x) => x.child(subagents(o, t, `${id}-subs`, snap.subagents, ctx.now, m.address && ctx.members.some((y) => y.address === m.address) ? m.address : null)))))
    .child(body)
    .when(Boolean(m.criteria?.length), (el) => el.child(criteriaList(t, id, m.criteria, indent)))
    .when(latest, (el) => el.child(h_flex().ml(-5).gap(2)
      .child(copy)
      .when(Boolean(live), (el) => el.child(tool(t, `${id}-term`, "terminal", `Open ${role?.name ?? m.from}'s terminal`, () => o.openTerminal(live.address))))))
    .when(Boolean(offer), (el) => el.child(h_flex().pt(2).gap(6)
      .child(button(t, `${id}-compact`, o.acting === `compact-${offer.address}` ? "Compacting…" : "Compact", (_e, cx) => o.compact(offer, cx),
        { primary: true, disabled: Boolean(o.acting) || offer.status === "working",
          tip: offer.status === "working" ? "Once its turn ends" : "Claude's /compact: same session, the history becomes a summary" }))));
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
    const pad = 26;
    return v_flex().id(id).gap(6).pt(gapTop(o))
      .child(h_flex().h(22).gap(8).items_center()
        .child(o.route ? h_flex().flex_none().gap(8).items_center().child(avatarOf(t, role, 18)).child(div().text_size(13).font_semibold().text_color(t.foreground).child(name))
          : who(o, t, `${id}-who`, m.address, avatarOf(t, role, 18), div().text_size(13).font_semibold().text_color(t.foreground).child(name)))
        .child(statusMark(t, "working", 12))
        .when(Boolean(started), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(span(now - started))))
        .when(Boolean(caption), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(caption))))
      .when(Boolean(thought), (el) => el.child(div().pl(pad).max_h(o.wide ? 66 : 60).overflow_hidden()
        .text_size(o.wide ? 13.5 : 12.5).line_height(1.55).text_color(t.muted).loop("opacity", { from: 0.55, to: 1, period: 2200 })
        .child(thought)))
      .when(Boolean(current), (el) => el.child(h_flex().pl(pad).h(22).gap(8).items_center()
        .child(icon(stepIcon(current.tool), 12).text_color(t.working))
        .child(div().min_w(0).flex_1().truncate().text_size(12).text_color(t.foreground).child(current.text ?? current.tool))))
      .when(!thought && !current && !caption, (el) => el.child(div().pl(pad).child(dots(t))))
      .when(Boolean(summary), (el) => el.child(v_flex().pl(pad).gap(4)
        .child(h_flex().id(`${id}-tools`).h(22).gap(6).items_center().text_size(12).text_color(t.dim)
          .when(steps.length > 0, (x) => x.cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { open ? o.toolsOpen.delete(m.address) : o.toolsOpen.add(m.address); cx.notify(); }))
          .child(icon(steps.length && open ? "chevron-down" : "chevron", 11))
          .child(div().min_w(0).truncate().child(summary))
          .when(Boolean(fresh?.tools?.failed), (x) => x.child(h_flex().flex_none().gap(4).items_center()
            .child(statusMark(t, "failed", 10)).child(`${fresh.tools.failed} failed`))))
        .when(open && steps.length > 0, (x) => x.child(stepList(t, `${id}-feed`, steps.slice(-40), { fresh: o.freshStep(m.address) })))))
      .when(subs.length > 0, (el) => el.child(div().pl(pad).child(subagents(o, t, `${id}-subs`, subs, now, o.route ? null : m.address))));
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
      .child(statusMark(t, lead.status === "blocked" ? "blocked" : working ? "working" : lead.status === "done" ? "done" : "idle", 11))
      .child(div().text_color(t.muted).child(role?.name ?? lead.role))
      .when(Boolean(started), (el) => el.child(div().child(`working ${span(now - started)}`))))
    .child(div().flex_1())
    .when(Boolean(meter), (el) => el.child(h_flex().id("chat-ctx").flex_none().gap(6).items_center()
      .tooltip(`${Math.round(meter.pct * 100)}% of the context window`)
      .child(div().w(44).h(4).rounded(2).bg(t.border).overflow_hidden().child(div().h(4).w(Math.max(2, 44 * meter.pct)).rounded(2).bg(color)))
      .child(div().text_color(meter.level === "normal" ? t.dim : color).child(meter.label))))
    .when(Boolean(model), (el) => el.child(div().flex_none().child(model)));
}
