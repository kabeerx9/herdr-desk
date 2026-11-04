# Desk overhaul: fast, clean, T3-grade

Kabeer approved a full GUI overhaul (2026-11-04). Keep the runtime (bin/team,
desk_runtime.py, the queue/recovery/permission model and its tests); rebuild what
you see on top of it. Sources for each idea: T3 Code (pingdotgg/t3code), Sheprd,
herdr-t3, herdr-reviewr, herdr-annotate, herdrm, herdr-conductor, herdr-dagr,
herdr-cadence.

## Design language (every Desk surface)

- Quiet by default. One accent (`t.accent`) for the one thing to do next; status
  colours only on status marks. No tinted icon tiles, no pills for decoration.
- Type: 13 body (14 in the wide chat), 12 secondary, 11 meta. Semibold only for
  names and section titles. Line height 1.55 for prose.
- Rhythm: 4px grid. Rows 28px. Radius 8 (cards 10, composer 16). Hairlines
  `t.border`; no shadows except floating surfaces.
- **One status mark set**, `statusMark(t, status, size)` in `mods/desk/ui.js`,
  used everywhere (chat, card, spaces, pane headers). Shape carries meaning,
  colour confirms it: working = spinning ring, blocked = filled square with `!`
  (pulse), done = check in a circle, idle = hollow dot, queued = dashed ring,
  failed = cross, disconnected = broken ring. Never re-sort a row under the
  pointer.
- Show only what's unusual: git branch only off main, ahead/behind only when
  non-zero, context meter only past 50%.
- Motion is native only (`.spring`, `.transition`, `.loop`, `.frames`, `.spin`),
  never timer+notify. New rows fade/slide in once (opacity+height 180ms
  ease-out). Following the tail glides (`.spring("top")`).
- Empty states say what the surface is for, in one line, with the one action.

## Performance rules

- No per-frame work in `render`: parse/derive in data handlers, cache by id +
  content hash; render reads caches.
- Event-driven refresh (`watchFolder`, hook writes) with a slow fallback timer;
  never poll faster than 1s; timers check `window().active` where it matters.
- The chat draws a window of the newest rows (default 60) with "Show earlier";
  finished rows' derived data is cached; only the streaming row is rebuilt.
- One shared 1s clock (`shared("desk.tick")` written by one owner) drives all
  elapsed labels, and only while something is working.

## Data contracts (runtime → GUI)

All `bin/team` commands print JSON on stdout, errors JSON on stderr.

### `team timeline --address A [--since-ms N]`
What one live agent is doing this turn, derived from its Claude transcript
(`~/.claude/projects/*/<conversation>.jsonl`, found via the runtime session's
`conversation`), reading only the tail since the turn started (bounded, <=512KB),
plus its `subagents/agent-*.jsonl`. Codex/others: fields null, `supported:false`.

```json
{ "address": "t7", "supported": true, "turn": { "started_ms": 0, "working": true },
  "thought": { "text": "latest non-empty thinking, <=400 chars", "heading": "**bold** heading or null", "at": 0 } ,
  "tools": { "summary": "Read 4 files, ran 2 commands", "counts": {"read":4,"command":2,"edit":0,"search":0,"web":0,"agent":1,"other":0}, "failed": 0 },
  "subagents": [ { "id": "agent-ab12", "title": "description from the Task/Agent call", "type": "Explore",
                   "status": "running|done|failed", "started_ms": 0, "ended_ms": null,
                   "line": "latest progress (tool text) or result first line, <=140 chars" } ],
  "context": { "tokens": 123000, "max": 200000 },
  "title": "Claude's latest ai-title for the session, or null" }
```

### `team state` additions
- session: `title` (ai-title), `settled_at`, `snoozed_until`, `evidence`
  (`verified|reported|asserted|null` for its last done report).
- new commands: `team settle --address A`, `team snooze --address A --until-ms N`,
  `team unsettle --address A`. Settled/snoozed agents come back on their own when
  status becomes working/blocked or a new done report arrives after settling.

### Review
- `desk_review.py ... --mode turn`: diff against `refs/worktree/desk/turn-base`,
  which `team hook` snapshots (private index + `write-tree`, no working-tree
  writes) when an agent's turn starts (UserPromptSubmit / first PreToolUse).
- `team review-send --address A --file F` : sends a batch of line comments
  (markdown, prefix "Fix each comment, then run the checks.") pasted without
  Enter; refuses when the agent is at a permission prompt; never drops the batch
  on failure (exit nonzero, file kept). Empty batch = "Kabeer approved the changes."

### Team reliability (bin/team + role prompts)
- Task contract: `team start ... --brief F` briefs carry `acceptance` (ids+text),
  `owns` (paths), `must_run` (commands). `team report done` takes
  `--criteria '{"A1":"pass|fail|n/a: note"}'` and `--evidence verified|reported`.
  The Desk shows a criteria checklist on the done card.
- Merge gate: an engineer's branch can't be integrated (`team integrate`, and the
  CTO protocol) until a Reviewer on a different CLI/model reported `done` with no
  blocking findings; max 3 review rounds, then it goes to Kabeer.
- Runner fallback: a role may list `runners: [{cli, model, effort}, ...]`; launch
  tries the next only when the CLI fails for usage limits/auth; the chosen runner
  is pinned to the session.

## GUI pieces

1. Chat timeline (desks.js → timeline.js + model.js): windowed rows; turn folds
   ("Worked for 2m 13s"); tool-group row ("Read 4 files, ran 2 commands",
   expandable to the step feed); inline subagent rows + stacked group; live row
   (latest thought or step above current tool, shimmer, ticking elapsed); status
   lines at the end (waiting on approval, queued, disconnected) replacing ad-hoc
   banners; prompt minimap on the left edge; header strip (turn timer, context
   meter, model).
2. Floating card (card.js): sections Team, Lineage, Changes, PRs, Usage;
   right-click toggles; full/compact/essential density by height; Lineage = this
   desk's parent, forks, side questions, reviewers/QA (edge kind labels, running
   vs previous, stop/open per row).
3. Triage: settle/snooze in the spaces list and inbox; macOS notification
   (osascript) for Needs-you items only when Herdr isn't frontmost; click focuses.
4. Review: Last turn mode; line comments batched and sent; approve.
5. Names: tab/pane names from session `title`.
