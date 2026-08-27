import { connect, type Socket } from "node:net";

import {
  TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
  TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";

import { workerLogger } from "./logger.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = (attachmentId: string) => Promise<boolean>;
type ConnectionObserver = (localPort: number) => void;
type SocketConnector = (options: {
  allowHalfOpen: boolean;
  host: string;
  port: number;
}) => Socket;

interface TcpStream {
  destinationHalfClosed: boolean;
  destinationHalfCloseSent: boolean;
  destinationToSourceCredit: number;
  flushing: boolean;
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>;
  inputSequence: number;
  outputSequence: number;
  pendingBytes: number;
  pendingOutput: Uint8Array[];
  pendingSourceCreditBytes: number;
  pausedForOutput: boolean;
  rejectedOutputSequence: number | null;
  socket: Socket;
  sourceHalfClosed: boolean;
  startedAtMs: number;
}

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_STREAMS = 256;
const MAX_SOCKET_BUFFER_BYTES = 1 * 1_024 * 1_024;
const MAX_OUTPUT_FRAMES_PER_TURN = 1;

function key(header: TunnelDataPlaneFrameHeader): string {
  return `${header.tunnelId}\0${header.attachmentId}\0${header.connectionId}`;
}

function responseBase(stream: TcpStream) {
  return {
    protocolVersion: 1 as const,
    tunnelId: stream.header.tunnelId,
    attachmentId: stream.header.attachmentId,
    sourceEndpointId: stream.header.sourceEndpointId,
    destinationEndpointId: stream.header.destinationEndpointId,
    connectionId: stream.header.connectionId,
    sequence: stream.outputSequence++,
  };
}

function terminalResponseBase(stream: TcpStream, sequence?: number) {
  if (sequence !== undefined) {
    stream.rejectedOutputSequence = null;
    return {
      protocolVersion: 1 as const,
      tunnelId: stream.header.tunnelId,
      attachmentId: stream.header.attachmentId,
      sourceEndpointId: stream.header.sourceEndpointId,
      destinationEndpointId: stream.header.destinationEndpointId,
      connectionId: stream.header.connectionId,
      sequence,
    };
  }
  if (stream.rejectedOutputSequence === null) return responseBase(stream);
  const reserved = stream.rejectedOutputSequence;
  stream.rejectedOutputSequence = null;
  return {
    protocolVersion: 1 as const,
    tunnelId: stream.header.tunnelId,
    attachmentId: stream.header.attachmentId,
    sourceEndpointId: stream.header.sourceEndpointId,
    destinationEndpointId: stream.header.destinationEndpointId,
    connectionId: stream.header.connectionId,
    sequence: reserved,
  };
}

function chunks(payload: Uint8Array): Uint8Array[] {
  const output: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES
  ) {
    output.push(
      payload.subarray(offset, offset + TUNNEL_DATA_PLANE_MAX_PLAINTEXT_BYTES),
    );
  }
  return output;
}

export class TunnelTcpDestinationAdapter {
  readonly #streams = new Map<string, TcpStream>();
  #emit: FrameEmitter = () => false;
  #waitForCapacity: CapacityWaiter = async () => true;

  constructor(
    private readonly connectSocket: SocketConnector = (options) =>
      connect(options),
  ) {}

  setFrameEmitter(
    emit: FrameEmitter,
    waitForCapacity: CapacityWaiter = async () => true,
  ): void {
    this.#emit = emit;
    this.#waitForCapacity = waitForCapacity;
  }

  handleFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
    onConnected?: ConnectionObserver,
  ): void {
    if (header.kind === "connect") {
      this.#connect(header, onConnected);
      return;
    }
    const stream = this.#streams.get(key(header));
    if (!stream) return;
    if (
      header.sourceEndpointId !== stream.header.sourceEndpointId ||
      header.destinationEndpointId !== stream.header.destinationEndpointId ||
      header.sequence !== stream.inputSequence
    ) {
      this.#close(stream, "protocol-error");
      return;
    }
    stream.inputSequence += 1;
    if (
      header.kind === "data" &&
      header.direction === "source-to-destination"
    ) {
      if (
        stream.sourceHalfClosed ||
        stream.socket.writableLength + payload.byteLength >
          MAX_SOCKET_BUFFER_BYTES
      ) {
        this.#close(stream, "congested");
        return;
      }
      stream.socket.write(payload, () => {
        if (!this.#streams.has(key(stream.header))) return;
        stream.pendingSourceCreditBytes += payload.byteLength;
        void this.#flushOutput(stream);
      });
      return;
    }
    if (
      header.kind === "credit" &&
      header.direction === "destination-to-source"
    ) {
      stream.destinationToSourceCredit = Math.min(
        TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
        stream.destinationToSourceCredit + header.bytes,
      );
      void this.#flushOutput(stream);
      return;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "source-to-destination"
    ) {
      stream.sourceHalfClosed = true;
      stream.socket.end();
      return;
    }
    if (header.kind === "close" || header.kind === "error") {
      this.#remove(stream);
      stream.socket.destroy();
    }
  }

  failProtectedFrame(header: TunnelDataPlaneFrameHeader): void {
    const stream = this.#streams.get(key(header));
    if (stream) this.#close(stream, "protocol-error");
  }

  failProtectedOutputFrame(header: TunnelDataPlaneFrameHeader): void {
    const stream = this.#streams.get(key(header));
    if (stream) {
      this.#close(
        stream,
        "protocol-error",
        "protected-output-frame-failed",
        header.sequence,
      );
    }
  }

  disconnect(): void {
    const count = this.#streams.size;
    for (const stream of [...this.#streams.values()]) {
      this.#remove(stream);
      stream.socket.destroy();
    }
    if (count > 0) {
      workerLogger.event("info", "Tunnel destination streams disconnected", {
        event: "tunnel.destination.disconnected-all",
        subsystem: "tunnel",
        operation: "disconnect",
        status: "completed",
        counts: { streams: count },
      });
    }
  }

  revokeAttachment(attachmentId: string): number {
    const streams = [...this.#streams.values()].filter(
      (stream) => stream.header.attachmentId === attachmentId,
    );
    for (const stream of streams) {
      this.#close(stream, "revoked", "attachment-revoked");
    }
    return streams.length;
  }

  close(): void {
    this.disconnect();
  }

  #connect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    onConnected?: ConnectionObserver,
  ): void {
    const streamKey = key(header);
    if (this.#streams.has(streamKey)) {
      this.#logRejected(header, "protocol-error");
      this.#reject(header, "protocol-error");
      return;
    }
    if (this.#streams.size >= MAX_STREAMS) {
      this.#logRejected(header, "limit-exceeded");
      this.#reject(header, "limit-exceeded");
      return;
    }
    if (header.target.kind !== "tcp") {
      this.#logRejected(header, "target-rejected");
      this.#reject(header, "target-rejected");
      return;
    }
    const socket = this.connectSocket({
      host: header.target.host,
      port: header.target.port,
      allowHalfOpen: true,
    });
    const stream: TcpStream = {
      destinationHalfClosed: false,
      destinationHalfCloseSent: false,
      destinationToSourceCredit: header.initialCreditBytes,
      flushing: false,
      header,
      inputSequence: 1,
      outputSequence: 0,
      pendingBytes: 0,
      pendingOutput: [],
      pendingSourceCreditBytes: 0,
      pausedForOutput: false,
      rejectedOutputSequence: null,
      socket,
      sourceHalfClosed: false,
      startedAtMs: Date.now(),
    };
    this.#streams.set(streamKey, stream);
    workerLogger.event("debug", "Tunnel destination logical stream opening", {
      connectionScope: "logical-stream",
      event: "tunnel.destination.opening",
      subsystem: "tunnel",
      operation: "connect",
      status: "started",
      tunnelId: header.tunnelId,
      attachmentId: header.attachmentId,
      connectionId: header.connectionId,
      counts: { streams: this.#streams.size },
    });
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      if (!this.#streams.has(streamKey)) return;
      socket.setTimeout(0);
      if (socket.localPort !== undefined) {
        try {
          onConnected?.(socket.localPort);
        } catch {
          // Diagnostic correlation must not affect tunnel connectivity.
        }
      }
      workerLogger.event(
        "info",
        "Tunnel destination logical stream connected",
        {
          connectionScope: "logical-stream",
          event: "tunnel.destination.connected",
          subsystem: "tunnel",
          operation: "connect",
          status: "completed",
          tunnelId: header.tunnelId,
          attachmentId: header.attachmentId,
          connectionId: header.connectionId,
          durationMs: Date.now() - stream.startedAtMs,
        },
      );
      const accepted: TunnelDataPlaneFrameHeader = {
        ...responseBase(stream),
        kind: "accepted",
        initialCreditBytes: INITIAL_CREDIT_BYTES,
      };
      if (!this.#emit(accepted, EMPTY_PAYLOAD)) {
        stream.rejectedOutputSequence = accepted.sequence;
        this.#close(stream, "congested", "accepted-frame-emitter-rejected");
      }
    });
    socket.once("timeout", () => {
      if (!this.#remove(stream)) return;
      this.#logFailure(stream, "timeout", "target-unavailable");
      void this.#emitDetached(
        {
          ...terminalResponseBase(stream),
          kind: "rejected",
          code: "target-unavailable",
        },
        EMPTY_PAYLOAD,
      );
      socket.destroy();
    });
    socket.on("data", (data) =>
      this.#sendData(
        stream,
        typeof data === "string" ? Buffer.from(data) : data,
      ),
    );
    socket.once("end", () => {
      if (!this.#streams.has(streamKey)) return;
      stream.destinationHalfClosed = true;
      this.#pauseOutput(stream);
      void this.#flushOutput(stream);
    });
    socket.once("error", () => {
      if (!this.#remove(stream)) return;
      this.#logFailure(stream, "connection-error", "connection-failed");
      void this.#emitDetached(
        {
          ...terminalResponseBase(stream),
          kind: "error",
          code: "connection-failed",
        },
        EMPTY_PAYLOAD,
      );
    });
    socket.once("close", () => {
      if (!this.#remove(stream)) return;
      workerLogger.event("debug", "Tunnel destination logical stream closed", {
        connectionScope: "logical-stream",
        event: "tunnel.destination.closed",
        subsystem: "tunnel",
        operation: "connect",
        status: "completed",
        tunnelId: stream.header.tunnelId,
        attachmentId: stream.header.attachmentId,
        connectionId: stream.header.connectionId,
        durationMs: Date.now() - stream.startedAtMs,
        counts: { streams: this.#streams.size },
      });
      void this.#emitDetached(
        {
          ...terminalResponseBase(stream),
          kind: "close",
          code: "normal",
        },
        EMPTY_PAYLOAD,
      );
    });
  }

  #sendData(stream: TcpStream, data: Buffer): void {
    if (!this.#streams.has(key(stream.header))) return;
    // A TCP socket can produce more data events while an async capacity wait is
    // pending. Pause before queueing so the bounded queue reflects one already
    // delivered read instead of the speed difference between TCP and WebSocket.
    this.#pauseOutput(stream);
    for (const payload of chunks(data)) {
      if (!this.#streams.has(key(stream.header))) return;
      stream.pendingOutput.push(payload.slice());
      stream.pendingBytes += payload.byteLength;
      if (stream.pendingBytes > MAX_SOCKET_BUFFER_BYTES) {
        this.#close(stream, "congested", "destination-output-buffer-limit");
        return;
      }
    }
    void this.#flushOutput(stream);
  }

  async #flushOutput(stream: TcpStream): Promise<void> {
    if (stream.flushing) return;
    stream.flushing = true;
    let emittedFramesThisTurn = 0;
    try {
      while (stream.pendingOutput.length > 0) {
        if (!this.#streams.has(key(stream.header))) return;
        const payload = stream.pendingOutput[0]!;
        if (stream.destinationToSourceCredit === 0) break;
        const writablePayload =
          payload.byteLength <= stream.destinationToSourceCredit
            ? payload
            : payload.subarray(0, stream.destinationToSourceCredit);
        const header: TunnelDataPlaneFrameHeader = {
          ...responseBase(stream),
          kind: "data",
          direction: "destination-to-source",
        };
        // A false result means the frame was not accepted. Preserve the exact
        // payload and sequence across the capacity wait so parallel HTTP and
        // WebSocket streams cannot turn transient contention into data loss.
        if (!(await this.#emitStreamFrame(stream, header, writablePayload))) {
          return;
        }
        if (writablePayload.byteLength === payload.byteLength) {
          stream.pendingOutput.shift();
        } else {
          stream.pendingOutput[0] = payload.subarray(
            writablePayload.byteLength,
          );
        }
        stream.pendingBytes -= writablePayload.byteLength;
        stream.destinationToSourceCredit -= writablePayload.byteLength;
        emittedFramesThisTurn += 1;
        if (emittedFramesThisTurn >= MAX_OUTPUT_FRAMES_PER_TURN) {
          // Yield between accepted nested frames without waiting on the
          // carrier. Multiple streams can therefore share one outer byte
          // window instead of whichever continuation wakes first refilling it.
          await new Promise<void>((resolve) => setImmediate(resolve));
          emittedFramesThisTurn = 0;
        }
      }
      if (!this.#streams.has(key(stream.header))) return;
      while (stream.pendingSourceCreditBytes > 0) {
        const bytes = Math.min(
          TUNNEL_DATA_PLANE_MAX_CREDIT_BYTES,
          stream.pendingSourceCreditBytes,
        );
        const header: TunnelDataPlaneFrameHeader = {
          ...responseBase(stream),
          kind: "credit",
          direction: "source-to-destination",
          bytes,
        };
        if (!(await this.#emitStreamFrame(stream, header, EMPTY_PAYLOAD))) {
          return;
        }
        stream.pendingSourceCreditBytes -= bytes;
      }
      if (!this.#streams.has(key(stream.header))) return;
      if (
        stream.pendingOutput.length === 0 &&
        stream.destinationHalfClosed &&
        !stream.destinationHalfCloseSent
      ) {
        const header: TunnelDataPlaneFrameHeader = {
          ...responseBase(stream),
          kind: "half-close",
          direction: "destination-to-source",
        };
        if (!(await this.#emitStreamFrame(stream, header, EMPTY_PAYLOAD))) {
          return;
        }
        stream.destinationHalfCloseSent = true;
      }
    } finally {
      stream.flushing = false;
      if (!this.#streams.has(key(stream.header))) return;
      if (
        (stream.pendingOutput.length > 0 &&
          stream.destinationToSourceCredit > 0) ||
        stream.pendingSourceCreditBytes > 0 ||
        (stream.pendingOutput.length === 0 &&
          stream.destinationHalfClosed &&
          !stream.destinationHalfCloseSent)
      ) {
        void this.#flushOutput(stream);
      } else if (
        stream.pendingOutput.length === 0 &&
        !stream.destinationHalfClosed
      ) {
        this.#resumeOutput(stream);
      }
    }
  }

  async #awaitCapacity(stream: TcpStream): Promise<boolean> {
    let capacityAvailable = false;
    try {
      capacityAvailable = await this.#waitForCapacity(
        stream.header.attachmentId,
      );
    } catch {
      this.#close(stream, "congested", "capacity-wait-failed");
      return false;
    }
    if (!capacityAvailable) {
      this.#close(stream, "congested", "capacity-unavailable");
      return false;
    }
    return true;
  }

  async #emitStreamFrame(
    stream: TcpStream,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): Promise<boolean> {
    while (!this.#emit(header, payload)) {
      stream.rejectedOutputSequence = header.sequence;
      if (!(await this.#awaitCapacity(stream))) return false;
      if (!this.#streams.has(key(stream.header))) return false;
    }
    if (stream.rejectedOutputSequence === header.sequence) {
      stream.rejectedOutputSequence = null;
    }
    return true;
  }

  #pauseOutput(stream: TcpStream): void {
    if (stream.pausedForOutput) return;
    stream.pausedForOutput = true;
    stream.socket.pause();
  }

  #resumeOutput(stream: TcpStream): void {
    if (!stream.pausedForOutput) return;
    stream.pausedForOutput = false;
    stream.socket.resume();
  }

  #reject(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "rejected" }>["code"],
  ): void {
    void this.#emitDetached(
      {
        protocolVersion: 1,
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        sourceEndpointId: header.sourceEndpointId,
        destinationEndpointId: header.destinationEndpointId,
        connectionId: header.connectionId,
        sequence: 0,
        kind: "rejected",
        code,
      },
      EMPTY_PAYLOAD,
    );
  }

  #close(
    stream: TcpStream,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "close" }>["code"],
    reasonCode: string = code,
    outputSequence?: number,
  ): void {
    if (!this.#remove(stream)) return;
    workerLogger.rateLimited(
      `tunnel-destination-close:${reasonCode}`,
      code === "normal" ? "debug" : "warn",
      "Tunnel destination logical stream closed locally",
      {
        connectionScope: "logical-stream",
        event: "tunnel.destination.closed-locally",
        subsystem: "tunnel",
        operation: "close",
        reasonCode,
        status: code === "normal" ? "completed" : "failed",
        tunnelId: stream.header.tunnelId,
        attachmentId: stream.header.attachmentId,
        connectionId: stream.header.connectionId,
        code,
        durationMs: Date.now() - stream.startedAtMs,
        counts: {
          streams: this.#streams.size,
          pendingBytes: stream.pendingBytes,
        },
      },
    );
    void this.#emitDetached(
      {
        ...terminalResponseBase(stream, outputSequence),
        kind: "close",
        code,
      },
      EMPTY_PAYLOAD,
    );
    stream.socket.destroy();
  }

  async #emitDetached(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): Promise<void> {
    while (!this.#emit(header, payload)) {
      let available = false;
      try {
        available = await this.#waitForCapacity(header.attachmentId);
      } catch {
        return;
      }
      if (!available) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  #remove(stream: TcpStream): boolean {
    const streamKey = key(stream.header);
    if (this.#streams.get(streamKey) !== stream) return false;
    this.#streams.delete(streamKey);
    return true;
  }

  #logRejected(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    reasonCode: string,
  ): void {
    workerLogger.rateLimited(
      `tunnel-connect-rejected:${reasonCode}`,
      "warn",
      "Tunnel destination logical stream rejected",
      {
        connectionScope: "logical-stream",
        event: "tunnel.destination.rejected",
        subsystem: "tunnel",
        operation: "connect",
        reasonCode,
        status: "rejected",
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        connectionId: header.connectionId,
      },
    );
  }

  #logFailure(stream: TcpStream, reasonCode: string, code: string): void {
    workerLogger.event("warn", "Tunnel destination logical stream failed", {
      connectionScope: "logical-stream",
      event: "tunnel.destination.failed",
      subsystem: "tunnel",
      operation: "connect",
      reasonCode,
      status: "failed",
      tunnelId: stream.header.tunnelId,
      attachmentId: stream.header.attachmentId,
      connectionId: stream.header.connectionId,
      code,
      durationMs: Date.now() - stream.startedAtMs,
      counts: { streams: this.#streams.size },
    });
  }
}
