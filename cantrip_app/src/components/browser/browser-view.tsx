import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteBrowserClipboardMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  remoteSurfaceConnectionMessageSchema,
  type BrowserSummary,
  type RemoteBrowserClientMessage,
  type RemoteSurfaceChannel,
} from "@cantrip/protocol";
import {
  ArrowLeft,
  ArrowRight,
  ClipboardCopy,
  ClipboardPaste,
  ExternalLink,
  Globe2,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { SurfaceLoadingVeil } from "@/components/ui/surface-loading-veil";
import { remoteSurfaceWebSocketUrl } from "@/lib/api";
import { RemoteSurfaceWebRtcClient } from "@/lib/remote-surface-webrtc";

const decoder = new TextDecoder();
const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;

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

async function openBrowserExternally(url: string): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
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

export function browserTouchPoints(
  touches: ArrayLike<
    Pick<Touch, "clientX" | "clientY" | "identifier"> & {
      force?: number;
      radiusX?: number;
      radiusY?: number;
    }
  >,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  viewport: { width: number; height: number },
) {
  return Array.from(touches, (touch) => ({
    id: touch.identifier,
    ...browserPointerCoordinates(touch, bounds, viewport),
    radiusX: Math.max(1, touch.radiusX || 1),
    radiusY: Math.max(1, touch.radiusY || 1),
    force: Math.max(0, Math.min(1, touch.force || 1)),
  }));
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
  onPageState,
}: {
  browser: BrowserSummary;
  onPageState(state: {
    previousTitle: string | null;
    title: string;
    url: string;
  }): void;
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
  const inputFocusedRef = useRef(false);
  const onPageStateRef = useRef(onPageState);
  const pageStateRef = useRef<{ title: string; url: string } | null>(null);
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
  const [runtimeStatus, setRuntimeStatus] = useState<
    "ready" | "recovering" | "error"
  >("ready");
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [clipboardMessage, setClipboardMessage] = useState<string | null>(null);
  const [renderedSurfaceId, setRenderedSurfaceId] = useState<string | null>(
    null,
  );
  const surfaceReady = renderedSurfaceId === browser.id;
  onPageStateRef.current = onPageState;

  const sendFrame = useCallback(
    (
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
      webSocketOnly = false,
    ) => {
      const socket = socketRef.current;
      const attachmentId = attachmentIdRef.current;
      if (!attachmentId) return false;
      const header = {
        protocolVersion: 1 as const,
        surfaceId: browser.id,
        attachmentId,
        sequence: sequenceRef.current,
        channel,
      };
      if (!webSocketOnly && webRtcRef.current?.send(header, payload)) {
        sequenceRef.current += 1;
        return true;
      }
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
        socket.close(1013, "Remote Surface connection is congested");
        return false;
      }
      socket.send(
        Uint8Array.from(encodeRemoteSurfaceFrame(header, payload)).buffer,
      );
      sequenceRef.current += 1;
      return true;
    },
    [browser.id],
  );

  const send = useCallback(
    (message: RemoteBrowserClientMessage) =>
      sendFrame(
        "control",
        new TextEncoder().encode(
          JSON.stringify(remoteBrowserClientMessageSchema.parse(message)),
        ),
      ),
    [sendFrame],
  );

  useEffect(() => {
    setAddress(browser.url);
    setCurrentUrl(browser.url);
    setInvalidAddress(false);
    pageStateRef.current = null;
    setRuntimeStatus("ready");
    setRuntimeMessage(null);
  }, [browser.id]);

  useEffect(() => {
    if (pageStateRef.current?.url === browser.url) return;
    setCurrentUrl(browser.url);
    if (!inputFocusedRef.current) setAddress(browser.url);
  }, [browser.url]);

  useEffect(() => {
    if (!clipboardMessage) return;
    const timeout = setTimeout(() => setClipboardMessage(null), 3_000);
    return () => clearTimeout(timeout);
  }, [clipboardMessage]);

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
    lastInboundSequenceRef.current = -1;
    webRtcRef.current?.close();
    webRtcRef.current = null;
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
          setRenderedSurfaceId(browser.id);
        })
        .catch(() => {
          if (!disposed)
            setError("The worker sent an unreadable browser frame.");
        });
    };

    const handleFrameBytes = (bytes: Uint8Array) => {
      try {
        const frame = decodeRemoteSurfaceFrame(bytes);
        if (
          frame.header.surfaceId !== browser.id ||
          frame.header.sequence <= lastInboundSequenceRef.current
        ) {
          return;
        }
        lastInboundSequenceRef.current = frame.header.sequence;
        if (frame.header.channel === "frame") {
          drawFrame(frame.payload);
        } else if (frame.header.channel === "control") {
          const state = remoteBrowserServerMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          );
          if (state.type === "browser-runtime") {
            setRuntimeStatus(state.status);
            setRuntimeMessage(state.message);
            if (state.status === "ready") setError(null);
          } else {
            const normalized = normalizeBrowserAddress(state.url);
            if (normalized) {
              setCurrentUrl(normalized);
              if (!inputFocusedRef.current) setAddress(normalized);
              const previous = pageStateRef.current;
              if (
                previous?.url !== normalized ||
                previous?.title !== state.title
              ) {
                pageStateRef.current = {
                  title: state.title,
                  url: normalized,
                };
                onPageStateRef.current({
                  previousTitle: previous?.title ?? null,
                  title: state.title,
                  url: normalized,
                });
              }
            }
            setCanGoBack(state.canGoBack);
            setCanGoForward(state.canGoForward);
            setLoading(state.loading);
          }
        } else if (frame.header.channel === "cursor") {
          const cursor = remoteBrowserCursorMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          ).cursor;
          const canvas = canvasRef.current;
          if (canvas && CSS.supports("cursor", cursor)) {
            canvas.style.cursor = cursor;
          }
        } else if (frame.header.channel === "clipboard") {
          const clipboard = remoteBrowserClipboardMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          );
          void navigator.clipboard.writeText(clipboard.text).then(
            () => setClipboardMessage("Selection copied"),
            () =>
              setClipboardMessage(
                "Clipboard access was denied by this app environment.",
              ),
          );
        } else if (frame.header.channel === "webrtc-signal") {
          void webRtcRef.current?.handleSignal(frame.payload);
        }
      } catch {
        setError("The server sent an invalid browser frame.");
      }
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
            if (message.transport === "webrtc" && message.webrtc) {
              const client = new RemoteSurfaceWebRtcClient({
                configuration: message.webrtc,
                onFrame: handleFrameBytes,
                onSignal: (signal) => {
                  sendFrame(
                    "webrtc-signal",
                    new TextEncoder().encode(JSON.stringify(signal)),
                    true,
                  );
                },
                onState: () => undefined,
              });
              webRtcRef.current = client;
              void client.start();
            }
            send({ type: "viewport", viewport: viewportRef.current });
          } else {
            setError(message.message);
          }
        } catch {
          setError("The server sent an invalid browser connection message.");
        }
        return;
      }
      handleFrameBytes(new Uint8Array(event.data));
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
      if (webRtcRef.current) {
        webRtcRef.current.close();
        webRtcRef.current = null;
      }
      socket.close(1000, "Browser view closed");
    };
  }, [browser.id, connectionKey, send, sendFrame]);

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
    send({ type: "navigate", url: normalized });
  };

  const pointer = (
    event: PointerEvent<HTMLCanvasElement>,
    type: "move" | "down" | "up",
  ) => {
    if (event.pointerType === "touch") return;
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

  const touch = (
    event: TouchEvent<HTMLCanvasElement>,
    type: "start" | "move" | "end" | "cancel",
  ) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.focus();
    send({
      type: "touch",
      event: type,
      points: browserTouchPoints(
        event.touches,
        canvas.getBoundingClientRect(),
        viewportRef.current,
      ),
      modifiers: modifiers(event),
    });
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      send({ type: "clipboard", operation: "paste-text", text });
      setClipboardMessage(text ? "Clipboard pasted" : "Clipboard is empty");
    } catch {
      setClipboardMessage(
        "Clipboard access was denied by this app environment.",
      );
    }
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
          title={loading ? "Stop loading" : "Reload"}
          onClick={() => send({ type: loading ? "stop" : "reload" })}
        >
          {loading ? (
            <X className="size-3.5" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          <span className="sr-only">{loading ? "Stop" : "Reload"}</span>
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
          title="Copy selected page text"
          onClick={() =>
            send({
              type: "clipboard",
              operation: "copy-selection",
              text: "",
            })
          }
        >
          <ClipboardCopy className="size-3.5" />
          <span className="sr-only">Copy selected page text</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Paste clipboard into the page"
          onClick={() => void pasteClipboard()}
        >
          <ClipboardPaste className="size-3.5" />
          <span className="sr-only">Paste clipboard into the page</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Open in your system browser"
          onClick={() =>
            void openBrowserExternally(currentUrl).catch(() =>
              setError("Could not open the system browser."),
            )
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
          onPointerCancel={(event) => pointer(event, "up")}
          onWheel={wheel}
          onTouchStart={(event) => touch(event, "start")}
          onTouchMove={(event) => touch(event, "move")}
          onTouchEnd={(event) => touch(event, "end")}
          onTouchCancel={(event) => touch(event, "cancel")}
          onKeyDown={(event) => key(event, "down")}
          onKeyUp={(event) => key(event, "up")}
        />
        <SurfaceLoadingVeil
          label={
            runtimeStatus === "recovering"
              ? runtimeMessage || "Restarting browser…"
              : connectionState === "reconnecting"
                ? "Reconnecting to browser…"
                : "Starting browser…"
          }
          visible={!surfaceReady}
        />
        {surfaceReady &&
        (connectionState !== "ready" || runtimeStatus === "recovering") ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {runtimeStatus === "recovering"
              ? runtimeMessage || "Restarting Chromium…"
              : connectionState === "connecting"
                ? "Starting browser"
                : "Reconnecting…"}
          </div>
        ) : null}
        {error || runtimeStatus === "error" ? (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-xl -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-2 text-sm text-destructive-foreground shadow-lg">
            {error ?? runtimeMessage ?? "The worker browser could not recover."}
          </div>
        ) : null}
        {clipboardMessage ? (
          <div className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-background/90 px-3 py-2 text-xs text-foreground shadow-lg backdrop-blur-xl">
            {clipboardMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}
