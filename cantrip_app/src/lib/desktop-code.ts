import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  codeOpenFileResultSchema,
  type CodeAttachment,
  type CodeOpenFileResult,
} from "@cantrip/protocol";

import { createDirectCodeAttachment, deleteDirectAttachment } from "@/lib/api";
import {
  desktopTunnelClientId,
  startDirectDesktopTunnel,
} from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  directTunnelId: string | null;
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
      forward.tunnelId === tunnelId && forward.routeState === "local-direct",
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

export async function stopDirectCodeAttachment(
  tunnelId: string | null,
): Promise<void> {
  if (!tunnelId || !isTauri()) return;
  await invoke("stop_tunnel_forward", { tunnelId }).catch(() => undefined);
}
