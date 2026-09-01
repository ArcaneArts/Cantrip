import type { TerminalSummary } from "@cantrip/protocol";
import { useEffect, useMemo, useRef, useState } from "react";

import { clientLogger } from "@/lib/client-log-relay";
import { cn } from "@/lib/utils";

import { TerminalView } from "./terminal-view";

// Xterm, its addons, and a WorkerLink stay owned here after their visible host
// is parked. Keep the selected terminal plus the eleven most-recent owners so
// a project with abandoned tabs cannot retain browser/transport resources
// without bound.
export const MAX_RETAINED_TERMINAL_VIEWS = 12;

export interface PendingTerminalInput {
  data: string;
  id: string;
  terminalId: string;
}

export function retainTerminalSurfaceTabs(
  retained: readonly TerminalSummary[],
  owned: readonly TerminalSummary[],
  selected: TerminalSummary | null,
  limit = MAX_RETAINED_TERMINAL_VIEWS,
): TerminalSummary[] {
  const available = new Map(
    owned
      .filter((terminal) => terminal.kind !== "run-configuration")
      .map((terminal) => [terminal.id, terminal]),
  );
  if (selected && selected.kind !== "run-configuration") {
    available.set(selected.id, selected);
  }
  const next = retained
    .map((terminal) => available.get(terminal.id))
    .filter((terminal): terminal is TerminalSummary => Boolean(terminal));
  if (selected && selected.kind !== "run-configuration") {
    const existingIndex = next.findIndex(
      (terminal) => terminal.id === selected.id,
    );
    if (existingIndex >= 0) next.splice(existingIndex, 1);
    next.push(selected);
  }
  return next.slice(-Math.max(1, limit));
}

export function PersistentTerminalViews({
  active,
  commandPaletteTerminalId,
  onCommandPaletteOpenChange,
  onLinkedConsoleExit,
  onOpenExternalLink,
  onOpenLink,
  onPendingInputSent,
  onServicePanelOpenChange,
  ownedTerminals,
  pendingInputs,
  selectedTerminal,
  servicePanelTerminalId,
}: {
  active: boolean;
  commandPaletteTerminalId: string | null;
  onCommandPaletteOpenChange(terminalId: string, open: boolean): void;
  onLinkedConsoleExit(chatId: string): void;
  onOpenExternalLink?(url: string): void;
  onOpenLink?(url: string): void;
  onPendingInputSent(inputId: string): void;
  onServicePanelOpenChange(terminalId: string, open: boolean): void;
  ownedTerminals: readonly TerminalSummary[];
  pendingInputs: readonly PendingTerminalInput[];
  selectedTerminal: TerminalSummary | null;
  servicePanelTerminalId: string | null;
}) {
  const [retainedTerminals, setRetainedTerminals] = useState<TerminalSummary[]>(
    () => retainTerminalSurfaceTabs([], ownedTerminals, selectedTerminal),
  );
  const renderedTerminals = useMemo(
    () =>
      retainTerminalSurfaceTabs(
        retainedTerminals,
        ownedTerminals,
        selectedTerminal,
      ),
    [ownedTerminals, retainedTerminals, selectedTerminal],
  );
  const previousOwnershipRef = useRef(new Map<string, TerminalSummary>());

  useEffect(() => {
    setRetainedTerminals((current) =>
      retainTerminalSurfaceTabs(current, ownedTerminals, selectedTerminal),
    );
  }, [ownedTerminals, selectedTerminal]);

  useEffect(() => {
    const current = new Map(
      renderedTerminals.map((terminal) => [terminal.id, terminal]),
    );
    for (const terminal of renderedTerminals) {
      if (previousOwnershipRef.current.has(terminal.id)) continue;
      clientLogger.info("Terminal surface ownership retained", {
        counts: { retainedTerminals: renderedTerminals.length },
        event: "surface.terminal.retention.observed",
        operation: "retain-surface",
        status: "observed",
        subsystem: "terminal",
        surfaceId: terminal.id,
        workerId: terminal.activeWorkerId,
      });
    }
    for (const [terminalId, terminal] of previousOwnershipRef.current) {
      if (current.has(terminalId)) continue;
      const ownershipRemoved = !ownedTerminals.some(
        (candidate) => candidate.id === terminalId,
      );
      clientLogger.info("Terminal surface ownership released", {
        counts: { retainedTerminals: renderedTerminals.length },
        event: "surface.terminal.retention.removed",
        operation: "release-surface",
        reasonCode: ownershipRemoved
          ? "ownership-removed"
          : "retention-capacity-evicted",
        status: "completed",
        subsystem: "terminal",
        surfaceId: terminalId,
        workerId: terminal.activeWorkerId,
      });
    }
    previousOwnershipRef.current = current;
  }, [ownedTerminals, renderedTerminals]);

  return renderedTerminals.map((terminal) => {
    const visible = active && selectedTerminal?.id === terminal.id;
    const linkedChatId = terminal.linkedChatId;
    return (
      <div
        aria-hidden={!visible}
        className={cn("min-h-0 flex-1", visible ? "flex" : "hidden")}
        data-active={visible ? "true" : "false"}
        data-slot="persistent-terminal-surface"
        data-terminal-id={terminal.id}
        key={terminal.id}
      >
        <TerminalView
          commandPaletteOpen={
            visible && commandPaletteTerminalId === terminal.id
          }
          onCommandPaletteOpenChange={
            linkedChatId
              ? undefined
              : (open) => onCommandPaletteOpenChange(terminal.id, open)
          }
          onExit={
            linkedChatId ? () => onLinkedConsoleExit(linkedChatId) : undefined
          }
          onOpenExternalLink={onOpenExternalLink}
          onOpenLink={onOpenLink}
          onPendingInputSent={onPendingInputSent}
          onServicePanelOpenChange={
            linkedChatId
              ? undefined
              : (open) => onServicePanelOpenChange(terminal.id, open)
          }
          pendingInput={
            pendingInputs.find((input) => input.terminalId === terminal.id) ??
            null
          }
          servicePanelOpen={visible && servicePanelTerminalId === terminal.id}
          terminal={terminal}
          visible={visible}
        />
      </div>
    );
  });
}
