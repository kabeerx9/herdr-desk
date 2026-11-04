import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";

// An agent's chat reply as blocks: lead, headings, callouts, tables, steps, code cards and a
// "Next:" row of reply chips. TextView.markdown can't be styled, so the blocks are drawn here
// and only inline runs (bold, italic, code, links) go through TextView, which keeps them
// selectable. parseBlocks is pure; renderBlocks reads a parse cached by content hash, so a
// finished reply is parsed once and only the streaming one is re-parsed.

// ---- parse ----------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DELIM_CELL = /^\s*:?-+:?\s*$/;
const CALLOUT = /^\*\*([A-Za-z][A-Za-z ]{0,23}?):?\*\*:?\s*(.*)$/;
const BLOCKED_LABELS = new Set(["warning", "risk", "caution", "danger", "blocker"]);
const NEXT = /^\s*(?:\*\*)?Next(?:\*\*)?:(?:\*\*)?\s*(.+?)\s*$/i;

const blank = (line) => !line.trim();
const indentOf = (s) => s.replace(/\t/g, "    ").match(/^ */)[0].length;

// Cells of one table row: split on unescaped pipes outside inline code, outer pipes dropped.
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function delimiter(line, count) {
  if (!line || !line.includes("-")) return null;
  const cells = splitRow(line);
  if (cells.length !== count || !cells.every((c) => DELIM_CELL.test(c))) return null;
  return cells.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
}

