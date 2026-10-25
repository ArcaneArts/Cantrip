import type { WorkspaceOwnership } from "@cantrip/protocol";
import type {
  ClientEncryptionIdentity,
  ClientEncryptionService,
} from "./client-encryption";
import type { DesktopPopoutPaneTarget } from "./desktop-popout";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import { createWorkspaceTransferChannel } from "./workspace-transfer-channel";
import type { WorkspaceTransferBinding } from "./workspace-transfer-encryption";

/** The native label and authorized snapshot are authority; launch parameters
 * only locate a reservation, and cannot manufacture one. */
export function destinationTransferBinding(
  layout: WorkspaceOwnership,
  windowId: string,
  target: DesktopPopoutPaneTarget,
  identity: ClientEncryptionIdentity,
): Omit<WorkspaceTransferBinding, "purpose"> {
  const route = target.transfer;
  const transfer = layout.pendingTransfers?.find(({ id }) => id === route?.id);
  const destination = layout.windows.find(({ id }) => id === windowId);
  const source = layout.windows.find(
    ({ id }) => id === transfer?.sourceWindowId,
  );
  if (
    !route ||
    !transfer ||
    !destination ||
    !source ||
    layout.id !== route.workspaceId ||
    layout.projectId !== target.projectId ||
    windowId !== route.windowId ||
    windowId !== transfer.destinationWindowId ||
    route.generation !== destination.attachmentGeneration ||
    route.generation !== transfer.destinationGeneration ||
    source.attachmentGeneration !== transfer.sourceGeneration ||
    target.paneId !== transfer.destinationPaneId ||
    !transfer.tabIds.includes(target.activeTabKey)
  )
    throw new Error("The window does not own this pending workspace transfer.");
  return {
    ...identity,
    projectId: layout.projectId,
    workspaceId: layout.id,
    transferId: transfer.id,
    sourceWindowId: source.id,
    sourceGeneration: transfer.sourceGeneration,
    destinationWindowId: destination.id,
    destinationGeneration: transfer.destinationGeneration,
  };
}

export function startWorkspaceTransferDestination(
  input: {
    controller: Pick<WorkspaceCommandClient, "getSnapshot" | "dispatch">;
    windowId: string;
    target: DesktopPopoutPaneTarget;
    identity: ClientEncryptionIdentity;
    service?: ClientEncryptionService;
    /** Validate and stage all views. Do not attach exclusive renderers yet. */
    restore(bytes: Uint8Array): Promise<void>;
    onError(error: unknown): void;
  },
  createChannel = createWorkspaceTransferChannel,
) {
  const { controller } = input;
  const target = structuredClone(input.target);
  const identity = { ...input.identity };
  let disposed = false;
  const readBinding = () => {
    const state = controller.getSnapshot();
    if (disposed || state.disposed)
      throw new Error("Workspace transfer destination is disposed.");
    return destinationTransferBinding(
      state.authoritative,
      input.windowId,
      target,
      identity,
    );
  };
  const binding = readBinding();
  const assertCurrent = () => {
    if (JSON.stringify(readBinding()) !== JSON.stringify(binding))
      throw new Error("Workspace transfer attachment changed.");
  };
  const channel = createChannel({
    binding,
    service: input.service,
    side: "destination",
    onError: input.onError,
    restore: async (bytes) => {
      assertCurrent();
      await input.restore(bytes);
      assertCurrent();
      await controller.dispatch({
        type: "transfer-state-ready",
        transferId: binding.transferId,
      });
      assertCurrent();
    },
  });
  const ready = (async () => {
    assertCurrent();
    await controller.dispatch({
      type: "transfer-ready",
      transferId: binding.transferId,
    });
    assertCurrent();
    await channel.announceReady();
  })().catch((error: unknown) => {
    disposed = true;
    channel.dispose();
    throw error;
  });
  return {
    ready,
    dispose() {
      disposed = true;
      channel.dispose();
    },
    async announceReady() {
      await ready;
      assertCurrent();
      await channel.announceReady();
    },
  };
}
