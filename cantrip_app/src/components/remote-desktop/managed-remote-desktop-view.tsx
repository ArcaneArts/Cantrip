import {
  remoteDesktopClientMessageSchema,
  remoteDesktopServerMessageSchema,
  type RemoteDesktopClientMessage,
  type RemoteDesktopSummary,
  type RemoteDesktopTarget,
  type RemoteDesktopTargetInventory,
} from "@cantrip/protocol";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Check,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Loader2,
  MonitorUp,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  RemoteSurfaceCanvas,
  type RemoteSurfaceCanvasHandle,
} from "@/components/remote-surface/remote-surface-canvas";
import { Button } from "@/components/ui/button";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import {
  remoteSurfaceWebSocketUrl,
  updateRemoteDesktopTarget,
} from "@/lib/api";
import {
  forwardRemoteSurfaceClipboard,
  remoteSurfacePointerCoordinates,
} from "@/lib/remote-surface-input";
import {
  useRemoteSurfaceTransport,
  type RemoteSurfaceFrameContext,
  type RemoteSurfaceInboundFrame,
} from "@/lib/use-remote-surface-transport";
import { cn } from "@/lib/utils";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const desktopTransportMessages = {
  closeReason: "Remote Desktop view closed",
  congestionReason: "Remote Desktop connection is congested",
  connectionError: "Could not connect to the worker Remote Desktop.",
  invalidConnectionMessage:
    "The server sent an invalid Remote Desktop connection message.",
  invalidFrame: "The server sent an invalid Remote Desktop frame.",
};
const menuContentClass =
  "z-50 max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] min-w-80 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg";
const menuItemClass =
  "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

interface Size {
  height: number;
  width: number;
}

export function fitDesktopSize(container: Size, desktop: Size): Size {
  const scale = Math.min(
    container.width / desktop.width,
    container.height / desktop.height,
  );
  return {
    width: Math.max(1, Math.floor(desktop.width * scale)),
    height: Math.max(1, Math.floor(desktop.height * scale)),
  };
}

export function desktopPointerCoordinates(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "height" | "left" | "top" | "width">,
  desktop: Size,
) {
  return remoteSurfacePointerCoordinates(point, bounds, desktop, "last-pixel");
}

export function remoteDesktopTargetMatches(
  left: RemoteDesktopTarget,
  right: RemoteDesktopTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "monitor" && right.kind === "monitor") {
    return (
      (Boolean(left.id) && left.id === right.id) ||
      (Boolean(left.name) && left.name === right.name) ||
      (!left.id && !left.name)
    );
  }
  if (left.kind === "window" && right.kind === "window") {
    return (
      (Boolean(left.id) && left.id === right.id) ||
      (Boolean(left.title) &&
        left.application === right.application &&
        left.title === right.title) ||
      (!left.id && !left.title && left.application === right.application)
    );
  }
  return false;
}

export function remoteDesktopTargetLabel(target: RemoteDesktopTarget): string {
  if (target.kind === "monitor") return target.name ?? "Primary display";
  return target.title
    ? `${target.application} — ${target.title}`
    : target.application;
}

