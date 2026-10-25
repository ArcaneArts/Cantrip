import type { ExplorerFileMode } from "@cantrip/protocol";
import type { EditorDocumentTransfer } from "@/components/editor/document-session";
import {
  validateExplorerTransfer,
  type ExplorerTransferScope,
} from "./explorer-transfer-state";
import type { ExplorerTransferState } from "./explorer-view";

export interface LegacyDocumentCandidate {
  workerId: string;
  worktreeId: string;
  path: string;
  selected: boolean;
  mode: ExplorerFileMode;
  documents: EditorDocumentTransfer[];
}

export type LegacyDraftChoice = "live" | "recovered";
export class LegacyDraftConflict extends Error {
  constructor(
    readonly live: EditorDocumentTransfer,
    readonly recovered: EditorDocumentTransfer,
  ) {
    super(
      "Legacy migration recovery conflicts with a live draft. Both drafts have been retained.",
    );
  }
}
export type ResolveLegacyDraft = (
  conflict: LegacyDraftConflict,
) => Promise<LegacyDraftChoice | null>;

/** Merge an interrupted migration journal without allowing a fresh disk read
 * to replace an unsaved buffer. Divergent dirty versions need user resolution;
 * neither snapshot may be checkpointed over the other in that case. */
export function mergeLegacyDocumentRecovery(
  live: unknown,
  recovered: unknown,
  scope: ExplorerTransferScope,
  choices: ReadonlyMap<string, LegacyDraftChoice> = new Map(),
): ExplorerTransferState {
  const current = validateExplorerTransfer(live, scope);
  const previous = validateExplorerTransfer(recovered, scope);
  const documents = new Map(
    current.documents.documents.map((document) => [document.id, document]),
  );
  for (const document of previous.documents.documents) {
    const active = documents.get(document.id);
    if (!active) {
      documents.set(document.id, document);
      continue;
    }
    const activeDirty =
      active.text !== active.baselineContent || active.saveFailed;
    const recoveredDirty =
      document.text !== document.baselineContent || document.saveFailed;
    if (
      activeDirty &&
      recoveredDirty &&
      (active.text !== document.text ||
        active.baselineContent !== document.baselineContent ||
        active.version !== document.version)
    ) {
      const choice = choices.get(document.id);
      if (!choice) throw new LegacyDraftConflict(active, document);
      if (choice === "recovered") documents.set(document.id, document);
      continue;
    }
    if (!activeDirty && recoveredDirty) documents.set(document.id, document);
  }
  return {
    ...current,
    documents: { ...current.documents, documents: [...documents.values()] },
  };
}

/** Choices apply only to these validated snapshots, never to a later retry.
 * No persistence occurs until every conflict is resolved and ownership is
 * checked again. Cancellation leaves both inputs unchanged. */
export async function reconcileLegacyDocumentRecovery(
  live: unknown,
  recovered: unknown,
  scope: ExplorerTransferScope,
  resolve: ResolveLegacyDraft | undefined,
  assertCurrent: () => void,
): Promise<ExplorerTransferState> {
  const current = validateExplorerTransfer(live, scope);
  const previous = validateExplorerTransfer(recovered, scope);
  const choices = new Map<string, LegacyDraftChoice>();
  for (;;) {
    assertCurrent();
    try {
      return mergeLegacyDocumentRecovery(current, previous, scope, choices);
    } catch (error) {
      if (!(error instanceof LegacyDraftConflict) || !resolve) throw error;
      const choice = await resolve(error);
      assertCurrent();
      if (choice !== "live" && choice !== "recovered")
        throw new Error(
          "File migration cancelled. Both drafts have been retained.",
        );
      choices.set(error.live.id, choice);
    }
  }
}

/** Partition a captured legacy view without discarding inactive buffers. This
 * does not authorize resources or mutate ownership: the caller must create and
 * checkpoint every document before atomically replacing the legacy binding. */
export function planLegacyDocuments(
  input: unknown,
  scope: ExplorerTransferScope,
): LegacyDocumentCandidate[] {
  if (scope.documentId || scope.documentPath)
    throw new Error("Migration requires a legacy Explorer view.");
  const state = validateExplorerTransfer(input, scope);
  const candidates: LegacyDocumentCandidate[] = [];
  if (state.selectedPath !== null)
    candidates.push({
      workerId: state.workerId,
      worktreeId: state.worktreeId,
      path: state.selectedPath,
      selected: true,
      mode: state.fileMode,
      documents: [],
    });
  for (const document of state.documents.documents) {
    // validateExplorerTransfer checked canonical identity and account/project
    // provenance for every buffer, including those in a previous worktree.
    const [, , workerId, , worktreeId, path] = JSON.parse(
      document.id,
    ) as string[];
    const selected = candidates.find(
      (candidate) =>
        candidate.workerId === workerId &&
        candidate.worktreeId === worktreeId &&
        candidate.path === path,
    );
    if (selected) selected.documents.push(document);
    else
      candidates.push({
        workerId: workerId!,
        worktreeId: worktreeId!,
        path: path!,
        selected: false,
        mode: "edit",
        documents: [document],
      });
  }
  return candidates;
}

/** Rebind a single validated buffer to its immutable document and tab. The
 * original selected tab retains its ID; additional retained files get separate
 * IDs supplied by the migration transaction, not a shared Explorer identity. */
export function bindLegacyDocument(
  candidate: LegacyDocumentCandidate,
  scope: ExplorerTransferScope,
  target: { tabId: string; documentId: string },
): ExplorerTransferState {
  if (!target.tabId || !target.documentId)
    throw new Error("Migration requires explicit tab and document identities.");
  return validateExplorerTransfer(
    {
      explorerId: target.tabId,
      documentId: target.documentId,
      projectId: scope.projectId,
      workerId: candidate.workerId,
      worktreeId: candidate.worktreeId,
      selectedPath: candidate.path,
      fileMode: candidate.mode,
      documents: {
        scope: JSON.stringify([scope.serverId, scope.ownerId]),
        documents: candidate.documents,
      },
    },
    {
      ...scope,
      explorerId: target.tabId,
      documentId: target.documentId,
      documentPath: candidate.path,
      workerId: candidate.workerId,
      worktreeId: candidate.worktreeId,
    },
  );
}
