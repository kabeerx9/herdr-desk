// Pure derivation for the desk chat: no herdr or gpui imports, so `node --test` runs it.
// desks.js calls these when data arrives (a thread reload, a step/timeline poll); the
// timeline only reads what they return.

export const EVENTS = ["desk", "start", "fresh", "compact", "permission", "permission-done"];
// Report kinds: the word after the name, and the status mark that goes with it (if any).
export const KIND = {
  done: { word: "done", mark: "done" }, blocked: { word: "blocked", mark: "blocked" }, update: { word: "update" },
  flag: { word: "left locally", mark: "failed" }, finish: { word: "wrapped up" }, ask: { word: "asks" },
  answer: { word: "answers" }, route: { word: "passes on" }, context: { word: "long context" },
};
export const ASIDE = ["ask", "answer", "route"];
const SIDE = ["ask", "answer", "route", "done", "blocked", "update", "flag"];
export const WINDOW = 60;

// "Worked for 9m 38s".
export function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

// A cheap, stable content hash (FNV-1a) for cache keys.
export function hash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export const rowKey = (m, i) => String(m.id ?? `${m.at}-${m.from ?? ""}-${i}`);

// The thread as rows, derived once per reload. Consecutive "added X" events by one person
// merge; each agent reply learns its turn span (from the first message that reached that
// agent since its last reply); runs by one author share a name row. `cache` (a Map) keeps
// row objects whose inputs didn't change, so finished rows are the same objects every time.
export function buildRows(messages, cache = new Map()) {
  const permitDone = new Map();
  const merged = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== "object") continue;
    if (m.kind === "permission-done") { permitDone.set(m.re, m.decision); continue; }
    const last = merged.at(-1);
    if (m.kind === "start" && last?.kind === "start" && last.from === m.from && m.at - last.at < 600000) {
      merged[merged.length - 1] = { ...last, roles: [...(last.roles ?? [last.role]), m.role] };
    } else merged.push(m);
  }
  const started = new Map();
  const rows = [], prompts = [];
  let lastReply = -1, prev = null;
  merged.forEach((m, i) => {
    let worked = null, turnStart = null;
    const event = EVENTS.includes(m.kind);
    if (!event && m.kind !== "context") {
      if (m.from === "kabeer" || m.kind === "ask" || m.kind === "route") {
        for (const r of m.to ?? []) if (!started.has(r)) started.set(r, m.at);
      }
      if (m.from !== "kabeer" && started.has(m.from)) { turnStart = started.get(m.from); worked = m.at - turnStart; started.delete(m.from); }
    }
    const type = m.kind === "permission" ? "permission" : event ? "event" : m.from === "kabeer" ? "mine" : "agent";
    const aside = type === "agent" && ASIDE.includes(m.kind);
    const grouped = type === "agent" && !aside && !KIND[m.kind] && Boolean(prev) && prev.m.from === m.from && prev.type === "agent"
      && !KIND[prev.m.kind] && m.at - prev.m.at < 300000;
    const key = rowKey(m, i);
    const sig = `${hash(m.text)}|${m.kind}|${worked}|${grouped}|${(m.roles ?? []).length}|${(m.delivered ?? []).length}|${(m.failed ?? []).length}`;
    let row = cache.get(key);
    if (!row || row.sig !== sig) {
      row = { key, sig, type, m, aside, grouped, worked, turnStart, side: SIDE.includes(m.kind), long: SIDE.includes(m.kind) && (m.text ?? "").length > 600 };
      cache.set(key, row);
    }
    rows.push(row);
    if (type === "mine") prompts.push({ key, text: m.text ?? "", at: m.at });
    if (type === "agent" && m.kind !== "ask") lastReply = rows.length - 1;
    prev = row;
  });
  // Turns still open: someone was asked and hasn't replied yet (role -> when).
  const open = Object.fromEntries(started);
  return { rows, prompts, permitDone, lastReply, open, said: rows.some((r) => r.type !== "event" && r.type !== "permission") };
}

// Which rows to draw: the newest `limit`, but while the reader is scrolled up the start stays
// put (new rows at the bottom never shift what they're reading). `from` is last frame's start.
export function windowStart(total, { limit = WINDOW, following = true, from = null } = {}) {
  const newest = Math.max(0, total - limit);
  if (following || from === null || from === undefined) return newest;
  return Math.max(0, Math.min(from, newest));
}

