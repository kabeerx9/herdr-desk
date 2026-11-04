import { div, svg } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { terminals, exec, home, appHome, readTextFile, watchFolder, notify, run, shared, setShared } from "herdr";
import { pill, button, empty } from "./ui.js";
import { Roles, roleTile } from "./roles.js";

// The team chat: one thread per task, read from ~/.herdr/team/<task>.jsonl, which
// bin/team writes (starts, reports, `team say`, and Kabeer's posts). Sending goes
// through `team post`, which logs the message and types it into each recipient.
// Agents never message each other here; they reply with `team say`.

const DIR = () => `${home()}/.herdr/team`;
const TEAM = () => `${appHome()}/bin/team`;
const KIND = { done: ["done", "done"], blocked: ["blocked", "blocked"], update: ["update", "accent"] };

const clock = (ms) => {
  const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? "" : `${d.getDate()}/${d.getMonth() + 1} `}${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function parse(text) {
  return (text ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export class Chat {
  // fixed: a task this view always shows (a popped-out pane); toasts: announce agents' messages.
  constructor(cx, { fixed = null, toasts = false } = {}) {
    this.roles = new Roles();
    this.fixed = fixed;
    this.toasts = toasts;
    this.threads = [];      // [{ slug, at }], newest first
    this.messages = [];
    this.counts = {};       // lines seen per thread, for toasts
    this.to = null;         // chosen recipient roles (null: the default)
    this.sending = false;
    this.input = TextareaState.new({ placeholder: "Message the team… (@backend, @frontend, @all)", rows: 2 });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (e, cx) => { if (!e.shift) this.send(cx); });
    this.roles.load(cx);
    cx.timer.every(5000, (cx) => this.roles.load(cx));
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", DIR()]);
      await this.reload(cx, true);
      for (;;) { await watchFolder(DIR()); await this.reload(cx, false); }
    });
  }

  get slug() { return this.fixed ?? shared("desk.chat.task") ?? this.threads[0]?.slug ?? null; }
  select(slug, cx) { this.to = null; setShared("desk.chat.task", slug); this.reload(cx, false); }

  async reload(cx, first) {
    try {
      const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && for f in *.jsonl; do [ -f "$f" ] && printf "%s\\t%s\\t%s\\n" "$(stat -f %m "$f")" "$(wc -l < "$f" | tr -d " ")" "${f%.jsonl}"; done | sort -rn', "ls", DIR()]);
      const rows = r.stdout.split("\n").filter(Boolean).map((l) => { const [at, n, slug] = l.split("\t"); return { slug, at: Number(at) * 1000, n: Number(n) }; });
      this.threads = rows;
      // Toast agents' new chat lines in threads other than the one on screen.
      if (this.toasts) {
        for (const row of rows) {
          const seen = this.counts[row.slug];
          this.counts[row.slug] = row.n;
          if (first || seen === undefined || row.n <= seen || (row.slug === this.slug && shared("desk.tab") === "chat")) continue;
          const fresh = parse(await readTextFile(`${DIR()}/${row.slug}.jsonl`)).slice(seen);
          for (const m of fresh) if (m.kind === "say" && m.from !== "kabeer") {
            notify({ title: `${this.roles.byId(m.from)?.name ?? m.from} · ${row.slug}`, body: m.text.slice(0, 160), level: "info", timeout: 6000 });
          }
        }
      }
      const slug = this.slug;
      this.messages = slug ? parse(await readTextFile(`${DIR()}/${slug}.jsonl`)) : [];
    } catch { this.messages = []; }
    cx.notify();
  }

  // Who's in the task now: live terminals labeled task=<slug>, by role.
  members() {
    const slug = this.slug;
    return terminals().filter((t) => t.state === "live" && t.labels?.task === slug && t.labels?.role)
      .map((t) => ({ address: t.address, role: t.labels.role }));
  }

  recipients(members) {
    const present = [...new Set(members.map((m) => m.role))];
    // @role at the start of the message wins over the chips.
    const text = this.input.value();
    const named = [...text.matchAll(/(^|\s)@([a-z]+)/g)].map((m) => m[2]).filter((r) => r === "all" || present.includes(r));
    if (named.includes("all")) return present;
    if (named.length) return [...new Set(named)];
    if (this.to) return this.to.filter((r) => present.includes(r));
    return present.includes("cto") ? ["cto"] : present;
  }

  send(cx) {
    const text = this.input.value().trim(), slug = this.slug, members = this.members();
    const roles = this.recipients(members);
    if (!text || !slug || this.sending) return;
    if (!roles.length) return notify({ title: "Nobody to send to", body: "No agent in this task is running.", level: "warning", timeout: 4000 });
    const to = members.filter((m) => roles.includes(m.role)).flatMap((m) => ["--to", `${m.address}:${m.role}`]);
    this.sending = true;
    this.input.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(TEAM(), ["post", "--task", slug, ...to, text]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim());
        const rec = JSON.parse(r.stdout);
        if (rec.failed?.length) notify({ title: "Not delivered to everyone", body: rec.failed.map((f) => `${f.role}: ${f.why}`).join("\n"), level: "warning", timeout: 7000 });
      } catch (e) {
        this.input.set_value(text);
        notify({ title: "Message not sent", body: String(e?.message ?? e).slice(0, 200), level: "error", timeout: 6000 });
      }
      this.sending = false;
      await this.reload(cx, false);
    });
  }

  // A chip click adds or removes that role; All picks everyone. Never leaves nobody chosen.
  toggleTo(role, members, cx) {
    const present = [...new Set(members.map((m) => m.role))], current = this.recipients(members);
    if (role === "all") this.to = present;
    else if (!current.includes(role)) this.to = [...current, role];
    else if (current.length > 1) this.to = current.filter((r) => r !== role);
    cx.notify();
  }

  // ── view ──────────────────────────────────────────────────────────────────

  roleOf(id) { return this.roles.byId(id); }

  message(t, m, i) {
    const id = `msg-${i}`;
    if (m.kind === "start") {
      return h_flex().id(id).justify_center().py(4).child(div().px(10).py(3).rounded(10).bg(t.raised).text_size(11).text_color(t.dim)
        .child(`${m.from === "kabeer" ? "You" : this.roleOf(m.from)?.name ?? m.from} · ${m.text} · ${clock(m.at)}`));
    }
    if (m.from === "kabeer") {
      const to = (m.to ?? []).map((r) => this.roleOf(r)?.name ?? r).join(", ");
      return v_flex().id(id).items_end().gap(3).py(5).pl(36)
        .child(div().text_size(11).text_color(t.dim).child(`You → ${to} · ${clock(m.at)}`))
        .child(div().max_w_full().px(11).py(7).rounded(12).bg(t.accent + "26").text_size(12.5).line_height(1.45).text_color(t.foreground).child(m.text))
        .when(Boolean(m.failed?.length), (el) => el.child(div().text_size(11).text_color(t.blocked)
          .child(`Not delivered: ${m.failed.map((f) => `${this.roleOf(f.role)?.name ?? f.role} (${f.why})`).join("; ")}`)));
    }
    const role = this.roleOf(m.from), kind = KIND[m.kind];
    return h_flex().id(id).items_start().gap(9).py(5).pr(24)
      .child(role ? roleTile(div, svg, t, role, 26) : div().size(26).flex_none().rounded(7).bg(t.raised))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(role?.name ?? m.from))
          .when(Boolean(kind), (el) => el.child(pill(t, kind[0], t[kind[1]] ?? t.accent)))
          .child(div().text_size(11).text_color(t.dim).child(clock(m.at))))
        .child(div().px(11).py(7).rounded(12).bg(kind ? (t[kind[1]] ?? t.accent) + "14" : t.raised)
          .text_size(12.5).line_height(1.45).text_color(t.foreground).child(m.text)));
  }

  render(t, cx) {
    const slug = this.slug, members = this.members(), to = this.recipients(members);
    const picker = this.fixed ? null : h_flex().px(12).py(8).gap(5).flex_wrap().border_b(1).border_color(t.border)
      .children(this.threads.slice(0, 12).map((th) => {
        const on = th.slug === slug, live = terminals().some((x) => x.state === "live" && x.labels?.task === th.slug);
        return h_flex().id(`th-${th.slug}`).h(22).px(8).gap(5).items_center().rounded(11).cursor_pointer().text_size(11)
          .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : "#00000000")
          .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.select(th.slug, cx))
          .when(live, (el) => el.child(div().size(6).rounded(3).bg(t.working)))
          .child(th.slug);
      }));

    const list = this.messages.length
      ? v_flex().id("chat-list").flex_1().min_h(0).px(12).py(8).overflow_y_scrollbar().flex_col_reverse()
          .children(this.messages.map((m, i) => this.message(t, m, i)).reverse())
      : v_flex().flex_1().min_h(0).py(8).child(empty(t, slug
          ? "No messages yet. Starts, reports and the agents' `team say` messages show up here."
          : "No team tasks yet. Start the CTO from the Team tab with a task, and its thread appears here."));

    const chip = (role) => {
      const on = to.includes(role.id);
      return h_flex().id(`to-${role.id}`).h(22).pl(3).pr(8).gap(5).items_center().rounded(11).cursor_pointer().text_size(11)
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : "#00000000")
        .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleTo(role.id, members, cx))
        .child(roleTile(div, svg, t, role, 16, !on)).child(role.name);
    };
    const present = [...new Set(members.map((m) => m.role))].map((r) => this.roleOf(r)).filter(Boolean);
    const composer = v_flex().px(12).pt(8).pb(10).gap(6).border_t(1).border_color(t.border)
      .child(h_flex().gap(5).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).child("To"))
        .children(present.map(chip))
        .when(present.length > 1, (el) => el.child(div().id("to-all").h(22).px(8).flex().items_center().rounded(11).cursor_pointer().text_size(11)
          .border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleTo("all", members, cx)).child("All")))
        .when(!present.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("nobody running in this task"))))
      .child(h_flex().gap(8).items_end()
        .child(div().flex_1().min_w(0).child(Textarea.new(this.input).w_full().px(10).py(8).rounded(8).border_1().border_color(t.input)
          .bg(t.background).text_size(12.5).text_color(t.foreground)))
        .child(button(t, "chat-send", this.sending ? "Sending…" : "Send", (_e, cx) => this.send(cx),
          { primary: true, disabled: this.sending || !this.input.value().trim() || !to.length })));

    return v_flex().size_full().min_h(0)
      .when(Boolean(picker), (el) => el.child(picker))
      .when(Boolean(slug), (el) => el.child(h_flex().px(14).h(34).flex_none().gap(8).items_center()
        .child(div().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(slug))
        .child(div().flex_1())
        .when(!this.fixed, (el) => el.child(button(t, "chat-pop", "Open as pane", () =>
          run("pane.split", { direction: "right", mod: "desk", props: { chat: true, task: slug } }), { tip: "Put this thread beside your terminals" })))))
      .child(list)
      .when(Boolean(slug), (el) => el.child(composer));
  }
}
