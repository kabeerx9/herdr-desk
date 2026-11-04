# Agent-neutral Desk workflows

User-approved scope: session recovery, changes/review pane, Send now vs Queue next (edit/reorder/cancel), side conversations/forks, global Needs you inbox. No Codex App Server integration. Claude Code remains the default lead; preserve CTO role IDs and current defaults. Support future CLIs through explicit adapter capabilities, not UI branches on provider names.

## Contracts and decisions
- Durable local runtime state under ~/.herdr/team, atomic serialized writes, private file permissions. Never commit runtime data or transcripts. Stable session identity survives a terminal replacement. Save launch configuration and conversation identity; recovery is explicit, keeps the desk, and never replays an old task.
- A role-labeled recovered shell is disconnected, never a running agent. Validate the actual foreground process before delivering messages. Existing sessions can be adopted from their running launch arguments; don't scan unrelated conversation stores.
- CLI adapters declare resume, fork and identity capabilities. Unsupported recovery/forks are actionable and disabled, never silently replaced by a fresh conversation. Generic roles launch their configured argv rather than falling through to Claude.
- Queue stores targets and message with a stable ID. Pending messages are editable, reorderable, cancellable. Dispatch only to idle live agents, one message per target at a time, never to a shell or a permission prompt. Uncertain delivery must surface for manual review rather than automatically replay. A bounded background dispatcher handles queue delivery while the GUI is closed, with a lock to prevent duplicate dispatchers.
- Side discussions are independent desks, with parent metadata, the selected role and a read-only question; native forks preserve context when supported and use a separate git worktree to avoid concurrent edits. Original agent is untouched. Return link goes to original desk.
- Review data is read-only git output scoped to the selected repository/worktree. Modes: Working, Staged, Branch. Files, bounded textual diffs (including untracked text), binary/truncated explanations, and tests/review reports visible together. Select a diff file/hunk and compose an explain/fix request addressed to the relevant agent; no implicit publishing.
- Global attention combines disconnected sessions, active permission requests, questions/reports requiring action, failed deliveries/queued messages, and completed work. Stable IDs allow dismissing/acknowledging non-permission items; resolved permissions disappear. Deep link to desk/terminal.

## Work and ownership
1. Runtime and regression tests: bin/team, bin/desk_runtime.py, bin/test_desk_runtime.py. Session registry, adapters, lifecycle hooks, recovery, queue/dispatcher, side/fork commands, attention, CLI integration.
2. Review pane and read-only git service: bin/desk_review.py, bin/test_desk_review.py, mods/desk/review.js. ReviewView module supports init(cx), render(t), open({repo,address,task,role},cx). It publishes compose requests through shared desk.compose and exposes review data for tests/reports.
3. Chat and inbox integration: mods/desk/desks.js, card.js, main.js, inbox.js, roles.js and supporting workflow UI. Root owns these plus .gitignore/README/docs. Integrate runtime state, recovery cards, editable queue, side/fork controls, Needs you details/deep links, ReviewView entry points.

## Runtime CLI interfaces (JSON stdout, errors JSON stderr)
- team state [--task SLUG] -> {sessions,queue,attention}; session fields: id,address,role,task,cwd,cli,state,can_resume,can_fork,parent_task; state active|disconnected|finished; queue fields id,task,text,targets:[{address,role}],state,position,error; attention fields id,task,address,kind,title,text,at.
- team adopt -> inspect live role terminals, persist missing records, do not launch anything.
- team recover --session ID -> {address,task,session}; rejects active sessions, unsupported identity or concurrent recovery.
- team queue --task SLUG --to ADDR:ROLE (repeat) TEXT -> queued item; team queue-edit --id ID --text TEXT; team queue-move --id ID --direction up|down; team queue-cancel --id ID.
- team attention-dismiss --id ID.
- team side --session ID --kind side|fork [--text TEXT] -> {task,address,parent_task}; creates independent child desk, no message to original agent. Side question may be supplied, fork doesn't execute old task.
- team post keeps existing CLI but validates foreground agent; defaults to explicit immediate delivery, never writes to a shell. UI Send now preserves agent's normal input behavior and does not promise native mid-turn steering.
- SessionStart/Stop hooks record identity and trigger queue readiness without changing approval policy.

## Verification
Meaningful Python unittest coverage for crash recovery, duplicate dispatch, uncertain delivery, queue ordering/cancellation/edits, shell rejection, malformed inputs, adapter capability boundaries, and git path/binary/truncation behavior. Run macOS /usr/bin/python3 tests and parse checks, herdr-app check mods/desk, herdr-app status no errors. UI verify recovery status, queue controls, side/fork entry, review files/diffs and inbox. Do not stop live agents/services or send implementation tasks into user's agents. Use isolated fixture git repositories and test-only terminals/desks for integration where necessary; preserve existing sessions and user messages. Commit task changes and push origin main per standing authorization.
