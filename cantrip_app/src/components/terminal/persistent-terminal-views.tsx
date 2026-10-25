import type { TerminalSummary } from "@cantrip/protocol";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PersistentSurfacePortal } from "@/components/app/persistent-surface-portal";
import { clientLogger } from "@/lib/client-log-relay";
import { cn } from "@/lib/utils";

import { LinkedConsoleControls } from "./linked-console-controls";
import { TerminalView, type TerminalTransferStaging } from "./terminal-view";
import type { TerminalViewState } from "./terminal-view-state";

// Xterm, its addons, and a WorkerLink stay owned here after their visible host
// is parked. Keep the selected terminal plus the eleven most-recent owners so
// a project with abandoned tabs cannot retain browser/transport resources
// without bound.
export const MAX_RETAINED_TERMINAL_VIEWS = 12;
const EMPTY_EXCLUDED_TERMINAL_IDS: ReadonlySet<string> = new Set();
interface IncomingTerminalView {
  tabId: string;
  terminal: TerminalSummary;
  state: TerminalViewState;
  staging?: TerminalTransferStaging;
}
const EMPTY_INCOMING: readonly IncomingTerminalView[] = [];

function ownedTerminalViews(
  known: readonly TerminalSummary[],
  resolved: readonly TerminalSummary[],
  tabIds: ReadonlyMap<string, string>,
  excludedIds: ReadonlySet<string>,
): TerminalSummary[] {
  const terminals = new Map(
    resolved.map((terminal) => [terminal.id, terminal]),
  );
  for (const terminal of known)
    if (tabIds.has(terminal.id) && !terminals.has(terminal.id))
      terminals.set(terminal.id, terminal);
  return [...terminals.values()].filter(
    (terminal) =>
      !excludedIds.has(terminal.id) && terminal.kind !== "run-configuration",
  );
}

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
  renderAgentActions,
  selectedTerminal,
  servicePanelTerminalId,
  visiblePlacements,
  excludedIds = EMPTY_EXCLUDED_TERMINAL_IDS,
  transferTabIds: providedTransferTabIds,
  initialTransfers,
  incomingViews = EMPTY_INCOMING,
}: {
  active: boolean;
  transferTabIds?: ReadonlyMap<string, string>;
  initialTransfers?: ReadonlyMap<string, TerminalViewState>;
  incomingViews?: readonly IncomingTerminalView[];
  commandPaletteTerminalId: string | null;
  onCommandPaletteOpenChange(terminalId: string, open: boolean): void;
  onLinkedConsoleExit(chatId: string): void;
  onOpenExternalLink?(url: string): void;
  onOpenLink?(url: string): void;
  onPendingInputSent(inputId: string): void;
  onServicePanelOpenChange(terminalId: string, open: boolean): void;
  ownedTerminals: readonly TerminalSummary[];
  pendingInputs: readonly PendingTerminalInput[];
  renderAgentActions?(chatId: string): ReactNode;
  selectedTerminal: TerminalSummary | null;
  servicePanelTerminalId: string | null;
  excludedIds?: ReadonlySet<string>;
  visiblePlacements?: readonly {
    focused: boolean;
    gridArea: string;
    paneId: string;
    portalTarget?: Element | null;
    terminal: TerminalSummary;
  }[];
}) {
  const transferTabIds = useMemo(
    () =>
      incomingViews.length
        ? new Map([
            ...(providedTransferTabIds ?? []),
            ...incomingViews.map(
              (view) => [view.terminal.id, view.tabId] as const,
            ),
          ])
        : providedTransferTabIds,
    [providedTransferTabIds, incomingViews],
  );
  const incomingById = new Map(
    incomingViews.map((view) => [view.terminal.id, view]),
  );
  const visibleTerminals = useMemo(
    () =>
      (visiblePlacements?.map(({ terminal }) => terminal) ?? []).filter(
        ({ id }) => !excludedIds.has(id),
      ),
    [excludedIds, visiblePlacements],
  );
  const availableOwnedTerminals = useMemo(
    () =>
      [
        ...new Map(
          [
            ...ownedTerminals,
            ...incomingViews.map((view) => view.terminal),
          ].map((terminal) => [terminal.id, terminal]),
        ).values(),
      ].filter(({ id }) => !excludedIds.has(id)),
    [excludedIds, ownedTerminals, incomingViews],
  );
  const availableSelectedTerminal =
    selectedTerminal && !excludedIds.has(selectedTerminal.id)
      ? selectedTerminal
      : null;
  const [retainedTerminals, setRetainedTerminals] = useState<TerminalSummary[]>(
    () =>
      visibleTerminals.reduce(
        (retained, terminal) =>
          retainTerminalSurfaceTabs(
            retained,
            availableOwnedTerminals,
            terminal,
          ),
        retainTerminalSurfaceTabs(
          [],
          availableOwnedTerminals,
          availableSelectedTerminal,
        ),
      ),
  );
  const renderedTerminals = useMemo(
    () =>
      transferTabIds
        ? ownedTerminalViews(
            retainedTerminals,
            availableOwnedTerminals,
            transferTabIds,
            excludedIds,
          )
        : visibleTerminals.reduce(
            (retained, terminal) =>
              retainTerminalSurfaceTabs(
                retained,
                availableOwnedTerminals,
                terminal,
              ),
            retainTerminalSurfaceTabs(
              retainedTerminals,
              availableOwnedTerminals,
              availableSelectedTerminal,
            ),
          ),
    [
      availableOwnedTerminals,
      availableSelectedTerminal,
      retainedTerminals,
      visibleTerminals,
      transferTabIds,
      excludedIds,
    ],
  );
  const previousOwnershipRef = useRef(new Map<string, TerminalSummary>());

  useEffect(() => {
    if (transferTabIds) {
      setRetainedTerminals((current) =>
        ownedTerminalViews(
          current,
          availableOwnedTerminals,
          transferTabIds,
          excludedIds,
        ),
      );
      return;
    }
    setRetainedTerminals((current) =>
      visibleTerminals.reduce(
        (retained, terminal) =>
          retainTerminalSurfaceTabs(
            retained,
            availableOwnedTerminals,
            terminal,
          ),
        retainTerminalSurfaceTabs(
          current,
          availableOwnedTerminals,
          availableSelectedTerminal,
        ),
      ),
    );
  }, [
    availableOwnedTerminals,
    availableSelectedTerminal,
    visibleTerminals,
    transferTabIds,
    excludedIds,
  ]);

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
      const ownershipRemoved = !availableOwnedTerminals.some(
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
  }, [availableOwnedTerminals, renderedTerminals]);
  const placementById = new Map(
    visiblePlacements?.map((placement) => [placement.terminal.id, placement]) ??
      [],
  );

  return renderedTerminals.map((terminal) => {
    const placement = placementById.get(terminal.id);
    const visible = visiblePlacements
      ? Boolean(placement && placement.portalTarget !== null)
      : active && selectedTerminal?.id === terminal.id;
    const linkedChatId = terminal.linkedChatId;
    const owner = (
      <div
        aria-hidden={!visible}
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          visible ? "flex" : "hidden",
        )}
        data-active={visible ? "true" : "false"}
        data-slot="persistent-terminal-surface"
        data-terminal-id={terminal.id}
        data-project-pane-id={placement?.paneId}
        key={terminal.id}
        style={placement ? { gridArea: placement.gridArea } : undefined}
      >
        {visible && linkedChatId ? (
          <LinkedConsoleControls
            key={linkedChatId}
            actions={renderAgentActions?.(linkedChatId)}
            chatId={linkedChatId}
            projectId={terminal.projectId}
          />
        ) : null}
        <TerminalView
          transferStaging={incomingById.get(terminal.id)?.staging}
          initialViewState={
            incomingById.get(terminal.id)?.state ??
            initialTransfers?.get(transferTabIds?.get(terminal.id) ?? "")
          }
          transferTabId={transferTabIds?.get(terminal.id)}
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
    return visiblePlacements ? (
      <PersistentSurfacePortal
        host={placement?.portalTarget ?? null}
        key={terminal.id}
        portalKey={terminal.id}
      >
        {owner}
      </PersistentSurfacePortal>
    ) : (
      owner
    );
  });
}
