import type { ProjectBuiltInSurfaceDefinitionId } from "@cantrip/protocol";
import {
  CircleDot,
  CirclePlay,
  GitPullRequest,
  History,
  LayoutDashboard,
  ListTodo,
  Network,
  type LucideProps,
} from "lucide-react";

export function ProjectBuiltInSurfaceIcon({
  definitionId,
  ...props
}: LucideProps & { definitionId: ProjectBuiltInSurfaceDefinitionId }) {
  const Icon =
    definitionId === "project.overview"
      ? LayoutDashboard
      : definitionId === "project.tasks"
        ? ListTodo
        : definitionId === "git.history"
          ? History
          : definitionId === "git.graph"
            ? Network
            : definitionId === "github.issues"
              ? CircleDot
              : definitionId === "github.pull-requests"
                ? GitPullRequest
                : CirclePlay;
  return <Icon {...props} />;
}
