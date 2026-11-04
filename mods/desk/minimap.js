import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

// A thin rail at the thread's left (wide chat only): one mark per message you sent. Hover
// shows its first words; click jumps there; the prompt you're reading under is highlighted.
const MAX = 48;

export function minimap(o, t, slug, prompts, active) {
  if (prompts.length < 2) return null;
  const from = Math.max(0, prompts.length - MAX);
  return v_flex().id(`minimap-${slug}`).absolute().left(10).top(0).bottom(0).w(22).justify_center().gap(2)
    .children(prompts.slice(from).map((p, j) => {
      const i = from + j, on = i === active;
      const preview = p.text.replace(/\s+/g, " ").trim();
      return div().id(`mm-${slug}-${p.key}`).h(10).w(22).flex().items_center().cursor_pointer()
        .tooltip(preview.length > 120 ? `${preview.slice(0, 119)}…` : preview || "(empty)")
        .on_click((_e, cx) => o.jumpTo(slug, p.key, cx))
        .child(div().h(2).w(on ? 16 : 8).rounded(1).bg(on ? t.accent : t.input)
          .transition("width", { duration: 160, easing: "ease-out" }));
    }));
}
