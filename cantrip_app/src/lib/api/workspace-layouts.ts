import {
  workspaceCommandSchema,
  workspaceOwnershipSchema,
  type WorkspaceCommand,
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
): WorkspaceTransport {
  const expectedIdentity = { ...identity };
  const base = `/api/projects/${encodeURIComponent(projectId)}/workspace-layouts/${encodeURIComponent(workspaceId)}`;
  const behavior = { expectedIdentity, allowCsrfRecovery: false };
  return {
    read: async () =>
      workspaceOwnershipSchema.parse(await request(base, undefined, behavior)),
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

/** Opens existing migrated ownership only. Seeding requires native-window import
 * coordination and is deliberately not an automatic side effect of mounting. */
export async function connectWorkspaceCommands(
  projectId: string,
  workspaceId: string,
  windowId: string,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before opening workspace ownership.");
  const transport = workspaceLayoutTransport(projectId, workspaceId, identity);
  const layout = await transport.read();
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
