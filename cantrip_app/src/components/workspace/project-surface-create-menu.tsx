import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { type ReactNode } from "react";

import { ProjectSurfaceIcon } from "./project-surface-icon";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-menu";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export type ProjectSurfaceCreateKind = ProjectSurface["kind"];

export interface ProjectSurfaceCreateDefinition {
  kind: ProjectSurfaceCreateKind;
  label: string;
}

export const projectSurfaceCreateDefinitions = [
  { kind: "chat", label: "Chat" },
  { kind: "terminal", label: "Terminal" },
  { kind: "explorer", label: "Explorer" },
  { kind: "code", label: "Code" },
  { kind: "browser", label: "Browser" },
  { kind: "history", label: "History" },
  { kind: "issues", label: "Issues" },
  { kind: "remote-desktop", label: "Remote Desktop" },
] as const satisfies readonly ProjectSurfaceCreateDefinition[];

const noCreatingKinds: ReadonlySet<ProjectSurfaceCreateKind> = new Set();

export function projectSurfaceCreateOptions(
  creatingKinds: ReadonlySet<ProjectSurfaceCreateKind> = noCreatingKinds,
) {
  return projectSurfaceCreateDefinitions.map((definition) => ({
    ...definition,
    disabled: creatingKinds.has(definition.kind),
  }));
}

export function ProjectSurfaceCreateMenu({
  align = "start",
  contentClassName,
  creatingKinds = noCreatingKinds,
  onCreate,
  trigger,
}: {
  align?: "start" | "center" | "end";
  contentClassName?: string;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind): void;
  trigger: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <StyledDropdownMenuContent
          align={align}
          sideOffset={4}
          className={cn("min-w-40", contentClassName)}
        >
          {projectSurfaceCreateOptions(creatingKinds).map(
            ({ disabled, kind, label }) => (
              <StyledDropdownMenuItem
                key={kind}
                disabled={disabled}
                onSelect={() => onCreate(kind)}
              >
                <ProjectSurfaceIcon kind={kind} className="size-4" />
                {label}
              </StyledDropdownMenuItem>
            ),
          )}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
