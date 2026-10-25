import type { QueryClient } from "@tanstack/react-query";
import { clearSensitiveBytes } from "@cantrip/crypto";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { validateExplorerTransfer } from "@/components/explorer/explorer-transfer-state";
import {
  bindLegacyDocument,
  mergeLegacyDocumentRecovery,
  planLegacyDocuments,
} from "@/components/explorer/legacy-document-migration";
import { getExplorerMigrationSource } from "./api/explorers";
import {
  createFileDocument,
  getFileDocuments,
  type FileDocument,
} from "./api/file-documents";
import {
  getClientSessionIdentitySnapshot,
  clientSessionIdentityMatches,
} from "./client-session";
import { DocumentRecoverySession } from "./document-recovery-session";
import { surfaceTitleEncryption } from "./surface-title-encryption";
import type { WorkspaceCommandClient } from "./workspace-command-client";

/** Runs only for a mounted, owned legacy file view. The encrypted journal
 * bridges crash-before-layout-commit; document checkpoints precede conversion. */
export async function migrateOwnedLegacyFile({
  controller,
  windowId,
  tabId,
  explorerId,
  lifecycle,
  queryClient,
}: {
  controller: WorkspaceCommandClient;
  windowId: string;
  tabId: string;
  explorerId: string;
  lifecycle: ExplorerLifecycleActions;
  queryClient: QueryClient;
}) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before migrating a file view.");
  const initial = controller.getSnapshot().authoritative;
  const generation = initial.windows.find(
    (window) => window.id === windowId,
  )?.attachmentGeneration;
  const ownsSource = () => {
    const state = controller.getSnapshot();
    const window = state.authoritative.windows.find(
      (window) => window.id === windowId,
    );
    const tab = window?.panes
      .flatMap((pane) => pane.tabs)
      .find((tab) => tab.id === tabId);
    return (
      !state.disposed &&
      clientSessionIdentityMatches(identity) &&
      window?.attachmentGeneration === generation &&
      tab?.resource.kind === "entity" &&
      tab.resource.definitionId === "project.explorer" &&
      tab.resource.resourceId === explorerId
    );
  };
  const assertSource = () => {
    if (
      !ownsSource() ||
      controller
        .getSnapshot()
        .authoritative.pendingTransfers?.some((transfer) =>
          transfer.tabIds.includes(tabId),
        )
    )
      throw new Error("Legacy file ownership changed during migration.");
  };
  assertSource();
  if (
    !lifecycle.suspendTransfer ||
    !lifecycle.captureTransfer ||
    !lifecycle.restoreTransfer ||
    !lifecycle.retireTransfer
  )
    throw new Error("Legacy editor migration lifecycle is unavailable.");
  const resume = lifecycle.suspendTransfer();
  let journal: DocumentRecoverySession | undefined;
  let committed = false;
  try {
    let capture = await lifecycle.captureTransfer();
    assertSource();
    const scope = {
      serverId: identity.serverId,
      ownerId: identity.userId,
      explorerId,
      projectId: initial.projectId,
      workerId: capture.workerId,
      worktreeId: capture.worktreeId,
    };
    capture = validateExplorerTransfer(capture, scope);
    if (capture.selectedPath === null) return;
    journal = new DocumentRecoverySession({
      ...scope,
      workspaceId: initial.id,
      tabId,
      documentId: `legacy-migration:${explorerId}`,
    });
    const recovered = await journal.load((bytes) =>
      validateExplorerTransfer(
        JSON.parse(new TextDecoder().decode(bytes)),
        scope,
      ),
    );
    assertSource();
    if (recovered) {
      const merged = mergeLegacyDocumentRecovery(capture, recovered, scope);
      const live = new Map(
        capture.documents.documents.map((document) => [document.id, document]),
      );
      const restore = merged.documents.documents.filter((document) => {
        const current = live.get(document.id);
        if (!current) return true;
        const currentDirty =
          current.text !== current.baselineContent || current.saveFailed;
        const recoveredDirty =
          document.text !== document.baselineContent || document.saveFailed;
        return !currentDirty && recoveredDirty;
      });
      if (restore.length) {
        lifecycle.restoreTransfer({
          ...capture,
          documents: { ...capture.documents, documents: restore },
        });
        capture = await lifecycle.captureTransfer();
        assertSource();
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(capture));
    try {
      await journal.checkpoint(bytes);
    } finally {
      clearSensitiveBytes(bytes);
    }
    assertSource();
    const { wire, explorer } = await getExplorerMigrationSource(
      initial.projectId,
      explorerId,
    );
    assertSource();
    if (
      explorer.activeWorkerId !== capture.workerId ||
      explorer.worktreeId !== capture.worktreeId ||
      explorer.selectedPath !== capture.selectedPath
    )
      throw new Error("Legacy Explorer location changed during migration.");
    const catalog = await getFileDocuments(initial.projectId);
    assertSource();
    const targets: {
      document: FileDocument;
      tabId: string;
      mode: typeof capture.fileMode;
    }[] = [];
    for (const candidate of planLegacyDocuments(capture, scope)) {
      const binding = {
        projectId: initial.projectId,
        workerId: candidate.workerId,
        worktreeId: candidate.worktreeId,
        path: candidate.path,
      };
      const document =
        catalog.find(
          (document) =>
            document.workerId === binding.workerId &&
            document.worktreeId === binding.worktreeId &&
            document.path === binding.path,
        ) ??
        (await createFileDocument({
          ...binding,
          id: surfaceTitleEncryption.fileDocumentId(binding),
        }));
      assertSource();
      const targetTabId = candidate.selected
        ? tabId
        : `legacy-retained:${tabId}:${document.id}`;
      let transfer = bindLegacyDocument(candidate, scope, {
        tabId: targetTabId,
        documentId: document.id,
      });
      const recovery = new DocumentRecoverySession({
        serverId: identity.serverId,
        ownerId: identity.userId,
        workspaceId: initial.id,
        projectId: initial.projectId,
        workerId: candidate.workerId,
        worktreeId: candidate.worktreeId,
        documentId: document.id,
        tabId: targetTabId,
      });
      try {
        const targetScope = {
          ...scope,
          explorerId: targetTabId,
          documentId: document.id,
          documentPath: document.path,
          workerId: document.workerId,
          worktreeId: document.worktreeId,
        };
        const recoveredTarget = await recovery.load((bytes) =>
          validateExplorerTransfer(
            JSON.parse(new TextDecoder().decode(bytes)),
            targetScope,
          ),
        );
        assertSource();
        // An interrupted attempt may already have checkpointed this target.
        // Loading it is not permission to overwrite it with a fresh disk read.
        if (recoveredTarget)
          transfer = mergeLegacyDocumentRecovery(
            transfer,
            recoveredTarget,
            targetScope,
          );
        const bytes = new TextEncoder().encode(JSON.stringify(transfer));
        try {
          await recovery.checkpoint(bytes);
        } finally {
          clearSensitiveBytes(bytes);
        }
      } finally {
        recovery.dispose();
      }
      assertSource();
      targets.push({ document, tabId: targetTabId, mode: candidate.mode });
    }
    queryClient.setQueryData<FileDocument[]>(
      ["file-documents", initial.projectId],
      (current = []) => {
        const documents = new Map(
          current.map((document) => [document.id, document]),
        );
        for (const { document } of targets)
          documents.set(document.id, document);
        return [...documents.values()];
      },
    );
    assertSource();
    lifecycle.retireTransfer();
    await controller.dispatch({
      type: "migrate-explorer-file",
      tabId,
      explorerId,
      expectedWorkerId: capture.workerId,
      expectedWorktreeId: capture.worktreeId,
      expectedStateProtection: wire.stateProtection,
      documentId: targets[0]!.document.id,
      mode: targets[0]!.mode,
      retainedViews: targets.slice(1).map((target) => ({
        tabId: target.tabId,
        documentId: target.document.id,
        mode: target.mode,
      })),
    });
    committed = true;
    await journal.checkpoint(null);
  } catch (error) {
    // Retain the journal even on rejection: legacy editors do not yet own a
    // document recovery record, and the user may reload before another attempt.
    if (committed)
      throw new Error(
        "File migration completed, but its recovery checkpoint could not be cleared.",
        { cause: error },
      );
    throw error;
  } finally {
    journal?.dispose();
    if (!committed && ownsSource()) resume();
  }
}
