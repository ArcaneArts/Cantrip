import { Transform, type Readable } from "node:stream";

import type { AccountBandwidthChannel } from "@cantrip/protocol/resource-usage";

import type { AccountUsageRecorder } from "./bandwidth-meter.js";

interface MeteredTransform extends Transform {
  receivedEncodedLength: number;
}

export function httpBandwidthChannelForRoute(route: string) {
  return route === "/api/chats/:chatId/attachments" ||
    route === "/api/attachments/:attachmentId/content"
    ? ("attachment-transfer" as const)
    : ("http" as const);
}

export function encodedPayloadBytes(payload: unknown): number | null {
  if (typeof payload === "string") return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.byteLength;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  return null;
}

export function isReadablePayload(payload: unknown): payload is Readable {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "pipe" in payload &&
    typeof payload.pipe === "function" &&
    "on" in payload &&
    typeof payload.on === "function"
  );
}

/** Counts bytes that actually pass through a parsed or streamed HTTP body. */
export function meterPayloadStream(
  payload: Readable,
  ownerId: string,
  direction: "egress" | "ingress",
  recorder: AccountUsageRecorder,
  notifyChange = true,
  channel: AccountBandwidthChannel = "http",
): MeteredTransform {
  let completed = false;
  const transform = new Transform({
    transform(chunk: unknown, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.byteLength
        : Buffer.byteLength(String(chunk), encoding);
      transform.receivedEncodedLength += bytes;
      recorder.record({
        ownerId,
        direction,
        channel,
        bytes,
        operationCount: 0,
        notifyChange,
      });
      callback(null, chunk);
    },
    flush(callback) {
      completed = true;
      recorder.record({
        ownerId,
        direction,
        channel,
        bytes: 0,
        operationCount: 1,
        notifyChange,
      });
      callback();
    },
    destroy(error, callback) {
      if (!completed) {
        completed = true;
        recorder.record({
          ownerId,
          direction,
          channel,
          bytes: 0,
          operationCount: 1,
          notifyChange,
        });
      }
      callback(error);
    },
  }) as MeteredTransform;
  transform.receivedEncodedLength = 0;
  payload.pipe(transform);
  return transform;
}
