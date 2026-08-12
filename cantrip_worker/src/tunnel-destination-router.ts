import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";

import type { ProjectShareTunnelDestinationAdapter } from "./project-share-tunnel-adapter.js";
import type { TunnelTcpDestinationAdapter } from "./tunnel-tcp-adapter.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = () => Promise<boolean>;

export class TunnelDestinationRouter {
  constructor(
    private readonly tcp: TunnelTcpDestinationAdapter,
    private readonly projectShares: ProjectShareTunnelDestinationAdapter,
  ) {}

  setFrameEmitter(emit: FrameEmitter, waitForCapacity: CapacityWaiter): void {
    this.tcp.setFrameEmitter(emit, waitForCapacity);
    this.projectShares.setFrameEmitter(emit, waitForCapacity);
  }

  handleFrame(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (header.kind === "connect") {
      if (header.target.kind === "tcp") this.tcp.handleFrame(header, payload);
      else if (header.target.adapter === "project-share") {
        this.projectShares.handleFrame(header, payload);
      }
      return;
    }
    this.tcp.handleFrame(header, payload);
    this.projectShares.handleFrame(header, payload);
  }

  disconnect(): void {
    this.tcp.disconnect();
    this.projectShares.disconnect();
  }

  close(): void {
    this.tcp.close();
    this.projectShares.close();
  }
}
