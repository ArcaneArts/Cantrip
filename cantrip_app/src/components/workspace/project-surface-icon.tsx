import {
  CircleDot,
  Code2,
  FolderTree,
  GitCommitHorizontal,
  Globe2,
  Layers3,
  MessageSquare,
  MonitorUp,
  SquareTerminal,
  type LucideProps,
} from "lucide-react";

import type { ProjectTabGroupVisualKind } from "@/lib/project-tab-group";

export function ProjectSurfaceIcon({
  kind,
  ...props
}: LucideProps & { kind: ProjectTabGroupVisualKind }) {
  const Icon =
    kind === "chat"
      ? MessageSquare
      : kind === "terminal"
        ? SquareTerminal
        : kind === "explorer"
          ? FolderTree
          : kind === "browser"
            ? Globe2
            : kind === "code"
              ? Code2
              : kind === "history"
                ? GitCommitHorizontal
                : kind === "issues"
                  ? CircleDot
                  : kind === "remote-desktop"
                    ? MonitorUp
                    : Layers3;
  return <Icon {...props} />;
}
