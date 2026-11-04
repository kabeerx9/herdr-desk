// Slash commands for the desk composer: pure data and matching (no herdr or gpui imports, so
// `node --test` runs it). desks.js draws the menu and runs the picked command.
//
// Two kinds: "cli" commands are typed into the target agent exactly as written (bin/team post
// --raw), chosen by the target's CLI; "desk" commands run a Desk action instead.
//
// Each cli command has a mode, which decides what the runtime does after typing it:
// - "action": it does something; the runtime checks it left the input box and says what came
//   of it (/clear: "CTO started a new conversation", and the member route shows the new one).
// - "info": it prints or shows something; the runtime captures that from the screen into the
//   chat as a result card, closing any dialog it opened (Claude's /cost and /status do).
// - "interactive": a picker or editor Kabeer has to drive; the agent's terminal opens for it.
// A command not listed here goes as an action; if it opens a dialog, the terminal opens.
// Verified on Claude Code 2.1.318: /context prints inline; /cost (an alias of /usage) and
// /status open the Settings dialog, which swallows every key until Esc. The rest follow Claude's
// and Codex's documented behaviour.

const CLAUDE = [
  { name: "clear", icon: "refresh", desc: "Start a new conversation; the old one is dropped", mode: "action" },
  { name: "compact", icon: "collapse", desc: "Summarize the history to free up context", args: true, mode: "action" },
  { name: "model", icon: "sparkles", desc: "Switch the model (a name sets it; none opens the picker)", args: true, mode: "interactive", withArgs: "action" },
  { name: "context", icon: "pages", desc: "Show what fills the context window", mode: "info" },
  { name: "cost", icon: "clock", desc: "Tokens, cost and plan usage of this session", mode: "info" },
  { name: "review", icon: "branch", desc: "Review a pull request; its review comes back here", args: true, mode: "action" },
  { name: "status", icon: "alert", desc: "Version, model, account and connections", mode: "info" },
  { name: "memory", icon: "book", desc: "Edit CLAUDE.md memory files (opens its terminal)", mode: "interactive" },
  { name: "agents", icon: "team", desc: "Manage subagent definitions (opens its terminal)", mode: "interactive" },
  { name: "permissions", icon: "check", desc: "Allow and deny tool rules (opens its terminal)", mode: "interactive" },
  { name: "mcp", icon: "fetch", desc: "MCP servers and their tools (opens its terminal)", mode: "interactive" },
];
const CODEX = [
  { name: "new", icon: "refresh", desc: "Start a new chat in the same session", mode: "action" },
  { name: "compact", icon: "collapse", desc: "Summarize the history to free up context", mode: "action" },
  { name: "model", icon: "sparkles", desc: "Choose the model and reasoning effort (opens its terminal)", mode: "interactive" },
  { name: "status", icon: "alert", desc: "Session settings and token usage", mode: "info" },
  { name: "review", icon: "branch", desc: "Review the current changes; its review comes back here", args: true, mode: "action" },
  { name: "diff", icon: "pages", desc: "Show the git diff, untracked files included", mode: "info" },
];
export const MODES = ["action", "info", "interactive"];
export const DESK_COMMANDS = [
  { name: "fresh", icon: "play", desc: "Fresh start: it writes a handoff, a new session takes over", action: "fresh" },
  { name: "terminal", icon: "terminal", desc: "Open its terminal", action: "terminal" },
  { name: "changes", icon: "branch", desc: "Review its changes", action: "changes" },
  { name: "wrap", icon: "check", desc: "Wrap up the desk: everyone closes", action: "wrap" },
  { name: "queue", icon: "clock", desc: "Toggle send mode: send now or queue until idle", action: "queue" },
];

// The menu for a target CLI ("claude", "codex", or null for a mixed or empty audience): its
// passthrough commands, then the Desk's own. A name both have keeps the CLI's.
export function commandsFor(cli) {
  const own = (cli === "codex" ? CODEX : cli === "claude" || !cli ? CLAUDE : []).map((c) => ({ ...c, kind: "cli", cli: cli ?? "claude" }));
  const names = new Set(own.map((c) => c.name));
  return [...own, ...DESK_COMMANDS.filter((c) => !names.has(c.name)).map((c) => ({ ...c, kind: "desk" }))];
}

