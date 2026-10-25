import { clearSensitiveBytes } from "@cantrip/crypto";
import {
  workspaceLegacyFileImportSchema,
  type WorkspaceLegacyFileImport,
} from "@cantrip/protocol";
import type { ExplorerLifecycleActions } from "@/components/explorer/explorer-view";
import { validateExplorerTransfer } from "@/components/explorer/explorer-transfer-state";
import {
  bindLegacyDocument,
  reconcileLegacyDocumentRecovery,
  type ResolveLegacyDraft,
  planLegacyDocuments,
} from "@/components/explorer/legacy-document-migration";
import { workspaceLayoutTransport } from "./api/workspace-layouts";
import { createFileDocument, getFileDocuments } from "./api/file-documents";
import { CantripApiError } from "./api-client";
import {
  clientSessionIdentityMatches,
  getClientSessionIdentitySnapshot,
} from "./client-session";
import {
  currentDesktopWorkspaceWindowId,
  desktopPopoutPaneSearch,
} from "./desktop-popout";
import { DocumentRecoverySession } from "./document-recovery-session";
import { readWorkspaceDeviceIdentity } from "./workspace-device-identity";
import { workspaceRendererLifetime } from "./workspace-renderer-lifetime";
import { surfaceTitleEncryption } from "./surface-title-encryption";

/** Import the actual native host, never a query-supplied window identity. The
 * journal and target checkpoints precede the atomic ownership mutation. */
type ImportInput = {
  projectId: string;
  explorerId: string;
  path: string;
  lifecycle: ExplorerLifecycleActions;
  activate(search: string): void;
  resolveConflict?: ResolveLegacyDraft;
};

/** Only this live source can advance a checkpoint it wrote itself. A new
 * renderer still treats divergent recovered drafts as a conflict. */
export function createLegacyFileWindowImporter() {
  const knownCheckpoints = new Map<string, string>();
  return (input: ImportInput) =>
    importLegacyFileWindow(input, knownCheckpoints);
}

