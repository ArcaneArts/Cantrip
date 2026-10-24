import { explorerFileModeSchema } from "@cantrip/protocol";
import type {
  EditorDocumentTransfer,
  EditorSelection,
} from "@/components/editor/document-session";
import type { EditorHistoryState } from "@/components/editor/input-history";
import type { ExplorerTransferState } from "./explorer-view";

export interface ExplorerTransferScope {
  serverId: string;
  ownerId: string;
  explorerId: string;
  projectId: string;
  workerId: string;
  worktreeId: string;
}
const invalid = (): never => {
  throw new Error("Invalid or mismatched editor transfer state.");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}
function integer(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid();
}
function position(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : invalid();
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : invalid();
}
function selection(value: unknown): EditorSelection {
  const item = object(value);
  const start = integer(item.start),
    end = integer(item.end);
  if (
    start > end ||
    !["forward", "backward", "none"].includes(string(item.direction))
  )
    return invalid();
  return {
    start,
    end,
    direction: item.direction as EditorSelection["direction"],
  };
}
function change(value: unknown) {
  const item = object(value);
  const from = integer(item.from),
    to = integer(item.to);
  if (from > to) return invalid();
  return { from, to, insert: string(item.insert) };
}
function history(value: unknown): EditorHistoryState {
  const item = object(value);
  const entries = (value: unknown) =>
    array(value).map((entry) => {
      const item = object(entry);
      return {
        change: change(item.change),
        inverse: change(item.inverse),
        before: selection(item.before),
        after: selection(item.after),
      };
    });
  return { undo: entries(item.undo), redo: entries(item.redo) };
}

/** Copies validated fields only. Account/project provenance applies to inactive
 * drafts too; other retained worktrees remain distinct document identities. */
export function validateExplorerTransfer(
  value: unknown,
  scope: ExplorerTransferScope,
): ExplorerTransferState {
  const state = object(value);
  for (const field of [
    "explorerId",
    "projectId",
    "workerId",
    "worktreeId",
  ] as const)
    if (
      typeof scope[field] !== "string" ||
      !scope[field] ||
      state[field] !== scope[field]
    )
      invalid();
  if (!scope.serverId || !scope.ownerId) invalid();
  const sessions = object(state.documents);
  const accountScope = JSON.stringify([scope.serverId, scope.ownerId]);
  if (sessions.scope !== accountScope) invalid();
  const ids = new Set<string>();
  const documents: EditorDocumentTransfer[] = array(sessions.documents).map(
    (value) => {
      const document = object(value);
      const id = string(document.id);
      let identity: unknown;
      try {
        identity = JSON.parse(id);
      } catch {
        return invalid();
      }
      if (
        !Array.isArray(identity) ||
        identity.length !== 6 ||
        identity.some((part) => typeof part !== "string" || !part) ||
        identity[0] !== scope.serverId ||
        identity[1] !== scope.ownerId ||
        identity[3] !== scope.projectId ||
        JSON.stringify(identity) !== id ||
        ids.has(id)
      )
        return invalid();
      ids.add(id);
      if (typeof document.saveFailed !== "boolean") return invalid();
      return {
        id,
        text: string(document.text),
        baselineContent: string(document.baselineContent),
        version: string(document.version),
        revision: integer(document.revision),
        selection: selection(document.selection),
        scrollTop: position(document.scrollTop),
        scrollLeft: position(document.scrollLeft),
        saveFailed: document.saveFailed,
        history: history(document.history),
      };
    },
  );
  const mode = explorerFileModeSchema.safeParse(state.fileMode);
  if (!mode.success) return invalid();
  const selectedPath =
    state.selectedPath === null ? null : string(state.selectedPath);
  if (selectedPath === "") invalid();
  return {
    explorerId: scope.explorerId,
    projectId: scope.projectId,
    workerId: scope.workerId,
    worktreeId: scope.worktreeId,
    fileMode: mode.data,
    selectedPath,
    documents: { scope: accountScope, documents },
  };
}

export function encodeExplorerTransfer(
  state: ExplorerTransferState,
  scope: ExplorerTransferScope,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      state: validateExplorerTransfer(state, scope),
    }),
  );
}
export function decodeExplorerTransfer(
  bytes: Uint8Array,
  scope: ExplorerTransferScope,
): ExplorerTransferState {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  const envelope = object(value);
  if (envelope.version !== 1) return invalid();
  return validateExplorerTransfer(envelope.state, scope);
}
