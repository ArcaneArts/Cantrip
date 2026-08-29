import type { ProjectShareAttachment, ProjectSummary } from "@cantrip/protocol";

import {
  createProjectNetworkShare,
  deleteProjectNetworkShare,
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
) {
  const source = project.source;
  if (!source) return null;
  return {
    folderManagement: project.folderManagement ?? null,
    path: source.path,
    placementMode: source.placementMode,
    relativePath,
    serverUrl,
    sourceKind: source.sourceKind,
    workerId: source.workerId,
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
  preferLocalFolder: boolean,
  operations: {
    revealLocalFolder(): Promise<LocalProjectRevealResult | boolean>;
    revealNetworkShare(): Promise<void>;
  },
): Promise<void> {
  if (preferLocalFolder) {
    const result = await operations.revealLocalFolder();
    if (result === "opened" || result === true) return;
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
): Promise<void> {
  return coordinateDesktopProjectReveal(project, {
    createAttachment: () => createProjectNetworkShare(project),
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
): Promise<void> {
  return coordinateDesktopProjectRevealPreference(localFolder, {
    revealLocalFolder: async () => {
      const request = nativeLocalProjectFolderRequest(
        project,
        getActiveServerUrl(),
        relativePath,
      );
      if (!request) return "source-path-missing";
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<LocalProjectRevealResult>("reveal_local_project_folder", {
        request,
      });
    },
    revealNetworkShare: () => revealProjectNetworkShare(project, relativePath),
  });
}