export function ManagedRemoteDesktopView({
  desktop,
}: {
  desktop: RemoteDesktopSummary;
}) {
  const queryClient = useQueryClient();
  const remoteCanvasRef = useRef<RemoteSurfaceCanvasHandle>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef({
    width: 1_280,
    height: 720,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  const desktopSizeRef = useRef<Size>({ width: 1_920, height: 1_080 });
  const [desktopSize, setDesktopSize] = useState(desktopSizeRef.current);
  const [canvasSize, setCanvasSize] = useState<Size>({
    width: 1_280,
    height: 720,
  });
  const [runtimeStatus, setRuntimeStatus] = useState<
    "ready" | "launching" | "suspended" | "error"
  >("ready");
  const [notice, setNotice] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<{
    backend: "native" | "compatibility";
    encodedWidth: number;
    observedFps: number;
    quality: number;
    targetFps: number;
  } | null>(null);
  const [targetInventory, setTargetInventory] =
    useState<RemoteDesktopTargetInventory>({ monitors: [], windows: [] });
  const [requestedTarget, setRequestedTarget] = useState(desktop.target);
  const [activeTarget, setActiveTarget] = useState(desktop.target);
  const [launchingApplication, setLaunchingApplication] = useState<
    string | null
  >(null);
  const [targetMessage, setTargetMessage] = useState<string | null>(null);
  const [renderedSurfaceId, setRenderedSurfaceId] = useState<string | null>(
    null,
  );
  const surfaceReady = renderedSurfaceId === desktop.id;

  const updateTarget = useMutation({
    mutationFn: (target: RemoteDesktopTarget) =>
      updateRemoteDesktopTarget(desktop.id, target),
    onMutate: (target) => {
      const previous = requestedTarget;
      setRequestedTarget(target);
      return { previous };
    },
    onError: (_error, _target, context) => {
      if (context?.previous) setRequestedTarget(context.previous);
    },
    onSuccess: (updated) => {
      setRequestedTarget(updated.target);
      queryClient.setQueryData(["remote-desktop", desktop.id], updated);
    },
  });

  function handleFrame(
    frame: RemoteSurfaceInboundFrame,
    context: RemoteSurfaceFrameContext,
  ): void {
    if (frame.header.channel === "frame") {
      remoteCanvasRef.current?.pushFrame(frame.payload);
      return;
    }
    if (
      frame.header.channel !== "control" &&
      frame.header.channel !== "clipboard"
    ) {
      return;
    }
    const message = remoteDesktopServerMessageSchema.parse(
      JSON.parse(decoder.decode(frame.payload)),
    );
    if (message.type === "desktop-state") {
      const nextSize = { width: message.width, height: message.height };
      desktopSizeRef.current = nextSize;
      setDesktopSize(nextSize);
      setRuntimeStatus(message.status);
      context.reportError(message.status === "error" ? message.message : null);
      setStreamStatus(message.stream);
    } else if (message.type === "desktop-targets") {
      setTargetInventory(message.inventory);
      setRequestedTarget(message.requested);
      setActiveTarget(message.active);
      setLaunchingApplication(message.launchingApplication);
      setTargetMessage(message.message);
    } else {
      void navigator.clipboard.writeText(message.text).then(
        () => {
          if (context.isCurrent()) setNotice("Remote clipboard copied");
        },
        () => {
          if (context.isCurrent()) {
            setNotice("Clipboard access was denied by this app environment.");
          }
        },
      );
    }
  }

  const { connectionState, error, retry, sendFrame, setError, transportState } =
    useRemoteSurfaceTransport({
      surfaceId: desktop.id,
      webSocketUrl: () =>
        remoteSurfaceWebSocketUrl(desktop.id, viewportRef.current),
      messages: desktopTransportMessages,
      onConnecting: () => {
        remoteCanvasRef.current?.reset();
        setStreamStatus(null);
        setLaunchingApplication(null);
        setTargetMessage(null);
      },
      onFrame: handleFrame,
    });

  const send = useCallback(
    (message: RemoteDesktopClientMessage) =>
      sendFrame(
        "control",
        encoder.encode(
          JSON.stringify(remoteDesktopClientMessageSchema.parse(message)),
        ),
      ),
    [sendFrame],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setRequestedTarget(desktop.target);
  }, [desktop.target]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const resize = () => {
      const bounds = surface.getBoundingClientRect();
      const container = {
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      };
      viewportRef.current = {
        ...container,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      setCanvasSize(fitDesktopSize(container, desktopSizeRef.current));
      send({ type: "viewport", viewport: viewportRef.current });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [desktopSize, send]);

  useEffect(() => {
    if (connectionState === "ready") {
      send({ type: "viewport", viewport: viewportRef.current });
    }
  }, [connectionState, send]);

  useEffect(() => {
    const feedbackTimer = setInterval(() => {
      const feedback = remoteCanvasRef.current?.takeFrameFeedback();
      if (!feedback) return;
      send({
        type: "stream-feedback",
        ...feedback,
      });
    }, 2_000);
    return () => clearInterval(feedbackTimer);
  }, [send]);

  const pasteClipboard = async () => {
    setNotice(
      await forwardRemoteSurfaceClipboard((text) =>
        send({ type: "clipboard", operation: "paste-text", text }),
      ),
    );
  };
  const inventoryTargets: RemoteDesktopTarget[] = [
    ...targetInventory.monitors.map((monitor) => ({
      kind: "monitor" as const,
      id: monitor.id,
      name: monitor.name,
    })),
    ...targetInventory.windows.map((window) => ({
      kind: "window" as const,
      id: window.id,
      application: window.application,
      title: window.title,
    })),
  ];
  const requestedTargetListed =
    requestedTarget.kind === "monitor" &&
    !requestedTarget.id &&
    !requestedTarget.name
      ? targetInventory.monitors.some((monitor) => monitor.primary)
      : inventoryTargets.some((target) =>
          remoteDesktopTargetMatches(requestedTarget, target),
        );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 bg-background px-3">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <MonitorUp className="size-4 shrink-0" />
          <span className="truncate">
            {desktopSize.width} × {desktopSize.height} · project worker
            {streamStatus
              ? ` · ${Math.round(streamStatus.observedFps)} / ${streamStatus.targetFps} FPS · ${streamStatus.backend}`
              : ""}
          </span>
        </div>
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 max-w-[min(26rem,40vw)] gap-1.5 px-2"
              disabled={updateTarget.isPending}
              title={
                targetMessage ??
                `Streaming ${remoteDesktopTargetLabel(activeTarget)}`
              }
            >
              {updateTarget.isPending || launchingApplication ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
              ) : activeTarget.kind === "window" ? (
                <AppWindow className="size-3.5 shrink-0" />
              ) : (
                <MonitorUp className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {remoteDesktopTargetLabel(activeTarget)}
              </span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="end"
              sideOffset={4}
              className={menuContentClass}
            >
              <DropdownMenuPrimitive.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Displays
              </DropdownMenuPrimitive.Label>
              {targetInventory.monitors.map((monitor) => {
                const target: RemoteDesktopTarget = {
                  kind: "monitor",
                  id: monitor.id,
                  name: monitor.name,
                };
                return (
                  <DropdownMenuPrimitive.Item
                    key={`monitor:${monitor.id}`}
                    className={menuItemClass}
                    onSelect={() => updateTarget.mutate(target)}
                  >
                    <MonitorUp className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {monitor.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {monitor.width} × {monitor.height}
                      {monitor.primary ? " · primary" : ""}
                    </span>
                    {(
                      requestedTarget.kind === "monitor" &&
                      !requestedTarget.id &&
                      !requestedTarget.name
                        ? monitor.primary
                        : remoteDesktopTargetMatches(requestedTarget, target)
                    ) ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuPrimitive.Item>
                );
              })}
              {!targetInventory.monitors.length ? (
                <DropdownMenuPrimitive.Item disabled className={menuItemClass}>
                  No displays reported
                </DropdownMenuPrimitive.Item>
              ) : null}

              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Label className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Application windows
              </DropdownMenuPrimitive.Label>
              {!requestedTargetListed && requestedTarget.kind === "window" ? (
                <DropdownMenuPrimitive.Item
                  className={cn(menuItemClass, "bg-muted/50")}
                  onSelect={() => updateTarget.mutate(requestedTarget)}
                >
                  <AppWindow className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {remoteDesktopTargetLabel(requestedTarget)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    Launch on worker
                  </span>
                  <Check className="size-3.5 shrink-0" />
                </DropdownMenuPrimitive.Item>
              ) : null}
              {targetInventory.windows.map((window) => {
                const target: RemoteDesktopTarget = {
                  kind: "window",
                  id: window.id,
                  application: window.application,
                  title: window.title,
                };
                return (
                  <DropdownMenuPrimitive.Item
                    key={`window:${window.id}`}
                    className={menuItemClass}
                    onSelect={() => updateTarget.mutate(target)}
                  >
                    <AppWindow className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {window.application}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {window.title}
                        {window.minimized ? " · minimized" : ""}
                      </span>
                    </span>
                    {remoteDesktopTargetMatches(requestedTarget, target) ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                  </DropdownMenuPrimitive.Item>
                );
              })}
              {!targetInventory.windows.length &&
              !(!requestedTargetListed && requestedTarget.kind === "window") ? (
                <DropdownMenuPrimitive.Item disabled className={menuItemClass}>
                  No application windows reported
                </DropdownMenuPrimitive.Item>
              ) : null}
              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={menuItemClass}
                onSelect={() => send({ type: "refresh-targets" })}
              >
                <RotateCw className="size-4" /> Refresh windows and displays
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Copy remote selection"
          onClick={() =>
            send({ type: "clipboard", operation: "copy", text: "" })
          }
        >
          <ClipboardCopy className="size-3.5" />
          <span className="sr-only">Copy remote selection</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Paste local clipboard"
          onClick={() => void pasteClipboard()}
        >
          <ClipboardPaste className="size-3.5" />
          <span className="sr-only">Paste local clipboard</span>
        </Button>
        {runtimeStatus === "error" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={retry}
          >
            <RotateCw className="size-3.5" />
            Retry
          </Button>
        ) : null}
      </div>
      <div
        ref={surfaceRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
      >
        <RemoteSurfaceCanvas
          ref={remoteCanvasRef}
          allowAltModifiedText={false}
          ariaLabel={`${desktop.title} managed desktop surface`}
          className="touch-none outline-none"
          coordinateLimit="last-pixel"
          framePolicy="latest"
          getCoordinateSpace={() => desktopSizeRef.current}
          ignoreRepeatedKeyDown
          onFocus={() => send({ type: "focus" })}
          onFrameError={() =>
            setError("The worker sent an unreadable desktop frame.")
          }
          onKey={send}
          onPointer={send}
          onRendered={() => setRenderedSurfaceId(desktop.id)}
          pointerMoveThrottleMs={32}
          preventContextMenu
          style={{ width: canvasSize.width, height: canvasSize.height }}
        />
        <SurfaceLoadingVeil
          label={
            connectionState === "reconnecting"
              ? "Reconnecting to Remote Desktop…"
              : "Starting Remote Desktop…"
          }
          visible={!surfaceReady}
        />
        {surfaceReady && connectionState !== "ready" ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {connectionState === "connecting"
              ? "Starting Remote Desktop…"
              : "Reconnecting…"}
          </div>
        ) : null}
        {runtimeStatus === "launching" || launchingApplication ? (
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-3 rounded-xl bg-background/90 px-4 py-3 text-sm text-foreground shadow-xl backdrop-blur-xl">
            <Loader2 className="size-4 animate-spin" />
            Launching {launchingApplication ?? "application"} on the worker…
          </div>
        ) : null}
        {error || updateTarget.error ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground shadow-lg">
            {error ??
              (updateTarget.error instanceof Error
                ? updateTarget.error.message
                : "Could not change the Remote Desktop target.")}
          </div>
        ) : null}
        {targetMessage &&
        runtimeStatus !== "launching" &&
        !launchingApplication &&
        !error ? (
          <div className="pointer-events-none absolute left-1/2 top-3 max-w-xl -translate-x-1/2 truncate rounded-md bg-background/85 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            {targetMessage}
          </div>
        ) : null}
        {notice ? (
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-background/90 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-xl">
            {notice}
          </div>
        ) : null}
        {connectionState === "ready" && transportState === "fallback" ? (
          <div className="pointer-events-none absolute left-4 top-3 rounded-md bg-background/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-xl">
            Server-relayed WebSocket stream
          </div>
        ) : null}
      </div>
    </div>
  );
}
