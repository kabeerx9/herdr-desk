// Pure helpers that decide when the Desk polls. No host calls here, so node --test can load them.

// What the runtime poll (team state) reads from ~/.herdr/team: .runtime.json and the desks'
// threads. A returned root means "refresh everything". Everything else under it changes for
// other reasons: .activity/ on every tool call, the lock files, and .titles.json, which
// team state itself writes (watching it would make the poll wake itself).
export function runtimeWake(paths, dir) {
  return (paths ?? []).some((p) => {
    if (p === dir || p === `${dir}/`) return true;
    if (!p.startsWith(`${dir}/`)) return false;
    const rel = p.slice(dir.length + 1);
    return rel === ".runtime.json" || /^[^/.][^/]*\.jsonl$/.test(rel);
  });
}

// Who is an agent and what it is doing, as one string: a change means team state may differ.
export const agentSignature = (list) => (list ?? []).map((a) => `${a.address}:${a.status}`).sort().join(",");

// How often an elapsed label ("working 12s") needs a redraw: every second for the first
// minute, then every 5 s (the labels still show seconds; they step by five).
export const tickEvery = (elapsedMs) => (elapsedMs < 60000 ? 1000 : 5000);

// `tail -n <n>` of a text, without a process: the last n lines (a final newline ends a line).
export function lastLines(text, n) {
  const lines = String(text ?? "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}

// A minimum spacing per key: true (and the time noted) when key last ran at least `every` ms ago.
export function due(stamps, key, every, now) {
  if (now - (stamps[key] ?? -Infinity) < every) return false;
  stamps[key] = now;
  return true;
}

// Whether to read a member's screen for a permission prompt (team approve --peek, a process
// each). Blocked: every 2.5 s. Otherwise every 10 s, but only while something could have
// changed: its status, turn or agent record moved since the last look (sig), the last look
// found a prompt, or it started in the last 2 minutes (a Codex folder-trust question doesn't
// always mark it blocked). An unchanged member still gets a look once a minute.
export function peekDue(prev, { status, sig, created }, now) {
  if (!prev) return true;
  const age = now - prev.at;
  if (status === "blocked") return age > 2500;
  if (age <= 10000) return false;
  return prev.sig !== sig || Boolean(prev.dialog) || now - (created ?? 0) < 120000 || age > 60000;
}

// One read for the copies one change wakes (every copy of the mod watches the same folder).
// A read in flight is shared only with callers that woke (`since`) no later than it started,
// so no caller gets data from before its change; settled reads are never reused. A joiner
// whose shared read fails (its copy closed mid-read) reads for itself.
export function coalesce(reads, key, since, start, now = Date.now()) {
  const hit = reads.get(key);
  if (hit && hit.at >= since) return hit.promise.catch(() => start());
  const entry = { at: now, promise: Promise.resolve(start()) };
  reads.set(key, entry);
  const clear = () => { if (reads.get(key) === entry) reads.delete(key); };
  entry.promise.then(clear, clear);
  return entry.promise;
}
