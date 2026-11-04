// Slash commands for the desk composer: pure data and matching (no herdr or gpui imports, so
// `node --test` runs it). desks.js draws the menu and runs the picked command.
//
// Two kinds: "cli" commands are typed into the target agent exactly as written (bin/team post
// --raw), chosen by the target's CLI; "desk" commands run a Desk action instead.

const CLAUDE = [
  { name: "clear", icon: "refresh", desc: "Start a new conversation; the old one is dropped" },
  { name: "compact", icon: "collapse", desc: "Summarize the history to free up context", args: true },
  { name: "model", icon: "sparkles", desc: "Switch the model", args: true },
  { name: "context", icon: "pages", desc: "Show what fills the context window" },
  { name: "cost", icon: "clock", desc: "Tokens and cost of this session" },
  { name: "review", icon: "branch", desc: "Review a pull request", args: true },
  { name: "status", icon: "alert", desc: "Version, model, account and connections" },
  { name: "memory", icon: "book", desc: "Edit CLAUDE.md memory files" },
  { name: "agents", icon: "team", desc: "Manage subagent definitions" },
];
const CODEX = [
  { name: "new", icon: "refresh", desc: "Start a new chat in the same session" },
  { name: "model", icon: "sparkles", desc: "Choose the model and reasoning effort", args: true },
  { name: "status", icon: "alert", desc: "Session settings and token usage" },
  { name: "review", icon: "branch", desc: "Review the current changes", args: true },
  { name: "diff", icon: "pages", desc: "Show the git diff, untracked files included" },
];
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

// What a sent "/…" line means: a known Desk command (run it), else raw text for the agent.
export function resolveCommand(text, cli) {
  const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const found = commandsFor(cli).find((c) => c.name === m[1].toLowerCase());
  if (found?.kind === "desk") return { kind: "desk", action: found.action, name: found.name };
  return { kind: "cli", text: String(text).trim(), name: m[1] };
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
