import type {
  ProjectShareAttachment,
  ProjectSummary,
  ProjectWorktreeSummary,
} from "@cantrip/protocol";

import {
  createProjectNetworkShare,
  deleteProjectNetworkShare,
  getProjectWorktreeStatus,
} from "@/lib/api";
import { startDesktopTunnel, stopDesktopTunnel } from "@/lib/desktop-tunnel";
import { getActiveServerUrl } from "@/lib/server-connections";

export type DesktopProjectRevealLabel =
  "Reveal in File Explorer" | "Reveal in Finder";
export type DesktopFolderRevealLabel =
  "Show in File Explorer" | "Show in Finder";
export type DesktopProjectRevealButtonLabel = "Explorer" | "Finder";
export type LocalProjectRevealResult =
  | "opened"
  | "worker-not-local"
  | "server-mismatch"
  | "source-path-missing"
  | "outside-managed-root"
  | "explorer-launch-failed";
export type DesktopProjectRevealTarget = Pick<
  ProjectWorktreeSummary,
  "id" | "isPrimary" | "path" | "projectSourceId" | "workerId"
>;

const PROTECTED_PATH_UNAVAILABLE = "Protected path unavailable";

const localProjectRevealErrors: Record<
  Exclude<LocalProjectRevealResult, "opened">,
  string
> = {
  "worker-not-local": "This project's worker is not running on this desktop.",
  "server-mismatch":
    "This project's worker is connected to a different Cantrip server.",
  "source-path-missing":
    "The project folder no longer exists at the path reported by its worker.",
  "outside-managed-root":
    "The project folder is outside this worker's managed storage root.",
  "explorer-launch-failed":
    "The system file manager could not open the project folder.",
};

function desktopFileManagerName(
  desktopRuntime: boolean,
  userAgent: string,
): "File Explorer" | "Finder" | null {
  if (!desktopRuntime) return null;
  if (/Macintosh|Mac OS X/u.test(userAgent)) return "Finder";
  if (/Windows/u.test(userAgent)) return "File Explorer";
  return null;
}

export interface DesktopProjectRevealOperations {
  createAttachment(projectId: string): Promise<ProjectShareAttachment>;
  invokeNative(
    attachment: ProjectShareAttachment,
    project: ProjectSummary,
  ): Promise<void>;
  revokeAttachment(attachmentId: string): Promise<void>;
}

type ProjectWorktreePathRefresh = (
  projectId: string,
  worktreeId: string,
) => Promise<{ worktree: { path: string } }>;

function projectPathUnavailable(path: string): boolean {
  return !path.trim() || path === PROTECTED_PATH_UNAVAILABLE;
}

/**
 * Worktree lists are allowed to retain a protected-path placeholder after a
 * transient worker startup failure. Refresh that private path at the moment a
 * native reveal is requested so the placeholder can never be sent back to the
 * worker as a filesystem path.
 */
export async function resolveDesktopProjectRevealTarget(
  project: ProjectSummary,
  target: DesktopProjectRevealTarget | undefined,
  refresh: ProjectWorktreePathRefresh = async (projectId, worktreeId) =>
    getProjectWorktreeStatus(projectId, worktreeId),
): Promise<DesktopProjectRevealTarget | undefined> {
  if (!target || !projectPathUnavailable(target.path)) return target;

  try {
    const refreshed = await refresh(project.id, target.id);
    if (!projectPathUnavailable(refreshed.worktree.path)) {
      return { ...target, path: refreshed.worktree.path };
    }
  } catch {
    // The primary source path below remains a safe worker-resolved fallback.
  }

  const source = project.source;
  if (
    target.isPrimary &&
    source &&
    source.id === target.projectSourceId &&
    source.workerId === target.workerId &&
    !projectPathUnavailable(source.path)
  ) {
    return undefined;
  }

  throw new Error("The project worktree path is unavailable. Try again.");
}

export function desktopProjectRevealLabel(
  desktopRuntime: boolean,
  userAgent: string,
): DesktopProjectRevealLabel | null {
  const fileManager = desktopFileManagerName(desktopRuntime, userAgent);
  return fileManager ? `Reveal in ${fileManager}` : null;
}

export function desktopProjectRevealButtonLabel(
  desktopRuntime: boolean,
  userAgent: string,
): DesktopProjectRevealButtonLabel | null {
  const fileManager = desktopFileManagerName(desktopRuntime, userAgent);
  if (fileManager === "Finder") return "Finder";
  if (fileManager === "File Explorer") return "Explorer";
  return null;
}

