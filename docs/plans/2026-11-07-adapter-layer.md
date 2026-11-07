# Desk adapter layer: keep upstream changes in one place

Status: accepted with review changes (2026-11-07). Kabeer wants to keep
evolving the Desk; this makes upstream updates cheap to absorb before more
features land. Reviewed by Fable 5.1; its changes are folded in below.

## Problem

The Desk depends on programs it does not own. Each one changes on its own
schedule, and today its details are spread across `bin/team` (2,931 lines),
`bin/desk_runtime.py` (1,622 lines) and two GUI files.

| Upstream | Tested version | What the Desk relies on | Where it lives today |
|---|---|---|---|
| herdr-core (`hc`) | 0.1.18 | `run --bg`, `send`, `keys`, `read --lines`, `label`, `ls`, `get`, `kill`, `rm`, `server status`, and their JSON shapes | 43 call sites in `bin/team`; `desks.js:1278` |
| Claude Code | 2.1.319 | launch flags, hook names, payloads and reply shape, transcript JSONL, `subagents/`, prompt box, permission and trust dialogs, process aliases, launch-failure text | `argv_for`, `hook`, `permission_request`, `accept_trust`, `measure`, `transcript_*`, `screen_state`, `permission_dialog`, `foreground_agent`, `classify_launch_failure` |
| Codex CLI | 0.167.0 | launch flags, `notify` payload, rollout JSONL, input line | `argv_for`, `codex_*`, `codex_input`, `approve_cli` |
| Plan usage | none | Claude keychain item and `~/.claude/.credentials.json`, `~/.codex/auth.json`, two private usage endpoints | `mods/desk/usage.py` (most volatile) |
| Herdr app (gpui-kit, `herdr.d.ts`) | 0.1.13 | mod API, `terminals()`/`agents()` shapes | `mods/desk/*.js` |
| git | any | worktree, rev-parse, diff | 44 call sites |

There are 17 `if cli == "codex"` style branches plus a third detector in
`approve_cli`. A Claude or Codex change today means hunting through both files.

## Decision

Ports and adapters (the repository pattern) at the upstream boundaries
only. The Desk's own logic (queue, gate, contract parsing, attention, cost)
stays as it is: it is already pure functions over data.

```
mods/desk/*.js  (GUI)
      │  team <command> → JSON          ← existing contract, unchanged
      ▼
bin/team        (CLI: parse args, call core, print JSON)
      │
      ├── desk_runtime.py  (core: pure domain)
      │
      └── desk_adapters/   (the only code that knows upstream details)
            agents.py      AgentAdapter base + registry by role "cli"
            claude.py      ClaudeAdapter (2.1.319)
            codex.py       CodexAdapter  (0.167.0)
            host.py        TerminalHost port: HcHost (hc 0.1.18), HostResult
            plan_usage.py  shared helpers for each adapter's plan_usage()
```

**Rule: adapters never import `desk_runtime` or `team`.** Shared screen
helpers move into `desk_adapters`; `desk_runtime` re-exports moved names
during the move. This prevents import cycles.

### Ports

`TerminalHost` (one adapter: `HcHost`)
- `launch(argv, name, cwd, labels, parent=None, outlive=True) -> address`;
  the shell wrapper, `--outlive-parent`/`--no-parent` and JSON parsing live
  inside `HcHost`.
- `send_text(address, text)`, `send_keys(address, keys)`; raise
  `HostError(message)` instead of each caller unwrapping `error.message`.
- `screen(address, history=0) -> str`
- `label(address, **labels)`
- `get(address) -> TerminalInfo | None`, `list(label=None, all=False) ->
  list[TerminalInfo]`: normalized Desk fields (address, state, reason,
  executable, app, labels, cwd), never raw `hc` dicts.
- `kill(address)`, `remove(address)`, `status()`
- "Not found" and "hc is down" are different results, unlike `hc_json`.

`AgentAdapter` (one per CLI)
- `owns(info) -> bool`: process alias detection (`foreground_agent`,
  `approve_cli`, `cli_of`).
- `launch_argv(role, prompt, task, session_id, self_path)`,
  `resume_argv(identity)`, `fork_argv(identity)`; the `roles.json`
  `adapter` override stays.
- `screen_state(screen)`, `permission_dialog(screen)`,
  `pick_option(dialog, choice)`, `trust_prompt(screen) -> keys | None`,
  `launch_failure(screen, task)`, `input_as_keys(text) -> bool`.
- `find_transcript(session)`, `turns`, `timeline`, `usage`, `title`,
  `context_size`; `supported=False` where a CLI has none.
- `parse_hook(kind, payload)` and `hook_reply(event, decision, suggestions)`.
- `plan_usage()` replaces `usage.py`'s per-CLI code.

Adapters return Desk-shaped data (the shapes `team timeline`, `team
transcript` and `team cost` already print).

