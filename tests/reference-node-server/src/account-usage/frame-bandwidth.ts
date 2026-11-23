import type { AccountBandwidthChannel } from "@cantrip/protocol/resource-usage";

import type { AccountUsageRecorder } from "./bandwidth-meter.js";

/** Returns the encoded application-frame bytes exposed by WebSocket libraries. */
export function encodedFrameBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + encodedFrameBytes(chunk), 0);
  }
  return Buffer.byteLength(String(data));
}

export function recordEncodedFrame(
  recorder: AccountUsageRecorder | undefined,
  input: {
    channel: AccountBandwidthChannel;
    data: unknown;
    direction: "egress" | "ingress";
    ownerId: string;
  },
): void {
  recorder?.record({
    ownerId: input.ownerId,
    direction: input.direction,
    channel: input.channel,
    bytes: encodedFrameBytes(input.data),
  });
}