// The reply chips on the last line: `Next: [a] [b]` or `Next: a | b`. Brackets must all be
// closed (a half-streamed `[Pla` is not a chip yet); links `[x](url)` are not chips.
export function parseNext(line) {
  const m = NEXT.exec(line ?? "");
  if (!m) return null;
  const rest = m[1];
  let options;
  if (rest.includes("[")) {
    if (/\]\(/.test(rest)) return null;
    const found = [...rest.matchAll(/\[([^\[\]]+)\]/g)].map((x) => x[1]);
    const left = rest.replace(/\[([^\[\]]+)\]/g, "").replace(/[\s,|·/]+/g, "");
    if (!found.length || left) return null;
    options = found;
  } else {
    options = rest.split("|");
  }
  options = options.map((x) => x.trim().replace(/^[*`"']+|[*`"']+$/g, "").trim()).filter(Boolean);
  return options.length ? options.slice(0, 3) : null;
}

// Sentences in a paragraph, for the lead: ends of . ! ? followed by space or the end.
const sentences = (text) => (text.trim().match(/[.!?]+(?=\s|$)/g) ?? []).length || 1;

// Nested lists from list lines (already cut out of the text). Deeper lines belong to the item
// above (a nested list, or a continuation of its text); a marker of the other kind at the same
// depth starts a new list.
const isOrdered = (marker) => /\d/.test(marker);
function buildLists(lines) {
  const lists = [];
  let i = 0;
  while (i < lines.length) {
    const first = ITEM.exec(lines[i]);
    if (!first) { i++; continue; }
    const base = indentOf(first[1]), ordered = isOrdered(first[2]);
    const list = { type: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    while (i < lines.length) {
      const m = ITEM.exec(lines[i]);
      if (m && indentOf(m[1]) === base) {
        if (isOrdered(m[2]) !== ordered) break;
        list.items.push({ text: m[3], children: [] });
        i++;
        continue;
      }
      if (m && indentOf(m[1]) < base) break;
      const sub = [];
      while (i < lines.length) {
        const n = ITEM.exec(lines[i]);
        if (n && indentOf(n[1]) <= base) break;
        sub.push(lines[i]);
        i++;
      }
      const item = list.items[list.items.length - 1];
      const at = sub.findIndex((l) => ITEM.test(l));
      const cont = (at < 0 ? sub : sub.slice(0, at)).map((l) => l.trim()).filter(Boolean);
      if (cont.length) item.text += `\n${cont.join("\n")}`;
      if (at >= 0) item.children.push(...buildLists(sub.slice(at)));
    }
    lists.push(list);
  }
  return lists;
}

// Blocks of a reply. Safe on streaming text: an unclosed code fence, or a table whose header
// has no complete delimiter row yet, comes back as plain text; a half-typed last row of a table
// at the very end is held back as plain text until its line is complete.
export function parseBlocks(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const endsOpen = !src.endsWith("\n");
  const blocks = [];

  // The last non-empty line may be the Next row.
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last])) last--;
  let next = null;
  const openFence = lines.slice(0, Math.max(last, 0)).filter((l) => FENCE.test(l)).length % 2 === 1;
  if (last >= 0 && !openFence) {
    const opts = parseNext(lines[last]);
    if (opts) { next = { type: "next", options: opts }; lines.length = last; }
  }

  let i = 0;
  const para = [];
  const flush = () => {
    if (!para.length) return;
    blocks.push({ type: "para", text: para.join("\n") });
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { flush(); i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const close = new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      if (j >= lines.length) {
        // Still streaming: show what has arrived, unstyled.
        blocks.push({ type: "plain", text: lines.slice(i).join("\n"), mono: true });
        i = lines.length;
        break;
      }
      blocks.push({ type: "code", lang: fence[2] || null, code: lines.slice(i + 1, j).join("\n") });
      i = j + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (HR.test(line)) { flush(); blocks.push({ type: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])[1]); i++; }
      const head = CALLOUT.exec(body[0].trim());
      if (head) {
        const label = head[1].trim();
        const rest = [head[2], ...body.slice(1)].join("\n").trim();
        blocks.push({ type: "callout", label, tone: BLOCKED_LABELS.has(label.toLowerCase()) ? "blocked" : "accent", text: rest });
      } else {
        blocks.push({ type: "quote", text: body.join("\n").trim() });
      }
      continue;
    }

    if (line.includes("|")) {
      const header = splitRow(line);
      // The delimiter row must be complete: not the line still being typed.
      const typing = endsOpen && i + 1 === lines.length - 1;
      const align = typing ? null : delimiter(lines[i + 1], header.length);
      if (header.length > 1 && align) {
        flush();
        const rows = [];
        let j = i + 2;
        while (j < lines.length && !blank(lines[j]) && lines[j].includes("|")) {
          const cells = splitRow(lines[j]);
          rows.push(Array.from({ length: header.length }, (_, k) => cells[k] ?? ""));
          j++;
        }
        // A partial last row while streaming: the text ends inside it.
        let tail = null;
        if (endsOpen && j === lines.length && rows.length && !lines[j - 1].trim().endsWith("|")
          && splitRow(lines[j - 1]).length < header.length) {
          rows.pop();
          tail = lines[j - 1];
        }
        blocks.push({ type: "table", header, align, rows });
        if (tail) blocks.push({ type: "plain", text: tail });
        i = j;
        continue;
      }
    }

    if (ITEM.test(line) && !(para.length && !/^\s*(?:[-*+]|1[.)])\s/.test(line))) {
      flush();
      const region = [];
      while (i < lines.length) {
        const l = lines[i];
        if (blank(l)) {
          // A blank line ends the list unless the list continues after it.
          let k = i + 1;
          while (k < lines.length && blank(lines[k])) k++;
          if (k < lines.length && (ITEM.test(lines[k]) || indentOf(lines[k]) >= 2)) { i = k; continue; }
          break;
        }
        if (!ITEM.test(l) && indentOf(l) < 2 && region.length && (FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || HR.test(l))) break;
        region.push(l);
        i++;
      }
      blocks.push(...buildLists(region));
      continue;
    }

    para.push(line);
    i++;
  }
  flush();

  // The lead: a short opening paragraph (two sentences at most).
  if (blocks[0]?.type === "para" && sentences(blocks[0].text) <= 2) blocks[0].lead = true;
  if (next) blocks.push(next);
  return blocks;
}

