import {
  workspaceCommandSchema,
  workspaceOwnershipSchema,
  workspaceSeedRequestSchema,
  type WorkspaceCommand,
  type WorkspaceSeedRequest,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { CantripApiError, request } from "@/lib/api-client";
import { attachWorkspaceRenderer } from "@/lib/workspace-renderer-attachment";
import type { WorkspaceRendererLifetime } from "@/lib/workspace-renderer-lifetime";
import { bindWorkspaceRefreshChannel } from "@/lib/workspace-refresh-channel";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  type ClientSessionIdentitySnapshot,
} from "@/lib/client-session";
import {
  WorkspaceCommandClient,
  workspaceReceiptSchema,
  type WorkspaceTransport,
} from "@/lib/workspace-command-client";

/** Captures one account/server lifetime for reads, retries, and delayed responses. */
export function workspaceLayoutTransport(
  projectId: string,
  workspaceId: string,
  identity: ClientSessionIdentitySnapshot,
): WorkspaceTransport & {
  seed(input: WorkspaceSeedRequest): Promise<WorkspaceOwnership>;
} {
  const expectedIdentity = { ...identity };
  const base = `/api/projects/${encodeURIComponent(projectId)}/workspace-layouts/${encodeURIComponent(workspaceId)}`;
  const behavior = { expectedIdentity, allowCsrfRecovery: false };
  return {
    read: async () =>
      workspaceOwnershipSchema.parse(await request(base, undefined, behavior)),
    seed: async (input) =>
      workspaceOwnershipSchema.parse(
        await request(
          `${base}/seed`,
          {
            method: "POST",
            body: JSON.stringify(workspaceSeedRequestSchema.parse(input)),
          },
          behavior,
        ),
      ),
    execute: async (input: WorkspaceCommand) => {
      const command = workspaceCommandSchema.parse(input);
      if (
        command.projectId !== projectId ||
        command.workspaceId !== workspaceId
      )
        throw new CantripApiError("Workspace scope mismatch.", 400);
      return workspaceReceiptSchema.parse(
        await request(
          `${base}/commands`,
          { method: "POST", body: JSON.stringify(command) },
          behavior,
        ),
      );
    },
    classify: (error) => {
      if (error instanceof CantripApiError) {
        if (error.status === 409 && error.code === "revision")
          return "conflict";
        if ([400, 401, 403, 404, 409].includes(error.status)) return "rejected";
      }
      return "uncertain";
    },
  };
}

/** Observe legacy placement only after an actual missing-workspace response.
 * Callers must coordinate native import; a transport failure never means empty. */
export async function connectWorkspaceCommands(
  projectId: string,
  workspaceId: string,
  windowId: string,
  prepareSeed?: () => Promise<WorkspaceSeedRequest>,
  lifetime?: WorkspaceRendererLifetime,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before opening workspace ownership.");
  const transport = workspaceLayoutTransport(projectId, workspaceId, identity);
  let layout: WorkspaceOwnership;
  try {
    layout = await transport.read();
  } catch (error) {
    if (
      !(error instanceof CantripApiError) ||
      error.status !== 404 ||
      !prepareSeed
    )
      throw error;
    const seed = await prepareSeed();
    layout = await transport.seed(seed);
  }
  if (
    layout.projectId !== projectId ||
    layout.id !== workspaceId ||
    !clientSessionIdentityMatches(identity)
  )
    throw new Error("Workspace connection scope changed.");
  if (lifetime)
    layout = await attachWorkspaceRenderer(
      layout,
      windowId,
      lifetime,
      transport,
      () => {
        if (!clientSessionIdentityMatches(identity))
          throw new Error(
            "Workspace session changed during renderer attachment.",
          );
      },
    );
  const window = layout.windows.find((w) => w.id === windowId);
  if (!window) throw new Error("The window does not belong to this workspace.");
  const controller = new WorkspaceCommandClient(
    layout,
    windowId,
    window.attachmentGeneration,
    transport,
  );
  const closeRefreshChannel = bindWorkspaceRefreshChannel(controller, identity);
  let disposed = false;
  let unsubscribe = () => {};
  const dispose = (reason?: unknown) => {
    if (disposed) return;
    disposed = true;
    lifetime?.signal.removeEventListener("abort", endLifetime);
    closeRefreshChannel();
    unsubscribe();
    controller.dispose(reason);
    lifetime?.releaseConnection?.();
  };
  const endLifetime = () => dispose(lifetime?.signal.reason);
  unsubscribe = onClientSessionIdentityChanged(() => {
    if (!clientSessionIdentityMatches(identity)) {
      dispose();
    }
  });
  lifetime?.signal.addEventListener("abort", endLifetime, { once: true });
  if (lifetime?.signal.aborted) endLifetime();
  return { controller, dispose: () => dispose() };
}
