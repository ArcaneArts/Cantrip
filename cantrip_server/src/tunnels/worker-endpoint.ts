import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";
import type {
  TunnelDataPlaneEndpoint,
  TunnelEndpointFrameListener,
} from "./broker.js";

export class WorkerTunnelEndpoint implements TunnelDataPlaneEndpoint {
  readonly endpointId: string;
  readonly placement: { kind: "worker"; workerId: string };

  constructor(
    private readonly bridge: WorkerCommandBus,
    readonly workerId: string,
    endpointId = `worker:${workerId}`,
  ) {
    this.endpointId = endpointId;
    this.placement = { kind: "worker", workerId };
  }

  send(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    return (
      this.bridge.sendTunnelDataPlaneFrame?.(this.workerId, header, payload) ??
      false
    );
  }

  subscribe(listener: TunnelEndpointFrameListener): () => void {
    const subscribe = this.bridge.subscribeTunnelDataPlaneFrames;
    if (!subscribe) return () => undefined;
    return subscribe.call(this.bridge, this.workerId, (header, payload) => {
      if (
        header.sourceEndpointId === this.endpointId ||
        header.destinationEndpointId === this.endpointId
      ) {
        listener(header, payload);
      }
    });
  }

  subscribeDisconnect(listener: () => void): () => void {
    return this.bridge.subscribeWorkerDisconnect(this.workerId, listener);
  }
}
