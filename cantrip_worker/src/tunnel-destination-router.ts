import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";

import type { CodeTunnelProxy } from "./code/tunnel-proxy.js";
import type { ProjectShareTunnelDestinationAdapter } from "./project-share-tunnel-adapter.js";
import { openWorkerTunnelContentRecord } from "./tunnel-content-encryption.js";
import type { TunnelTcpDestinationAdapter } from "./tunnel-tcp-adapter.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = (attachmentId: string) => Promise<boolean>;

export class TunnelDestinationRouter {
  #emit: FrameEmitter | null = null;

  constructor(
    private readonly tcp: TunnelTcpDestinationAdapter,
    private readonly projectShares: ProjectShareTunnelDestinationAdapter,
    private readonly code: CodeTunnelProxy,
    private readonly encryption: WorkerEncryptionService,
    private readonly workerId: string,
  ) {}

  setFrameEmitter(emit: FrameEmitter, waitForCapacity: CapacityWaiter): void {
    this.#emit = emit;
    this.tcp.setFrameEmitter(emit, waitForCapacity);
    this.projectShares.setFrameEmitter(emit, waitForCapacity);
    this.code.setFrameEmitter(emit, waitForCapacity);
  }

  handleFrame(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (header.kind === "connect") {
      if (header.target.kind === "protected-tunnel") {
        void this.#handleProtectedConnect(header, payload);
      } else if (header.target.kind === "tcp")
        this.tcp.handleFrame(header, payload);
      else if (header.target.adapter === "project-share") {
        this.projectShares.handleFrame(header, payload);
      } else if (header.target.adapter === "code") {
        this.code.handleFrame(header, payload);
      }
      return;
    }
    this.tcp.handleFrame(header, payload);
    this.projectShares.handleFrame(header, payload);
    this.code.handleFrame(header, payload);
  }

  disconnect(): void {
    this.tcp.disconnect();
    this.projectShares.disconnect();
    this.code.disconnect();
  }

  close(): void {
    this.tcp.close();
    this.projectShares.close();
    this.code.close();
  }

  async #handleProtectedConnect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      if (
        header.target.kind !== "protected-tunnel" ||
        header.target.recordId !== header.tunnelId
      ) {
        throw new Error("Protected tunnel target escaped its record binding.");
      }
      const content = await openWorkerTunnelContentRecord({
        record: header.target.protectedRecord,
        serverId: this.encryption.serverIdentity(),
        service: this.encryption,
        tunnelId: header.tunnelId,
        workerId: this.workerId,
      });
      if (
        content.destination.kind !== "worker-tcp" ||
        content.destination.workerId !== this.workerId ||
        header.target.targetKind !== "tcp"
      ) {
        throw new Error("Protected tunnel target belongs to another endpoint.");
      }
      this.tcp.handleFrame(
        {
          ...header,
          target: {
            kind: "tcp",
            host: content.destination.host,
            port: content.destination.port,
          },
        },
        payload,
      );
    } catch {
      this.#emit?.(
        {
          protocolVersion: header.protocolVersion,
          tunnelId: header.tunnelId,
          attachmentId: header.attachmentId,
          sourceEndpointId: header.sourceEndpointId,
          destinationEndpointId: header.destinationEndpointId,
          connectionId: header.connectionId,
          sequence: 0,
          kind: "rejected",
          code: "target-rejected",
        },
        new Uint8Array(),
      );
    }
  }
}
