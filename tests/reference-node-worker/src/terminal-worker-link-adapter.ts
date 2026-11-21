import {
  terminalClientMessageSchema,
  terminalServerMessageSchema,
  workerLinkTerminalGrantRequestSchema,
  type SurfaceStreamContext,
  type SurfaceStreamOpaque,
  type TerminalServerMessage,
} from "@cantrip/protocol";

import type {
  WorkerLinkAdapterEmitter,
  WorkerLinkResourceAdapter,
} from "./worker-link-gateway.js";
import type {
  TerminalManager,
  TerminalRuntimeEvent,
} from "./terminal-manager.js";
import type { SurfaceStreamReplayGuard } from "./surface-stream-encryption.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_OUTPUT_CHUNK_CHARACTERS = 32 * 1_024;
const MAX_PENDING_OUTPUT_FRAMES = 128;
const MAX_PENDING_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAX_PENDING_PLAINTEXT_CHARACTERS = 2_000_000;

type TerminalRuntime = Pick<
  TerminalManager,
  "attachExisting" | "detach" | "input" | "resize"
>;

export interface TerminalWorkerLinkAdapterOptions {
  inputAllowed(terminalId: string): boolean;
  openInput(
    context: SurfaceStreamContext,
    opaque: SurfaceStreamOpaque,
  ): Promise<{ type: "terminal.input"; data: string }>;
  protectOutput(
    context: SurfaceStreamContext,
    event: Extract<TerminalRuntimeEvent, { type: "terminal.output" }>,
  ): Promise<SurfaceStreamOpaque>;
  replay: Pick<SurfaceStreamReplayGuard, "accept" | "release" | "reserve">;
}

export class TerminalWorkerLinkAdapter implements WorkerLinkResourceAdapter {
  readonly kind = "terminal" as const;

  constructor(
    private readonly terminals: TerminalRuntime,
    private readonly options: TerminalWorkerLinkAdapterOptions,
  ) {}

  open: WorkerLinkResourceAdapter["open"] = ({
    channel,
    emit,
    grant,
    session,
  }) => {
    const terminalId = grant.binding.resource.resourceId;
    const operationId =
      workerLinkTerminalGrantRequestSchema.shape.operationId.parse(
        grant.binding.resource.attachmentId,
      );
    if (!this.options.inputAllowed(terminalId)) {
      throw new Error("Run configuration terminals are read-only.");
    }
    const attachmentId = `worker-link:${channel.channelId}`;
    const stream = new TerminalWorkerLinkChannel({
      attachmentId,
      emit,
      inputAllowed: this.options.inputAllowed,
      openInput: this.options.openInput,
      operationId,
      protectOutput: this.options.protectOutput,
      replay: this.options.replay,
      serverId: session.identity.serverId,
      terminalId,
      terminals: this.terminals,
    });
    stream.attach();
    return stream;
  };
}

interface TerminalWorkerLinkChannelOptions extends TerminalWorkerLinkAdapterOptions {
  attachmentId: string;
  emit: WorkerLinkAdapterEmitter;
  operationId: string;
  serverId: string;
  terminalId: string;
  terminals: TerminalRuntime;
}

class TerminalWorkerLinkChannel {
  #closeAfterDrain = false;
  #closed = false;
  #draining = false;
  #outputSequence = 0;
  #outputTail = Promise.resolve();
  #pendingBytes = 0;
  #pendingPlaintextCharacters = 0;
  readonly #pending: Uint8Array[] = [];

  constructor(private readonly options: TerminalWorkerLinkChannelOptions) {}

