import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { exec, appHome, shared, setShared, run, notify, window } from "herdr";
import { button, icon, pill, iconButton, chip, snoozeOptions } from "./ui.js";

export const runtimeData = () => shared("desk.runtime") ?? { sessions: [], queue: [], attention: [] };
export async function runTeam(args) {
  const r = await exec(`${appHome()}/bin/team`, args);
  if (r.code !== 0) {
    let message = r.stderr?.trim() || r.stdout?.trim() || "The Desk command failed";
    try { message = JSON.parse(message).error ?? message; } catch {}
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return JSON.parse(r.stdout || "{}");
}

export function openDesk(task) {
  setShared("desk.view", task);
  setShared("desk.review", null);
  setShared("deskchat.terminals", false);
  if (shared("layout") === "desk-chat") {
    run("layout.select", { stack: "center", child: "chat" });
    run("layout.hide", { id: "tabs" });
  } else {
    setShared("desk.tab", "desks"); setShared("desk.open", true);
    run("layout.show", { id: "desk" });
  }
}

// Only the always-visible rail polls the runtime. Shared data feeds the card, chat and inbox.
export function refreshRuntime(cx, force = false) {
  const now = Date.now(), active = shared("desk.runtime.inflight");
  if (active && now - active.at < 15000) {
    if (force) setShared("desk.runtime.dirty", now);
    return;
  }
  if (!force && now - (shared("desk.runtime.poll") ?? 0) < 2500) return;
  const request = { id: `${now}-${Math.random()}`, at: now };
  setShared("desk.runtime.poll", now);
  setShared("desk.runtime.inflight", request);
  cx.spawn(async (cx) => {
    try {
      const next = await runTeam(["state"]);
      if (shared("desk.runtime.inflight")?.id !== request.id) return;
      if (JSON.stringify(next) !== JSON.stringify(runtimeData())) setShared("desk.runtime", next);
      setShared("desk.runtime.error", null);
    } catch (e) {
      if (shared("desk.runtime.inflight")?.id === request.id) setShared("desk.runtime.error", String(e?.message ?? e));
    } finally {
      if (shared("desk.runtime.inflight")?.id === request.id) {
        setShared("desk.runtime.inflight", null);
        if ((shared("desk.runtime.dirty") ?? 0) >= request.at) {
          setShared("desk.runtime.dirty", 0); refreshRuntime(cx, true);
        }
      }
      cx.notify();
    }
  });
}

export class RuntimeWatch {
  init(cx) {
    this.needsYou = new NeedsYouAlerts();
    refreshRuntime(cx, true);
    cx.timer.every(3000, (cx) => { refreshRuntime(cx); this.needsYou.check(); });
  }
}

// ── Triage: settle / snooze (bin/team settle|unsettle|snooze; session settled_at, snoozed_until) ──

// The live (not finished) runtime session of a terminal.
export const sessionOf = (address) => (runtimeData().sessions ?? []).find((s) => s.address === address && s.state !== "finished") ?? null;
// The controls show only once the runtime reports the fields, and hide after a command the runtime doesn't know.
export const triageOn = () => !shared("desk.triage.off") && (runtimeData().sessions ?? []).some((s) => "settled_at" in s || "snoozed_until" in s);
// "settled" | "snoozed" | null. Busy work is never shown as put away, whatever the runtime says.
export function settledState(session, status) {
  if (!session || status === "working" || status === "blocked") return null;
  if ((session.snoozed_until ?? 0) > Date.now()) return "snoozed";
  return session.settled_at ? "settled" : null;
}
export function triage(cx, action, address, until) {
  const args = action === "snooze" ? ["snooze", "--address", address, "--until-ms", String(until)] : [action, "--address", address];
  cx.spawn(async (cx) => {
    try { await runTeam(args); }
    catch (e) {
      const why = String(e?.message ?? e);
      if (/invalid choice|unrecognized|unknown command|usage:/i.test(why)) setShared("desk.triage.off", true);
      else notify({ title: action === "snooze" ? "Couldn't snooze" : action === "settle" ? "Couldn't settle" : "Couldn't bring it back", body: why.slice(0, 200), level: "error", timeout: 6000 });
    }
    refreshRuntime(cx, true);
    cx.notify();
  });
}
const untilLabel = (ms) => {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  return `${new Date().toDateString() === d.toDateString() ? "" : "tomorrow "}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const settledNote = (session) => (session?.snoozed_until ?? 0) > Date.now() ? `until ${untilLabel(session.snoozed_until)}` : "settled";

// A row's triage: Settle and Snooze as icons; Snooze opens its times as chips (owner.snoozing = id).
export function triageIcons(t, id, owner, address, put) {
  if (!triageOn()) return [];
  if (put) return [iconButton(t, `${id}-unsettle`, "back", "Bring it back", (_e, cx) => triage(cx, "unsettle", address))];
  return [
    iconButton(t, `${id}-settle`, "check", "Settle: put it away until it has new work", (_e, cx) => triage(cx, "settle", address)),
    iconButton(t, `${id}-snooze`, "clock", "Snooze", (_e, cx) => { owner.snoozing = owner.snoozing === id ? null : id; cx.notify(); },
      { color: owner.snoozing === id ? t.accent : undefined }),
  ];
}
export function snoozeChips(t, id, owner, address, { indent = 36 } = {}) {
  if (owner.snoozing !== id || !triageOn()) return null;
  return h_flex().id(`${id}-times`).h(30).pl(indent).pr(8).gap(5).items_center()
    .child(div().text_size(11).text_color(t.dim).child("Snooze"))
    .children(snoozeOptions().map((o) => chip(t, `${id}-snz-${o.id}`, o.label, (_e, cx) => { owner.snoozing = null; triage(cx, "snooze", address, o.until); })));
}

// ── Needs-you alerts: one macOS notification per item, only while Herdr isn't the active app ──

const ALERT = { permission: "asks permission", blocked: "is blocked", ask: "has a question", failed: "delivery failed", uncertain: "delivery may not have arrived", delivery: "needs you" };
const alertStore = {
  get() { try { return JSON.parse(localStorage.getItem("desk.alerted")); } catch { return null; } },
  set(v) { try { localStorage.setItem("desk.alerted", JSON.stringify(v)); } catch {} },
};
class NeedsYouAlerts {
  constructor() { this.seen = alertStore.get(); this.last = null; }
  check() {
    const data = shared("desk.runtime");
    if (!data || data === this.last) return;   // nothing new since the last look
    this.last = data;
    const items = (data.attention ?? []).filter((i) => ALERT[i.kind]);
    // The first look after install only learns what's already waiting.
    if (!this.seen) { this.seen = items.map((i) => i.id); return alertStore.set(this.seen); }
    const seen = new Set(this.seen), fresh = items.filter((i) => !seen.has(i.id));
    if (!fresh.length) return;
    for (const item of fresh) {
      const title = item.title || `Agent ${ALERT[item.kind]}`, where = item.desk_name ?? item.task ?? "";
      const body = (item.text ?? "").replace(/\s+/g, " ").slice(0, 160);
      if (!window().active) {
        exec("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)", "-e", "end run",
          title, body || "Open the Desk to answer", where]).catch(() => {});
      }
      // In-app too, with the jump. The panel already toasts permissions outside desk-chat.
      if (item.kind !== "permission" || shared("layout") === "desk-chat") {
        notify({ title: where ? `${title} · ${where}` : title, body: body || "Click to open its desk", level: "warning", timeout: 12000,
          ...(item.task ? { action: { name: `desk.open-${item.task}` } } : {}) });
      }
    }
    this.seen = [...this.seen, ...fresh.map((i) => i.id)].slice(-400);
    alertStore.set(this.seen);
  }
}

export class WorkflowControls {
  constructor(owner) {
    this.owner = owner;
    this.queueOpen = true;
    this.editId = null;
    this.edit = TextareaState.new({ placeholder: "Edit the queued message", rows: 2 });
    this.edit.set_auto_grow(2, 5);
    this.question = TextareaState.new({ placeholder: "What do you want to explore?", rows: 2 });
    this.question.set_auto_grow(2, 5);
    this.question.on("change", (_e, cx) => cx.notify());
    this.edit.on("change", (_e, cx) => cx.notify());
  }
  get side() { return shared("desk.side") ?? null; }
  set side(value) { setShared("desk.side", value); }
  session(m) { return runtimeData().sessions?.find((s) => s.address === m.address && s.state !== "finished") ?? null; }
  act(id, args, cx, after) {
    this.owner.busy(id, async (cx) => {
      const result = await runTeam(args);
      after?.(result);
      refreshRuntime(cx, true);
    }, cx);
  }
  recover(s, cx) {
    this.act(`recover-${s.id}`, ["recover", "--session", s.id], cx, () => {
      notify({ title: "Conversation resumed", body: "The agent is back in this desk.", level: "success", timeout: 4000 });
    });
  }
  disconnected(t, task) {
    const sessions = (runtimeData().sessions ?? []).filter((s) => s.task === task && ["disconnected", "recovering"].includes(s.state));
    return sessions.map((s) => v_flex().id(`recover-${s.id}`).gap(6).px(12).py(9).rounded(10).border_1().border_color(t.blocked + "80").bg(t.blocked + "0c")
      .child(h_flex().gap(7).items_center()
        .child(icon("terminal", 14).text_color(t.blocked))
        .child(div().flex_1().text_size(12).font_semibold().text_color(t.foreground).child(`${this.owner.roles.byId(s.role)?.name ?? s.role} ${s.state === "recovering" ? "reconnecting" : "disconnected"}`))
        .child(button(t, `resume-${s.id}`, s.state === "recovering" || this.owner.acting === `recover-${s.id}` ? "Resuming…" : "Resume", (_e, cx) => this.recover(s, cx),
          { primary: true, disabled: !s.can_resume || Boolean(this.owner.acting), tip: s.reason ?? s.resume_reason ?? "Restore the saved conversation; the old task is not replayed" })))
      .child(div().text_size(11.5).line_height(1.4).text_color(t.muted).child(s.state === "recovering" ? "Recovery is starting. Check the terminal if it does not reconnect." : s.reason ?? s.resume_reason ?? "The terminal stopped, but this conversation is saved.")));
  }
  actions(t, m) {
    const s = this.session(m), busy = Boolean(this.owner.acting);
    const show = (kind, cx) => { this.side = { session: s, kind, at: Date.now() }; this.question.set_value(""); cx.notify(); };
    return h_flex().gap(6).flex_wrap()
      .child(button(t, `side-${m.address}`, "Side question", (_e, cx) => show("side", cx),
        { disabled: !s || busy, tip: "A separate question and conversation; the original agent keeps working" }))
      .child(button(t, `fork-${m.address}`, "Fork", (_e, cx) => show("fork", cx),
        { disabled: !s?.can_fork || busy, tip: s?.can_fork ? "Branch this conversation into its own worktree" : s?.fork_reason ?? "This CLI has no configured conversation-fork capability" }));
  }
  sideForm(t, task) {
    if (!this.side || this.side.session.task !== task) return div().h(0);
    const { session: s, kind } = this.side, fork = kind === "fork";
    return v_flex().gap(7).p(12).rounded(10).border_1().border_color(t.input).bg(t.raised)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child(fork ? "Fork this conversation" : "Ask on the side"))
      .child(div().text_size(11.5).line_height(1.4).text_color(t.muted)
        .child(fork ? "Keeps the conversation context and opens a separate worktree from HEAD. Uncommitted edits stay in the original worktree."
          : "Opens a separate read-only discussion. The current task keeps running, and its conversation stays untouched."))
      .child(Textarea.new(this.question).w_full().text_size(12).px(8).py(6).rounded(6).bg(t.background))
      .child(h_flex().gap(6).justify_end()
        .child(button(t, "side-cancel", "Cancel", (_e, cx) => { this.side = null; cx.notify(); }))
        .child(button(t, "side-start", fork ? "Create fork" : "Open discussion", (_e, cx) => {
          const text = this.question.value().trim();
          this.act("side-start", ["side", "--session", s.id, "--kind", kind, ...(text ? [`--text=${text}`] : [])], cx,
            (result) => { this.side = null; openDesk(result.task); });
        }, { primary: true, disabled: Boolean(this.owner.acting) || (!fork && !this.question.value().trim()) })));
  }
  // The queued messages of a desk. The chat shows them under its own "N messages queued" status
  // line, so the list draws header-less by default; { header: true } adds its own fold.
  queue(t, task, { header = false } = {}) {
    const items = (runtimeData().queue ?? []).filter((q) => q.task === task && !["delivered", "cancelled", "sent"].includes(q.state)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    if (!items.length) return div().h(0);
    const busy = Boolean(this.owner.acting), pending = items.filter((q) => q.state === "pending");
    const open = header ? this.queueOpen : true;
    return v_flex().max_h(240).overflow_y_scrollbar().gap(5).py(5)
      .when(header, (el) => el.child(h_flex().gap(6).items_center()
        .child(button(t, "queue-fold", `${items.length} queued message${items.length === 1 ? "" : "s"}`, (_e, cx) => { this.queueOpen = !this.queueOpen; cx.notify(); }, { iconName: this.queueOpen ? "chevron-down" : "chevron" }))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child("Sent when each recipient is idle"))))
      .when(open, (el) => el.children(items.map((q) => {
        const editing = this.editId === q.id, isPending = q.state === "pending", index = pending.findIndex((x) => x.id === q.id);
        return v_flex().id(`queued-${q.id}`).gap(5).px(10).py(8).rounded(8).bg(t.raised).border_1().border_color(t.border)
          .child(h_flex().gap(5).items_center()
            .child(pill(t, q.state === "pending" ? "Next" : q.state, isPending ? t.accent : t.blocked))
            .child(div().min_w(0).flex_1().truncate().text_size(11).text_color(t.muted).child((q.targets ?? []).map((r) => this.owner.roles.byId(r.role)?.name ?? r.role).join(", ")))
            .when(isPending && !editing, (row) => row
              .child(button(t, `qe-${q.id}`, "Edit", (_e, cx) => { this.editId = q.id; this.edit.set_value(q.text); cx.notify(); }, { disabled: busy }))
              .child(button(t, `qu-${q.id}`, "↑", (_e, cx) => this.act(`qu-${q.id}`, ["queue-move", "--id", q.id, "--direction", "up"], cx), { disabled: busy || index <= 0, tip: "Move earlier" }))
              .child(button(t, `qd-${q.id}`, "↓", (_e, cx) => this.act(`qd-${q.id}`, ["queue-move", "--id", q.id, "--direction", "down"], cx), { disabled: busy || index >= pending.length - 1, tip: "Move later" })))
            .when(isPending || ["failed", "uncertain"].includes(q.state), (row) => row.child(button(t, `qx-${q.id}`, isPending ? "Cancel" : "Dismiss", (_e, cx) => this.act(`qx-${q.id}`, ["queue-cancel", "--id", q.id], cx), { disabled: busy, tip: isPending ? "Cancel pending delivery" : "Dismiss this attempt; any message already sent cannot be recalled" }))))
          .when(!editing, (row) => row.child(div().max_h(54).overflow_hidden().text_size(12).line_height(1.4).text_color(t.foreground).child(q.text)))
          .when(editing, (row) => row.child(Textarea.new(this.edit).w_full().px(6).py(5).rounded(5).bg(t.background).text_size(12))
            .child(h_flex().gap(6).justify_end()
              .child(button(t, `qed-${q.id}`, "Discard edit", (_e, cx) => { this.editId = null; cx.notify(); }))
              .child(button(t, `qes-${q.id}`, "Save", (_e, cx) => {
                const text = this.edit.value().trim(); if (!text) return;
                this.act(`qes-${q.id}`, ["queue-edit", "--id", q.id, `--text=${text}`], cx, () => { this.editId = null; });
              }, { primary: true, disabled: busy }))))
          .when(Boolean(q.error), (row) => row.child(div().text_size(11).line_height(1.4).text_color(t.blocked).child(q.error)));
      })));
  }
}
