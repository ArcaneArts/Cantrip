import {
  encodeTunnelDataPlaneFrame,
  type TunnelDataPlaneFrameHeader,
} from "@cantrip/protocol";
import type { AccountBandwidthChannel } from "@cantrip/protocol/resource-usage";

import type { AccountUsageRecorder } from "../account-usage/bandwidth-meter.js";
import { recordEncodedFrame } from "../account-usage/frame-bandwidth.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import type {
  TunnelDataPlaneEndpoint,
  TunnelEndpointFrameListener,
} from "./broker.js";

type WorkerOfflineSubscription = {
  subscribeWorkerOffline?: WorkerCommandBus["subscribeWorkerDisconnect"];
};

export function subscribeWorkerTerminalOffline(
  bridge: WorkerCommandBus,
  workerId: string,
  listener: () => void,
): () => void {
  const subscribeOffline = (
    bridge as WorkerCommandBus & WorkerOfflineSubscription
  ).subscribeWorkerOffline;
  return subscribeOffline
    ? subscribeOffline.call(bridge, workerId, listener)
    : bridge.subscribeWorkerDisconnect(workerId, listener);
}

export class WorkerTunnelEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "worker"; workerId: string };

  constructor(
    private readonly bridge: WorkerCommandBus,
    readonly workerId: string,
    endpointId = `worker:${workerId}`,
    readonly usage?: {
      attachmentId: string;
      channel: AccountBandwidthChannel;
      ownerId: string;
      recorder: AccountUsageRecorder;
    },
  ) {
    this.endpointId = endpointId;
    this.placement = { kind: "worker", workerId };
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    const sent =
      this.bridge.sendTunnelDataPlaneFrame?.(this.workerId, header, payload) ??
      false;
    if (sent) {
      recordEncodedFrame(this.usage?.recorder, {
        ownerId: this.usage?.ownerId ?? "",
        direction: "egress",
        channel: this.usage?.channel ?? "tunnel-relay",
        data: encodeTunnelDataPlaneFrame(header, payload),
      });
    }
    return sent;
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    const subscribe = this.bridge.subscribeTunnelDataPlaneFrames;
    if (!subscribe) return () => undefined;
    return subscribe.call(this.bridge, this.workerId, (header, payload) => {
      if (
        (header.sourceEndpointId === this.endpointId ||
          header.destinationEndpointId === this.endpointId) &&
        (!this.usage || header.attachmentId === this.usage.attachmentId)
      ) {
        recordEncodedFrame(this.usage?.recorder, {
          ownerId: this.usage?.ownerId ?? "",
          direction: "ingress",
          channel: this.usage?.channel ?? "tunnel-relay",
          data: encodeTunnelDataPlaneFrame(header, payload),
        });
        listener(header, payload);
      }
    });
  }

  subscribeDisconnect(listener: () => void): () => void {
    return subscribeWorkerTerminalOffline(this.bridge, this.workerId, listener);
  }
}
