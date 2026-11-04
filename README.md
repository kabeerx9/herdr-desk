# herdr-desk

My personal UI for the [Herdr desktop app](https://github.com/herdrdev/herdr-app): a layout, two mods and my keys. This repo is `~/.config/herdr-app` itself. Herdr writes the rest of that folder, and `.gitignore` keeps it out.

## What's here

| Path | What it is |
|---|---|
| `layouts/desk.json` | The window: Herdr's default layout plus a collapsible Desk panel and an icon rail on the right. Pane headers use `desk-pane`. The `projects` list in the panel's props drives the Projects, PRs and Issues tabs. |
| `layouts/desk-chat.json` | The same window with the desk chat as the main view: the center is a stack of the chat (`desk` with `main`) and the shown tab's terminals, with a floating card at the top right (`desk` with `card`: changes per worktree, pull requests, agents and sub-agents, and the Chat / Terminals switch). |
| `mods/desk/` | The Desk. `main.js` holds the panel (Projects, PRs, Issues, Git, Pages tabs) and routes each copy by its props: panel, `rail`, or usage `popover`. `rail.js` draws the icon rail with Claude/Codex weekly limits at its foot, `git.js` the Git tab, `usage.js` the limits popover, `tabs.js` the state shared between copies. |
| `mods/desk/usage.py` | Reads Claude Code's and Codex's own sign-ins and prints only plan-limit percentages. Tokens never leave that process. |
| `mods/desk-pane/` | Pane header: program, repo path, branch with an uncommitted-file count, and agent status. Hover shows Claude-beside, Zed, split, zoom and close. A copy of Herdr's `pane` mod. |
| `keys.json` | Herdr's keys, plus `cmd-shift-j` → `desk.toggle`, and in `desk-chat` `cmd-e` → `desk.chat` (chat or terminals). |

## Commands

```sh
herdr-app check ~/.config/herdr-app/mods/desk     # after every mod change
herdr-app status                                  # errors from layouts, keys and mods
herdr-app do desk.toggle                          # also: desk.prs, desk.git, desk.claude-limits …
```

## Set up on a new machine

Install Herdr and open it once so it creates `~/.config/herdr-app`, then:

```sh
cd ~/.config/herdr-app
git init && git remote add origin https://github.com/kabeerx9/herdr-desk.git
git fetch && git checkout -f -t origin/main
herdr-app do layout.switch --name desk
```

Needs `gh` signed in (PRs and issues), `git`, `python3` (usage limits) and Zed (Open in Zed).

## Permissions

CTO, Frontend and Backend start in Claude's `auto` mode (`permission_mode` in `mods/desk/roles.json`). When one of them would ask you something in its terminal, a `PermissionRequest` hook (`team hook claude-permission`) also puts the request in the desk chat, above the message box, with Claude's own choices: Yes; Yes, and don't ask again for the rule Claude suggests; No (whatever you've typed goes with it as the reason). `team permit` writes your answer; the first answer wins, the chat or the terminal. With no answer in 9 minutes it's left to the terminal, and nothing is ever allowed by default. Codex (the Reviewer) can't be answered this way: its terminal prompt shows as "needs you" in the chat.


## Sessions, review and conversations

The Desk owns these workflows; agent CLIs run in ordinary herdr-core terminals. Claude Code remains the default lead. There is no dependency on Codex App Server.

- **Resume:** a stopped agent appears as disconnected, even if herdr-core replaced it with a shell. Resume restores its saved conversation and launch configuration, keeping its desk. It never replays an old task or replaces another foreground program. Conversation identity must have been recorded by the adapter or adopted from a running session.
- **Changes:** click a worktree in the card, or an agent's Changes action. Working includes staged/unstaged changes and untracked text; Staged shows the index; Branch compares against the available main/default branch. Pick a file or a diff hunk, then Explain or Ask to fix. These create a draft addressed to that agent; review and send it yourself. Recent reports are available below the diff. Binary files and large diffs are identified, with output capped at 120 KB.
- **Send now / Queue next:** Send now uses the CLI's usual input behavior. Queue next waits for an idle recipient; queued messages can be edited, moved or cancelled. Other projects can continue while one recipient is busy. A delivery interrupted after its claim is marked uncertain for review, rather than sent again. A single dispatcher runs for at most 20 minutes; hooks and the open GUI rearm it when work remains.
- **Side question / Fork:** open an agent's actions in the card. Side question starts an independent conversation with a read-only task. Fork preserves native conversation context when the adapter supports it and creates a separate Git worktree from HEAD; uncommitted edits remain in the original worktree. Both have a link back to the original desk. A fork waits for new input when no question was supplied.
- **Needs you:** the Inbox combines disconnected sessions, unresolved permissions, questions addressed to you, reports, and failed/uncertain deliveries. Open jumps to the desk; acknowledging an item sends no message. Answer permissions in their original chat so the exact tool request stays visible.

Runtime state is private, outside Git, in `~/.herdr/team/.runtime.json`. Registry changes use an exclusive lock and atomic replacement; terminal delivery has its own lock. `bin/desk_runtime.py` owns the state model, `bin/team` connects it to terminals, and `mods/desk/workflows.js` draws the controls. `bin/desk_review.py` supplies read-only Git data to `mods/desk/review.js`.

Existing running roles can be registered with `bin/team adopt`. New sessions register at launch; Claude hooks capture conversation identity, and the Stop hook records replies. A CLI without a supported capability gets a disabled action with a reason.

### Other agent CLIs

A role can use its own `cli` name and an `argv` array. Its optional `adapter` object declares `resume_args`, `fork_args`, and `session_args` arrays; `{session_id}` is replaced with the saved identity. `executable` identifies a differently named foreground process. Use arguments verified against that CLI's help. Generic CLIs can report their session identity through `team hook session` with a JSON `session_id` on stdin inside their `HC_TERMINAL_ID` terminal. Resume uses the saved role configuration; changing tomorrow's default does not silently switch an existing conversation to another provider.

### Verification

```sh
/usr/bin/python3 -m unittest discover -s bin -p 'test_*.py' -v
herdr-app check ~/.config/herdr-app/mods/desk
herdr-app status
```

The Python suite covers real CLI orchestration as well as state and Git behavior: concurrent writes, delivery serialization, uncertain attempts, queue ordering, reply reservation, recovery without replay, custom adapter arguments, shell/pager rejection, resolved permissions, worktree boundaries and branch bases.
