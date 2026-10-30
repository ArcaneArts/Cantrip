import { workspacePaneViews, workspaceSelectedViewId } from "@cantrip/protocol";
import { clearSensitiveBytes } from "@cantrip/crypto";
import type {
  ClientEncryptionIdentity,
  ClientEncryptionService,
} from "./client-encryption";
import {
  openWorkspaceTransferWindow,
  destroyCancelledWorkspaceWindow,
  watchWorkspaceNativeWindow,
} from "./desktop-popout";
import type { WorkspaceCommandClient } from "./workspace-command-client";
import { createWorkspaceTransferChannel } from "./workspace-transfer-channel";
import { destinationTransferBinding } from "./workspace-transfer-destination";

/** A lease keeps all affected views (including inactive drafts) suspended until
 * ownership commits or cancellation is authoritatively acknowledged. Retiring
 * detaches exclusive runtime attachments without discarding recoverable state. */
export interface WorkspaceTransferLease {
  capture(): Promise<Uint8Array>;
  retire(): Promise<void>;
  resume(): Promise<void>;
}

function acknowledgement() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Errors may arrive while native creation or preparation is still awaited.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** An observation deadline is not evidence that an owner died. The caller must
 * still cancel the reservation authoritatively before resuming source inputs. */
async function waitForAcknowledgement(promise: Promise<void>, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Workspace transfer timed out waiting for ${phase}.`),
            ),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function detachWorkspaceViews(
  input: {
    controller: Pick<
      WorkspaceCommandClient,
      "getSnapshot" | "dispatch" | "subscribe"
    >;
    windowId: string;
    paneId: string;
    tabId?: string;
    /** Return this complete pane to the existing main window. */
    returnToMain?: boolean;
    title: string;
    identity: ClientEncryptionIdentity;
    service?: ClientEncryptionService;
    signal?: AbortSignal;
    /** Suspend inputs before resolving; failure must undo partial preparation. */
    prepare(tabIds: readonly string[]): Promise<WorkspaceTransferLease>;
    activate(windowId: string): Promise<void>;
  },
  dependencies = {
    allocateId: () => crypto.randomUUID() as string,
    open: openWorkspaceTransferWindow,
    watch: watchWorkspaceNativeWindow,
    channel: createWorkspaceTransferChannel,
    destroyCancelled: destroyCancelledWorkspaceWindow,
  },
) {
  const { controller } = input;
  input.signal?.throwIfAborted();
  if (input.returnToMain && input.tabId)
    throw new Error("Window return transfers a complete pane.");
  const transferId = dependencies.allocateId();
  const destinationWindowId = input.returnToMain
    ? controller.getSnapshot().authoritative.mainWindowId
    : `cantrip-pane-workspace-${dependencies.allocateId()}`;
  const destinationPaneId = input.tabId
    ? dependencies.allocateId()
    : input.paneId;
  // Unknown command outcomes remain pending in the controller. Never race a
  // mutation against an observation timeout and infer that it did not apply.
  await controller.dispatch(
    input.returnToMain
      ? {
          type: "prepare-return",
          transferId,
          paneId: input.paneId,
          splitId: dependencies.allocateId(),
        }
      : {
          type: "prepare-detach",
          transferId,
          paneId: input.paneId,
          tabId: input.tabId,
          destinationWindowId,
          destinationPaneId,
        },
  );
  let lease: WorkspaceTransferLease | undefined;
  let channel: ReturnType<typeof createWorkspaceTransferChannel> | undefined;
  let committed = false;
  let unwatch: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let sourceGeneration: number | undefined;
  let reservedTabIds: readonly string[] = [];
  const sourceStillOwnsViews = () => {
    const state = controller.getSnapshot();
    const source = state.authoritative.windows.find(
      ({ id }) => id === input.windowId,
    );
    return (
      !state.disposed &&
      sourceGeneration !== undefined &&
      source?.attachmentGeneration === sourceGeneration &&
      reservedTabIds.length > 0 &&
      reservedTabIds.every((id) =>
        source.panes.some((pane) =>
          workspacePaneViews(pane).some((tab) => tab.id === id),
        ),
      )
    );
  };
  const ready = acknowledgement();
  const restored = acknowledgement();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    ready.reject(error);
    restored.reject(error);
  };
  const assertLive = () => {
    input.signal?.throwIfAborted();
    if (failure) throw failure.error;
    if (controller.getSnapshot().disposed)
      throw new Error("Workspace controller is disposed.");
  };
  const abort = () =>
    fail(input.signal?.reason ?? new Error("Transfer cancelled."));
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    assertLive();
    const state = controller.getSnapshot();
    const transfer = state.authoritative.pendingTransfers?.find(
      ({ id }) => id === transferId,
    );
    if (
      state.disposed ||
      !transfer ||
      transfer.sourceWindowId !== input.windowId
    )
      throw new Error("The source no longer owns this transfer.");
    sourceGeneration = transfer.sourceGeneration;
    reservedTabIds = [...transfer.tabIds];
    unsubscribe = controller.subscribe(() => {
      const current = controller.getSnapshot();
      if (
        current.disposed ||
        current.authoritative.windows.find(({ id }) => id === input.windowId)
          ?.attachmentGeneration !== sourceGeneration
      ) {
        fail(new Error("Workspace controller is disposed."));
      } else if (
        !committed &&
        !current.authoritative.pendingTransfers?.some(
          ({ id }) => id === transferId,
        ) &&
        sourceStillOwnsViews()
      ) {
        // A destination renderer replacement may cancel an incoming return.
        // This is an authoritative cancellation, not a missing heartbeat.
        fail(
          new Error(
            "Workspace transfer was cancelled during attachment recovery.",
          ),
        );
      }
    });
    const sourcePane = state.authoritative.windows
      .find(({ id }) => id === input.windowId)
      ?.panes.find(({ id }) => id === input.paneId);
    const target = {
      projectId: state.authoritative.projectId,
      paneId: destinationPaneId,
      activeTabKey:
        input.tabId ??
        (sourcePane ? workspaceSelectedViewId(sourcePane) : null) ??
        transfer.tabIds[0]!,
      transfer: {
        id: transferId,
        workspaceId: state.authoritative.id,
        windowId: destinationWindowId,
        generation: transfer.destinationGeneration,
      },
    };
    const binding = destinationTransferBinding(
      state.authoritative,
      destinationWindowId,
      target,
      input.identity,
    );
    channel = dependencies.channel({
      binding,
      service: input.service,
      side: "source",
      onReady: ready.resolve,
      onRestored: restored.resolve,
      onError: fail,
    });
    lease = await input.prepare([...transfer.tabIds]);
    assertLive();
    if (input.returnToMain) await input.activate(destinationWindowId);
    else await dependencies.open(target, input.title);
    unwatch = await dependencies.watch(
      destinationWindowId === state.authoritative.mainWindowId
        ? "main"
        : destinationWindowId,
      () => {
        if (!committed)
          fail(new Error("Workspace transfer destination window closed."));
      },
    );
    await waitForAcknowledgement(ready.promise, "destination readiness");
    assertLive();
    const bytes = await lease.capture();
    try {
      assertLive();
      await channel.sendSnapshot(bytes);
    } finally {
      clearSensitiveBytes(bytes);
    }
    await waitForAcknowledgement(
      restored.promise,
      "destination state restoration",
    );
    assertLive();
    await lease.retire();
    assertLive();
    await controller.dispatch({ type: "commit-transfer", transferId });
    committed = true;
    // A focus failure after commit cannot resurrect the source renderer.
    await input.activate(destinationWindowId);
    return destinationWindowId;
  } catch (error) {
    if (!committed) {
      try {
        if (
          controller
            .getSnapshot()
            .authoritative.pendingTransfers?.some(({ id }) => id === transferId)
        ) {
          await controller.dispatch({ type: "cancel-transfer", transferId });
        }
        if (lease && !sourceStillOwnsViews())
          throw new Error(
            "The previous renderer cannot resume views it no longer owns.",
          );
        await lease?.resume();
        if (
          !input.returnToMain &&
          !controller
            .getSnapshot()
            .authoritative.windows.some(({ id }) => id === destinationWindowId)
        ) {
          await dependencies.destroyCancelled(destinationWindowId);
        }
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          "Transfer failed; source state remains retained pending ownership recovery.",
        );
      }
    }
    throw error;
  } finally {
    unwatch?.();
    unsubscribe?.();
    input.signal?.removeEventListener("abort", abort);
    channel?.dispose();
  }
}
