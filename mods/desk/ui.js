import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export const icon = (name, size = 14) => svg(`mods/desk/icons/${name}.svg`).size(size).flex_none();

// Stable per-name color for project tiles.
const TILE = ["ansi4", "ansi5", "ansi6", "ansi2", "ansi3", "ansi1"];
export function tileColor(t, name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return t[TILE[h % TILE.length]];
}

export const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

// The one status mark every Desk surface draws (chat, card, spaces, pane headers). Shape
// carries the meaning, colour confirms it, so it reads in either theme and for colour-blind
// eyes: working spins a ring, blocked is a pulsing square with "!", done a filled check,
// idle a hollow dot, queued a dashed ring, failed a cross, disconnected a broken ring.
export const MARKS = ["working", "blocked", "done", "idle", "queued", "failed", "disconnected"];
const MARK_COLOR = { working: "working", blocked: "blocked", done: "done", idle: "dim", queued: "muted", failed: "blocked", disconnected: "dim" };
export function statusMark(t, status, size = 12) {
  const kind = MARKS.includes(status) ? status : "idle";
  const el = svg(`mods/desk/icons/marks/${kind}.svg`).size(size).flex_none().text_color(t[MARK_COLOR[kind]] ?? t.dim);
  if (kind === "working") return el.spin(900);
  if (kind === "blocked") return el.loop("opacity", { from: 0.45, to: 1, period: 1400 });
  return el;
}

// A status at a glance, in its color: working spins; needs you pulses; done has a check;
// idle is quiet text. The Desk's agent rows and the spaces list draw the same badge.
export const STATUS_LABEL = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
export function statusBadge(t, status, { idle = true } = {}) {
  if (!STATUS_LABEL[status] || (status === "idle" && !idle)) return null;
  if (status === "idle") return div().flex_none().px(2).text_size(11).text_color(t.dim).child("Idle");
  const color = t[status] ?? t.dim;
  const mark = status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().spin(900)
    : status === "blocked" ? div().size(6).rounded(3).flex_none().bg(color).loop("opacity", { from: 0.35, to: 1, period: 1400 })
    : svg("mods/desk/icons/check.svg").size(10).flex_none();
  return h_flex().flex_none().h(20).pl(6).pr(7).gap(4).items_center().rounded(10).bg(color + "1f")
    .text_size(10.5).font_semibold().text_color(color).child(mark).child(STATUS_LABEL[status]);
}

// A quiet label: outlined, muted text; `color` tints only its text (status words, PR states).
export function pill(t, text, color) {
  return div().px(6).h(18).flex().flex_none().items_center().rounded(5).border_1().border_color(t.border)
    .text_size(11).font_medium().text_color(color ?? t.muted).child(text);
}

// A small action button; stops the press so rows underneath don't also click.
// variant: "ghost" (text only, hover fill), "outline" (hairline; the default), "solid" (the one
// primary action: accent). `primary: true` is "solid". Hover and press each step one shade.
export function button(t, id, label, onClick, { iconName, primary, disabled, tip, variant } = {}) {
  const kind = variant ?? (primary ? "solid" : "outline");
  const solid = kind === "solid", ghost = kind === "ghost";
  const bg = disabled ? (solid ? t.raised : "#00000000") : solid ? t.accent : ghost ? "#00000000" : t.background;
  const fg = disabled ? t.dim : solid ? t.accent_foreground : ghost ? t.muted : t.foreground;
  return h_flex().id(id).h(26).px(label ? 10 : 6).gap(6).items_center().justify_center().rounded(6).flex_none().text_size(12).font_medium()
    .bg(bg).text_color(fg)
    .when(!ghost, (el) => el.border_1().border_color(solid && !disabled ? t.accent : t.border))
    .when(!disabled, (el) => el.cursor_pointer()
      .hover((s) => (solid ? s.opacity(0.9) : s.bg(t.hover).text_color(t.foreground)))
      .active((s) => (solid ? s.opacity(0.8) : s.bg(t.selected))))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) onClick(e, cx); })
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 13)))
    .when(Boolean(label), (el) => el.child(label));
}

// A section's title: sentence case, 12 semibold, a quiet count, the fold chevron after it.
export function section(t, id, title, count, open, onToggle, extra) {
  return h_flex().id(id).h(28).px(14).gap(6).items_center().cursor_pointer().on_click(onToggle)
    .hover((s) => s.text_color(t.foreground))
    .child(div().text_size(12).font_semibold().text_color(t.foreground).child(title))
    .when(count !== null && count !== undefined, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))))
    .child(icon(open ? "chevron-down" : "chevron", 11).text_color(t.dim))
    .child(div().flex_1())
    .when(Boolean(extra), (el) => el.child(extra));
}

// An empty state: one quiet line on the surface, no box.
export function empty(t, text) {
  return div().mx(14).my(4).py(6).text_size(12).text_color(t.dim).child(text);
}

// A list card: a hairline outline always (white on white reads by its edge), hover fills.
export function card(t, id, hovered) {
  return v_flex().id(id).mx(8).px(10).py(8).gap(4).rounded(8).border_1()
    .border_color(hovered ? t.input : t.border).bg(hovered ? t.hover : "#00000000");
}

// ── Shared rhythm (docs/plans/2026-11-04-desk-overhaul.md): 28px rows, radius 8, hairlines ──
export const ROW = 28;
export const RADIUS = 8;
export const hairline = (t) => div().h(1).flex_none().mx(12).bg(t.border);

// A square icon button for a row's hover actions; stops the press so the row doesn't click too.
export function iconButton(t, id, name, tip, onClick, { size = 22, color, disabled } = {}) {
  return h_flex().id(id).size(size).flex_none().items_center().justify_center().rounded(6)
    .text_color(disabled ? t.dim : color ?? t.muted)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) onClick(e, cx); })
    .child(icon(name, 13));
}

// Show a branch only when it's off the main line.
export const offMain = (branch, base) => Boolean(branch) && branch !== base && !["main", "master", "trunk", "HEAD"].includes(branch);

// Most urgent first: what a group of agents shows as one mark.
const URGENCY = ["blocked", "failed", "working", "queued", "done", "disconnected", "idle"];
export function mostUrgent(statuses) {
  let best = null;
  for (const s of statuses) if (s && (best === null || URGENCY.indexOf(s) < URGENCY.indexOf(best))) best = s;
  return best;
}
