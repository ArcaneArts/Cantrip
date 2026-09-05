import { useEffect, useState, useSyncExternalStore } from "react";
import { Camera, Monitor, Square } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createComputerUseClient } from "@/lib/computer-use-client";
import { onClientSessionIdentityChanged } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { CursorControls } from "./cursor-controls";
import { previewPointToTarget } from "./preview-coordinates";
import { ComputerUsePreviewController } from "./preview-controller";

export function ComputerUsePreviewPanel({
  controller,
  onReviewApproval,
}: {
  controller: ComputerUsePreviewController;
  onReviewApproval(): void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const active = Boolean(state.lease) && state.phase === "connected";
  const disabled = state.busy || state.stopping || !active;
  const target = state.session?.target;
  const following = state.mode === "agent";
  const selectedSource =
    state.agentSource ??
    state.sources.find((source) => source.sourceId === state.sourceId);
  return (
    <div className="grid min-w-0 gap-4" data-slot="computer-use-preview">
      <label className="grid gap-1 text-xs sm:max-w-xs">
        Preview mode
        <select
          aria-label="Preview mode"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={state.mode}
          disabled={state.stopping || state.phase === "disposed"}
          onChange={(event) =>
            controller.setMode(event.currentTarget.value as "manual" | "agent")
          }
        >
          <option value="manual">Manual preview</option>
          <option value="agent">Follow agent</option>
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            state.busy ||
            state.stopping ||
            state.phase === "disposed" ||
            (state.phase === "stopped" && Boolean(state.lease))
          }
          onClick={() => void controller.connect()}
        >
          {active ? "Refresh connection" : "Connect to agent worker"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={state.stopping || (!state.lease && !state.busy)}
          onClick={() => void controller.stop()}
        >
          <Square aria-hidden="true" className="size-3" />{" "}
          {state.stopping ? "Stopping…" : "Stop computer use"}
        </Button>
        <p role="status" className="text-xs text-muted-foreground">
          {state.busy
            ? "Request in progress…"
            : state.phase === "stopped"
              ? "Preview stopped"
              : following && active
                ? "Latest completed agent observations · refresh explicitly"
                : state.capabilities
                  ? `${state.capabilities.backend} · ${state.capabilities.capture ? "Capture supported" : "Capture unavailable"}`
                  : "The worker is contacted only when you connect."}
        </p>
      </div>
      {!following && active && state.lease ? (
        <dl className="grid min-w-0 gap-1 break-all text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Worker</dt>
            <dd>{state.lease.workerId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Session</dt>
            <dd>{state.session?.binding.sessionId ?? "Not started"}</dd>
          </div>
        </dl>
      ) : null}
      {state.error ? (
        <div
          role="alert"
          className="grid gap-2 rounded-lg border border-destructive/40 p-3 text-sm"
        >
          <p>{state.error.message}</p>
          {state.error.code === "approval-required" ? (
            <>
              <p className="text-muted-foreground">
                Review the request in this chat, then reopen the preview and
                explicitly retry the action. Nothing runs automatically after
                approval.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                onClick={onReviewApproval}
              >
                Review approval in chat
              </Button>
            </>
          ) : following ? (
            <p className="text-xs text-muted-foreground">
              Refresh agent sources and select a currently available
              observation.
            </p>
          ) : state.error.code === "target-not-found" ||
            state.error.code === "stale-target" ? (
            <p className="text-xs text-muted-foreground">
              Refresh targets and select the current window or monitor. No other
              target was captured as a fallback.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Retry the requested action explicitly. If the session ended or the
              worker restarted, Stop and reconnect.
            </p>
          )}
        </div>
      ) : null}
      {following ? (
        <div className="grid min-w-0 gap-3">
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="grid min-w-0 flex-1 basis-full gap-1 text-xs sm:basis-0">
              Agent observation source
              <select
                aria-label="Agent observation source"
                className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
                disabled={!active || state.stopping}
                value={state.sourceId ?? ""}
                onChange={(event) =>
                  void controller.selectSource(event.currentTarget.value)
                }
              >
                <option value="" disabled>
                  Select an agent observation
                </option>
                {state.sources.map((source) => (
                  <option key={source.sourceId} value={source.sourceId}>
                    {source.binding.threadId === source.rootThreadId
                      ? "Root"
                      : "Child"}{" "}
                    {source.binding.threadId} ·{" "}
                    {source.target.title ?? source.target.id} · #
                    {source.observationRevision}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => void controller.refreshSources()}
            >
              Refresh agent sources
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || !state.sourceId}
              onClick={() => void controller.refreshObservation()}
            >
              Refresh observation
            </Button>
          </div>
          {active && !state.sources.length ? (
            <p role="status" className="text-sm text-muted-foreground">
              No completed agent observation is available. Refresh after the
              agent captures a target.
            </p>
          ) : null}
          {selectedSource ? (
            <dl className="grid min-w-0 gap-1 break-all text-xs sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Root thread</dt>
                <dd>{selectedSource.rootThreadId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {selectedSource.binding.threadId ===
                  selectedSource.rootThreadId
                    ? "Root execution thread"
                    : "Child execution thread"}
                </dt>
                <dd>{selectedSource.binding.threadId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Turn</dt>
                <dd>{selectedSource.binding.turnId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Session</dt>
                <dd>{selectedSource.binding.sessionId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Worker</dt>
                <dd>{selectedSource.binding.workerId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Target</dt>
                <dd>
                  {selectedSource.target.title ?? selectedSource.target.id} (
                  {selectedSource.target.id})
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  Last completed observation
                </dt>
                <dd>
                  #{selectedSource.observationRevision} ·{" "}
                  {new Date(selectedSource.observedAtMs).toLocaleString()} ·{" "}
                  {state.observation ? "Displayed" : "Image not loaded"}
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 basis-full gap-1 text-xs sm:basis-0">
            Monitor or window
            <select
              aria-label="Monitor or window"
              className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
              disabled={disabled}
              value={target ? `${target.id}:${target.generation}` : ""}
              onChange={(event) => {
                const next = state.targets.find(
                  (item) =>
                    `${item.id}:${item.generation}` ===
                    event.currentTarget.value,
                );
                if (next) void controller.selectTarget(next);
              }}
            >
              <option value="" disabled>
                Select a target
              </option>
              {target &&
              !state.targets.some(
                (item) =>
                  item.id === target.id &&
                  item.generation === target.generation,
              ) ? (
                <option value={`${target.id}:${target.generation}`}>
                  Attached: {target.title ?? target.id} (outside this page)
                </option>
              ) : null}
              {state.targets.map((item) => (
                <option
                  key={`${item.id}:${item.generation}`}
                  value={`${item.id}:${item.generation}`}
                >
                  {item.kind === "monitor"
                    ? "Monitor"
                    : (item.application ?? "Window")}{" "}
                  — {item.title ?? item.id}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void controller.refreshTargets()}
          >
            Refresh targets
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !target}
            onClick={() => void controller.snapshot()}
          >
            <Camera aria-hidden="true" className="size-4" /> Snapshot
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !target}
            onClick={() => void controller.detach()}
          >
            Detach target
          </Button>
        </div>
      )}
      {!following && active ? (
        <nav
          aria-label="Target pages"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || state.targetPage.after === null}
            onClick={() => void controller.firstTargets()}
          >
            First page
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !state.targetPage.previous.length}
            onClick={() => void controller.previousTargets()}
          >
            Previous page
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !state.targetPage.nextCursor}
            onClick={() => void controller.nextTargets()}
          >
            Next page
          </Button>
          <span className="text-xs text-muted-foreground">
            {state.targets.length} targets on this page
          </span>
        </nav>
      ) : null}
      {!following && state.targetsTruncated ? (
        <p role="status" className="text-xs text-muted-foreground">
          {state.targetPage.nextCursor
            ? "More native targets are available. Use Next page to continue."
            : "Some native targets were omitted because their metadata is unavailable or the inventory reached its size limit."}
        </p>
      ) : null}
      <div
        className={
          following
            ? "grid min-w-0 gap-4"
            : "grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]"
        }
      >
        <div className="grid min-w-0 content-start gap-2">
          <div className="grid min-h-48 place-items-center overflow-hidden rounded-lg border bg-black/30 p-2">
            {state.observation ? (
              <button
                type="button"
                className="block max-w-full cursor-crosshair p-0 disabled:cursor-default"
                disabled={following || disabled || !target}
                aria-label={
                  following
                    ? "Latest completed agent observation"
                    : "Move logical agent cursor on snapshot"
                }
                onClick={(event) => {
                  // The image itself supplies the rect; no object-fit/letterbox or
                  // desktop-origin guessing enters target-local coordinates.
                  if (following) return;
                  const img = event.currentTarget.querySelector("img");
                  if (!img || !target || event.detail === 0) return;
                  const point = previewPointToTarget({
                    clientX: event.clientX,
                    clientY: event.clientY,
                    imageRect: img.getBoundingClientRect(),
                    targetBounds:
                      state.observation!.metadata.session.target!.bounds,
                  });
                  if (point) void controller.move(point);
                }}
              >
                <img
                  src={state.observation.url}
                  alt="Selected worker target with logical agent cursor"
                  draggable={false}
                  className="block h-auto max-h-[50vh] max-w-full"
                />
              </button>
            ) : (
              <p className="px-4 text-center text-sm text-muted-foreground">
                {following
                  ? "Select an agent source to view its latest completed observation. Refresh explicitly for changes."
                  : "Select a target and request a snapshot. Images are not a live video feed."}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {following
              ? "This is the agent’s completed observation. Its cursor is already rendered in the image. Refreshing reads the captured image without requesting another capture."
              : "Click the snapshot to move the logical cursor. No system mouse or keyboard input is sent. The cursor is already rendered in the image."}
          </p>
          {!following && target ? (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>Keyboard cursor movement:</span>
              {(
                [
                  [-10, 0, "Left"],
                  [0, -10, "Up"],
                  [0, 10, "Down"],
                  [10, 0, "Right"],
                ] as const
              ).map(([dx, dy, label]) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => {
                    const position = state.session!.cursor.position;
                    void controller.move({
                      x: Math.max(
                        0,
                        Math.min(target.bounds.width - 0.001, position.x + dx),
                      ),
                      y: Math.max(
                        0,
                        Math.min(target.bounds.height - 0.001, position.y + dy),
                      ),
                    });
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
          {state.observation ? (
            <p className="text-xs text-muted-foreground">
              Snapshot #{state.observation.metadata.session.observationRevision}{" "}
              · {state.observation.metadata.image.width} ×{" "}
              {state.observation.metadata.image.height}
              {state.observation.nativeImage ? (
                <>
                  {" "}
                  rendition · Native {
                    state.observation.nativeImage.width
                  } × {state.observation.nativeImage.height}
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        {!following && state.session ? (
          <CursorControls
            appearance={state.session.cursor.appearance}
            disabled={disabled || !target}
            onChange={(appearance) => void controller.configure(appearance)}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Closing this panel or switching modes preserves the agent execution.
        Manual preview observers share this chat’s manual target and cursor.
        Stop ends computer use for all preview observers and agent executions of
        this chat.
      </p>
    </div>
  );
}

export function ComputerUsePreviewLauncher({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const [controller, setController] =
    useState<ComputerUsePreviewController | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const unsubscribe = onClientSessionIdentityChanged(() => {
      controller?.dispose();
      setController(null);
      setError(null);
    });
    const initial = clientEncryption.getSnapshot();
    const unsubscribeEncryption = clientEncryption.subscribe(() => {
      const current = clientEncryption.getSnapshot();
      if (
        current.status !== "ready" ||
        current.clientId !== initial.clientId ||
        current.masterKeyRevision !== initial.masterKeyRevision
      )
        controller?.encryptionUnavailable();
    });
    return () => {
      unsubscribe();
      unsubscribeEncryption();
      controller?.dispose();
    };
  }, [controller, chatId]);
  const close = () => {
    controller?.dispose();
    setController(null);
  };
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => {
          setError(null);
          try {
            setController(
              new ComputerUsePreviewController(createComputerUseClient(chatId)),
            );
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Computer use could not open.",
            );
          }
        }}
      >
        <Monitor aria-hidden="true" className="size-4" /> Computer use{" "}
        <span className="text-xs text-muted-foreground">Experimental</span>
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog
        open={controller !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="max-w-6xl p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Computer use preview</DialogTitle>
            <DialogDescription>
              Observe the desktop of the worker running this agent. This client
              device is never the capture target.
            </DialogDescription>
          </DialogHeader>
          {controller ? (
            <ComputerUsePreviewPanel
              controller={controller}
              onReviewApproval={() => {
                close();
                // Refresh the existing durable interaction UI; never synthesize an approval.
                void queryClient.invalidateQueries({
                  queryKey: ["agent-requests", chatId],
                });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
