import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  codeOpenFileResultSchema,
  codePresentationUpdateSchema,
  type CodeAttachment,
  type CodeProtectedAttachmentWire,
  type CodeOpenFileResult,
  type CodePresentationUpdate,
} from "@cantrip/protocol";

import {
  browserCodeAttachmentHealthy,
  startBrowserCodeAttachment,
  stopBrowserCodeAttachment,
} from "@/lib/browser-code-tunnel";
import { startDesktopTunnel, stopDesktopTunnel } from "@/lib/desktop-tunnel";

export interface PreferredCodeAttachment {
  attachment: CodeAttachment;
  directTunnelId: string | null;
}

const protectedAttachmentIds = new Map<string, string>();
const CODE_ATTACHMENT_HEALTH_ATTEMPTS = 100;
const CODE_ATTACHMENT_HEALTH_RETRY_MS = 50;

export async function waitForDirectCodeAttachmentReady(
  attachment: Pick<CodeAttachment, "url">,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const attempts = Math.max(
    1,
    options.attempts ?? CODE_ATTACHMENT_HEALTH_ATTEMPTS,
  );
  const retryDelayMs = Math.max(
    0,
    options.retryDelayMs ?? CODE_ATTACHMENT_HEALTH_RETRY_MS,
  );
  const endpoint = new URL("_cantrip/health", attachment.url);
  let lastError: unknown = new Error("Cantrip Code is unavailable.");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "omit",
      });
      if (response.ok) return;
      lastError = new Error(`Cantrip Code returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw lastError;
}

export async function preferProtectedCodeAttachment(
  wire: CodeProtectedAttachmentWire,
): Promise<PreferredCodeAttachment> {
  if (!isTauri()) {
    return {
      attachment: await startBrowserCodeAttachment(wire),
      directTunnelId: wire.tunnelId,
    };
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
    const attachment = {
      attachmentId: wire.attachmentId,
      sessionId: wire.sessionId,
      url: url.toString(),
      expiresAt: wire.expiresAt,
      runtime: wire.runtime,
    } satisfies CodeAttachment;
    await waitForDirectCodeAttachmentReady(attachment);
    protectedAttachmentIds.set(wire.tunnelId, forward.attachmentId);
    return {
      attachment,
      directTunnelId: wire.tunnelId,
    };
  } catch (error) {
    await stopDesktopTunnel(wire.tunnelId, forward.attachmentId).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function directCodeAttachmentHealthy(
  tunnelId: string,
): Promise<boolean> {
  if (!isTauri()) return browserCodeAttachmentHealthy(tunnelId);
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
  if (!tunnelId) return;
  if (!isTauri()) {
    await stopBrowserCodeAttachment(tunnelId).catch(() => undefined);
    return;
  }
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
