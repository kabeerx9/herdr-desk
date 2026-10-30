// A pane's header for the desk layout, cloned from the shipped `pane` mod.
// Left: program, repo/folder, branch with uncommitted count, agent status with
// how long it has been working. On hover, five buttons, the hovered one named:
// Claude beside, open in Zed, split, zoom, close. Props from the app: { pane, terminal }.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, exec } from "herdr";

const CLAUDE = "#d97757";

function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// "~/Desktop/projects/tattvix/apps/web" → { lead: "~/Desktop/projects/", name: "tattvix", rest: "/apps/web" }
function split(cwd, root) {
  if (!cwd) return { lead: "", name: "", rest: "" };
  const short = (s) => { const h = home(); return s === h ? "~" : s.startsWith(h + "/") ? "~" + s.slice(h.length) : s; };
  if (root && (cwd === root || cwd.startsWith(root + "/"))) {
    const r = short(root), i = r.lastIndexOf("/");
    return { lead: r.slice(0, i + 1), name: r.slice(i + 1), rest: cwd.slice(root.length) };
  }
  return { lead: "", name: short(cwd), rest: "" };
}

const elapsed = (since) => {
  const m = Math.floor((Date.now() - since) / 60000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.git = null;
    this.tip = null;
    cx.timer.every(15000, (cx) => this.refresh(cx));
    // Redraws the working time; cheap, and only matters while an agent works.
    cx.timer.every(30000, (cx) => { if (this.me()?.status === "working") cx.notify(); });
    this.refresh(cx);
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  refresh(cx) {
    const cwd = this.me()?.cwd;
    if (!cwd) return;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
        if (top.code !== 0) { this.git = null; return; }
        const st = await exec("git", ["--no-optional-locks", "status", "--porcelain"], { cwd });
        this.git = { root: top.stdout.trim(), dirty: st.stdout.split("\n").filter(Boolean).length, cwd };
      } catch { this.git = null; }
      finally { cx.notify(); }
    });
  }

  button(t, id, iconEl, tip, onClick) {
    return div().id(id).p(3).rounded(4).flex_none().text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_hover((h, cx) => { this.tip = h ? tip : this.tip === tip ? null : this.tip; cx.notify(); })
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(iconEl);
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    if (p.cwd && this.git && this.git.cwd !== p.cwd) { this.git = null; this.refresh(cx); }
    const pane = p.pane, cwd = p.cwd;
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = programIcon(p.program, 14, t.dim);
    const st = p.status;
    const since = spaces().flatMap((s) => s.tabs).find((x) => x.id === p.tab)?.working_since;
    const path = split(cwd, this.git?.root);
    const ic = (file, size = 14) => svg(`mods/desk-pane/${file}.svg`).size(size);

    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full().px(10).gap(8).items_center()
      .bg(p.focused ? t.background : t.surface)
      .border_b(1).border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; if (!hovered) this.tip = null; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(220).font_medium().text_color(p.focused ? t.foreground : t.muted).child(name))
      // repo-relative path: the repo name stands out, its parents fade.
      .child(h_flex().flex_1().min_w(0).items_center()
        .child(div().flex_none().text_color(t.dim).child(path.lead))
        .child(div().flex_none().text_color(this.git ? t.muted : t.dim).when(Boolean(this.git), (el) => el.font_medium()).child(path.name))
        .child(div().min_w(0).truncate().text_color(t.dim).child(path.rest))
        .when(Boolean(p.branch), (el) => el.child(h_flex().ml(8).flex_none().gap(4).items_center().px(6).h(18).rounded(5)
          .bg(t.raised).text_size(11).text_color(t.muted)
          .child(ic("branch", 11))
          .child(div().max_w(180).truncate().child(p.branch))
          .when(Boolean(this.git?.dirty), (el) => el.child(div().text_color(t.blocked).child(`●${this.git.dirty}`))))))
      .when(st === "working", (el) => el.child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.working)
        .child(svg("mods/workspace-chrome/spinner.svg").size(12).spin(900))
        .when(Boolean(since), (el) => el.child(elapsed(since)))))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26")
        .text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.done + "26")
        .text_size(10.5).font_semibold().text_color(t.done).child("Done")))
      .when(this.hovered, (el) => el
        // The hovered button's name, spelled out beside the buttons.
        .when(Boolean(this.tip), (el) => el.child(div().flex_none().mr(2).text_size(11).text_color(t.muted).child(this.tip)))
        .when(Boolean(cwd), (el) => el
          .child(this.button(t, `ph-c-${pane}`, svg("icons/claude.svg").size(14).text_color(CLAUDE), "New Claude beside",
            () => run("pane.split", { direction: "right", pane, argv: ["claude"] })))
          .child(this.button(t, `ph-e-${pane}`, ic("editor"), "Open in Zed", () => exec("open", ["-a", "Zed", this.git?.root ?? cwd]))))
        .child(this.button(t, `ph-r-${pane}`, ic("split-right"), "Split", () => run("pane.split", { direction: "right", pane })))
        .child(this.button(t, `ph-z-${pane}`, ic(p.zoomed ? "unzoom" : "zoom"), p.zoomed ? "Unzoom" : "Zoom", () => run("pane.zoom", { pane })))
        .child(this.button(t, `ph-x-${pane}`, ic("close"), "Close", () => run("pane.close", { pane }))));
  }
}
