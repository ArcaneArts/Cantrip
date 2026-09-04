import { spawn } from "node:child_process";

export const PROTOCOL_VERSION = 1;
export const MAX_HEADER_BYTES = 65_536;
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);
const utf8 = new TextDecoder("utf-8", { fatal: true });

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, expected) {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function sequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateHeader(header, payloadLength) {
  if (
    !fields(header, ["version", "message"]) ||
    header.version !== PROTOCOL_VERSION ||
    !record(header.message)
  ) {
    throw new Error("Invalid CUA protocol header or version.");
  }
  const message = header.message;
  switch (message.kind) {
    case "request":
      if (
        !fields(message, ["kind", "requestId", "operation"]) ||
        !sequence(message.requestId)
      ) {
        throw new Error("Invalid CUA request frame.");
      }
      break;
    case "cancel":
      if (
        !fields(message, ["kind", "requestId"]) ||
        !sequence(message.requestId)
      ) {
        throw new Error("Invalid CUA cancellation frame.");
      }
      break;
    case "event":
      if (
        !fields(message, ["kind", "sequence", "sessionId", "event"]) ||
        !sequence(message.sequence) ||
        !(message.sessionId === null || typeof message.sessionId === "string")
      ) {
        throw new Error("Invalid CUA event frame.");
      }
      break;
    case "response": {
      if (
        !fields(message, ["kind", "requestId", "result"]) ||
        !sequence(message.requestId) ||
        !record(message.result)
      ) {
        throw new Error("Invalid CUA response frame.");
      }
      const result = message.result;
      if (result.status === "ok" && fields(result, ["status", "data"])) break;
      if (
        result.status === "error" &&
        fields(result, ["status", "error"]) &&
        fields(result.error, ["code", "message"]) &&
        typeof result.error.code === "string" &&
        typeof result.error.message === "string"
      ) {
        break;
      }
      throw new Error("Invalid CUA response outcome.");
    }
    default:
      throw new Error("Unknown CUA frame kind.");
  }
  if (
    payloadLength !== 0 &&
    !(message.kind === "response" && message.result.status === "ok")
  ) {
    throw new Error("Only successful CUA responses may carry image bytes.");
  }
}

export function encodeFrame(header, payload = EMPTY) {
  if (!Buffer.isBuffer(payload) || payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error("Invalid CUA binary payload length.");
  }
  validateHeader(header, payload.length);
  const json = Buffer.from(JSON.stringify(header));
  if (json.length === 0 || json.length > MAX_HEADER_BYTES) {
    throw new Error("CUA frame header exceeds its byte limit.");
  }
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, json, payload]);
}

/** Incremental framing with one bounded header/payload, never a growing concat buffer. */
export class FrameDecoder {
  #prefix = Buffer.alloc(8);
  #prefixRead = 0;
  #headerBytes;
  #headerRead = 0;
  #header;
  #payloadLength = 0;
  #payload;
  #payloadRead = 0;
  #failed;
  #onFrame;

  constructor(onFrame) {
    this.#onFrame = onFrame;
  }

  get bufferedBytes() {
    return this.#prefixRead + this.#headerRead + this.#payloadRead;
  }

