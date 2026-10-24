import {
  prepareExplorerTransferBatch,
  stageExplorerTransferBatch,
  type ExplorerTransferEntry,
} from "@/components/explorer/explorer-transfer-batch";
import {
  parseTerminalViewState,
  type TerminalViewState,
} from "@/components/terminal/terminal-view-state";
import type { TerminalTransferLifecycle } from "@/components/terminal/terminal-view";

export interface TerminalTransferEntry {
  tabId: string;
  terminalId: string;
  workerId: string;
  lifecycle: TerminalTransferLifecycle;
}
type ExpectedTerminal = Omit<TerminalTransferEntry, "lifecycle">;
function validateTerminal(
  value: unknown,
  expected: ExpectedTerminal,
): TerminalViewState {
  const state = parseTerminalViewState(value);
  if (
    state.terminalId !== expected.terminalId ||
    state.workerId !== expected.workerId
  )
    throw new Error(
      "Transferred terminal session does not match its reservation.",
    );
  return state;
}

export function stageWorkspaceViewTransferBatch(
  bytes: Uint8Array,
  editors: readonly Pick<ExplorerTransferEntry, "tabId" | "scope">[],
  terminals: readonly ExpectedTerminal[],
) {
  const editorStates = stageExplorerTransferBatch(bytes, editors);
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  const incoming: unknown = payload.terminals ?? [];
  if (!Array.isArray(incoming) || incoming.length !== terminals.length)
    throw new Error("Invalid terminal transfer batch.");
  const ids = new Set(editorStates.map(({ tabId }) => tabId));
  const terminalStates = terminals.map((expected) => {
    if (ids.has(expected.tabId))
      throw new Error("Duplicate transfer tab identity.");
    ids.add(expected.tabId);
    const matches = incoming.filter(
      (item) =>
        item && typeof item === "object" && item.tabId === expected.tabId,
    );
    if (matches.length !== 1)
      throw new Error("Invalid terminal transfer batch.");
    return {
      tabId: expected.tabId,
      state: validateTerminal(matches[0].state, expected),
    };
  });
  return { editors: editorStates, terminals: terminalStates };
}

/** One encrypted envelope and one suspension lifetime for a mixed pane. */
export function prepareWorkspaceViewTransferBatch(
  editors: readonly ExplorerTransferEntry[],
  terminals: readonly TerminalTransferEntry[],
) {
  const entries = terminals.map((entry) => ({ ...entry }));
  const ids = new Set(editors.map(({ tabId }) => tabId));
  for (const entry of entries) {
    if (!entry.tabId || ids.has(entry.tabId))
      throw new Error("Duplicate transfer tab identity.");
    ids.add(entry.tabId);
  }
  const editorBatch = prepareExplorerTransferBatch(editors);
  const releases: (() => void)[] = [];
  const retired = new Set<string>();
  let released = false;
  let captured = false;
  const resume = () => {
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
    try {
      editorBatch.resume();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Workspace view suspensions could not be released.",
      );
  };
  try {
    for (const entry of entries)
      releases.push(entry.lifecycle.suspendTransfer());
  } catch (error) {
    try {
      resume();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Workspace transfer preparation and recovery failed.",
      );
    }
    throw error;
  }
  return {
    resume,
    async captureBytes() {
      if (released) throw new Error("Workspace transfer batch was released.");
      const editorStates = await editorBatch.capture();
      const terminalStates = [];
      for (const entry of entries) {
        const state = validateTerminal(
          await entry.lifecycle.captureTransfer(),
          entry,
        );
        if (released)
          throw new Error(
            "Workspace transfer batch was released during capture.",
          );
        terminalStates.push({ tabId: entry.tabId, state });
      }
      if (released)
        throw new Error(
          "Workspace transfer batch was released during capture.",
        );
      captured = true;
      return new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          editors: editorStates,
          terminals: terminalStates,
        }),
      );
    },
    async retire() {
      if (released || !captured)
        throw new Error("Capture workspace state before retirement.");
      editorBatch.retire();
      for (const entry of entries) {
        if (retired.has(entry.tabId)) continue;
        await entry.lifecycle.retireTransfer();
        retired.add(entry.tabId);
        if (released)
          throw new Error(
            "Workspace transfer batch was released during retirement.",
          );
      }
    },
  };
}
