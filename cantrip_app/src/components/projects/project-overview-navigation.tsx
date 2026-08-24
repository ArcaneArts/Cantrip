import {
  CircleDot,
  GitPullRequest,
  History,
  LayoutDashboard,
  ListTodo,
  Network,
} from "lucide-react";

import {
  NavigationTabBar,
  type NavigationTab,
} from "@/components/ui/navigation-tab-bar";
import type { ProjectOverviewSection } from "@/lib/project-overview-section";

const projectOverviewTabs: readonly NavigationTab<ProjectOverviewSection>[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "history", label: "History", icon: History },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "prs", label: "PRs", icon: GitPullRequest },
  { id: "graph", label: "Graph", icon: Network },
];

export function ProjectOverviewNavigation({
  activeTab,
  githubEnabled,
  gitEnabled,
  includeOverview = true,
  onTabChange,
}: {
  activeTab: ProjectOverviewSection;
  githubEnabled: boolean;
  gitEnabled: boolean;
  includeOverview?: boolean;
  onTabChange(tab: ProjectOverviewSection): void;
}) {
  const tabs = projectOverviewTabs
    .filter(
      (tab) =>
        (includeOverview || (tab.id !== "overview" && tab.id !== "tasks")) &&
        (gitEnabled || tab.id === "overview" || tab.id === "tasks"),
    )
    .map((tab) => ({
      ...tab,
      disabled:
        tab.id !== "overview" &&
        tab.id !== "tasks" &&
        (!gitEnabled ||
          ((tab.id === "issues" || tab.id === "prs") && !githubEnabled)),
    }));

  return (
    <NavigationTabBar<ProjectOverviewSection>
      activeTab={activeTab}
      ariaLabel={includeOverview ? "Project overview sections" : "Git sections"}
      className="w-fit max-w-full"
      tabs={tabs}
      onTabChange={onTabChange}
    />
  );
}
