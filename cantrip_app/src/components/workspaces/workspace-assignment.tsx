import type { ProjectWorkspaceSummary } from "@cantrip/protocol";
import { Layers3 } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

export function WorkspaceAssignment({
  trailingAction,
  workspaceId,
  workspaces,
}: {
  trailingAction?: ReactNode;
  workspaceId: string;
  workspaces: ProjectWorkspaceSummary[];
}) {
  const workspace = workspaces.find(({ id }) => id === workspaceId);
  if (!workspace) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Workspace</span>
      <Badge variant="secondary" className="gap-1.5">
        <Layers3 className="size-3" />
        {workspace.name}
      </Badge>
      <span className="text-xs text-muted-foreground">
        Projects stay in the workspace where they are added.
      </span>
      {trailingAction ? (
        <div className="ml-auto pl-3">{trailingAction}</div>
      ) : null}
    </div>
  );
}
