import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import type { TunnelDataProtectionConfiguration } from "@cantrip/protocol/tunnel-content";

import type { CodeTunnelProxy } from "./code/tunnel-proxy.js";
import type { CodeDirectEndpointManager } from "./code/direct-endpoint.js";
import type { ProjectShareManager } from "./project-share-manager.js";
import { openWorkerTunnelContentRecord } from "./tunnel-content-encryption.js";
import {
  openTunnelDataFrame,
  sealTunnelDataFrame,
} from "./tunnel-data-protection.js";
import type { TunnelTcpDestinationAdapter } from "./tunnel-tcp-adapter.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

type FrameEmitter = (
  header: TunnelDataPlaneFrameHeader,
  payload: Uint8Array,
) => boolean;
type CapacityWaiter = (attachmentId: string) => Promise<boolean>;

interface ProtectedConnection {
  configuration: TunnelDataProtectionConfiguration;
  targetKind: "tcp";
}

export class TunnelDestinationRouter {
  #emit: FrameEmitter | null = null;
  readonly #protections = new Map<string, ProtectedConnection>();

  constructor(
    private readonly tcp: TunnelTcpDestinationAdapter,
    private readonly projectShares: ProjectShareManager,
    private readonly code: CodeTunnelProxy,
    private readonly codeEndpoints: CodeDirectEndpointManager,
    private readonly encryption: WorkerEncryptionService,
    private readonly workerId: string,
  ) {}

  setFrameEmitter(emit: FrameEmitter, waitForCapacity: CapacityWaiter): void {
    this.#emit = emit;
    this.tcp.setFrameEmitter(
      (header, payload) => this.#emitTcp(header, payload),
      waitForCapacity,
    );
    this.code.setFrameEmitter(emit, waitForCapacity);
  }

  handleFrame(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): void {
    if (header.kind === "connect") {
      if (header.target.kind === "protected-tunnel") {
        void this.#handleProtectedConnect(header, payload);
      } else if (header.target.kind === "tcp")
        this.tcp.handleFrame(header, payload);
      else if (header.target.adapter === "code") {
        this.code.handleFrame(header, payload);
      }
      return;
    }
    const protection = this.#protections.get(connectionKey(header));
    if (protection) {
      if (header.kind === "data") {
        try {
          this.#handleProtectedFrame(
            protection.targetKind,
            { ...header, protection: undefined },
            openTunnelDataFrame(protection.configuration, header, payload),
          );
        } catch {
          this.tcp.failProtectedFrame(header);
        }
      } else {
        this.#handleProtectedFrame(protection.targetKind, header, payload);
        if (header.kind === "close" || header.kind === "error") {
          this.#protections.delete(connectionKey(header));
        }
      }
      return;
    }
    this.tcp.handleFrame(header, payload);
    this.code.handleFrame(header, payload);
  }

  disconnect(): void {
    this.#protections.clear();
    this.tcp.disconnect();
    this.code.disconnect();
  }

  close(): void {
    this.#protections.clear();
    this.tcp.close();
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
      if (content.destination.workerId !== this.workerId) {
        throw new Error("Protected tunnel target belongs to another endpoint.");
      }
      if (
        content.destination.kind === "worker-tcp" &&
        header.target.targetKind === "tcp"
      ) {
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          targetKind: "tcp",
        });
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
        return;
      }
      if (
        content.destination.kind === "worker-code" &&
        header.target.targetKind === "code" &&
        content.destination.resourceId === header.target.recordId
      ) {
        const endpoint = await this.codeEndpoints.prepareProtected(
          header.tunnelId,
          content.destination.sessionId,
        );
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          targetKind: "tcp",
        });
        this.tcp.handleFrame({ ...header, target: endpoint }, payload);
        return;
      }
      if (
        content.destination.kind === "worker-project-share" &&
        header.target.targetKind === "project-share" &&
        content.destination.resourceId === header.target.recordId
      ) {
        const share = await this.projectShares.open({
          password: content.destination.password,
          publicBasePath: content.destination.publicBasePath,
          publicOrigin: content.destination.publicOrigin,
          realm: content.destination.realm,
          root: content.destination.root,
          shareId: content.destination.resourceId,
          username: content.destination.username,
        });
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          targetKind: "tcp",
        });
        this.tcp.handleFrame(
          {
            ...header,
            target: {
              kind: "tcp",
              host: share.loopbackHost,
              port: share.loopbackPort,
            },
          },
          payload,
        );
        return;
      }
      throw new Error("Protected tunnel target belongs to another endpoint.");
    } catch {
      this.#protections.delete(connectionKey(header));
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

  #emitTcp(header: TunnelDataPlaneFrameHeader, payload: Uint8Array): boolean {
    return this.#emitProtected(header, payload);
  }

  #emitProtected(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const key = connectionKey(header);
    const connection = this.#protections.get(key);
    let emittedHeader = header;
    let emittedPayload = payload;
    if (connection && header.kind === "data") {
      try {
        const sealed = sealTunnelDataFrame(
          connection.configuration,
          header,
          payload,
        );
        emittedHeader = sealed.header;
        emittedPayload = sealed.payload;
      } catch {
        return false;
      }
    }
    const sent = this.#emit?.(emittedHeader, emittedPayload) ?? false;
    if (
      header.kind === "rejected" ||
      header.kind === "close" ||
      header.kind === "error"
    ) {
      this.#protections.delete(key);
    }
    return sent;
  }

  #handleProtectedFrame(
    targetKind: ProtectedConnection["targetKind"],
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): void {
    if (targetKind === "tcp") this.tcp.handleFrame(header, payload);
  }
}

function connectionKey(header: TunnelDataPlaneFrameHeader): string {
  return `${header.tunnelId}\0${header.attachmentId}\0${header.connectionId}`;
}
