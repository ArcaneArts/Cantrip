import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteSurfaceConnectionMessageSchema,
  type RemoteSurfaceChannel,
  type RemoteSurfaceFrameHeader,
} from "@cantrip/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { clientLogger, operationalErrorMetadata } from "@/lib/client-log-relay";

import {
  RemoteSurfaceWebRtcClient,
  type RemoteSurfaceWebRtcClientOptions,
  type RemoteSurfaceWebRtcState,
  type RemoteSurfaceWebRtcTransport as SelectedWebRtcTransport,
} from "./remote-surface-webrtc";

const MAX_BUFFERED_SURFACE_BYTES = 8 * 1_024 * 1_024;
const encoder = new TextEncoder();

export type RemoteSurfaceConnectionState =
  "connecting" | "ready" | "reconnecting";
export type RemoteSurfaceActiveTransport =
  SelectedWebRtcTransport | "websocket-relay";

export interface RemoteSurfaceTransportMessages {
  closeReason: string;
  congestionReason: string;
  connectionError: string;
  invalidConnectionMessage: string;
  invalidFrame: string;
}

export interface RemoteSurfaceInboundFrame {
  header: RemoteSurfaceFrameHeader;
  payload: Uint8Array;
}

export interface RemoteSurfaceWebRtcTransport {
  close(): void;
  handleSignal(payload: Uint8Array): Promise<void>;
  send(header: RemoteSurfaceFrameHeader, payload: Uint8Array): boolean;
  start(): Promise<void>;
}

export interface RemoteSurfaceTransportClientOptions {
  createWebRtcClient?: (
    options: RemoteSurfaceWebRtcClientOptions,
  ) => RemoteSurfaceWebRtcTransport;
  createWebSocket?: (url: string) => WebSocket;
  messages: RemoteSurfaceTransportMessages;
  onConnecting?(state: Exclude<RemoteSurfaceConnectionState, "ready">): void;
  onConnectionState(state: RemoteSurfaceConnectionState): void;
  onError(message: string | null): void;
  onFrame(frame: RemoteSurfaceInboundFrame): void;
  onReady?(): void;
  onActiveTransport?(transport: RemoteSurfaceActiveTransport): void;
  onTransportState?(state: RemoteSurfaceWebRtcState): void;
  surfaceId: string;
  surfaceKind?: string;
  webSocketUrl(): string;
}

export function remoteSurfaceReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt), 5_000);
}

export class RemoteSurfaceTransportClient {
  readonly #options: RemoteSurfaceTransportClientOptions;
  #attachmentId: string | null = null;
  #disposed = false;
  #lastInboundSequence = -1;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #socket: WebSocket | null = null;
  #started = false;
  #webRtc: RemoteSurfaceWebRtcTransport | null = null;
  #connectStartedAt = 0;

  constructor(options: RemoteSurfaceTransportClientOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    clientLogger.info("Remote surface transport started", {
      event: "surface.transport.started",
      operation: "connect",
      subsystem: this.#options.surfaceKind ?? "remote-surface",
      surfaceId: this.#options.surfaceId,
    });
    this.connect();
  }

