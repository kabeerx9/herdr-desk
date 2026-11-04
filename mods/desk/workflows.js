import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { exec, appHome, shared, setShared, run, notify } from "herdr";
import { button, icon, pill } from "./ui.js";

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
  init(cx) { refreshRuntime(cx, true); cx.timer.every(3000, (cx) => refreshRuntime(cx)); }
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
  queue(t, task) {
    const items = (runtimeData().queue ?? []).filter((q) => q.task === task && !["delivered", "cancelled", "sent"].includes(q.state)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    if (!items.length) return div().h(0);
    const busy = Boolean(this.owner.acting), pending = items.filter((q) => q.state === "pending");
    return v_flex().max_h(240).overflow_y_scrollbar().gap(5).py(5)
      .child(h_flex().gap(6).items_center()
        .child(button(t, "queue-fold", `${items.length} queued message${items.length === 1 ? "" : "s"}`, (_e, cx) => { this.queueOpen = !this.queueOpen; cx.notify(); }, { iconName: this.queueOpen ? "chevron-down" : "chevron" }))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child("Sent when each recipient is idle")))
      .when(this.queueOpen, (el) => el.children(items.map((q) => {
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
