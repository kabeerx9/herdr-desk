import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, shared, setShared, openOverlay, closeOverlay, props, theme } from "herdr";
import { ago } from "./ui.js";

// Claude Code and Codex plan limits from usage.py, shared so the rail and its
// popover show the same numbers: shared("desk.usage") = { at, providers }.
const PAGES = {
  Claude: "https://claude.ai/settings/usage",
  Codex: "https://chatgpt.com/codex/settings/usage",
};
const LOGO = { Claude: ["icons/claude.svg", "#d97757"], Codex: ["icons/codex.svg", null] };

export function fetchUsage(cx) {
  cx.spawn(async (cx) => {
    try {
      const r = await exec("/usr/bin/python3", ["-I", `${appHome()}/mods/desk/usage.py`]);
      setShared("desk.usage", { at: Date.now(), providers: JSON.parse(r.stdout || "[]") });
    } catch (e) {
      setShared("desk.usage", { ...(shared("desk.usage") ?? {}), error: String(e) });
    }
    cx.notify();
  });
}

const usage = () => shared("desk.usage") ?? null;
const week = (p) => p.windows.find((w) => w.label === "Week") ?? p.windows[p.windows.length - 1];
const levelColor = (t, used) => (used >= 90 ? t.ansi1 : used >= 70 ? t.blocked : t.ansi2);

function logo(provider, size) {
  const [file, color] = LOGO[provider] ?? [null, null];
  // Codex's logo has a cutout that tinting would fill, so it draws as a picture.
  if (!file) return div().size(size);
  return color ? svg(file).size(size).flex_none().text_color(color) : image(file).w(size).h(size).flex_none();
}

function resetsIn(epoch) {
  if (!epoch) return "";
  const m = Math.max(0, Math.round((epoch * 1000 - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const POP_WIDTH = 280;
// Where each rail logo was last seen, so a key command opens beside it too.
const anchors = {};

// Opens to the left of the rail logo, bottom edges level, so the logos stay visible.
// The height is the popover's own layout: padding, header, footer, 42px a limit.
export function openLimits(provider) {
  const p = usage()?.providers?.find((x) => x.provider === provider);
  const height = 96 + 42 * Math.max(1, p?.windows.length ?? 1) + (p?.error ? 28 : 0);
  const b = anchors[provider];
  const at = b ? { x: Math.max(8, b.x - POP_WIDTH - 10), y: Math.max(8, b.y + b.height - height) } : "pointer";
  openOverlay({ mod: "desk", props: { popover: provider }, kind: "popup", width: POP_WIDTH, height, at });
}

// The rail's foot: each signed-in provider's logo over its weekly % used; the popover a click
// opens has every limit. The number turns amber past 70%, red past 90%.
export function railMeters(t) {
  const providers = (usage()?.providers ?? []).filter((p) => p.windows.length || p.error);
  if (!providers.length) return div();
  return v_flex().w_full().pt(8).pb(10).gap(4).items_center().border_t(1).border_color(t.border)
    .children(providers.map((p) => {
      const w = p.windows.length ? week(p) : null;
      const used = w ? Math.min(100, Math.max(0, Math.round(w.used))) : 0;
      return v_flex().id(`rail-u-${p.provider}`).w(40).h(38).gap(3).items_center().justify_center().rounded(8).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(w ? `${p.provider} · ${w.label.toLowerCase()} ${w.used}% used` : `${p.provider} · ${p.error ?? "no limits"}`)
        .on_mouse_move((e) => { if (e.bounds) anchors[p.provider] = e.bounds; })
        .on_mouse_down("left", (e, cx) => {
          if (e.bounds) anchors[p.provider] = e.bounds;
          cx.stop_propagation();
          openLimits(p.provider);
        })
        .child(logo(p.provider, 14))
        .child(div().text_size(11).font_medium().text_color(!w ? t.ansi1 : used >= 70 ? levelColor(t, used) : t.muted)
          .child(w ? `${used}%` : "!"));
    }));
}

// The popover a rail logo opens: that provider's plan and every limit.
export class UsagePopover {
  init() {}

  render(cx) {
    const t = theme();
    const u = usage(), name = props().popover;
    const p = u?.providers?.find((x) => x.provider === name);
    const close = () => closeOverlay(props().overlay);
    if (!p) return v_flex().p(14).text_size(12).text_color(t.dim).child("No usage yet.");
    const link = (id, label, onClick) => div().id(id).text_size(11.5).text_color(t.accent).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click(onClick).child(label);
    return v_flex().w_full().p(14).gap(12)
      .child(h_flex().gap(8).items_center()
        .child(logo(p.provider, 18))
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child(p.provider))
        .child(div().flex_1())
        .when(Boolean(p.plan), (el) => el.child(div().px(7).h(20).flex().items_center().rounded(10)
          .border_1().border_color(t.border).text_color(t.muted).text_size(11).font_medium().child(p.plan))))
      .when(Boolean(p.error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(p.error)))
      .children(p.windows.map((w) => v_flex().gap(6)
        .child(h_flex().items_center()
          .child(div().text_size(12).text_color(t.muted).child(w.label))
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.dim).mr(8).child(w.resets_at ? `resets in ${resetsIn(w.resets_at)}` : ""))
          .child(div().text_size(13).font_semibold().text_color(w.used >= 70 ? levelColor(t, w.used) : t.foreground).child(`${w.used}%`)))
        .child(div().w_full().h(6).rounded(3).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${Math.min(100, Math.max(w.used, w.used > 0 ? 2 : 0))}%`).rounded(3).bg(levelColor(t, w.used))))))
      .child(h_flex().pt(10).gap(12).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(u.at ? `Updated ${ago(new Date(u.at))} ago` : ""))
        .child(link("u-refresh", "Refresh", (_e, cx) => fetchUsage(cx)))
        .child(link("u-open", "Open usage page", () => { exec("open", [PAGES[p.provider]]); close(); })));
  }
}
