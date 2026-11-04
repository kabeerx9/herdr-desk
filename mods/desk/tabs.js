import { run, shared, setShared } from "herdr";

// Shared by the panel (desk) and its icon rail (desk-rail).
export const TABS = [
  { id: "inbox", label: "Inbox", icon: "bell" },
  { id: "team", label: "Team", icon: "team" },
  { id: "chat", label: "Team chat", icon: "chat" },
  { id: "projects", label: "Projects", icon: "projects" },
  { id: "prs", label: "Pull requests", icon: "pr" },
  { id: "issues", label: "Issues", icon: "issue" },
  { id: "git", label: "Git", icon: "branch" },
  { id: "pages", label: "Pages", icon: "pages" },
];

export const currentTab = () => (TABS.some((t) => t.id === shared("desk.tab")) ? shared("desk.tab") : "projects");
export const isOpen = () => shared("desk.open") !== false;

// The panel is the layout node "desk"; the rail stays visible either way.
export function setOpen(open) {
  setShared("desk.open", open);
  run(open ? "layout.show" : "layout.hide", { id: "desk" });
}

// Rail click: open on that tab, or close when it's already showing.
export function choose(tab) {
  if (isOpen() && currentTab() === tab) return setOpen(false);
  setShared("desk.tab", tab);
  setOpen(true);
}
