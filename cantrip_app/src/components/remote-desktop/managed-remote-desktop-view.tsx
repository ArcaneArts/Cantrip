import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteDesktopClientMessageSchema,
  remoteDesktopServerMessageSchema,
  remoteSurfaceConnectionMessageSchema,
  type RemoteDesktopClientMessage,
  type RemoteDesktopSummary,
  type RemoteSurfaceChannel,
} from "@cantrip/protocol";
import {
  ClipboardCopy,
  ClipboardPaste,
  Loader2,
  MonitorUp,
  RotateCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { remoteSurfaceWebSocketUrl } from "@/lib/api";
import {
  RemoteSurfaceWebRtcClient,
  type RemoteSurfaceWebRtcState,
} from "@/lib/remote-surface-webrtc";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;

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
  return {
    x: Math.max(
      0,
      Math.min(
        desktop.width - 1,
        ((point.clientX - bounds.left) / bounds.width) * desktop.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        desktop.height - 1,
        ((point.clientY - bounds.top) / bounds.height) * desktop.height,
      ),
    ),
  };
}

function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

function pointerButton(button: number) {
  return (
    (["left", "middle", "right", "back", "forward"] as const)[button] ?? "none"
  );
}

export function ManagedRemoteDesktopView({
  desktop,
}: {
  desktop: RemoteDesktopSummary;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const webRtcRef = useRef<RemoteSurfaceWebRtcClient | null>(null);
  const attachmentIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const lastInboundSequenceRef = useRef(-1);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameChainRef = useRef(Promise.resolve());
  const lastPointerMoveAtRef = useRef(0);
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
  const [connectionKey, setConnectionKey] = useState(0);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "ready" | "reconnecting"
  >("connecting");
  const [runtimeStatus, setRuntimeStatus] = useState<
    "ready" | "suspended" | "error"
  >("ready");
  const [error, setError] = useState<string | null>(desktop.lastError);
  const [notice, setNotice] = useState<string | null>(null);
  const [transportState, setTransportState] =
    useState<RemoteSurfaceWebRtcState | null>(null);

  const sendFrame = useCallback(
    (
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
      webSocketOnly = false,
    ) => {
      const attachmentId = attachmentIdRef.current;
      if (!attachmentId) return false;
      const header = {
        protocolVersion: 1 as const,
        surfaceId: desktop.id,
        attachmentId,
        sequence: sequenceRef.current,
        channel,
      };
      if (!webSocketOnly && webRtcRef.current?.send(header, payload)) {
        sequenceRef.current += 1;
        return true;
      }
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
        socket.close(1013, "Remote Desktop connection is congested");
        return false;
      }
      socket.send(
        Uint8Array.from(encodeRemoteSurfaceFrame(header, payload)).buffer,
      );
      sequenceRef.current += 1;
      return true;
    },
    [desktop.id],
  );

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
    setConnectionState(
      reconnectAttemptRef.current ? "reconnecting" : "connecting",
    );
    setError(null);
    setTransportState(null);
    attachmentIdRef.current = null;
    sequenceRef.current = 0;
    lastInboundSequenceRef.current = -1;
    webRtcRef.current?.close();
    webRtcRef.current = null;
    const socket = new WebSocket(
      remoteSurfaceWebSocketUrl(desktop.id, viewportRef.current),
    );
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current) return;
      const delay = Math.min(500 * 2 ** reconnectAttemptRef.current, 5_000);
      reconnectAttemptRef.current += 1;
      setConnectionState("reconnecting");
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setConnectionKey((key) => key + 1);
      }, delay);
    };

    const drawFrame = (payload: Uint8Array) => {
      const bytes = new Uint8Array(payload);
      frameChainRef.current = frameChainRef.current
        .then(async () => {
          const canvas = canvasRef.current;
          if (!canvas || disposed) return;
          const bitmap = await createImageBitmap(
            new Blob([bytes], { type: "image/jpeg" }),
          );
          if (disposed) {
            bitmap.close();
            return;
          }
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          bitmap.close();
        })
        .catch(() => {
          if (!disposed)
            setError("The worker sent an unreadable desktop frame.");
        });
    };

    const handleFrame = (bytes: Uint8Array) => {
      try {
        const frame = decodeRemoteSurfaceFrame(bytes);
        if (
          frame.header.surfaceId !== desktop.id ||
          frame.header.sequence <= lastInboundSequenceRef.current
        ) {
          return;
        }
        lastInboundSequenceRef.current = frame.header.sequence;
        if (frame.header.channel === "frame") {
          drawFrame(frame.payload);
        } else if (
          frame.header.channel === "control" ||
          frame.header.channel === "clipboard"
        ) {
          const message = remoteDesktopServerMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          );
          if (message.type === "desktop-state") {
            const nextSize = { width: message.width, height: message.height };
            desktopSizeRef.current = nextSize;
            setDesktopSize(nextSize);
            setRuntimeStatus(message.status);
            setError(message.status === "error" ? message.message : null);
          } else {
            void navigator.clipboard.writeText(message.text).then(
              () => setNotice("Remote clipboard copied"),
              () =>
                setNotice(
                  "Clipboard access was denied by this app environment.",
                ),
            );
          }
        } else if (frame.header.channel === "webrtc-signal") {
          void webRtcRef.current?.handleSignal(frame.payload);
        }
      } catch {
        setError("The server sent an invalid Remote Desktop frame.");
      }
    };

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const message = remoteSurfaceConnectionMessageSchema.parse(
            JSON.parse(event.data),
          );
          if (message.type === "error") {
            setError(message.message);
            return;
          }
          reconnectAttemptRef.current = 0;
          attachmentIdRef.current = message.attachmentId;
          setConnectionState("ready");
          if (message.transport === "webrtc" && message.webrtc) {
            const client = new RemoteSurfaceWebRtcClient({
              configuration: message.webrtc,
              onFrame: handleFrame,
              onSignal: (signal) => {
                sendFrame(
                  "webrtc-signal",
                  encoder.encode(JSON.stringify(signal)),
                  true,
                );
              },
              onState: setTransportState,
            });
            webRtcRef.current = client;
            void client.start();
          } else {
            setTransportState("fallback");
          }
          send({ type: "viewport", viewport: viewportRef.current });
        } catch {
          setError(
            "The server sent an invalid Remote Desktop connection message.",
          );
        }
        return;
      }
      handleFrame(new Uint8Array(event.data));
    });
    socket.addEventListener("close", () => {
      attachmentIdRef.current = null;
      if (!disposed) scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (!disposed) {
        setError("Could not connect to the worker Remote Desktop.");
        scheduleReconnect();
      }
    });

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      webRtcRef.current?.close();
      webRtcRef.current = null;
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, "Remote Desktop view closed");
    };
  }, [connectionKey, desktop.id, send, sendFrame]);

  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    type: "move" | "down" | "up",
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (
      type === "move" &&
      performance.now() - lastPointerMoveAtRef.current < 32
    ) {
      return;
    }
    if (type === "move") lastPointerMoveAtRef.current = performance.now();
    if (type === "down") {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
    }
    send({
      type: "pointer",
      event: type,
      ...desktopPointerCoordinates(
        event,
        canvas.getBoundingClientRect(),
        desktopSizeRef.current,
      ),
      button: pointerButton(event.button),
      buttons: event.buttons,
      clickCount: event.detail,
      deltaX: 0,
      deltaY: 0,
      modifiers: modifiers(event),
    });
  };

  const wheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    send({
      type: "pointer",
      event: "wheel",
      ...desktopPointerCoordinates(
        event,
        canvas.getBoundingClientRect(),
        desktopSizeRef.current,
      ),
      button: "none",
      buttons: 0,
      clickCount: 0,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    });
  };

  const key = (
    event: KeyboardEvent<HTMLCanvasElement>,
    type: "down" | "up",
  ) => {
    event.preventDefault();
    if (type === "down" && event.repeat) return;
    send({
      type: "key",
      event: type,
      key: event.key,
      code: event.code,
      text:
        type === "down" &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
          ? event.key
          : "",
      modifiers: modifiers(event),
    });
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      send({ type: "clipboard", operation: "paste-text", text });
      setNotice(text ? "Clipboard pasted" : "Clipboard is empty");
    } catch {
      setNotice("Clipboard access was denied by this app environment.");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 bg-background px-3">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <MonitorUp className="size-4 shrink-0" />
          <span className="truncate">
            {desktopSize.width} × {desktopSize.height} · project worker
          </span>
        </div>
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
            onClick={() => setConnectionKey((key) => key + 1)}
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
        <canvas
          ref={canvasRef}
          aria-label={`${desktop.title} managed desktop surface`}
          className="touch-none outline-none"
          style={{ width: canvasSize.width, height: canvasSize.height }}
          tabIndex={0}
          onFocus={() => send({ type: "focus" })}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => pointer(event, "down")}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerUp={(event) => pointer(event, "up")}
          onPointerCancel={(event) => pointer(event, "up")}
          onWheel={wheel}
          onKeyDown={(event) => key(event, "down")}
          onKeyUp={(event) => key(event, "up")}
        />
        {connectionState !== "ready" ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {connectionState === "connecting"
              ? "Starting Remote Desktop…"
              : "Reconnecting…"}
          </div>
        ) : null}
        {error ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground shadow-lg">
            {error}
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
