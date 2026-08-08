import RFB from "@novnc/novnc";
import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteSurfaceConnectionMessageSchema,
  remoteVncClientMessageSchema,
  remoteVncServerMessageSchema,
  type RemoteDesktopSummary,
  type RemoteSurfaceChannel,
} from "@cantrip/protocol";
import {
  ClipboardCopy,
  ClipboardPaste,
  Keyboard,
  Loader2,
  MonitorUp,
  Power,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { remoteSurfaceWebSocketUrl } from "@/lib/api";
import { RemoteSurfaceRfbChannel } from "@/lib/remote-surface-rfb-channel";
import { RemoteSurfaceWebRtcClient } from "@/lib/remote-surface-webrtc";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function RemoteDesktopView({
  desktop,
}: {
  desktop: RemoteDesktopSummary;
}) {
  const targetRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const webRtcRef = useRef<RemoteSurfaceWebRtcClient | null>(null);
  const channelRef = useRef<RemoteSurfaceRfbChannel | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const attachmentIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const lastInboundSequenceRef = useRef(-1);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rfbReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const wasConnectedRef = useRef(false);
  const explicitDisconnectRef = useRef(false);
  const [connectionKey, setConnectionKey] = useState(0);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "ready" | "reconnecting"
  >("connecting");
  const [vncStatus, setVncStatus] = useState<
    "connecting" | "connected" | "disconnected" | "reconnecting" | "error"
  >("connecting");
  const [error, setError] = useState<string | null>(desktop.lastError);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      socket.send(
        Uint8Array.from(encodeRemoteSurfaceFrame(header, payload)).buffer,
      );
      sequenceRef.current += 1;
      return true;
    },
    [desktop.id],
  );

  const sendControl = useCallback(
    (type: "connect" | "disconnect") =>
      sendFrame(
        "control",
        encoder.encode(
          JSON.stringify(remoteVncClientMessageSchema.parse({ type })),
        ),
      ),
    [sendFrame],
  );

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 3_000);
    return () => clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const viewport = {
      width: Math.max(1, targetRef.current?.clientWidth ?? 1_280),
      height: Math.max(1, targetRef.current?.clientHeight ?? 720),
      devicePixelRatio: window.devicePixelRatio || 1,
    };
    setConnectionState(
      reconnectAttemptRef.current ? "reconnecting" : "connecting",
    );
    setError(null);
    attachmentIdRef.current = null;
    sequenceRef.current = 0;
    lastInboundSequenceRef.current = -1;
    wasConnectedRef.current = false;
    explicitDisconnectRef.current = false;
    webRtcRef.current?.close();
    webRtcRef.current = null;
    const socket = new WebSocket(
      remoteSurfaceWebSocketUrl(desktop.id, viewport),
    );
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    let disposed = false;

    const destroyRfb = () => {
      if (rfbReconnectTimerRef.current) {
        clearTimeout(rfbReconnectTimerRef.current);
        rfbReconnectTimerRef.current = null;
      }
      try {
        rfbRef.current?.disconnect();
      } catch {
        // The raw transport may already be closed.
      }
      channelRef.current?.close();
      rfbRef.current = null;
      channelRef.current = null;
      targetRef.current?.replaceChildren();
    };

    const startRfb = () => {
      const target = targetRef.current;
      if (!target || disposed || !attachmentIdRef.current) return;
      destroyRfb();
      explicitDisconnectRef.current = false;
      setVncStatus("connecting");
      setError(null);
      const channel = new RemoteSurfaceRfbChannel((bytes) =>
        sendFrame("rfb", bytes),
      );
      channelRef.current = channel;
      const rfb = new RFB(target, channel, { shared: true });
      rfb.background = "rgb(0, 0, 0)";
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.addEventListener("connect", () => {
        wasConnectedRef.current = true;
        setVncStatus("connected");
        setError(null);
      });
      rfb.addEventListener("disconnect", (event) => {
        if (!event.detail.clean && !explicitDisconnectRef.current) {
          setVncStatus("disconnected");
        }
      });
      rfb.addEventListener("credentialsrequired", () => {
        setVncStatus("error");
        setError(
          "The worker authentication gateway could not satisfy this VNC endpoint.",
        );
      });
      rfb.addEventListener("clipboard", (event) => {
        setRemoteClipboard(event.detail.text);
        setNotice("Remote clipboard is available");
      });
      rfbRef.current = rfb;
      sendControl("connect");
    };

    const scheduleSocketReconnect = () => {
      if (disposed || reconnectTimerRef.current) return;
      const delay = Math.min(500 * 2 ** reconnectAttemptRef.current, 5_000);
      reconnectAttemptRef.current += 1;
      setConnectionState("reconnecting");
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setConnectionKey((key) => key + 1);
      }, delay);
    };

    const scheduleRfbReconnect = () => {
      if (
        disposed ||
        explicitDisconnectRef.current ||
        !wasConnectedRef.current ||
        rfbReconnectTimerRef.current
      ) {
        return;
      }
      setVncStatus("reconnecting");
      rfbReconnectTimerRef.current = setTimeout(() => {
        rfbReconnectTimerRef.current = null;
        startRfb();
      }, 1_000);
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
        if (frame.header.channel === "rfb") {
          channelRef.current?.receive(frame.payload);
        } else if (frame.header.channel === "control") {
          const state = remoteVncServerMessageSchema.parse(
            JSON.parse(decoder.decode(frame.payload)),
          );
          setVncStatus(state.status);
          if (state.status === "error") {
            setError(state.message ?? "The VNC endpoint failed.");
            channelRef.current?.fail(state.message ?? "VNC endpoint failed.");
          } else if (state.status === "disconnected") {
            channelRef.current?.close();
            if (state.message) setError(state.message);
            scheduleRfbReconnect();
          } else if (state.status === "connected") {
            setError(null);
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
              onState: () => undefined,
            });
            webRtcRef.current = client;
            void client.start();
          }
          startRfb();
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
      destroyRfb();
      if (!disposed) scheduleSocketReconnect();
    });
    socket.addEventListener("error", () => {
      if (!disposed) {
        setError("Could not connect to the worker Remote Desktop.");
        scheduleSocketReconnect();
      }
    });

    return () => {
      disposed = true;
      destroyRfb();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      webRtcRef.current?.close();
      webRtcRef.current = null;
      if (socketRef.current === socket) socketRef.current = null;
      socket.close(1000, "Remote Desktop view closed");
    };
  }, [connectionKey, desktop.id, sendControl, sendFrame]);

  const disconnect = () => {
    explicitDisconnectRef.current = true;
    sendControl("disconnect");
    try {
      rfbRef.current?.disconnect();
    } catch {
      // Already disconnected.
    }
    channelRef.current?.close();
    setVncStatus("disconnected");
  };

  const reconnect = () => {
    explicitDisconnectRef.current = false;
    setConnectionKey((key) => key + 1);
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      rfbRef.current?.clipboardPasteFrom(text);
      setNotice(text ? "Clipboard pasted" : "Clipboard is empty");
    } catch {
      setNotice("Clipboard access was denied by this app environment.");
    }
  };

  const copyRemoteClipboard = async () => {
    if (remoteClipboard === null) {
      setNotice("The remote desktop has not provided clipboard text.");
      return;
    }
    try {
      await navigator.clipboard.writeText(remoteClipboard);
      setNotice("Remote clipboard copied");
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
            {desktop.displayName || `${desktop.host}:${desktop.port}`}
          </span>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Send Ctrl+Alt+Delete"
          disabled={vncStatus !== "connected"}
          onClick={() => rfbRef.current?.sendCtrlAltDel()}
        >
          <Keyboard className="size-3.5" />
          <span className="sr-only">Send Ctrl+Alt+Delete</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Copy remote clipboard"
          onClick={() => void copyRemoteClipboard()}
        >
          <ClipboardCopy className="size-3.5" />
          <span className="sr-only">Copy remote clipboard</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Paste local clipboard"
          disabled={vncStatus !== "connected"}
          onClick={() => void pasteClipboard()}
        >
          <ClipboardPaste className="size-3.5" />
          <span className="sr-only">Paste local clipboard</span>
        </Button>
        {vncStatus === "disconnected" || vncStatus === "error" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={reconnect}
          >
            <RotateCw className="size-3.5" />
            Reconnect
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            title="Disconnect"
            onClick={disconnect}
          >
            <Power className="size-3.5" />
            <span className="sr-only">Disconnect</span>
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div ref={targetRef} className="absolute inset-0 size-full" />
        {connectionState !== "ready" ||
        vncStatus === "connecting" ||
        vncStatus === "reconnecting" ? (
          <div className="pointer-events-none absolute right-4 top-3 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-xl">
            <Loader2 className="size-3 animate-spin" />
            {connectionState === "reconnecting"
              ? "Reconnecting to worker…"
              : vncStatus === "reconnecting"
                ? "Reconnecting to desktop…"
                : "Connecting to desktop…"}
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
      </div>
    </div>
  );
}
