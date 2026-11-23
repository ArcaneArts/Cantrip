export const projectOverviewSections = [
  "overview",
  "tasks",
  "alerts",
  "history",
  "issues",
  "prs",
  "actions",
  "graph",
] as const;

export type ProjectOverviewSection = (typeof projectOverviewSections)[number];

export function isProjectOverviewSection(
  value: string | null,
): value is ProjectOverviewSection {
  return projectOverviewSections.some((section) => section === value);
}
