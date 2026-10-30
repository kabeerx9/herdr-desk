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

export function pill(t, text, color) {
  return div().px(6).h(18).flex().items_center().rounded(9).text_size(10.5).font_medium()
    .bg(color + "22").text_color(color).child(text);
}

// A small action button; stops the press so rows underneath don't also click.
export function button(t, id, label, onClick, { iconName, primary, disabled, tip } = {}) {
  return h_flex().id(id).h(24).px(label ? 8 : 6).gap(5).items_center().rounded(6).flex_none().text_size(11.5).font_medium()
    .bg(primary && !disabled ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
    .border_1().border_color(primary ? (disabled ? t.border : t.solid) : t.border)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) onClick(e, cx); })
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 13)))
    .when(Boolean(label), (el) => el.child(label));
}

export function section(t, id, title, count, open, onToggle, extra) {
  return h_flex().id(id).h(28).px(12).gap(6).items_center().cursor_pointer().on_click(onToggle)
    .child(icon(open ? "chevron-down" : "chevron", 12).text_color(t.dim))
    .child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
    .when(count !== null && count !== undefined, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(count))))
    .child(div().flex_1())
    .when(Boolean(extra), (el) => el.child(extra));
}

export function empty(t, text) {
  return div().mx(12).my(4).px(12).py(10).rounded(8).border_1().border_color(t.border)
    .text_size(12).text_color(t.dim).child(text);
}

export function card(t, id, hovered) {
  return v_flex().id(id).mx(8).px(10).py(8).gap(4).rounded(8).border_1()
    .border_color(hovered ? t.input : "#00000000").bg(hovered ? t.hover : "#00000000");
}
