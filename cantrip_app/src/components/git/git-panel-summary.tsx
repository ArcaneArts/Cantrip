import type { ProjectSummary } from "@cantrip/protocol";
import { GitBranch } from "lucide-react";
import type { GitHistoryHeaderState } from "./git-history";

export function GitPanelSummary({
  header,
  project,
}: {
  header: GitHistoryHeaderState;
  project: ProjectSummary;
}) {
  const repository = project.github?.nameWithOwner ?? project.name;
  const history = header.section === "history";
  const graph = header.section === "graph";
  const count = history
    ? `${header.commitsLoaded.toLocaleString()} commits loaded`
    : graph
      ? `${header.graphNodes.toLocaleString()} repository nodes`
      : header.section === "actions"
        ? `${header.actionRunCount ?? "…"} workflow runs${header.activeActionRunCount ? ` · ${header.activeActionRunCount} active` : ""}`
        : `${header.issueCount ?? "…"} ${header.issueState} ${header.section === "prs" ? "PRs" : "issues"}`;
  return (
    <div
      className="flex min-w-0 basis-full items-center gap-2 pb-1 text-[10px] text-muted-foreground"
      data-slot="git-panel-summary"
    >
      <span className="min-w-0 truncate" title={repository}>
        {repository}
      </span>
      {history || graph ? (
        <>
          <span
            className="inline-flex min-w-0 max-w-40 items-center gap-1 font-mono"
            title={header.branch || "detached HEAD"}
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate">{header.branch || "detached HEAD"}</span>
          </span>
          {header.head ? (
            <code className="shrink-0" title={header.head}>
              @ {header.head.slice(0, 8)}
            </code>
          ) : null}
        </>
      ) : null}
      <span className="ml-auto shrink-0">{count}</span>
    </div>
  );
}
