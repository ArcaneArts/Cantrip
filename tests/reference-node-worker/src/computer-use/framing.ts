import {
  CUA_NATIVE_ERROR_CODES,
  type CuaNativeErrorCode,
  CuaProcessError,
} from "./errors.js";

export const CUA_PROTOCOL_VERSION = 1;
export const CUA_MAX_HEADER_BYTES = 16 * 1024 * 1024;
export const CUA_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type CuaOutcome =
  | { status: "ok"; data: unknown }
  | {
      status: "error";
      error: { code: CuaNativeErrorCode; message: string };
    };

export type CuaMessage =
  | { kind: "request"; requestId: number; operation: unknown }
  | { kind: "cancel"; requestId: number }
  | {
      kind: "event";
      sequence: number;
      sessionId: string | null;
      event: unknown;
    }
  | {
      kind: "hostCall";
      evaluationRequestId: number;
      callId: number;
      action: unknown;
    }
  | {
      kind: "hostResult";
      evaluationRequestId: number;
      callId: number;
      result: CuaOutcome;
    }
  | {
      kind: "response";
      requestId: number;
      result: CuaOutcome;
    };

export interface CuaFrame {
  header: { version: number; message: CuaMessage };
  payload: Buffer;
}

function fields(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function outcome(value: unknown): value is CuaOutcome {
  return (
    (fields(value, ["status", "data"]) && value.status === "ok") ||
    (fields(value, ["status", "error"]) &&
      value.status === "error" &&
      fields(value.error, ["code", "message"]) &&
      CUA_NATIVE_ERROR_CODES.includes(value.error.code as CuaNativeErrorCode) &&
      typeof value.error.message === "string")
  );
}

function validateHeader(
  value: unknown,
  payloadLength: number,
): CuaFrame["header"] {
  const invalid = () => new CuaProcessError("protocol-error");
  if (
    !fields(value, ["version", "message"]) ||
    value.version !== CUA_PROTOCOL_VERSION
  )
    throw invalid();
  const message = value.message;
  if (
    message === null ||
    typeof message !== "object" ||
    !Object.hasOwn(message, "kind")
  )
    throw invalid();
  const kind = (message as Record<string, unknown>).kind;
  switch (kind) {
    case "request":
      if (
        !fields(message, ["kind", "requestId", "operation"]) ||
        !sequence(message.requestId)
      )
        throw invalid();
      break;
    case "cancel":
      if (
        !fields(message, ["kind", "requestId"]) ||
        !sequence(message.requestId)
      )
        throw invalid();
      break;
    case "event":
      if (
        !fields(message, ["kind", "sequence", "sessionId", "event"]) ||
        !sequence(message.sequence) ||
        !(message.sessionId === null || typeof message.sessionId === "string")
      )
        throw invalid();
      break;
    case "hostCall":
      if (
        !fields(message, ["kind", "evaluationRequestId", "callId", "action"]) ||
        !sequence(message.evaluationRequestId) ||
        !sequence(message.callId)
      )
        throw invalid();
      break;
    case "hostResult":
      if (
        !fields(message, ["kind", "evaluationRequestId", "callId", "result"]) ||
        !sequence(message.evaluationRequestId) ||
        !sequence(message.callId) ||
        !outcome(message.result)
      )
        throw invalid();
      break;
    case "response": {
      if (
        !fields(message, ["kind", "requestId", "result"]) ||
        !sequence(message.requestId) ||
        !outcome(message.result)
      )
        throw invalid();
      break;
    }
    default:
      throw invalid();
  }
  const header = value as unknown as CuaFrame["header"];
  if (
    payloadLength !== 0 &&
    !(
      header.message.kind === "response" &&
      header.message.result.status === "ok"
    )
  )
    throw invalid();
  return header;
}

export function encodeCuaFrame(
  header: CuaFrame["header"],
  payload: Buffer = EMPTY,
): Buffer {
  try {
    if (!Buffer.isBuffer(payload) || payload.length > CUA_MAX_PAYLOAD_BYTES)
      throw new Error();
    validateHeader(header, payload.length);
    const json = Buffer.from(JSON.stringify(header));
    if (json.length === 0 || json.length > CUA_MAX_HEADER_BYTES)
      throw new Error();
    // JSON can omit undefined/functions or invoke toJSON. Validate the actual
    // bytes too, so an invalid host result never corrupts a live process stream.
    validateHeader(JSON.parse(utf8.decode(json)), payload.length);
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(json.length, 0);
    prefix.writeUInt32BE(payload.length, 4);
    return Buffer.concat([prefix, json, payload]);
  } catch {
    throw new CuaProcessError("invalid-request", "not-sent");
  }
}

/** Allocates one bounded header, then validates it before allocating its payload. */
export class CuaFrameDecoder {
  #prefix = Buffer.alloc(8);
  #prefixRead = 0;
  #headerBytes: Buffer | undefined;
  #headerRead = 0;
  #header: CuaFrame["header"] | undefined;
  #payloadLength = 0;
  #payload: Buffer | undefined;
  #payloadRead = 0;
  #failed = false;

  constructor(private readonly onFrame: (frame: CuaFrame) => void) {}

  get bufferedBytes(): number {
    return this.#prefixRead + this.#headerRead + this.#payloadRead;
  }

  push(chunk: Buffer): void {
    if (this.#failed) throw new CuaProcessError("protocol-error");
    try {
      if (!Buffer.isBuffer(chunk)) throw new Error();
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
          if (
            headerLength === 0 ||
            headerLength > CUA_MAX_HEADER_BYTES ||
            this.#payloadLength > CUA_MAX_PAYLOAD_BYTES
          )
            throw new Error();
          this.#headerBytes = Buffer.alloc(headerLength);
        }
        if (!this.#headerBytes) throw new Error();
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
          this.#header = validateHeader(
            JSON.parse(utf8.decode(this.#headerBytes)),
            this.#payloadLength,
          );
          this.#payload =
            this.#payloadLength === 0
              ? EMPTY
              : Buffer.alloc(this.#payloadLength);
        }
        if (!this.#payload || !this.#header) throw new Error();
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
        const frame: CuaFrame = {
          header: this.#header,
          payload: this.#payload,
        };
        this.#prefixRead =
          this.#headerRead =
          this.#payloadRead =
          this.#payloadLength =
            0;
        this.#headerBytes = this.#payload = undefined;
        this.#header = undefined;
        this.onFrame(frame);
      }
    } catch {
      this.#failed = true;
      this.#headerBytes = this.#payload = undefined;
      throw new CuaProcessError("protocol-error");
    }
  }

  finish(): void {
    if (this.#failed || this.bufferedBytes !== 0)
      throw new CuaProcessError("protocol-error");
  }
}
