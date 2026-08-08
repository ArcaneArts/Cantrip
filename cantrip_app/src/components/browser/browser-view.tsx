import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteBrowserClientMessageSchema,
  remoteBrowserServerMessageSchema,
  remoteSurfaceConnectionMessageSchema,
  type BrowserSummary,
  type RemoteBrowserClientMessage,
} from "@cantrip/protocol";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { remoteSurfaceWebSocketUrl } from "@/lib/api";

const decoder = new TextDecoder();

export function normalizeBrowserAddress(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function browserPointerCoordinates(
  point: { clientX: number; clientY: number },
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: { width: number; height: number },
) {
  return {
    x: Math.max(
      0,
      Math.min(
        viewport.width,
        ((point.clientX - bounds.left) / bounds.width) * viewport.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        viewport.height,
        ((point.clientY - bounds.top) / bounds.height) * viewport.height,
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

export function BrowserView({
  browser,
  onNavigate,
}: {
  browser: BrowserSummary;
  onNavigate(url: string): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const attachmentIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputFocusedRef = useRef(false);
  const onNavigateRef = useRef(onNavigate);
  const viewportRef = useRef({
    width: 1_280,
    height: 720,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  const frameChainRef = useRef(Promise.resolve());
  const [connectionKey, setConnectionKey] = useState(0);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "ready" | "reconnecting"
  >("connecting");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(browser.url);
  const [currentUrl, setCurrentUrl] = useState(browser.url);
  const [invalidAddress, setInvalidAddress] = useState(false);
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  onNavigateRef.current = onNavigate;

  const send = useCallback(
    (message: RemoteBrowserClientMessage) => {
      const socket = socketRef.current;
      const attachmentId = attachmentIdRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || !attachmentId)
        return;
      const frame = encodeRemoteSurfaceFrame(
        {
          protocolVersion: 1,
          surfaceId: browser.id,
          attachmentId,
          sequence: sequenceRef.current++,
          channel: "control",
        },
        new TextEncoder().encode(
          JSON.stringify(remoteBrowserClientMessageSchema.parse(message)),
        ),
      );
      socket.send(Uint8Array.from(frame).buffer);
    },
    [browser.id],
  );

  useEffect(() => {
    setAddress(browser.url);
    setCurrentUrl(browser.url);
    setInvalidAddress(false);
  }, [browser.id, browser.url]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const updateViewport = () => {
      const bounds = surface.getBoundingClientRect();
      const viewport = {
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
        devicePixelRatio: window.devicePixelRatio || 1,
      };
      viewportRef.current = viewport;
      send({ type: "viewport", viewport });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [send]);

  useEffect(() => {
    const viewport = viewportRef.current;
    setConnectionState(
      reconnectAttemptRef.current ? "reconnecting" : "connecting",
    );
    setError(null);
    attachmentIdRef.current = null;
    sequenceRef.current = 0;
    const socket = new WebSocket(
      remoteSurfaceWebSocketUrl(browser.id, viewport),
    );
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let disposed = false;
    let ready = false;

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
            setError("The worker sent an unreadable browser frame.");
        });
    };

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const message = remoteSurfaceConnectionMessageSchema.parse(
            JSON.parse(event.data),
          );
          if (message.type === "ready") {
            ready = true;
            reconnectAttemptRef.current = 0;
            attachmentIdRef.current = message.attachmentId;
            setConnectionState("ready");
            send({ type: "viewport", viewport: viewportRef.current });
          } else {
            setError(message.message);
          }
        } catch {
          setError("The server sent an invalid browser connection message.");
        }
        return;
      }
      try {
        const frame = decodeRemoteSurfaceFrame(new Uint8Array(event.data));
        if (frame.header.surfaceId !== browser.id) return;
        if (frame.header.channel === "frame") {
          drawFrame(frame.payload);
        } else if (frame.header.channel === "control") {
          const state = remoteBrowserServerMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          );
          const normalized = normalizeBrowserAddress(state.url);
          if (normalized) {
            setCurrentUrl(normalized);
            if (!inputFocusedRef.current) setAddress(normalized);
            if (normalized !== browser.url) onNavigateRef.current(normalized);
          }
          setCanGoBack(state.canGoBack);
          setCanGoForward(state.canGoForward);
          setLoading(state.loading);
        }
      } catch {
        setError("The server sent an invalid browser frame.");
      }
    });
    socket.addEventListener("close", () => {
      ready = false;
      attachmentIdRef.current = null;
      if (!disposed) scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (!disposed) {
        setError("Could not connect to the worker browser.");
        scheduleReconnect();
      }
    });

    return () => {
      disposed = true;
      ready = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, "Browser view closed");
    };
  }, [browser.id, connectionKey, send]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBrowserAddress(address);
    if (!normalized) {
      setInvalidAddress(true);
      return;
    }
    setInvalidAddress(false);
    setAddress(normalized);
    setCurrentUrl(normalized);
    setLoading(true);
    onNavigate(normalized);
    send({ type: "navigate", url: normalized });
  };

  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    type: "move" | "down" | "up",
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (type === "down") {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
    }
    const position = browserPointerCoordinates(
      event,
      canvas.getBoundingClientRect(),
      viewportRef.current,
    );
    send({
      type: "pointer",
      event: type,
      ...position,
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
    const position = browserPointerCoordinates(
      event,
      canvas.getBoundingClientRect(),
      viewportRef.current,
    );
    send({
      type: "pointer",
      event: "wheel",
      ...position,
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
    send({
      type: "key",
      event: type,
      key: event.key,
      code: event.code,
      text:
        type === "down" &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey
          ? event.key
          : "",
      modifiers: modifiers(event),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 bg-background px-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!canGoBack}
          onClick={() => send({ type: "history", delta: -1 })}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!canGoForward}
          onClick={() => send({ type: "history", delta: 1 })}
        >
          <ArrowRight className="size-4" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={() => send({ type: "reload" })}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          <span className="sr-only">Reload</span>
        </Button>
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <div className="relative">
            <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="Address"
              value={address}
              onFocus={() => {
                inputFocusedRef.current = true;
              }}
              onBlur={() => {
                inputFocusedRef.current = false;
                setAddress(currentUrl);
              }}
              onChange={(event) => {
                setAddress(event.target.value);
                setInvalidAddress(false);
              }}
              className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              placeholder="Enter a URL"
              spellCheck={false}
            />
          </div>
        </form>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Open in your system browser"
          onClick={() =>
            window.open(currentUrl, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink className="size-3.5" />
          <span className="sr-only">Open externally</span>
        </Button>
      </div>
      {invalidAddress ? (
        <p className="shrink-0 bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          Enter a valid HTTP or HTTPS address.
        </p>
      ) : null}
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 overflow-hidden bg-black"
      >
        <canvas
          ref={canvasRef}
          aria-label={`${browser.title} worker browser surface`}
          className="absolute inset-0 size-full touch-none object-fill outline-none"
          tabIndex={0}
          onFocus={() => send({ type: "focus" })}
          onPointerDown={(event) => pointer(event, "down")}
          onPointerMove={(event) => pointer(event, "move")}
          onPointerUp={(event) => pointer(event, "up")}
          onWheel={wheel}
          onKeyDown={(event) => key(event, "down")}
          onKeyUp={(event) => key(event, "up")}
        />
        {connectionState !== "ready" ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {connectionState === "connecting"
              ? "Starting browser"
              : "Reconnecting…"}
          </div>
        ) : null}
        {error ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground shadow-lg">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