### Fixture check (`team doctor`)

Version strings alone catch nothing, because screens and JSON keys change
without a version bump. `team doctor` ships only with:
1. `--record`: start a throwaway agent and save prompt, dialog, permission
   and trust screens plus one hook payload into `bin/fixtures/`.
2. Every adapter parser runs on the fixtures and asserts the expected state.
3. A live `hc` shape check: `ls --json` and `get --json` have the keys
   `HcHost` maps.

## Non-goals

- No abstraction over the Herdr mod API or git.
- No behaviour change: every `team` command prints the same JSON. The one
  exception is the GUI's direct `hc send` (phase C), which gains the dialog
  guard.
- No generic plugin system. A new CLI is one adapter file plus a registry line.

## Migration (one commit per phase, all tests green after each)

- **A. Agent adapters, launch.** *Done (da7303c).* `AgentAdapter` base, registry, Claude and
  Codex adapters; move `argv_for` and `adapter_config` into `launch_argv`,
  `resume_argv`, `fork_argv`. argv output is byte-for-byte unchanged.
- **B. Agent adapters, parsing.** *Done: screen, transcript, usage, pricing and launch-failure code moved to `desk_adapters/`; `team cost`, `state` and 47 real transcripts print byte-identical output.* Move screen parsing and transcript reading
  (pure functions, tested through `rt.*`) plus `owns`, `launch_failure`,
  `trust_prompt`, `context_size`. Re-export from `desk_runtime`.
- **C. Terminal host.** `TerminalHost`, `HcHost`, `FakeHost`. Rewrite the 13
  tests that patch `team.sh` to use `FakeHost` **in the same commit**, so no
  test passes by skipping the code. Route `desks.js:1278` through `team`.
  *Done: all 42 `hc` calls in `team` go through `HOST = HcHost(...)`; the GUI's two
  direct `hc send` calls (Open PR, send brief) go through the new `team send`, which
  refuses an open dialog.* Changes from the plan, decided during the move:
  - No `FakeHost`. `HcHost` runs through `team.sh`, so the existing tests still fake
    the process boundary and assert every exact `hc` argv. That checks more than a
    fake port would. Six mutations of `host.py` each fail the suite.
  - Records stay the dicts `hc get --json` prints. More than 40 readers use their keys
    (`status`, `labels`, `foreground`, `parent`); phase F's shape check guards them.
  - "Not found" and "hc is down" are still one result (`None`); no caller needs the
    difference yet.
- **D. Hooks.** Move only hook parsing and reply shapes; chat and permit
  waiting stay in `team`.
  *Done: every hook reads its payload through `ClaudeAdapter.hook_event` or
  `CodexAdapter.hook_event` into one `HookEvent` (Desk field names), and the
  PermissionRequest answer comes from `ClaudeAdapter.permission_reply`. Claude's
  context-size, compaction and last-message readers moved to `claude_transcript`.
  Tests for the allow, always, deny and Codex turn-end paths landed first, against the
  old code.*
- **E. Plan usage.** `usage.py` calls `adapter.plan_usage()`.
  *Done: sign-in reading, the request and the answer parsing live in
  `ClaudeAdapter.plan_usage` and `CodexAdapter.plan_usage`; `usage.py` is a
  10-line entry point that adds `bin/` by its full path (it still runs under
  `python3 -I`). Live output matched the old script except Codex's computed
  reset time, which moves with the clock.*
- **F. `team doctor`** with recording and the `hc` shape check.

Cut: rewriting other GUI `exec` calls; reshaping capabilities beyond moving
them.

## Findings during the move

- **Codex trust prompt (open, Kabeer decides).** codex-cli 0.167 replaced
  "Trust this folder?" with "Yes, allow Codex to work in this folder without
  asking for approval" (`bin/fixtures/codex-trust.txt`). `CodexAdapter.trust_prompt`
  never matches it, so the startup-dialog check shows it to Kabeer. Auto-accepting
  would also turn off Codex's approvals in that folder, so the behaviour is kept
  until Kabeer chooses.
- `trust_prompt`, `context_size` and `owns` beyond aliases move with phases C and D,
  where their `hc` calls change anyway.

## Verification

- All Python tests and `node --test` stay green after every phase.
- `herdr-app check mods/desk` passes and `herdr-app status` shows no errors.
- Read-only smoke after each phase: `team roles`, `team state`, `team cost`.
- One live desk run after phase C: start a Worker, report done, Reviewer, gate.

## Risks

- **Tests that stop testing.** Phase C changes how `hc` is faked; the fake
  rewrite lands in the same commit, and each rewritten test is checked to fail
  when the code it covers is broken.
- **Leaky ports.** Ports name what the Desk needs, not what `hc` offers.
- **Fixtures go stale.** Recording new fixtures is part of accepting an
  upstream update.
