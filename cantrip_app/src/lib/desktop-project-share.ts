import type { ProjectShareAttachment, ProjectSummary } from "@cantrip/protocol";

import {
  createProjectNetworkShare,
  deleteProjectNetworkShare,
} from "@/lib/api";

export type DesktopProjectRevealLabel =
  "Reveal in File Explorer" | "Reveal in Finder";

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
  if (!desktopRuntime) return null;
  if (/Macintosh|Mac OS X/u.test(userAgent)) return "Reveal in Finder";
  if (/Windows/u.test(userAgent)) return "Reveal in File Explorer";
  return null;
}

export function nativeProjectShareRequest(
  attachment: ProjectShareAttachment,
  project: ProjectSummary,
) {
  return {
    attachmentId: attachment.attachmentId,
    mountLeaseMs: attachment.mountLeaseMs,
    password: attachment.password,
    projectId: attachment.projectId,
    projectName: project.name,
    url: attachment.url,
    username: attachment.username,
  };
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

export async function revealProjectInNativeFileManager(
  project: ProjectSummary,
): Promise<void> {
  return coordinateDesktopProjectReveal(project, {
    createAttachment: createProjectNetworkShare,
    invokeNative: async (attachment, target) => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reveal_project_share", {
        request: nativeProjectShareRequest(attachment, target),
      });
    },
    revokeAttachment: deleteProjectNetworkShare,
  });
}
