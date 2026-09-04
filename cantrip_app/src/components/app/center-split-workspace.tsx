import { useDndContext, useDroppable } from "@dnd-kit/core";
import type { ProjectPaneSummary } from "@cantrip/protocol";
import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  centerSplitFractionForKey,
  type CenterLayoutNode,
  type CenterPaneEdge,
  type CenterSplitDirection,
} from "@/components/app/center-split-layout";
import type { VisibleProjectPane } from "@/components/app/project-workspace-frame-model";
import { cn } from "@/lib/utils";
import {
  type WorkspaceDndData,
  workspacePaneEdgeDropId,
} from "@/lib/workspace-dnd-model";

function CenterPaneEdgeDropTarget({
  active,
  edge,
  pane,
}: {
  active: boolean;
  edge: CenterPaneEdge;
  pane: ProjectPaneSummary;
}) {
  const drop = useDroppable({
    id: workspacePaneEdgeDropId(pane.id, edge),
    disabled: !active,
    data: {
      drop: {
        edge,
        paneId: pane.id,
        projectId: pane.projectId,
        type: "pane-edge",
      },
    } satisfies WorkspaceDndData,
  });
  return (
    <div
      aria-hidden="true"
      className={cn(
        "absolute z-50 rounded border border-transparent transition-colors",
        edge === "left" && "bottom-1/4 left-0 top-1/4 w-1/4",
        edge === "right" && "bottom-1/4 right-0 top-1/4 w-1/4",
        edge === "top" && "left-1/4 right-1/4 top-0 h-1/4",
        edge === "bottom" && "bottom-0 left-1/4 right-1/4 h-1/4",
        active ? "pointer-events-auto" : "pointer-events-none",
        drop.isOver && "border-primary bg-primary/20",
      )}
      data-center-pane-edge={edge}
      data-center-pane-edge-active={drop.isOver ? "true" : "false"}
      ref={drop.setNodeRef}
    />
  );
}

function CenterPaneEdgeDropTargets({
  enabled,
  pane,
}: {
  enabled: boolean;
  pane: ProjectPaneSummary;
}) {
  const { active } = useDndContext();
  const drag = (active?.data.current as WorkspaceDndData | undefined)?.drag;
  const acceptsCenter =
    enabled &&
    drag?.type === "surface" &&
    (drag.supportedRegions === undefined ||
      drag.supportedRegions.includes("center"));
  return (
    <>
      {(["left", "right", "top", "bottom"] as const).map((edge) => (
        <CenterPaneEdgeDropTarget
          active={acceptsCenter}
          edge={edge}
          key={edge}
          pane={pane}
        />
      ))}
    </>
  );
}

function CenterSplitDivider({
  direction,
  disabled,
  fraction,
  onCommit,
  onPreview,
  splitId,
}: {
  direction: CenterSplitDirection;
  disabled: boolean;
  fraction: number;
  onCommit(fraction: number): void;
  onPreview(fraction: number | null): void;
  splitId: string;
}) {
  const resize = useRef<{
    bounds: DOMRect;
    latestFraction: number;
    pointerId: number;
  } | null>(null);
  const finish = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = resize.current;
    if (!current || current.pointerId !== event.pointerId) return;
    resize.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onPreview(null);
    if (commit && current.latestFraction !== fraction) {
      onCommit(current.latestFraction);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = centerSplitFractionForKey(direction, fraction, event.key);
    if (next === null || disabled) return;
    event.preventDefault();
    onCommit(next);
  };
  return (
    <div
      aria-label={`${direction === "horizontal" ? "Horizontal" : "Vertical"} center split size`}
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      aria-valuemax={90}
      aria-valuemin={10}
      aria-valuenow={Math.round(fraction * 100)}
      className={cn(
        "group relative z-30 bg-border outline-none focus-visible:bg-ring",
        direction === "horizontal" ? "cursor-col-resize" : "cursor-row-resize",
        disabled && "cursor-default opacity-60",
      )}
      data-center-split-resize={splitId}
      onDoubleClick={() => !disabled && onCommit(0.5)}
      onKeyDown={onKeyDown}
      onLostPointerCapture={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onPointerDown={(event) => {
        if (disabled) return;
        const bounds =
          event.currentTarget.parentElement?.getBoundingClientRect();
        if (!bounds) return;
        resize.current = {
          bounds,
          latestFraction: fraction,
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const current = resize.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const raw =
          direction === "horizontal"
            ? (event.clientX - current.bounds.left) / current.bounds.width
            : (event.clientY - current.bounds.top) / current.bounds.height;
        const next = Math.max(0.1, Math.min(0.9, raw));
        current.latestFraction = next;
        onPreview(next);
      }}
      onPointerUp={(event) => finish(event, true)}
      role="separator"
      tabIndex={disabled ? -1 : 0}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute bg-primary/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          direction === "horizontal"
            ? "inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
            : "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
        )}
      />
    </div>
  );
}

