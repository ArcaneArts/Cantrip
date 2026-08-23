import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  codeOpenFileResultSchema,
  codePresentationUpdateSchema,
  type CodeAttachment,
  type CodeProtectedAttachmentWire,
  type CodeOpenFileResult,
  type CodePresentationUpdate,
} from "@cantrip/protocol";

import { createDirectCodeAttachment, deleteDirectAttachment } from "@/lib/api";
import {
  desktopTunnelClientId,
  startDesktopTunnel,
  startDirectDesktopTunnel,
  stopDesktopTunnel,
} from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  directTunnelId: string | null;
}

const protectedAttachmentIds = new Map<string, string>();

export async function preferProtectedCodeAttachment(
  wire: CodeProtectedAttachmentWire,
): Promise<PreferredCodeAttachment> {
  if (!isTauri()) {
    throw new Error(
      "Protected Code localhost attachments require the desktop app.",
    );
  }
  const forward = await startDesktopTunnel(wire.tunnelId);
  try {
    const url = new URL(
      `http://${forward.localHost}:${forward.localPort}/code/`,
    );
    if (wire.runtime.workspaceUri) {
      const workspace = new URL(wire.runtime.workspaceUri);
      if (workspace.protocol !== "file:") {
        throw new Error("Cantrip Code supplied an invalid workspace URI.");
      }
      url.searchParams.set("workspace", decodeURIComponent(workspace.pathname));
    }
    protectedAttachmentIds.set(wire.tunnelId, forward.attachmentId);
    return {
      attachment: {
        attachmentId: wire.attachmentId,
        sessionId: wire.sessionId,
        url: url.toString(),
        expiresAt: wire.expiresAt,
        runtime: wire.runtime,
      },
      directTunnelId: wire.tunnelId,
    };
  } catch (error) {
    await stopDesktopTunnel(wire.tunnelId, forward.attachmentId).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function preferDirectCodeAttachment(
  attachment: CodeAttachment,
): Promise<PreferredCodeAttachment> {
  if (!isTauri()) {
    return { attachment, directTunnelId: null };
  }
  const ticket = await createDirectCodeAttachment(
    attachment.attachmentId,
    desktopTunnelClientId(window.localStorage),
  );
  try {
    const forward = await startDirectDesktopTunnel(
      ticket,
      ticket.binding.leaseExpiresAt,
    );
    const url = new URL(
      `http://${forward.localHost}:${forward.localPort}/code/`,
    );
    // OpenVSCode reads the workspace to open from the browser location. Keep
    // the relay attachment query when replacing its origin with the local
    // desktop forward; dropping it launches an empty workbench, so the
    // workspace-owned Cantrip bridge and appearance settings never load.
    url.search = new URL(attachment.url).search;
    return {
      attachment: { ...attachment, url: url.toString() },
      directTunnelId: forward.tunnelId,
    };
  } catch (error) {
    await deleteDirectAttachment(ticket.binding.capabilityId).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function directCodeAttachmentHealthy(
  tunnelId: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  const forwards = await invoke<
    Array<{ routeState: string; tunnelId: string }>
  >("list_tunnel_forwards");
  return forwards.some(
    (forward) =>
      forward.tunnelId === tunnelId && forward.routeState !== "degraded",
  );
}

export async function openDirectCodeAttachmentFile(
  attachment: CodeAttachment,
  relativePath: string,
): Promise<CodeOpenFileResult> {
  const endpoint = new URL("_cantrip/open-file", attachment.url);
  const response = await fetch(endpoint, {
    body: JSON.stringify({ relativePath }),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Cantrip Code could not open this file.";
    throw new Error(message);
  }
  return codeOpenFileResultSchema.parse(body);
}

export async function setDirectCodeAttachmentPresentation(
  attachment: CodeAttachment,
  presentation: "editor",
): Promise<CodePresentationUpdate> {
  const endpoint = new URL("_cantrip/presentation", attachment.url);
  const response = await fetch(endpoint, {
    body: JSON.stringify({ presentation }),
    credentials: "omit",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : "Cantrip Code could not enter editor-only mode.";
    throw new Error(message);
  }
  return codePresentationUpdateSchema.parse(body);
}

export async function stopDirectCodeAttachment(
  tunnelId: string | null,
): Promise<void> {
  if (!tunnelId || !isTauri()) return;
  const protectedAttachmentId = protectedAttachmentIds.get(tunnelId);
  if (protectedAttachmentId) {
    protectedAttachmentIds.delete(tunnelId);
    await stopDesktopTunnel(tunnelId, protectedAttachmentId).catch(
      () => undefined,
    );
    return;
  }
  await invoke("stop_tunnel_forward", { tunnelId }).catch(() => undefined);
}
