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

interface TcpStream {
  destinationToSourceCredit: number;
  flushing: boolean;
  header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>;
  inputSequence: number;
  outputSequence: number;
  pendingBytes: number;
  pendingOutput: Uint8Array[];
  pausedForCredit: boolean;
  socket: Socket;
  sourceHalfClosed: boolean;
  startedAtMs: number;
}

const EMPTY_PAYLOAD = new Uint8Array();
const INITIAL_CREDIT_BYTES = 256 * 1_024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_STREAMS = 256;
const MAX_SOCKET_BUFFER_BYTES = 1 * 1_024 * 1_024;

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
        this.#emit(
          {
            ...responseBase(stream),
            kind: "credit",
            direction: "source-to-destination",
            bytes: payload.byteLength,
          },
          EMPTY_PAYLOAD,
        );
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
    const socket = connect({
      host: header.target.host,
      port: header.target.port,
      allowHalfOpen: true,
    });
    const stream: TcpStream = {
      destinationToSourceCredit: header.initialCreditBytes,
      flushing: false,
      header,
      inputSequence: 1,
      outputSequence: 0,
      pendingBytes: 0,
      pendingOutput: [],
      pausedForCredit: false,
      socket,
      sourceHalfClosed: false,
      startedAtMs: Date.now(),
    };
    this.#streams.set(streamKey, stream);
    workerLogger.event("debug", "Tunnel destination connection opening", {
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
      workerLogger.event("info", "Tunnel destination connected", {
        event: "tunnel.destination.connected",
        subsystem: "tunnel",
        operation: "connect",
        status: "completed",
        tunnelId: header.tunnelId,
        attachmentId: header.attachmentId,
        connectionId: header.connectionId,
        durationMs: Date.now() - stream.startedAtMs,
      });
      if (
        !this.#emit(
          {
            ...responseBase(stream),
            kind: "accepted",
            initialCreditBytes: INITIAL_CREDIT_BYTES,
          },
          EMPTY_PAYLOAD,
        )
      ) {
        this.#remove(stream);
        socket.destroy();
      }
    });
    socket.once("timeout", () => {
      if (!this.#remove(stream)) return;
      this.#logFailure(stream, "timeout", "target-unavailable");
      this.#emit(
        {
          ...responseBase(stream),
          kind: "rejected",
          code: "target-unavailable",
        },
        EMPTY_PAYLOAD,
      );
      socket.destroy();
    });
    socket.on(
      "data",
      (data) =>
        void this.#sendData(
          stream,
          typeof data === "string" ? Buffer.from(data) : data,
        ),
    );
    socket.once("end", () => {
      if (!this.#streams.has(streamKey)) return;
      this.#emit(
        {
          ...responseBase(stream),
          kind: "half-close",
          direction: "destination-to-source",
        },
        EMPTY_PAYLOAD,
      );
    });
    socket.once("error", () => {
      if (!this.#remove(stream)) return;
      this.#logFailure(stream, "connection-error", "connection-failed");
      this.#emit(
        {
          ...responseBase(stream),
          kind: "error",
          code: "connection-failed",
        },
        EMPTY_PAYLOAD,
      );
    });
    socket.once("close", () => {
      if (!this.#remove(stream)) return;
      workerLogger.event("debug", "Tunnel destination connection closed", {
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
      this.#emit(
        {
          ...responseBase(stream),
          kind: "close",
          code: "normal",
        },
        EMPTY_PAYLOAD,
      );
    });
  }

  async #sendData(stream: TcpStream, data: Buffer): Promise<void> {
    for (const payload of chunks(data)) {
      if (!this.#streams.has(key(stream.header))) return;
      stream.pendingOutput.push(payload.slice());
      stream.pendingBytes += payload.byteLength;
      if (stream.pendingBytes > MAX_SOCKET_BUFFER_BYTES) {
        this.#close(stream, "congested");
        return;
      }
    }
    await this.#flushOutput(stream);
  }

  async #flushOutput(stream: TcpStream): Promise<void> {
    if (stream.flushing) return;
    stream.flushing = true;
    try {
      while (stream.pendingOutput.length > 0) {
        if (!this.#streams.has(key(stream.header))) return;
        const payload = stream.pendingOutput[0]!;
        if (payload.byteLength > stream.destinationToSourceCredit) {
          stream.pausedForCredit = true;
          stream.socket.pause();
          return;
        }
        stream.pendingOutput.shift();
        stream.pendingBytes -= payload.byteLength;
        stream.destinationToSourceCredit -= payload.byteLength;
        if (
          !this.#emit(
            {
              ...responseBase(stream),
              kind: "data",
              direction: "destination-to-source",
            },
            payload,
          ) ||
          !(await this.#waitForCapacity(stream.header.attachmentId))
        ) {
          this.#close(stream, "congested");
          return;
        }
      }
      if (stream.pausedForCredit) {
        stream.pausedForCredit = false;
        stream.socket.resume();
      }
    } finally {
      stream.flushing = false;
    }
  }

  #reject(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    code: Extract<TunnelDataPlaneFrameHeader, { kind: "rejected" }>["code"],
  ): void {
    this.#emit(
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
  ): void {
    if (!this.#remove(stream)) return;
    this.#emit(
      {
        ...responseBase(stream),
        kind: "close",
        code,
      },
      EMPTY_PAYLOAD,
    );
    stream.socket.destroy();
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
      "Tunnel destination connection rejected",
      {
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
    workerLogger.event("warn", "Tunnel destination connection failed", {
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
