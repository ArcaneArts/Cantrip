import type {
  ExplorerLifecycleActions,
  ExplorerTransferState,
} from "./explorer-view";
import {
  validateExplorerTransfer,
  type ExplorerTransferScope,
} from "./explorer-transfer-state";

export interface ExplorerTransferEntry {
  tabId: string;
  scope: ExplorerTransferScope;
  lifecycle: Pick<
    ExplorerLifecycleActions,
    "suspendTransfer" | "captureTransfer" | "retireTransfer"
  >;
}

export interface ExplorerTransferSnapshot {
  tabId: string;
  state: ExplorerTransferState;
}

/** Validate the entire private payload before exposing any view for installation.
 * Expected identities must come from the authorized reservation and resources,
 * never from fields supplied by the sender. No editor is mounted or mutated here. */
export function stageExplorerTransferBatch(
  bytes: Uint8Array,
  expected: readonly Pick<ExplorerTransferEntry, "tabId" | "scope">[],
): ExplorerTransferSnapshot[] {
  const invalid = (): never => {
    throw new Error("Invalid editor transfer batch.");
  };
  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return invalid();
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("version" in payload) ||
    payload.version !== 1 ||
    !("editors" in payload) ||
    !Array.isArray(payload.editors) ||
    payload.editors.length !== expected.length
  )
    return invalid();
  const incoming = new Map<string, unknown>();
  for (const item of payload.editors) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.tabId !== "string" ||
      !item.tabId ||
      incoming.has(item.tabId)
    )
      return invalid();
    incoming.set(item.tabId, item.state);
  }
  const staged: ExplorerTransferSnapshot[] = [];
  for (const { tabId, scope } of expected) {
    if (!incoming.has(tabId)) return invalid();
    staged.push({
      tabId,
      state: validateExplorerTransfer(incoming.get(tabId), scope),
    });
    incoming.delete(tabId);
  }
  if (incoming.size) return invalid();
  return staged;
}

/** Acquires all editor suspensions before capturing any draft. The shell must
 * retain this batch until ownership commits or cancellation is acknowledged.
 * Snapshots are private endpoint state, never layout metadata. */
export function prepareExplorerTransferBatch(
  entries: readonly ExplorerTransferEntry[],
) {
  const capturedEntries = entries.map((entry) => ({
    ...entry,
    scope: { ...entry.scope },
  }));
  const ids = new Set<string>();
  const releases: (() => void)[] = [];
  let released = false;
  let captured = false;
  const retired = new Set<string>();
  const resume = () => {
    if (released && releases.length === 0) return;
    released = true;
    const errors: unknown[] = [];
    for (const release of releases.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        errors.push(error);
        releases.unshift(release);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Some editor suspensions could not be released.",
      );
  };
  try {
    for (const entry of capturedEntries) {
      if (!entry.tabId || ids.has(entry.tabId))
        throw new Error("Duplicate or missing transfer tab identity.");
      ids.add(entry.tabId);
      if (
        !entry.lifecycle.suspendTransfer ||
        !entry.lifecycle.captureTransfer ||
        !entry.lifecycle.retireTransfer
      )
        throw new Error("Editor transfer lifecycle is not attached.");
      releases.push(entry.lifecycle.suspendTransfer());
    }
  } catch (error) {
    try {
      resume();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Editor transfer preparation and recovery failed.",
      );
    }
    throw error;
  }
  const capture = async (): Promise<ExplorerTransferSnapshot[]> => {
    if (released) throw new Error("Editor transfer batch was released.");
    const snapshots = [];
    for (const entry of capturedEntries) {
      const state = await entry.lifecycle.captureTransfer!();
      if (released)
        throw new Error("Editor transfer batch was released during capture.");
      snapshots.push({
        tabId: entry.tabId,
        state: validateExplorerTransfer(state, entry.scope),
      });
    }
    captured = true;
    return snapshots;
  };
  return {
    resume,
    capture,
    retire() {
      if (released) throw new Error("Editor transfer batch was released.");
      if (!captured) throw new Error("Capture editor state before retirement.");
      for (const entry of capturedEntries) {
        if (retired.has(entry.tabId)) continue;
        entry.lifecycle.retireTransfer!();
        retired.add(entry.tabId);
      }
    },
    /** Plaintext bytes are ephemeral: pass only to the encrypted channel and
     * clear them after sending. Never persist this envelope in layout state. */
    async captureBytes(): Promise<Uint8Array> {
      return new TextEncoder().encode(
        JSON.stringify({ version: 1, editors: await capture() }),
      );
    },
  };
}