  attach(): void {
    let opened: ReturnType<TerminalRuntime["attachExisting"]>;
    try {
      opened = this.options.terminals.attachExisting(
        this.options.terminalId,
        this.options.attachmentId,
        (event) => this.#scheduleRuntimeEvent(event),
      );
    } catch (error) {
      this.options.replay.release(this.#inputContext());
      throw error;
    }
    void opened
      .then((result) => {
        if (result.status !== "exited") return;
        this.#outputTail = this.#outputTail.then(() => {
          if (this.#closed) return;
          this.#enqueue({ type: "exit", ...result });
          this.#closeAfterDrain = true;
          this.#drain();
        });
      })
      .catch(() => this.#fail("io-error", "endpoint-disconnected"));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.options.terminals.detach(
      this.options.terminalId,
      this.options.attachmentId,
    );
    this.options.replay.release(this.#inputContext());
  }

  credit(): void {
    this.#drain();
  }

  async write(payload: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("Terminal WorkerLink channel is closed.");
    let message: ReturnType<typeof terminalClientMessageSchema.parse>;
    try {
      message = terminalClientMessageSchema.parse(
        JSON.parse(decoder.decode(payload)),
      );
    } catch {
      this.#fail("payload-invalid", "protocol-error");
      throw new Error("Terminal WorkerLink payload is invalid.");
    }
    if (message.type === "resize") {
      this.options.terminals.resize(
        this.options.terminalId,
        message.cols,
        message.rows,
      );
      return;
    }
    if (
      message.operationId !== this.options.operationId ||
      !this.options.inputAllowed(this.options.terminalId)
    ) {
      this.#fail("payload-invalid", "protocol-error");
      throw new Error("Terminal WorkerLink input is not authorized.");
    }
    const context = {
      ...this.#inputContext(),
      sequence: message.sequence,
    };
    this.options.replay.reserve(context);
    const content = await this.options.openInput(
      context,
      message.protectedData,
    );
    this.options.terminals.input(this.options.terminalId, content.data);
    this.options.replay.accept(context, false);
  }

  #scheduleRuntimeEvent(event: TerminalRuntimeEvent): void {
    if (this.#closed) return;
    if (event.type === "terminal.ready") {
      this.#outputTail = this.#outputTail.then(() => {
        if (!this.#closed) this.#enqueue({ type: "ready" });
      });
      return;
    }
    const chunks = outputChunks(event.data);
    const characters = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (
      this.#pendingPlaintextCharacters + characters >
      MAX_PENDING_PLAINTEXT_CHARACTERS
    ) {
      this.#fail("credit-exceeded", "congested");
      return;
    }
    this.#pendingPlaintextCharacters += characters;
    for (const [chunkIndex, data] of chunks.entries()) {
      const sequence = this.#outputSequence;
      this.#outputSequence += 1;
      this.#outputTail = this.#outputTail
        .then(async () => {
          if (this.#closed) return;
          const protectedData = await this.options.protectOutput(
            {
              ...this.#inputContext(),
              direction: "output",
              sequence,
            },
            { type: "terminal.output", data },
          );
          this.#pendingPlaintextCharacters -= data.length;
          this.#enqueue({
            type: "output",
            operationId: this.options.operationId,
            sequence,
            protectedData,
            ...(chunkIndex === 0 && event.hydration
              ? { hydration: event.hydration }
              : {}),
          });
        })
        .catch(() => this.#fail("io-error", "protocol-error"));
    }
  }

  #enqueue(message: TerminalServerMessage): void {
    if (this.#closed) return;
    const payload = encoder.encode(
      JSON.stringify(terminalServerMessageSchema.parse(message)),
    );
    if (
      this.#pending.length >= MAX_PENDING_OUTPUT_FRAMES ||
      this.#pendingBytes + payload.byteLength > MAX_PENDING_OUTPUT_BYTES
    ) {
      this.#fail("credit-exceeded", "congested");
      return;
    }
    this.#pending.push(payload);
    this.#pendingBytes += payload.byteLength;
    this.#drain();
  }

  #drain(): void {
    if (this.#closed || this.#draining) return;
    this.#draining = true;
    try {
      while (this.#pending.length > 0) {
        const payload = this.#pending[0]!;
        if (!this.options.emit.data(payload)) return;
        this.#pending.shift();
        this.#pendingBytes -= payload.byteLength;
      }
      if (this.#closeAfterDrain) {
        this.#closeAfterDrain = false;
        void this.options.emit.close("normal");
      }
    } finally {
      this.#draining = false;
    }
  }

  #fail(
    error: "credit-exceeded" | "io-error" | "payload-invalid",
    close: "congested" | "endpoint-disconnected" | "protocol-error",
  ): void {
    if (this.#closed) return;
    this.options.emit.error(error);
    void this.options.emit.close(close);
  }

  #inputContext(): Omit<SurfaceStreamContext, "sequence"> {
    return {
      serverId: this.options.serverId,
      surfaceKind: "terminal",
      surfaceId: this.options.terminalId,
      operationId: this.options.operationId,
      direction: "input",
    };
  }
}

function outputChunks(data: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + MAX_OUTPUT_CHUNK_CHARACTERS);
    if (
      end < data.length &&
      end > offset &&
      isHighSurrogate(data.charCodeAt(end - 1)) &&
      isLowSurrogate(data.charCodeAt(end))
    ) {
      end -= 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