  push(chunk) {
    if (this.#failed) throw this.#failed;
    try {
      if (!Buffer.isBuffer(chunk))
        throw new Error("CUA frames must contain bytes.");
      let offset = 0;
      while (offset < chunk.length) {
        if (this.#prefixRead < 8) {
          const count = Math.min(8 - this.#prefixRead, chunk.length - offset);
          chunk.copy(this.#prefix, this.#prefixRead, offset, offset + count);
          this.#prefixRead += count;
          offset += count;
          if (this.#prefixRead !== 8) continue;
          const headerLength = this.#prefix.readUInt32BE(0);
          this.#payloadLength = this.#prefix.readUInt32BE(4);
          if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
            throw new Error("Invalid CUA frame header length.");
          }
          if (this.#payloadLength > MAX_PAYLOAD_BYTES) {
            throw new Error("CUA frame payload exceeds its byte limit.");
          }
          this.#headerBytes = Buffer.alloc(headerLength);
        }
        if (this.#headerRead < this.#headerBytes.length) {
          const count = Math.min(
            this.#headerBytes.length - this.#headerRead,
            chunk.length - offset,
          );
          chunk.copy(
            this.#headerBytes,
            this.#headerRead,
            offset,
            offset + count,
          );
          this.#headerRead += count;
          offset += count;
          if (this.#headerRead !== this.#headerBytes.length) continue;
          try {
            this.#header = JSON.parse(utf8.decode(this.#headerBytes));
          } catch {
            throw new Error("Invalid CUA UTF-8 JSON header.");
          }
          // Reject header/payload combinations before allocating image memory.
          validateHeader(this.#header, this.#payloadLength);
          this.#payload =
            this.#payloadLength === 0
              ? EMPTY
              : Buffer.alloc(this.#payloadLength);
        }
        if (this.#payloadRead < this.#payloadLength) {
          const count = Math.min(
            this.#payloadLength - this.#payloadRead,
            chunk.length - offset,
          );
          chunk.copy(this.#payload, this.#payloadRead, offset, offset + count);
          this.#payloadRead += count;
          offset += count;
          if (this.#payloadRead !== this.#payloadLength) continue;
        }
        const frame = { header: this.#header, payload: this.#payload };
        this.#prefixRead = 0;
        this.#headerBytes = undefined;
        this.#headerRead = 0;
        this.#header = undefined;
        this.#payloadLength = 0;
        this.#payload = undefined;
        this.#payloadRead = 0;
        this.#onFrame(frame);
      }
    } catch (error) {
      this.#failed = error;
      this.#headerBytes = undefined;
      this.#payload = undefined;
      throw error;
    }
  }

  finish() {
    if (this.#failed) throw this.#failed;
    if (this.bufferedBytes !== 0)
      throw new Error("CUA stdout ended inside a frame.");
  }
}

/** Actual child-process transport for build/package smoke checks, not a worker session owner. */
export class FramedCuaProcess {
  #child;
  #decoder;
  #pending = new Map();
  #requestId = 0;
  #eventSequence = 0;
  #events = 0;
  #stderrBytes = 0;
  #failure;
  #closing = false;
  #closed = false;
  #deadline;
  #killTimer;
  #exit;

  constructor(
    binary,
    { args = [], timeoutMs = 15_000, cwd, env = process.env, signal } = {},
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new Error(
        "CUA smoke timeout must be between 1 and 120000 milliseconds.",
      );
    }
    this.#child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#decoder = new FrameDecoder((frame) => this.#receive(frame));
    this.#exit = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        clearTimeout(this.#deadline);
        clearTimeout(this.#killTimer);
        if (
          !this.#closing ||
          this.#pending.size !== 0 ||
          code !== 0 ||
          signal !== null
        ) {
          this.#fail(
            new Error("CUA process exited before a clean smoke shutdown."),
          );
        }
        resolve({ code, signal });
      });
    });
    this.#child.once("error", () =>
      this.#fail(new Error("CUA executable could not be launched.")),
    );
    this.#child.stdin.on("error", () =>
      this.#fail(new Error("CUA stdin failed.")),
    );
    this.#child.stdout.on("error", () =>
      this.#fail(new Error("CUA stdout failed.")),
    );
    this.#child.stderr.on("error", () =>
      this.#fail(new Error("CUA stderr failed.")),
    );
    this.#child.stderr.on("data", (chunk) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > MAX_HEADER_BYTES) {
        this.#fail(new Error("CUA diagnostic output exceeded its byte limit."));
      }
    });
    this.#child.stdout.on("data", (chunk) => {
      if (this.#failure) return;
      try {
        this.#decoder.push(chunk);
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#child.stdout.once("end", () => {
      if (this.#failure) return;
      try {
        this.#decoder.finish();
      } catch (error) {
        this.#fail(error);
      }
    });
    this.#deadline = setTimeout(
      () => this.#fail(new Error("CUA smoke process deadline exceeded.")),
      timeoutMs,
    );
    if (signal) {
      const abort = () => this.#fail(new Error("CUA smoke was cancelled."));
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        this.#child.once("close", () =>
          signal.removeEventListener("abort", abort),
        );
      }
    }
  }

  get eventCount() {
    return this.#events;
  }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    clearTimeout(this.#deadline);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.#closed) {
      this.#child.kill("SIGTERM");
      this.#killTimer = setTimeout(() => this.#child.kill("SIGKILL"), 250);
      this.#killTimer.unref();
    }
  }

  #receive(frame) {
    const message = frame.header.message;
    if (message.kind === "event") {
      if (message.sequence <= this.#eventSequence || this.#events >= 256) {
        throw new Error("CUA events exceeded their sequence or count bound.");
      }
      this.#eventSequence = message.sequence;
      this.#events += 1;
      return;
    }
    if (message.kind !== "response" || !this.#pending.has(message.requestId)) {
      throw new Error("CUA response did not match a pending request.");
    }
    const pending = this.#pending.get(message.requestId);
    this.#pending.delete(message.requestId);
    if (message.result.status === "error") {
      // Do not echo arbitrary native messages, target titles, or identifiers.
      pending.reject(new Error("CUA operation returned an error outcome."));
    } else {
      pending.resolve({ data: message.result.data, payload: frame.payload });
    }
  }

  request(operation) {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closing || this.#closed || this.#pending.size >= 32) {
      return Promise.reject(
        new Error("CUA smoke transport is closed or at capacity."),
      );
    }
    const requestId = ++this.#requestId;
    const encoded = encodeFrame({
      version: PROTOCOL_VERSION,
      message: { kind: "request", requestId, operation },
    });
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#child.stdin.write(encoded, (error) => {
        if (error) this.#fail(new Error("CUA request write failed."));
      });
    });
  }

  async close() {
    if (!this.#failure) {
      this.#closing = true;
      this.#child.stdin.end();
    }
    await this.#exit;
    if (this.#failure) throw this.#failure;
  }

  async dispose() {
    if (!this.#closed)
      this.#fail(new Error("CUA smoke transport was disposed."));
    await this.#exit;
  }
}
