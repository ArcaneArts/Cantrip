import type {
  ExecutionTarget,
  ProjectPaneRegion,
  ProjectViewKind,
} from "@cantrip/protocol";

import type { ProjectSurfaceCreateKind } from "@/components/workspace/project-surface-create-menu";
import type { ProjectSurface } from "@/lib/project-surface";

interface MutationOperation<Input> {
  mutate(input: Input): void;
}

interface CreationMutation<Input> extends MutationOperation<Input> {
  error: Error | null;
  isError: boolean;
  isPending: boolean;
  reset(): void;
}

interface SurfaceCreateInput {
  paneId?: string;
  projectId: string;
  target?: ExecutionTarget;
  targetRegion?: ProjectPaneRegion;
}

export interface SurfaceCreationOperations {
  browser: CreationMutation<SurfaceCreateInput>;
  chat: CreationMutation<SurfaceCreateInput & { open?: boolean }>;
  code: CreationMutation<SurfaceCreateInput & { worktreeId?: string }>;
  explorer: CreationMutation<SurfaceCreateInput & { worktreeId?: string }>;
  projectView: CreationMutation<
    SurfaceCreateInput & {
      kind: Exclude<ProjectViewKind, "remote-desktop">;
      worktreeId?: string;
    }
  >;
  remoteDesktop: CreationMutation<SurfaceCreateInput>;
  terminal: CreationMutation<SurfaceCreateInput>;
}

export interface SurfaceCrudOperations {
  browser: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{
      browserId: string;
      input: { title?: string };
    }>;
  };
  chat: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{ chatId: string; title: string }>;
  };
  code: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{ codeTabId: string; title: string }>;
  };
  explorer: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{ explorerId: string; title: string }>;
    requestDelete(explorerId: string): void;
  };
  projectView: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{ title: string; viewId: string }>;
  };
  terminal: {
    delete: MutationOperation<string>;
    rename: MutationOperation<{ terminalId: string; title: string }>;
  };
}

export interface SurfaceViewOperations {
  close: MutationOperation<ProjectSurface>;
}

const projectToolCreateKinds = new Set<ProjectSurfaceCreateKind>([
  "history",
  "graph",
  "issues",
  "prs",
  "actions",
]);

export function createSurfaceCommandController({
  creation,
  crud,
  views,
}: {
  creation: SurfaceCreationOperations;
  crud: SurfaceCrudOperations;
  views: SurfaceViewOperations;
}) {
  const createProjectSurface = (
    projectId: string,
    kind: ProjectSurfaceCreateKind,
    paneId?: string,
    target?: ExecutionTarget,
    targetRegion?: ProjectPaneRegion,
  ) => {
    const input: SurfaceCreateInput = { projectId };
    if (paneId) input.paneId = paneId;
    if (target) input.target = target;
    if (targetRegion) input.targetRegion = targetRegion;
    if (kind === "chat") creation.chat.mutate(input);
    else if (kind === "terminal") creation.terminal.mutate(input);
    else if (kind === "explorer") creation.explorer.mutate(input);
    else if (kind === "browser") creation.browser.mutate(input);
    else if (kind === "code") creation.code.mutate(input);
    else if (projectToolCreateKinds.has(kind)) {
      creation.projectView.mutate({
        ...input,
        kind: kind as Exclude<ProjectViewKind, "remote-desktop">,
      });
    } else if (kind === "remote-desktop") {
      if (!paneId) creation.remoteDesktop.reset();
      creation.remoteDesktop.mutate(input);
    }
  };
  const renameSurface = (surface: ProjectSurface, title: string) => {
    if (surface.kind === "builtin") return;
    if (surface.kind === "chat") {
      crud.chat.rename.mutate({ chatId: surface.tabId, title });
    } else if (surface.kind === "terminal") {
      crud.terminal.rename.mutate({ terminalId: surface.tabId, title });
    } else if (surface.kind === "explorer") {
      crud.explorer.rename.mutate({ explorerId: surface.tabId, title });
    } else if (surface.kind === "browser") {
      crud.browser.rename.mutate({
        browserId: surface.tabId,
        input: { title },
      });
    } else if (surface.kind === "code") {
      crud.code.rename.mutate({ codeTabId: surface.tabId, title });
    } else {
      crud.projectView.rename.mutate({ viewId: surface.tabId, title });
    }
  };
  const closeSurfaceView = (surface: ProjectSurface) => {
    views.close.mutate(surface);
  };
  const deleteSurfaceResource = (surface: ProjectSurface) => {
    if (surface.kind === "builtin") return;
    if (surface.kind === "chat") crud.chat.delete.mutate(surface.tabId);
    else if (surface.kind === "terminal")
      crud.terminal.delete.mutate(surface.tabId);
    else if (surface.kind === "explorer")
      crud.explorer.requestDelete(surface.tabId);
    else if (surface.kind === "browser")
      crud.browser.delete.mutate(surface.tabId);
    else if (surface.kind === "code") crud.code.delete.mutate(surface.tabId);
    else crud.projectView.delete.mutate(surface.tabId);
  };
  const creatingSurfaceKinds = new Set<ProjectSurfaceCreateKind>([
    ...(creation.chat.isPending ? (["chat"] as const) : []),
    ...(creation.terminal.isPending ? (["terminal"] as const) : []),
    ...(creation.explorer.isPending ? (["explorer"] as const) : []),
    ...(creation.browser.isPending ? (["browser"] as const) : []),
    ...(creation.code.isPending ? (["code"] as const) : []),
    ...(creation.projectView.isPending ? [...projectToolCreateKinds] : []),
    ...(creation.remoteDesktop.isPending ? (["remote-desktop"] as const) : []),
  ]);
  const surfaceCreationFailure = creation.chat.isError
    ? {
        label: "Agent",
        error: creation.chat.error,
        dismiss: creation.chat.reset,
      }
    : creation.terminal.isError
      ? {
          label: "terminal",
          error: creation.terminal.error,
          dismiss: creation.terminal.reset,
        }
      : creation.explorer.isError
        ? {
            label: "Explorer",
            error: creation.explorer.error,
            dismiss: creation.explorer.reset,
          }
        : creation.browser.isError
          ? {
              label: "Browser",
              error: creation.browser.error,
              dismiss: creation.browser.reset,
            }
          : creation.code.isError
            ? {
                label: "Code tab",
                error: creation.code.error,
                dismiss: creation.code.reset,
              }
            : creation.projectView.isError
              ? {
                  label: "project tool",
                  error: creation.projectView.error,
                  dismiss: creation.projectView.reset,
                }
              : creation.remoteDesktop.isError
                ? {
                    label: "Remote Desktop",
                    error: creation.remoteDesktop.error,
                    dismiss: creation.remoteDesktop.reset,
                  }
                : null;
  return {
    createProjectSurface,
    creatingSurfaceKinds,
    closeSurfaceView,
    deleteSurfaceResource,
    renameSurface,
    surfaceCreationFailure,
  } as const;
}