// ── steps, tools and thoughts ────────────────────────────────────────────────

const STEP_KIND = { Read: "read", Glob: "search", Grep: "search", Bash: "command", Edit: "edit", MultiEdit: "edit", Write: "edit",
  NotebookEdit: "edit", WebFetch: "web", WebSearch: "web", Task: "agent", Agent: "agent" };
const PHRASE = {
  read: (n) => `read ${n} file${n === 1 ? "" : "s"}`, edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
  command: (n) => `ran ${n} command${n === 1 ? "" : "s"}`, search: (n) => `searched ${n} time${n === 1 ? "" : "s"}`,
  web: (n) => `fetched ${n} page${n === 1 ? "" : "s"}`, agent: (n) => `started ${n} subagent${n === 1 ? "" : "s"}`,
  other: (n) => `${n} other step${n === 1 ? "" : "s"}`,
};
const ORDER = ["read", "edit", "command", "search", "web", "agent", "other"];
export const stepKind = (tool) => STEP_KIND[tool] ?? "other";

// "Read 4 files, ran 2 commands" from counts ({read: 4, command: 2, ...}); at most three parts.
export function summarizeCounts(counts) {
  const kinds = ORDER.filter((k) => (Number(counts?.[k]) || 0) > 0);
  if (!kinds.length) return "";
  const shown = kinds.length > 3
    ? [...kinds.slice(0, 2).map((k) => PHRASE[k](counts[k])), PHRASE.other(kinds.slice(2).reduce((n, k) => n + Number(counts[k]), 0))]
    : kinds.map((k) => PHRASE[k](counts[k]));
  const text = shown.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}
export function summarizeSteps(steps) {
  const counts = {};
  for (const s of steps ?? []) { const k = stepKind(s.tool); counts[k] = (counts[k] ?? 0) + 1; }
  return summarizeCounts(counts);
}

// The latest thought as one calm line: its **heading** if it has one, else its first sentence,
// without markdown.
export function thoughtLine(thought) {
  if (!thought) return "";
  const raw = String(thought.heading || thought.text || "");
  const heading = /^\s*\*\*([^*\n]+)\*\*/.exec(raw)?.[1];
  const text = (heading ?? raw)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/\s+/g, " ").trim();
  if (heading !== undefined || thought.heading) return text;
  return text.length > 280 ? `${text.slice(0, 279)}…` : text;
}

// bin/team timeline's JSON, or null when it errored, isn't JSON, or isn't supported here.
export function parseTimeline(stdout) {
  let data;
  try { data = JSON.parse(String(stdout ?? "").trim() || "null"); } catch { return null; }
  if (!data || typeof data !== "object" || data.supported === false) return null;
  const subagents = Array.isArray(data.subagents) ? data.subagents.filter((s) => s && typeof s === "object").map((s) => ({
    id: String(s.id ?? s.title ?? ""), title: s.title || s.type || "Subagent", type: s.type ?? null,
    status: ["running", "done", "failed"].includes(s.status) ? s.status : "running",
    started_ms: Number(s.started_ms) || null, ended_ms: Number(s.ended_ms) || null, line: s.line ?? "",
  })) : [];
  const ctx = data.context && Number(data.context.tokens) && Number(data.context.max) ? { tokens: Number(data.context.tokens), max: Number(data.context.max) } : null;
  return {
    turn: data.turn && Number(data.turn.started_ms) ? { started_ms: Number(data.turn.started_ms), working: Boolean(data.turn.working) } : null,
    thought: data.thought && (data.thought.text || data.thought.heading) ? data.thought : null,
    tools: data.tools && typeof data.tools === "object" ? { summary: data.tools.summary || summarizeCounts(data.tools.counts), counts: data.tools.counts ?? {}, failed: Number(data.tools.failed) || 0 } : null,
    subagents, context: ctx, title: data.title ?? null,
  };
}

// The activity tail and the timeline come back from one exec, split by this line.
export const SPLIT = "\u001e";
export function splitPoll(stdout) {
  const [steps = "", timeline = ""] = String(stdout ?? "").split(`\n${SPLIT}\n`);
  const list = steps.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((s) => s && s.at);
  return { steps: list, timeline: parseTimeline(timeline) };
}