async function importLegacyFileWindow(
  input: ImportInput,
  knownCheckpoints: Map<string, string>,
) {
  const identity = getClientSessionIdentitySnapshot();
  if (!identity) throw new Error("Sign in before importing this file window.");
  const assertIdentity = () => {
    if (!clientSessionIdentityMatches(identity))
      throw new Error("File import account changed.");
  };
  const windowId = await currentDesktopWorkspaceWindowId();
  assertIdentity();
  if (!windowId?.startsWith("cantrip-editor-"))
    throw new Error("This is not a legacy native file window.");
  const device = await readWorkspaceDeviceIdentity(identity, input.projectId);
  assertIdentity();
  const lifetime = await workspaceRendererLifetime({
    serverId: identity.serverId,
    ownerId: identity.userId,
    workspaceId: device.workspaceId,
    windowId,
  });
  const lifecycle = input.lifecycle;
  let resume: (() => void) | undefined;
  let journal: DocumentRecoverySession | undefined;
  let activated = false;
  try {
    assertIdentity();
    if (
      !lifecycle.suspendTransfer ||
      !lifecycle.captureTransfer ||
      !lifecycle.restoreTransfer ||
      !lifecycle.retireTransfer
    )
      throw new Error("Legacy file import lifecycle is unavailable.");
    resume = lifecycle.suspendTransfer();
    let capture = await lifecycle.captureTransfer();
    assertIdentity();
    const scope = {
      serverId: identity.serverId,
      ownerId: identity.userId,
      projectId: input.projectId,
      explorerId: input.explorerId,
      workerId: capture.workerId,
      worktreeId: capture.worktreeId,
    };
    capture = validateExplorerTransfer(capture, scope);
    if (capture.selectedPath !== input.path)
      throw new Error("Legacy file location changed during import.");
    const journalBinding = {
      ...scope,
      workspaceId: device.workspaceId,
      tabId: windowId,
      documentId: `legacy-window:${input.explorerId}`,
    };
    const journalKey = JSON.stringify(journalBinding);
    journal = new DocumentRecoverySession(journalBinding);
    const recovered = await journal.load((bytes) => {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return {
        capture: validateExplorerTransfer(value.capture, scope),
        request:
          value.request == null
            ? null
            : workspaceLegacyFileImportSchema.parse(value.request),
      };
    });
    assertIdentity();
    if (recovered) {
      if (
        recovered.capture.selectedPath !== input.path ||
        (recovered.request && recovered.request.windowId !== windowId)
      )
        throw new Error(
          "Legacy import recovery belongs to another location or window.",
        );
      const live = new Map(
        capture.documents.documents.map((document) => [document.id, document]),
      );
      if (knownCheckpoints.get(journalKey) !== JSON.stringify(recovered))
        capture = await reconcileLegacyDocumentRecovery(
          capture,
          recovered.capture,
          scope,
          input.resolveConflict,
          assertIdentity,
        );
      // The session store correctly refuses to replace any live dirty buffer,
      // even with identical content. Restore only missing/clean sessions.
      const restore = capture.documents.documents.filter((document) => {
        const current = live.get(document.id);
        return (
          !current ||
          (current.text === current.baselineContent && !current.saveFailed)
        );
      });
      if (restore.length)
        lifecycle.restoreTransfer({
          ...capture,
          documents: { ...capture.documents, documents: restore },
        });
    }
    const checkpoint = async (request: WorkspaceLegacyFileImport | null) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ capture, request }),
      );
      try {
        await journal!.checkpoint(bytes);
        knownCheckpoints.set(journalKey, new TextDecoder().decode(bytes));
      } finally {
        clearSensitiveBytes(bytes);
      }
      assertIdentity();
    };
    await checkpoint(recovered?.request ?? null);
    const transport = workspaceLayoutTransport(
      input.projectId,
      device.workspaceId,
      identity,
    );
    let layout;
    try {
      layout = await transport.read();
    } catch (error) {
      if (!(error instanceof CantripApiError) || error.status !== 404)
        throw error;
      layout = await transport.seed({ mainWindowId: device.mainWindowId });
    }
    assertIdentity();
    const previous = layout.legacyFileImports?.find(
      (entry) => entry.windowId === windowId,
    );
    if (previous) {
      // A lost response can be retried before attachment. Once attached, moved,
      // or closed, this old route cannot overwrite that renderer's checkpoints.
      const owner = layout.windows.find((entry) => entry.id === windowId);
      if (!owner || owner.attachmentGeneration !== 0)
        throw new Error(
          "This legacy window was already imported. Its existing owned views have been retained.",
        );
    }
    const catalog = await getFileDocuments(input.projectId);
    assertIdentity();
    const views: WorkspaceLegacyFileImport["views"] = [];
    for (const candidate of planLegacyDocuments(capture, scope)) {
      const binding = {
        projectId: input.projectId,
        workerId: candidate.workerId,
        worktreeId: candidate.worktreeId,
        path: candidate.path,
      };
      const document =
        catalog.find(
          (entry) =>
            entry.workerId === binding.workerId &&
            entry.worktreeId === binding.worktreeId &&
            entry.path === binding.path,
        ) ??
        (await createFileDocument({
          ...binding,
          id: surfaceTitleEncryption.fileDocumentId(binding),
        }));
      assertIdentity();
      const tabId = `legacy-window:${windowId}:${document.id}`;
      const mode =
        recovered?.request?.views.find((view) => view.tabId === tabId)?.mode ??
        candidate.mode;
      const targetScope = {
        ...scope,
        explorerId: tabId,
        documentId: document.id,
        documentPath: document.path,
        workerId: document.workerId,
        worktreeId: document.worktreeId,
      };
      let transfer = bindLegacyDocument({ ...candidate, mode }, scope, {
        tabId,
        documentId: document.id,
      });
      const targetBinding = {
        ...targetScope,
        workspaceId: device.workspaceId,
        tabId,
      };
      const targetKey = JSON.stringify(targetBinding);
      const recovery = new DocumentRecoverySession(targetBinding);
      try {
        const saved = await recovery.load((bytes) =>
          validateExplorerTransfer(
            JSON.parse(new TextDecoder().decode(bytes)),
            targetScope,
          ),
        );
        assertIdentity();
        if (saved && knownCheckpoints.get(targetKey) !== JSON.stringify(saved))
          transfer = await reconcileLegacyDocumentRecovery(
            transfer,
            saved,
            targetScope,
            input.resolveConflict,
            assertIdentity,
          );
        const bytes = new TextEncoder().encode(JSON.stringify(transfer));
        try {
          await recovery.checkpoint(bytes);
          knownCheckpoints.set(targetKey, new TextDecoder().decode(bytes));
        } finally {
          clearSensitiveBytes(bytes);
        }
      } finally {
        recovery.dispose();
      }
      assertIdentity();
      views.push({
        tabId,
        documentId: document.id,
        mode,
      });
    }
    const request = workspaceLegacyFileImportSchema.parse({
      windowId,
      paneId: `legacy-window:${windowId}`,
      views,
    });
    if (
      recovered?.request &&
      JSON.stringify(recovered.request) !== JSON.stringify(request)
    )
      throw new Error(
        "Legacy import bindings changed after preparation; drafts have been retained.",
      );
    await checkpoint(request);
    const result = await transport.importLegacyFiles({
      ...request,
      expectedRevision: layout.revision,
    });
    assertIdentity();
    const owner = result.layout.windows.find((entry) => entry.id === windowId);
    if (!owner || owner.attachmentGeneration !== 0)
      throw new Error(
        "The imported window has already moved or attached elsewhere.",
      );
    lifecycle.retireTransfer();
    input.activate(
      desktopPopoutPaneSearch({
        projectId: input.projectId,
        paneId: request.paneId,
        activeTabKey: views[0]!.tabId,
      }),
    );
    activated = true;
    // Keep the encrypted journal until normal owned-file recovery is mounted.
    // A durable import tombstone prevents replay from resurrecting closed tabs.
  } finally {
    journal?.dispose();
    lifetime.releaseConnection?.();
    if (!activated && clientSessionIdentityMatches(identity)) resume?.();
  }
}
