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
  return (
    <div className="grid min-w-0 gap-4" data-slot="computer-use-preview">
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
              : state.capabilities
                ? `${state.capabilities.backend} · ${state.capabilities.capture ? "Capture supported" : "Capture unavailable"}`
                : "The worker is contacted only when you connect."}
        </p>
      </div>
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
          ) : (
            <p className="text-xs text-muted-foreground">
              Retry the requested action explicitly. If the session ended or the
              worker restarted, Stop and reconnect.
            </p>
          )}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-xs">
          Monitor or window
          <select
            aria-label="Monitor or window"
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
            disabled={disabled}
            value={target ? `${target.id}:${target.generation}` : ""}
            onChange={(event) => {
              const next = state.targets.find(
                (item) =>
                  `${item.id}:${item.generation}` === event.currentTarget.value,
              );
              if (next) void controller.selectTarget(next);
            }}
          >
            <option value="" disabled>
              Select a target
            </option>
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
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="grid min-w-0 content-start gap-2">
          <div className="grid min-h-48 place-items-center overflow-hidden rounded-lg border bg-black/30 p-2">
            {state.observation ? (
              <button
                type="button"
                className="block max-w-full cursor-crosshair p-0 disabled:cursor-default"
                disabled={disabled || !target}
                aria-label="Move logical agent cursor on snapshot"
                onClick={(event) => {
                  // The image itself supplies the rect; no object-fit/letterbox or
                  // desktop-origin guessing enters target-local coordinates.
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
                Select a target and request a snapshot. Images are not a live
                video feed.
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Click the snapshot to move the logical cursor. No system mouse or
            keyboard input is sent. The cursor is already rendered in the image.
          </p>
          {target ? (
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
            </p>
          ) : null}
        </div>
        {state.session ? (
          <CursorControls
            appearance={state.session.cursor.appearance}
            disabled={disabled || !target}
            onChange={(appearance) => void controller.configure(appearance)}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Observers share this chat’s target and cursor. Closing this panel leaves
        the session available; Stop ends computer use for all preview observers
        of this chat.
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