// What a table cell means: ✓ / yes / pass → done, ✗ / no / fail → fail, ⚠ / warn → blocked.
const DONE_WORDS = new Set(["✓", "✔", "✅", "yes", "pass", "passed"]);
const FAIL_WORDS = new Set(["✗", "✘", "❌", "no", "fail", "failed"]);
const WARN_WORDS = new Set(["⚠", "⚠️", "warn", "warning"]);
export function cellTone(cell) {
  const s = String(cell ?? "").replace(/\*\*|__|`/g, "").trim().toLowerCase();
  if (!s) return null;
  const head = s.split(/\s+/)[0];
  const glyph = /^[^\p{L}\p{N}]/u.test(head) ? head : null;
  const is = (set) => set.has(s) || (glyph && set.has(glyph));
  return is(DONE_WORDS) ? "done" : is(FAIL_WORDS) ? "fail" : is(WARN_WORDS) ? "warn" : null;
}

// ---- cache ----------------------------------------------------------------------------------

// FNV-1a, as in model.js.
function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(36)}-${s.length}`;
}

const CACHE = new Map();
const CACHE_MAX = 300;
export function blocksFor(text) {
  const key = hash(text);
  let hit = CACHE.get(key);
  if (hit) { CACHE.delete(key); CACHE.set(key, hit); return hit; }
  hit = parseBlocks(text);
  CACHE.set(key, hit);
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return hit;
}

// ---- render ---------------------------------------------------------------------------------

const MONO = "JetBrains Mono";
const MAX_W = 640;
const INLINE = /[*_`\[\]<]|https?:\/\//;
let copied = null;

const inline = (id, text) => TextView.markdown(id, text).selectable(true);
// Plain text without inline markup draws as a div; anything with markup goes through TextView.
const runs = (id, text) => (INLINE.test(text) ? inline(id, text) : text);
const stripInline = (s) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Space above each block, from the one before it.
function gapAbove(prev, b) {
  if (!prev) return 0;
  if (b.type === "heading") return 16;
  if (prev.type === "heading") return 6;
  if (b.type === "hr" || prev.type === "hr") return 12;
  if (prev.lead) return 12;
  if (b.type === "next") return 14;
  return 10;
}

function plainLines(t, id, text, mono) {
  return v_flex().id(id).min_w(0)
    .when(mono, (el) => el.font_family(MONO).text_size(12.5).line_height(1.55).text_color(t.muted))
    .children(text.split("\n").map((l, i) => div().id(`${id}-${i}`).min_w(0).child(l || " ")));
}

function heading(t, b) {
  return h_flex().w_full().gap(8).items_center()
    .child(div().flex_none().text_size(12).font_semibold().text_color(t.muted).child(stripInline(b.text)))
    .child(div().flex_1().h(1).bg(t.border));
}

function callout(t, id, b) {
  const color = b.tone === "blocked" ? t.blocked : t.accent;
  return v_flex().w_full().pl(12).gap(3).border_l_2().border_color(color)
    .child(div().text_size(11.5).font_semibold().text_color(color).child(b.label.toUpperCase()))
    .when(Boolean(b.text), (el) => el.child(div().text_color(t.foreground).child(inline(`${id}-body`, b.text))));
}

function quote(t, id, b) {
  return div().w_full().pl(12).border_l_2().border_color(t.border).text_color(t.muted).child(inline(`${id}-q`, b.text));
}

const ALIGN = { right: (el) => el.justify_end(), center: (el) => el.justify_center() };
function cell(t, id, text, align, { head = false } = {}) {
  const tone = head ? null : cellTone(text);
  const color = head ? t.muted : tone === "done" ? t.done : tone === "fail" ? (t.failed ?? t.blocked) : tone === "warn" ? t.blocked : t.foreground;
  const bold = head || (Boolean(tone) && /^\s*\*\*/.test(text));
  const el = h_flex().id(id).flex_1().flex_basis(0).min_w(0).px(10).py(7).text_size(12.5).line_height(1.45).text_color(color)
    .when(bold, (x) => x.font_semibold());
  return (ALIGN[align]?.(el) ?? el).child(tone || head ? stripInline(text) : runs(`${id}-t`, text));
}

function table(t, id, b) {
  return v_flex().id(id).w_full().rounded(9).border_1().border_color(t.border).overflow_hidden()
    .child(h_flex().w_full().bg(t.raised)
      .children(b.header.map((c, k) => cell(t, `${id}-h${k}`, c, b.align[k], { head: true }))))
    .children(b.rows.map((row, r) => h_flex().id(`${id}-r${r}`).w_full().border_t_1().border_color(t.border)
      .children(row.map((c, k) => cell(t, `${id}-r${r}c${k}`, c, b.align[k])))));
}

function list(t, id, b, depth = 0) {
  const n = b.items.length;
  return v_flex().id(id).w_full().min_w(0).when(!b.ordered, (el) => el.gap(4))
    .children(b.items.map((item, k) => {
      const text = v_flex().min_w(0).flex_1().gap(4)
        .child(div().min_w(0).child(inline(`${id}-i${k}`, item.text)))
        // Nested lists sit in the text column: 14px past a dot (+4 makes 18), past a step's ring.
        .children(item.children.map((c, j) => div().min_w(0).when(!b.ordered, (el) => el.pl(4)).child(list(t, `${id}-i${k}-l${j}`, c, depth + 1))));
      if (!b.ordered) {
        return h_flex().id(`${id}-row${k}`).w_full().items_start().gap(9)
          .child(div().flex_none().h(22).w(5).flex().items_center().child(div().size(5).rounded_full().bg(t.muted)))
          .child(text);
      }
      // Steps: a numbered ring, a 1px line down to the next one, the text beside it.
      return h_flex().id(`${id}-row${k}`).w_full().items_stretch().gap(10)
        .child(v_flex().flex_none().w(20).items_center()
          .child(div().mt(1).size(20).flex_none().rounded_full().border_1().border_color(t.border).flex().items_center().justify_center()
            .text_size(11).font_semibold().text_color(t.muted).child(String(b.start + k)))
          .when(k < n - 1, (el) => el.child(div().w(1).flex_1().min_h(6).bg(t.border))))
        .child(text.when(k < n - 1, (el) => el.pb(10)));
    }))
    .when(depth > 0, (el) => el.mt(2));
}

function code(t, id, b) {
  const done = copied === id;
  const lines = b.code.split("\n");
  return v_flex().id(id).w_full().rounded(9).border_1().border_color(t.border).overflow_hidden()
    .child(h_flex().h(30).px(10).items_center().bg(t.raised).border_b_1().border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11.5).text_color(t.dim).child(b.lang ?? "text"))
      .child(div().id(`${id}-copy`).flex_none().h(22).px(8).flex().items_center().rounded(6).text_size(11.5).font_medium()
        .text_color(done ? t.done : t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          cx.write_to_clipboard(b.code);
          copied = id;
          cx.notify();
          cx.timer?.after(1600, (cx) => { if (copied === id) { copied = null; cx.notify(); } });
        })
        .child(done ? "Copied" : "Copy")))
    .child(div().id(`${id}-scroll`).w_full().overflow_x_scroll()
      .child(v_flex().px(12).py(10).font_family(MONO).text_size(12.5).line_height(1.55).text_color(t.foreground)
        .children(lines.map((l, k) => div().id(`${id}-l${k}`).whitespace_nowrap().child(l || " ")))));
}

function nextRow(t, id, b, onReply) {
  return h_flex().id(id).w_full().flex_wrap().gap(8)
    .children(b.options.map((text, k) => div().id(`${id}-${k}`).h(28).px(12).flex().items_center().rounded(8)
      .border_1().border_color(t.border).text_size(12).font_medium().text_color(t.foreground)
      .when(Boolean(onReply), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onReply(text, cx); }))
      .child(text)));
}

function block(t, id, b, opts) {
  switch (b.type) {
    case "para": return div().w_full().min_w(0).text_color(t.foreground).when(Boolean(b.lead), (el) => el.font_medium()).child(inline(id, b.text));
    case "heading": return heading(t, b);
    case "callout": return callout(t, id, b);
    case "quote": return quote(t, id, b);
    case "table": return table(t, id, b);
    case "list": return list(t, id, b);
    case "code": return code(t, id, b);
    case "next": return nextRow(t, id, b, opts.onReply);
    case "hr": return div().w_full().h(1).bg(t.border);
    case "plain": return plainLines(t, id, b.text, Boolean(b.mono));
    default: return div();
  }
}

// One reply, drawn. `onReply(text, cx)` runs when a Next chip is clicked. `size` is the body
// size (14 in the wide chat).
export function renderBlocks(t, id, text, { onReply = null, size = 14 } = {}) {
  const blocks = blocksFor(text);
  return v_flex().id(id).w_full().max_w(MAX_W).min_w(0).text_size(size).line_height(1.6).text_color(t.foreground)
    .children(blocks.map((b, k) => div().w_full().min_w(0).pt(gapAbove(blocks[k - 1], b)).child(block(t, `${id}-b${k}`, b, { onReply }))));
}