  retry(): void {
    if (this.#disposed) return;
    this.#reconnectAttempt = 0;
    this.cancelReconnect();
    this.connect();
  }

  send(
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
    webSocketOnly = false,
  ): boolean {
    if (!this.#attachmentId) return false;
    const header = {
      protocolVersion: 1 as const,
      surfaceId: this.#options.surfaceId,
      attachmentId: this.#attachmentId,
      sequence: this.#sequence,
      channel,
    };
    if (!webSocketOnly && this.#webRtc?.send(header, payload)) {
      this.#sequence += 1;
      return true;
    }
    const socket = this.#socket;
    if (!socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_SURFACE_BYTES) {
      socket.close(1013, this.#options.messages.congestionReason);
      return false;
    }
    socket.send(
      Uint8Array.from(encodeRemoteSurfaceFrame(header, payload)).buffer,
    );
    this.#sequence += 1;
    return true;
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancelReconnect();
    this.teardownConnection();
    clientLogger.info("Remote surface transport closed", {
      event: "surface.transport.closed",
      operation: "disconnect",
      status: "closed",
      subsystem: this.#options.surfaceKind ?? "remote-surface",
      surfaceId: this.#options.surfaceId,
    });
  }

  private connect(): void {
    if (this.#disposed) return;
    this.teardownConnection();
    this.#attachmentId = null;
    this.#sequence = 0;
    this.#lastInboundSequence = -1;
    const state = this.#reconnectAttempt ? "reconnecting" : "connecting";
    this.#connectStartedAt = performance.now();
    this.#options.onConnectionState(state);
    this.#options.onConnecting?.(state);
    this.#options.onError(null);
    clientLogger.debug("Remote surface transport connecting", {
      attempt: this.#reconnectAttempt + 1,
      event: "surface.transport.connecting",
      operation: "connect",
      status: state,
      subsystem: this.#options.surfaceKind ?? "remote-surface",
      surfaceId: this.#options.surfaceId,
    });

    let socket: WebSocket;
    try {
      socket = (this.#options.createWebSocket ?? ((url) => new WebSocket(url)))(
        this.#options.webSocketUrl(),
      );
    } catch (error) {
      this.#options.onError(this.#options.messages.connectionError);
      clientLogger.rateLimited(
        `surface-connect:${this.#options.surfaceKind ?? "remote"}:${this.#options.surfaceId}`,
        "warn",
        "Remote surface transport could not open a socket",
        {
          attempt: this.#reconnectAttempt + 1,
          error:
            error instanceof Error
              ? error
              : new Error("Socket creation failed"),
          event: "surface.transport.connect.failed",
          operation: "connect",
          reasonCode: "socket-create-failed",
          status: "failed",
          subsystem: this.#options.surfaceKind ?? "remote-surface",
          surfaceId: this.#options.surfaceId,
        },
      );
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;

    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      if (typeof event.data === "string") {
        this.handleConnectionMessage(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.handleFrameBytes(new Uint8Array(event.data));
        return;
      }
      if (ArrayBuffer.isView(event.data)) {
        this.handleFrameBytes(
          new Uint8Array(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength,
          ),
        );
        return;
      }
      this.#options.onError(this.#options.messages.invalidFrame);
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#attachmentId = null;
      clientLogger.debug("Remote surface transport disconnected", {
        closeCode: event.code,
        event: "surface.transport.disconnected",
        operation: "disconnect",
        reasonCode: event.code === 1000 ? "normal" : "transport",
        subsystem: this.#options.surfaceKind ?? "remote-surface",
        surfaceId: this.#options.surfaceId,
      });
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#options.onError(this.#options.messages.connectionError);
      clientLogger.rateLimited(
        `surface-socket:${this.#options.surfaceKind ?? "remote"}:${this.#options.surfaceId}`,
        "warn",
        "Remote surface socket encountered an error",
        {
          attempt: this.#reconnectAttempt + 1,
          event: "surface.transport.socket-error",
          operation: "connect",
          reasonCode: "socket-error",
          subsystem: this.#options.surfaceKind ?? "remote-surface",
          surfaceId: this.#options.surfaceId,
        },
      );
      this.scheduleReconnect();
    });
  }

  private handleConnectionMessage(data: string): void {
    try {
      const message = remoteSurfaceConnectionMessageSchema.parse(
        JSON.parse(data),
      );
      if (message.type === "error") {
        this.#options.onError(message.message);
        clientLogger.warn("Remote surface rejected the attachment", {
          event: "surface.transport.attach.failed",
          operation: "attach",
          reasonCode: "remote-error",
          status: "failed",
          subsystem: this.#options.surfaceKind ?? "remote-surface",
          surfaceId: this.#options.surfaceId,
        });
        return;
      }
      this.#reconnectAttempt = 0;
      this.#attachmentId = message.attachmentId;
      this.#options.onConnectionState("ready");
      clientLogger.info("Remote surface transport is ready", {
        attempt: this.#reconnectAttempt + 1,
        durationMs: Math.round(performance.now() - this.#connectStartedAt),
        event: "surface.transport.ready",
        operation: "attach",
        status: "ready",
        subsystem: this.#options.surfaceKind ?? "remote-surface",
        surfaceId: this.#options.surfaceId,
        transport: message.transport,
      });
      if (message.transport === "webrtc" && message.webrtc) {
        const createWebRtcClient =
          this.#options.createWebRtcClient ??
          ((options: RemoteSurfaceWebRtcClientOptions) =>
            new RemoteSurfaceWebRtcClient(options));
        const client = createWebRtcClient({
          configuration: message.webrtc,
          onFrame: (bytes) => this.handleFrameBytes(bytes),
          onTransport: (transport) => this.reportTransport(transport),
          onSignal: (signal) => {
            this.send(
              "webrtc-signal",
              encoder.encode(JSON.stringify(signal)),
              true,
            );
          },
          onState: (state) => {
            this.#options.onTransportState?.(state);
            if (state === "fallback") {
              this.reportTransport("websocket-relay", "webrtc-fallback");
            }
          },
        });
        this.#webRtc = client;
        this.reportTransport("webrtc-unknown");
        void client.start().catch((error: unknown) => {
          clientLogger.warn("Remote surface WebRTC startup failed", {
            ...operationalErrorMetadata(error),
            event: "surface.transport.webrtc.failed",
            operation: "start-webrtc",
            reasonCode: "startup-failed",
            status: "fallback",
            subsystem: this.#options.surfaceKind ?? "remote-surface",
            surfaceId: this.#options.surfaceId,
          });
        });
      } else {
        this.#options.onTransportState?.("fallback");
        this.reportTransport("websocket-relay", "relay-selected");
      }
      this.#options.onReady?.();
    } catch {
      this.#options.onError(this.#options.messages.invalidConnectionMessage);
      clientLogger.warn("Remote surface connection response was invalid", {
        event: "surface.transport.protocol-error",
        operation: "decode-connection",
        reasonCode: "invalid-connection-message",
        status: "failed",
        subsystem: this.#options.surfaceKind ?? "remote-surface",
        surfaceId: this.#options.surfaceId,
      });
    }
  }

  private handleFrameBytes(bytes: Uint8Array): void {
    try {
      const frame = decodeRemoteSurfaceFrame(bytes);
      if (
        frame.header.surfaceId !== this.#options.surfaceId ||
        frame.header.sequence <= this.#lastInboundSequence
      ) {
        return;
      }
      this.#lastInboundSequence = frame.header.sequence;
      if (frame.header.channel === "webrtc-signal") {
        void this.#webRtc
          ?.handleSignal(frame.payload)
          .catch(() =>
            this.#options.onError(this.#options.messages.invalidFrame),
          );
        return;
      }
      this.#options.onFrame(frame);
    } catch {
      this.#options.onError(this.#options.messages.invalidFrame);
      clientLogger.rateLimited(
        `surface-frame:${this.#options.surfaceKind ?? "remote"}:${this.#options.surfaceId}`,
        "warn",
        "Remote surface frame was invalid",
        {
          event: "surface.transport.protocol-error",
          operation: "decode-frame",
          reasonCode: "invalid-frame",
          subsystem: this.#options.surfaceKind ?? "remote-surface",
          surfaceId: this.#options.surfaceId,
        },
      );
    }
  }

  private scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer) return;
    const delay = remoteSurfaceReconnectDelay(this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#options.onConnectionState("reconnecting");
    clientLogger.rateLimited(
      `surface-reconnect:${this.#options.surfaceKind ?? "remote"}:${this.#options.surfaceId}`,
      "info",
      "Remote surface reconnect scheduled",
      {
        attempt: this.#reconnectAttempt,
        delayMs: delay,
        event: "surface.transport.reconnect-scheduled",
        operation: "reconnect",
        subsystem: this.#options.surfaceKind ?? "remote-surface",
        surfaceId: this.#options.surfaceId,
      },
      { summaryEvery: 10, windowMs: 30_000 },
    );
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (!this.#reconnectTimer) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  private teardownConnection(): void {
    const socket = this.#socket;
    this.#socket = null;
    const webRtc = this.#webRtc;
    this.#webRtc = null;
    webRtc?.close();
    socket?.close(1000, this.#options.messages.closeReason);
  }

  private reportTransport(
    transport: RemoteSurfaceActiveTransport,
    reasonCode?: string,
  ): void {
    this.#options.onActiveTransport?.(transport);
    clientLogger.info("Remote surface transport selected", {
      event: "surface.transport.selected",
      operation: "select-transport",
      reasonCode,
      subsystem: this.#options.surfaceKind ?? "remote-surface",
      surfaceId: this.#options.surfaceId,
      transport,
    });
  }
}

export interface RemoteSurfaceFrameContext {
  isCurrent(): boolean;
  reportError(message: string | null): void;
}

export interface UseRemoteSurfaceTransportOptions {
  messages: RemoteSurfaceTransportMessages;
  onConnecting?(): void;
  onFrame(
    frame: RemoteSurfaceInboundFrame,
    context: RemoteSurfaceFrameContext,
  ): void;
  onReady?(): void;
  surfaceId: string;
  surfaceKind?: string;
  webSocketUrl(): string;
}

export interface UseRemoteSurfaceTransportResult {
  activeTransport: RemoteSurfaceActiveTransport | null;
  connectionState: RemoteSurfaceConnectionState;
  error: string | null;
  retry(): void;
  sendFrame(
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
    webSocketOnly?: boolean,
  ): boolean;
  setError: Dispatch<SetStateAction<string | null>>;
  transportState: RemoteSurfaceWebRtcState | null;
}

export function useRemoteSurfaceTransport(
  options: UseRemoteSurfaceTransportOptions,
): UseRemoteSurfaceTransportResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clientRef = useRef<RemoteSurfaceTransportClient | null>(null);
  const [connectionState, setConnectionState] =
    useState<RemoteSurfaceConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [activeTransport, setActiveTransport] =
    useState<RemoteSurfaceActiveTransport | null>(null);
  const [transportState, setTransportState] =
    useState<RemoteSurfaceWebRtcState | null>(null);

  useEffect(() => {
    let client: RemoteSurfaceTransportClient;
    client = new RemoteSurfaceTransportClient({
      surfaceId: options.surfaceId,
      surfaceKind: options.surfaceKind,
      webSocketUrl: () => optionsRef.current.webSocketUrl(),
      messages: options.messages,
      onConnecting: () => {
        setActiveTransport(null);
        setTransportState(null);
        optionsRef.current.onConnecting?.();
      },
      onConnectionState: setConnectionState,
      onError: setError,
      onFrame: (frame) =>
        optionsRef.current.onFrame(frame, {
          isCurrent: () => clientRef.current === client,
          reportError: setError,
        }),
      onReady: () => optionsRef.current.onReady?.(),
      onActiveTransport: (transport) => {
        if (clientRef.current === client) setActiveTransport(transport);
      },
      onTransportState: (state) => {
        if (clientRef.current === client) setTransportState(state);
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      if (clientRef.current === client) clientRef.current = null;
      client.close();
    };
  }, [options.surfaceId]);

  const retry = useCallback(() => clientRef.current?.retry(), []);
  const sendFrame = useCallback(
    (
      channel: RemoteSurfaceChannel,
      payload: Uint8Array,
      webSocketOnly = false,
    ) => clientRef.current?.send(channel, payload, webSocketOnly) ?? false,
    [],
  );

  return {
    activeTransport,
    connectionState,
    error,
    retry,
    sendFrame,
    setError,
    transportState,
  };
}
