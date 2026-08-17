import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type {
  ExecutionTarget,
  ProjectReplicaSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import {
  ChevronRight,
  Cpu,
  GitFork,
  HardDrive,
  ListTodo,
  Sparkles,
} from "lucide-react";
import { type ReactNode } from "react";

import { ProjectSurfaceIcon } from "./project-surface-icon";
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from "@/components/ui/styled-menu";
import type { ProjectSurface } from "@/lib/project-surface";
import { cn } from "@/lib/utils";

export type ProjectSurfaceCreateKind = ProjectSurface["kind"] | "task";

export interface ProjectSurfaceCreateDefinition {
  kind: ProjectSurfaceCreateKind;
  label: string;
}

export interface ProjectSurfacePlacementContext {
  projectId: string;
  replicas: readonly ProjectReplicaSummary[];
  workers: readonly WorkerSummary[];
  worktrees: readonly ProjectWorktreeSummary[];
}

export interface ProjectSurfaceWorkerPlacement {
  disabled: boolean;
  reason: string | null;
  replica: ProjectReplicaSummary | null;
  worker: WorkerSummary;
  worktrees: readonly ProjectWorktreeSummary[];
}

export const projectSurfaceCreateDefinitions = [
  { kind: "chat", label: "Agent" },
  { kind: "task", label: "Task" },
  { kind: "terminal", label: "Terminal" },
  { kind: "explorer", label: "Explorer" },
  { kind: "code", label: "Code" },
  { kind: "browser", label: "Browser" },
  { kind: "history", label: "Git" },
  { kind: "remote-desktop", label: "Remote Desktop" },
] as const satisfies readonly ProjectSurfaceCreateDefinition[];

const noCreatingKinds: ReadonlySet<ProjectSurfaceCreateKind> = new Set();

const worktreePlacementKinds = new Set<ProjectSurfaceCreateKind>([
  "chat",
  "task",
  "terminal",
  "explorer",
  "code",
]);

export function surfaceSupportsExplicitPlacement(
  kind: ProjectSurfaceCreateKind,
): boolean {
  return kind !== "history" && kind !== "issues";
}

function capabilityReason(
  kind: ProjectSurfaceCreateKind,
  worker: WorkerSummary,
): string | null {
  if (!worker.online) return "Offline";
  if (kind === "code" && !worker.code.available) return "Code unavailable";
  if (kind === "browser" && !worker.remoteSurfaces.browser) {
    return "Browser unavailable";
  }
  if (kind === "remote-desktop" && !worker.remoteSurfaces.desktop) {
    return "Desktop unavailable";
  }
  return null;
}

export function projectSurfaceWorkerPlacements(
  kind: ProjectSurfaceCreateKind,
  context: ProjectSurfacePlacementContext,
): ProjectSurfaceWorkerPlacement[] {
  return [...context.workers]
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.workerId.localeCompare(right.workerId),
    )
    .map((worker) => {
      const replica =
        context.replicas.find(
          (candidate) => candidate.workerId === worker.workerId,
        ) ?? null;
      const worktrees = context.worktrees
        .filter(
          (worktree) =>
            worktree.workerId === worker.workerId &&
            worktree.lifecycleState === "ready",
        )
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            Number(right.isPrimary) - Number(left.isPrimary) ||
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        );
      let reason = capabilityReason(kind, worker);
      if (!reason && worktreePlacementKinds.has(kind) && !replica) {
        reason = "No project replica";
      }
      if (
        !reason &&
        worktreePlacementKinds.has(kind) &&
        !replica?.ready &&
        worktrees.length === 0
      ) {
        reason = "Replica not ready";
      }
      return {
        disabled: reason !== null,
        reason,
        replica,
        worker,
        worktrees,
      };
    });
}

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
  placement,
  trigger,
}: {
  align?: "start" | "center" | "end";
  contentClassName?: string;
  creatingKinds?: ReadonlySet<ProjectSurfaceCreateKind>;
  onCreate(kind: ProjectSurfaceCreateKind, target?: ExecutionTarget): void;
  placement?: ProjectSurfacePlacementContext;
  trigger: ReactNode;
}) {
  const placementControls = Boolean(placement && placement.workers.length > 1);
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
            ({ disabled, kind, label }) => {
              if (
                !placementControls ||
                !placement ||
                !surfaceSupportsExplicitPlacement(kind)
              ) {
                return (
                  <StyledDropdownMenuItem
                    key={kind}
                    disabled={disabled}
                    onSelect={() => onCreate(kind)}
                  >
                    {kind === "task" ? (
                      <ListTodo className="size-4" />
                    ) : (
                      <ProjectSurfaceIcon kind={kind} className="size-4" />
                    )}
                    {label}
                  </StyledDropdownMenuItem>
                );
              }
              const workers = projectSurfaceWorkerPlacements(kind, placement);
              return (
                <DropdownMenu.Sub key={kind}>
                  <StyledDropdownMenuSubTrigger disabled={disabled}>
                    {kind === "task" ? (
                      <ListTodo className="size-4" />
                    ) : (
                      <ProjectSurfaceIcon kind={kind} className="size-4" />
                    )}
                    {label}
                    <ChevronRight className="ml-auto size-3.5" />
                  </StyledDropdownMenuSubTrigger>
                  <DropdownMenu.Portal>
                    <StyledDropdownMenuSubContent
                      sideOffset={4}
                      className="min-w-56"
                    >
                      <StyledDropdownMenuItem onSelect={() => onCreate(kind)}>
                        <Sparkles className="size-4" />
                        <span className="min-w-0 flex-1">Automatic</span>
                        <span className="text-[10px] text-muted-foreground">
                          Policy
                        </span>
                      </StyledDropdownMenuItem>
                      <DropdownMenu.Separator className="my-1 h-px bg-border" />
                      {workers.map(
                        ({
                          disabled: workerDisabled,
                          reason,
                          replica,
                          worker,
                          worktrees,
                        }) =>
                          worktreePlacementKinds.has(kind) ? (
                            <DropdownMenu.Sub key={worker.workerId}>
                              <StyledDropdownMenuSubTrigger
                                disabled={workerDisabled}
                              >
                                <Cpu className="size-4" />
                                <span className="min-w-0 flex-1 truncate">
                                  {worker.name}
                                </span>
                                {reason ? (
                                  <span className="text-[10px] text-muted-foreground">
                                    {reason}
                                  </span>
                                ) : (
                                  <ChevronRight className="size-3.5" />
                                )}
                              </StyledDropdownMenuSubTrigger>
                              {!workerDisabled && replica ? (
                                <DropdownMenu.Portal>
                                  <StyledDropdownMenuSubContent
                                    sideOffset={4}
                                    className="min-w-56"
                                  >
                                    <StyledDropdownMenuItem
                                      onSelect={() =>
                                        onCreate(kind, {
                                          kind: "worker",
                                          projectId: placement.projectId,
                                          workerId: worker.workerId,
                                        })
                                      }
                                    >
                                      <Sparkles className="size-4" />
                                      Worker default
                                    </StyledDropdownMenuItem>
                                    <StyledDropdownMenuItem
                                      onSelect={() =>
                                        onCreate(kind, {
                                          kind: "replica",
                                          projectId: placement.projectId,
                                          projectReplicaId: replica.id,
                                        })
                                      }
                                    >
                                      <HardDrive className="size-4" />
                                      Replica default
                                    </StyledDropdownMenuItem>
                                    {worktrees.length > 0 ? (
                                      <DropdownMenu.Separator className="my-1 h-px bg-border" />
                                    ) : null}
                                    {worktrees.map((worktree) => (
                                      <StyledDropdownMenuItem
                                        key={worktree.id}
                                        onSelect={() =>
                                          onCreate(kind, {
                                            kind: "worktree",
                                            projectId: placement.projectId,
                                            worktreeId: worktree.id,
                                          })
                                        }
                                      >
                                        <GitFork className="size-4" />
                                        <span className="min-w-0 flex-1 truncate">
                                          {worktree.name}
                                        </span>
                                        {worktree.isDefault ? (
                                          <span className="text-[10px] text-muted-foreground">
                                            Default
                                          </span>
                                        ) : worktree.isPrimary ? (
                                          <span className="text-[10px] text-muted-foreground">
                                            Primary
                                          </span>
                                        ) : null}
                                      </StyledDropdownMenuItem>
                                    ))}
                                  </StyledDropdownMenuSubContent>
                                </DropdownMenu.Portal>
                              ) : null}
                            </DropdownMenu.Sub>
                          ) : (
                            <StyledDropdownMenuItem
                              key={worker.workerId}
                              disabled={workerDisabled}
                              onSelect={() =>
                                onCreate(kind, {
                                  kind: "worker",
                                  projectId: placement.projectId,
                                  workerId: worker.workerId,
                                })
                              }
                            >
                              <Cpu className="size-4" />
                              <span className="min-w-0 flex-1 truncate">
                                {worker.name}
                              </span>
                              <span className="text-[10px] text-muted-foreground">
                                {reason ?? "Worker"}
                              </span>
                            </StyledDropdownMenuItem>
                          ),
                      )}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenu.Portal>
                </DropdownMenu.Sub>
              );
            },
          )}
        </StyledDropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