export function desktopFolderRevealLabel(
  desktopRuntime: boolean,
  userAgent: string,
): DesktopFolderRevealLabel | null {
  const fileManager = desktopFileManagerName(desktopRuntime, userAgent);
  return fileManager ? `Show in ${fileManager}` : null;
}

export function nativeProjectShareRequest(
  attachment: ProjectShareAttachment,
  project: ProjectSummary,
  relativePath = "",
) {
  return {
    attachmentId: attachment.attachmentId,
    mountLeaseMs: attachment.mountLeaseMs,
    password: attachment.password,
    projectId: attachment.projectId,
    projectName: project.name,
    relativePath,
    url: attachment.url,
    username: attachment.username,
  };
}

export function nativeLocalProjectFolderRequest(
  project: ProjectSummary,
  serverUrl: string,
  relativePath = "",
  target?: DesktopProjectRevealTarget,
) {
  const source = project.source;
  if (!source) return null;
  return {
    folderManagement: project.folderManagement ?? null,
    path: target?.path ?? source.path,
    placementMode: source.placementMode,
    relativePath,
    serverUrl,
    sourceKind: source.sourceKind,
    workerId: target?.workerId ?? source.workerId,
    ...(target
      ? { worktreeId: target.id, worktreeIsPrimary: target.isPrimary }
      : {}),
  };
}

export function directProjectShareUrl(
  attachment: Pick<ProjectShareAttachment, "url">,
  localPort: number,
): string {
  const url = new URL(attachment.url);
  url.protocol = "http:";
  url.hostname = "127.0.0.1";
  url.port = String(localPort);
  return url.toString();
}

export async function coordinateDesktopProjectReveal(
  project: ProjectSummary,
  operations: DesktopProjectRevealOperations,
): Promise<void> {
  const attachment = await operations.createAttachment(project.id);
  try {
    await operations.invokeNative(attachment, project);
  } catch (error) {
    await operations.revokeAttachment(attachment.attachmentId).catch(() => {
      // Preserve the actionable native mount error if best-effort cleanup fails.
    });
    throw error;
  }
}

export async function coordinateDesktopProjectRevealPreference(
  requireLocalFolder: boolean,
  operations: {
    revealLocalFolder(): Promise<LocalProjectRevealResult | boolean>;
    revealNetworkShare(): Promise<void>;
  },
): Promise<void> {
  let result: LocalProjectRevealResult | boolean;
  try {
    result = await operations.revealLocalFolder();
  } catch (error) {
    if (requireLocalFolder) throw error;
    await operations.revealNetworkShare();
    return;
  }
  if (result === "opened" || result === true) return;
  if (requireLocalFolder) {
    if (result === false) {
      throw new Error("The local folder is not available on this desktop.");
    }
    throw new Error(localProjectRevealErrors[result]);
  }
  await operations.revealNetworkShare();
}

async function revealProjectNetworkShare(
  project: ProjectSummary,
  relativePath: string,
  target?: DesktopProjectRevealTarget,
): Promise<void> {
  return coordinateDesktopProjectReveal(project, {
    createAttachment: () => createProjectNetworkShare(project, target),
    invokeNative: async (attachment, target) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const forward = await startDesktopTunnel(attachment.attachmentId);
      try {
        await invoke("reveal_project_share", {
          request: nativeProjectShareRequest(
            {
              ...attachment,
              url: directProjectShareUrl(attachment, forward.localPort),
            },
            target,
            relativePath,
          ),
        });
      } catch (error) {
        await stopDesktopTunnel(forward.tunnelId, forward.attachmentId).catch(
          () => undefined,
        );
        throw error;
      }
    },
    revokeAttachment: deleteProjectNetworkShare,
  });
}

export async function revealProjectInNativeFileManager(
  project: ProjectSummary,
  localFolder = false,
  relativePath = "",
  target?: DesktopProjectRevealTarget,
): Promise<void> {
  const resolvedTarget = await resolveDesktopProjectRevealTarget(
    project,
    target,
  );
  return coordinateDesktopProjectRevealPreference(localFolder, {
    revealLocalFolder: async () => {
      const request = nativeLocalProjectFolderRequest(
        project,
        getActiveServerUrl(),
        relativePath,
        resolvedTarget,
      );
      if (!request) return "source-path-missing";
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<LocalProjectRevealResult>("reveal_local_project_folder", {
        request,
      });
    },
    revealNetworkShare: () =>
      revealProjectNetworkShare(project, relativePath, resolvedTarget),
  });
}