// "3 subagents · 2 running".
export function subagentHeader(subs) {
  const running = subs.filter((s) => s.status === "running").length, failed = subs.filter((s) => s.status === "failed").length;
  const tail = running ? `${running} running` : failed ? `${failed} failed` : "all done";
  return { text: `${subs.length} subagent${subs.length === 1 ? "" : "s"} · ${tail}`, status: running ? "working" : failed ? "failed" : "done" };
}
export const subStatus = (s) => (s.status === "running" ? "working" : s.status);
export function subElapsed(s, now) {
  if (!s.started_ms) return "";
  return span((s.ended_ms ?? now) - s.started_ms);
}

// The context meter shows only past half: null below 50%.
export function contextMeter(ctx) {
  if (!ctx?.tokens || !ctx?.max) return null;
  const pct = ctx.tokens / ctx.max;
  if (pct < 0.5) return null;
  return { pct: Math.min(1, pct), label: `${kTokens(ctx.tokens)} / ${kTokens(ctx.max)}`, level: pct > 0.9 ? "red" : pct > 0.75 ? "amber" : "normal" };
}

// A finished turn keeps what the poll last saw of it: steps, summary, subagents. Match a reply
// to the snapshot taken during its turn (between when it was asked and a little after it landed).
export function snapshotFor(row, snapshots) {
  const list = snapshots?.[row.m.address] ?? [];
  const from = (row.turnStart ?? row.m.at - 3600000) - 5000, to = row.m.at + 120000;
  return list.find((s) => s.ended >= from && (s.first ?? s.ended) >= from && (s.first ?? s.ended) <= to && s.ended <= to) ?? null;
}

// ── end-of-thread status lines ───────────────────────────────────────────────

// What needs you or is pending, in order: approvals, terminal prompts, disconnected sessions,
// handoffs, the queue, runtime trouble. Each: { id, mark, title, detail, action }.
export function statusLines({ waiting = [], blocked = [], disconnected = [], handingOff = [], queued = 0, queueOpen = false, error = null, name = (r) => r }) {
  const lines = [];
  for (const m of waiting) lines.push({ id: `wait-${m.id}`, mark: "blocked", title: `${name(m.from)} is waiting on your approval`,
    detail: `${m.tool}${m.detail ? `: ${String(m.detail).split("\n")[0].slice(0, 80)}` : ""}`, action: null });
  for (const m of blocked) lines.push({ id: `blocked-${m.address}`, mark: "blocked", title: `${name(m.role)} needs you in its terminal`,
    detail: "a prompt only the terminal can answer", action: { label: "Open terminal", kind: "terminal", arg: m.address } });
  for (const s of disconnected) lines.push({ id: `lost-${s.id}`, mark: "disconnected", title: `${name(s.role)} ${s.state === "recovering" ? "is reconnecting" : "disconnected"}`,
    detail: s.state === "recovering" ? "check the terminal if it doesn't come back" : s.reason ?? s.resume_reason ?? "the conversation is saved",
    action: s.state === "recovering" ? null : { label: "Resume", kind: "resume", arg: s.id, disabled: !s.can_resume } });
  for (const m of handingOff) lines.push({ id: `handoff-${m.address}`, mark: "working", title: `${name(m.role)} is handing off`,
    detail: "writing a handoff; a fresh session takes over", action: null });
  if (queued) lines.push({ id: "queued", mark: "queued", title: `${queued} message${queued === 1 ? "" : "s"} queued`,
    detail: "sent when each recipient is idle", action: { label: queueOpen ? "Hide" : "Edit", kind: "queue" } });
  if (error) lines.push({ id: "runtime", mark: "failed", title: "Session controls unavailable", detail: String(error).slice(0, 120), action: null });
  return lines;
}

// ── minimap ──────────────────────────────────────────────────────────────────

// Offsets of drawn rows from measured heights: top padding, then each row in order. A row
// without a height yet stops the walk (later offsets would be wrong).
export function rowOffsets(keys, heights, top = 0) {
  const out = new Map();
  let y = top;
  for (const k of keys) {
    out.set(k, y);
    const h = heights.get(k);
    if (h === undefined) break;
    y += h;
  }
  return out;
}

// The prompt you're reading under: the last one that starts above a line 35% down the view.
// Prompts that aren't drawn (above the window) count as above.
export function activePrompt(prompts, offsets, scroll, viewport) {
  const line = scroll + viewport * 0.35;
  let active = -1;
  prompts.forEach((p, i) => {
    const y = offsets.get(p.key);
    if (y === undefined ? p.hidden : y <= line) active = i;
  });
  return active;
}
