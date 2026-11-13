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
