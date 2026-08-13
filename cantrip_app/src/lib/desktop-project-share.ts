import type { ProjectShareAttachment, ProjectSummary } from "@cantrip/protocol";

import {
  createDirectProjectNetworkShare,
  createProjectNetworkShare,
  deleteDirectAttachment,
  deleteProjectNetworkShare,
} from "@/lib/api";
import {
  desktopTunnelAvailable,
  desktopTunnelClientId,
  startDirectDesktopTunnel,
} from "@/lib/desktop-tunnel";

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
  direct?: { fallbackUrl: string; tunnelId: string },
) {
  return {
    attachmentId: attachment.attachmentId,
    directTunnelId: direct?.tunnelId ?? null,
    fallbackUrl: direct?.fallbackUrl ?? null,
    mountLeaseMs: attachment.mountLeaseMs,
    password: attachment.password,
    projectId: attachment.projectId,
    projectName: project.name,
    url: attachment.url,
    username: attachment.username,
  };
}

export function directProjectShareUrl(
  attachment: ProjectShareAttachment,
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

export async function revealProjectInNativeFileManager(
  project: ProjectSummary,
): Promise<void> {
  return coordinateDesktopProjectReveal(project, {
    createAttachment: createProjectNetworkShare,
    invokeNative: async (attachment, target) => {
      const { invoke } = await import("@tauri-apps/api/core");
      const clientId = desktopTunnelClientId(window.localStorage);
      const direct = await createDirectProjectNetworkShare(
        attachment.attachmentId,
        clientId,
      ).catch(() => null);
      if (direct) {
        try {
          const forward = await startDirectDesktopTunnel(
            direct,
            attachment.expiresAt,
          );
          await invoke("reveal_project_share", {
            request: nativeProjectShareRequest(
              {
                ...attachment,
                url: directProjectShareUrl(attachment, forward.localPort),
              },
              target,
              {
                fallbackUrl: attachment.url,
                tunnelId: direct.route.tunnelId,
              },
            ),
          });
          return;
        } catch {
          await deleteDirectAttachment(direct.binding.capabilityId).catch(
            () => {
              // The server URL remains the authoritative relay fallback.
            },
          );
        }
      }
      await invoke("reveal_project_share", {
        request: nativeProjectShareRequest(attachment, target),
      });
    },
    revokeAttachment: deleteProjectNetworkShare,
  });
}

export async function listDirectDesktopProjectShares(): Promise<string[]> {
  if (!desktopTunnelAvailable()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_direct_project_share_tunnels");
}

export async function fallbackDirectDesktopProjectShare(
  tunnelId: string,
): Promise<boolean> {
  if (!desktopTunnelAvailable()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("fallback_project_share", { tunnelId });
}
