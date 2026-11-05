// The sidebar's kept projects: folders that stay listed after their last terminal closes, so a
// new desk is one click away. Plain data, apart from the mod, so it can be tested.

// Worth keeping: a real project folder, not home and not a team worktree.
export const keepable = (folder, home) => Boolean(folder) && folder !== home && !folder.includes("/.herdr/worktrees/");

// The list with this folder added, in first-seen order; the same list when nothing changed.
export const withKept = (kept, folder, home) => (keepable(folder, home) && !kept.includes(folder) ? [...kept, folder] : kept);

// Agents or desk members stop a project being removed: wrap them up first.
export function removeBlockers(folder, spaces, agents, terminals, deskFolder) {
  const here = new Set(spaces.map((s) => s.id));
  const running = agents.filter((a) => here.has(a.space)).map((a) => a.address);
  const members = terminals.filter((x) => x.labels?.task && deskFolder(x.labels.task) === folder).map((x) => x.address);
  return [...new Set([...running, ...members])];
}