function CenterSplitNode({
  controlsEnabled,
  node,
  onResize,
  presentationByPaneId,
  renderPaneBody,
  renderTabStrip,
}: {
  controlsEnabled: boolean;
  node: CenterLayoutNode;
  onResize(splitId: string, fraction: number): void;
  presentationByPaneId: ReadonlyMap<string, VisibleProjectPane>;
  renderPaneBody(presentation: VisibleProjectPane): ReactNode;
  renderTabStrip(presentation: VisibleProjectPane): ReactNode;
}) {
  const [previewFraction, setPreviewFraction] = useState<number | null>(null);
  const paneId = node.kind === "pane" ? node.paneId : null;
  const portalTarget = paneId && presentationByPaneId.get(paneId)?.portalTarget;
  const attachPortalTarget = useCallback(
    (host: HTMLDivElement | null) => {
      if (host && portalTarget && portalTarget.parentElement !== host) {
        host.appendChild(portalTarget);
      }
    },
    [portalTarget],
  );
  if (node.kind === "pane") {
    const presentation = presentationByPaneId.get(node.paneId);
    if (!presentation) return null;
    return (
      <section
        className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
        data-center-pane={node.paneId}
        data-project-pane-id={node.paneId}
        key={node.paneId}
      >
        {renderTabStrip(presentation)}
        <div
          className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          data-center-pane-body={node.paneId}
          ref={attachPortalTarget}
        >
          {renderPaneBody(presentation)}
        </div>
        <CenterPaneEdgeDropTargets
          enabled={controlsEnabled}
          pane={presentation.pane}
        />
      </section>
    );
  }
  const fraction = previewFraction ?? node.fraction;
  const horizontal = node.direction === "horizontal";
  const childProps = {
    controlsEnabled,
    onResize,
    presentationByPaneId,
    renderPaneBody,
    renderTabStrip,
  };
  return (
    <div
      className="grid min-h-0 min-w-0 overflow-hidden"
      data-center-split={node.id}
      style={
        horizontal
          ? {
              gridTemplateColumns: `minmax(0, calc(${fraction * 100}% - 3px)) 6px minmax(0, calc(${(1 - fraction) * 100}% - 3px))`,
              gridTemplateRows: "minmax(0, 1fr)",
            }
          : {
              gridTemplateColumns: "minmax(0, 1fr)",
              gridTemplateRows: `minmax(0, calc(${fraction * 100}% - 3px)) 6px minmax(0, calc(${(1 - fraction) * 100}% - 3px))`,
            }
      }
    >
      <CenterSplitNode
        key={node.first.kind === "pane" ? node.first.paneId : node.first.id}
        node={node.first}
        {...childProps}
      />
      <CenterSplitDivider
        direction={node.direction}
        disabled={!controlsEnabled}
        fraction={fraction}
        onCommit={(next) => onResize(node.id, next)}
        onPreview={setPreviewFraction}
        splitId={node.id}
      />
      <CenterSplitNode
        key={node.second.kind === "pane" ? node.second.paneId : node.second.id}
        node={node.second}
        {...childProps}
      />
    </div>
  );
}

export function CenterSplitWorkspace(
  props: Parameters<typeof CenterSplitNode>[0],
) {
  return <CenterSplitNode {...props} />;
}
