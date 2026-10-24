import {
  workspaceCommandSchema,
  workspaceOwnershipSchema,
  workspaceSeedRequestSchema,
  type WorkspaceCommand,
  type WorkspaceSeedRequest,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { CantripApiError, request } from "@/lib/api-client";
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
  const window = layout.windows.find((w) => w.id === windowId);
  if (!window) throw new Error("The window does not belong to this workspace.");
  const controller = new WorkspaceCommandClient(
    layout,
    windowId,
    window.attachmentGeneration,
    transport,
  );
  const unsubscribe = onClientSessionIdentityChanged(() => {
    if (!clientSessionIdentityMatches(identity)) {
      controller.dispose();
      unsubscribe();
    }
  });
  return {
    controller,
    dispose: () => {
      unsubscribe();
      controller.dispose();
    },
  };
}
