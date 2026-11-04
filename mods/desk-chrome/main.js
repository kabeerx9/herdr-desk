import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, keys } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  // The palette key as actually bound (from workspace-status): "Commands  ⌘⇧P".
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `Commands  ${key}` : "Commands";
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      // T3's quiet footer: one row of 28px icon buttons on the sidebar's 8px inset, a hairline above.
      const item = (id, icon, tip, action, extra) => div().id(id).relative().size(28).flex_none().flex().items_center().justify_center().rounded(8)
        .text_color(t.dim).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected))
        .tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
        .child(svg(`mods/desk-chrome/${icon}.svg`).size(15))
        .when(Boolean(extra), el => el.child(extra));
      const ready = Boolean(updates()?.app?.ready);
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).gap(2).items_center()
        .child(item("settings", "settings", ready ? "Settings · an update is ready" : "Settings", () => run("app.settings"),
          ready ? div().absolute().top(5).right(5).size(6).rounded_full().bg(t.accent) : null))
        .when(!collapsed, el => el
          .child(item("machine", "machine", "Add machine", () => run("mod.open", { name: "machine-add" })))
          .child(item("palette", "command", this.hint(), () => run("app.palette")))
          .child(item("help", "help", "Help", () => run("app.help"))));
    }
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(image("frame/welcome/herdr.png").size(20).rounded(5)).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/desk-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the macOS rail the traffic lights fill the row; the agents list's » unfolds it.
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg("mods/desk-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
