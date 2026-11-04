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