// "/mo" at the very start of the composer, before any space: the query ("mo"). Anything else
// (no slash, a space typed, a second line) closes the menu: null.
export function slashQuery(value) {
  const m = /^\/([\w:-]*)$/.exec(String(value ?? ""));
  return m ? m[1].toLowerCase() : null;
}

// Prefix matches first, then names containing the query, then descriptions mentioning it.
export function matchCommands(list, query) {
  const q = String(query ?? "").toLowerCase();
  if (!q) return list;
  const rank = (c) => (c.name.startsWith(q) ? 0 : c.name.includes(q) ? 1 : c.desc.toLowerCase().includes(q) ? 2 : 9);
  return list.map((c, i) => ({ c, r: rank(c), i })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c);
}

// What a sent "/…" line means: a known Desk command (run it), else raw text for the agent, with
// its mode (null for one the menu doesn't know: the runtime treats it as an action).
export function resolveCommand(text, cli) {
  const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const found = commandsFor(cli).find((c) => c.name === m[1].toLowerCase());
  if (found?.kind === "desk") return { kind: "desk", action: found.action, name: found.name };
  const args = Boolean(m[2]?.trim());
  const mode = found ? (args && found.withArgs) || found.mode : null;
  return { kind: "cli", text: String(text).trim(), name: m[1], mode };
}

// Keyboard in the open menu: the new highlight, or what to do. Wraps at both ends.
export function menuKey(key, index, count) {
  if (!count) return key === "escape" ? { close: true } : null;
  if (key === "up") return { index: (index - 1 + count) % count };
  if (key === "down") return { index: (index + 1) % count };
  if (key === "tab") return { complete: true };
  if (key === "enter") return { run: true };
  if (key === "escape") return { close: true };
  return null;
}

// "@ba" at the end of the composer (start of text or after a space): { start (the "@"), q }.
export function mentionQuery(value) {
  const v = String(value ?? ""), m = /(^|\s)@([a-z]*)$/i.exec(v);
  return m ? { start: v.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
}

// The @ options ({ id, name }) the query matches, by id or name prefix, in their order.
export function matchMentions(options, q) {
  const query = String(q ?? "").toLowerCase();
  return (options ?? []).filter((o) => o.id.startsWith(query) || String(o.name).toLowerCase().startsWith(query));
}

// The @ menu: "Send to" (the desk's members, with each one's most urgent live status; Everyone
// when there are two or more) then "Bring in" (roles not on the desk). `members`: [{ role,
// address, status, phase }]; `roles`: [{ id, name }]. Items: { id, name, section, address, status }.
const MENTION_RANK = { blocked: 0, working: 1, done: 2, idle: 3 };
const liveOf = (m) => (m.status === "blocked" ? "blocked" : m.status === "working" ? "working" : m.phase === "done" || m.status === "done" ? "done" : "idle");
export function mentionItems(members, roles, q) {
  const byRole = new Map();
  for (const m of members ?? []) {
    const best = byRole.get(m.role);
    if (!best || MENTION_RANK[liveOf(m)] < MENTION_RANK[liveOf(best)]) byRole.set(m.role, m);
  }
  const send = [...byRole.entries()].map(([id, m]) => {
    const role = (roles ?? []).find((r) => r.id === id);
    return { id, name: role?.name ?? id, section: "send", address: m.address, status: liveOf(m) };
  });
  if (send.length > 1) send.push({ id: "all", name: "Everyone", section: "send", address: null, status: null });
  const bring = (roles ?? []).filter((r) => !byRole.has(r.id)).map((r) => ({ id: r.id, name: r.name, section: "bring", address: null, status: null }));
  return [...matchMentions(send, q), ...matchMentions(bring, q)];
}
