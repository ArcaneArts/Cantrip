import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import type { TunnelDataProtectionConfiguration } from "@cantrip/protocol/tunnel-content";

import type { CodeDirectEndpointManager } from "./code/direct-endpoint.js";
import type { ProjectShareManager } from "./project-share-manager.js";
import { workerLogErrorIdentity, workerLogger } from "./logger.js";
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
  diagnosticTraceId?: string;
  targetKind: "tcp";
}

interface TunnelDiagnosticContext {
  diagnosticTraceId?: string;
}

export class TunnelDestinationRouter {
  #emit: FrameEmitter | null = null;
  readonly #protections = new Map<string, ProtectedConnection>();

  constructor(
    private readonly tcp: TunnelTcpDestinationAdapter,
    private readonly projectShares: ProjectShareManager,
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
  }

  handleFrame(
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
    diagnostics: TunnelDiagnosticContext = {},
  ): void {
    if (header.kind === "connect") {
      if (header.target.kind === "protected-tunnel") {
        void this.#handleProtectedConnect(header, payload, diagnostics);
      } else if (header.target.kind === "tcp")
        this.tcp.handleFrame(header, payload);
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
        } catch (error) {
          workerLogger.rateLimited(
            `tunnel-protected-frame-open-failed:${header.tunnelId}`,
            "warn",
            "Protected tunnel data frame rejected",
            {
              event: "tunnel.protected-frame.rejected",
              subsystem: "tunnel",
              operation: "open-protected-frame",
              reasonCode: "data-open-failed",
              status: "rejected",
              tunnelId: header.tunnelId,
              attachmentId: header.attachmentId,
              connectionId: header.connectionId,
              ...(protection.diagnosticTraceId
                ? { diagnosticTraceId: protection.diagnosticTraceId }
                : {}),
              ...workerLogErrorIdentity(error),
            },
          );
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
  }

  disconnect(): void {
    this.#protections.clear();
    this.tcp.disconnect();
  }

  close(): void {
    this.#protections.clear();
    this.tcp.close();
  }

  async #handleProtectedConnect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    payload: Uint8Array,
    diagnostics: TunnelDiagnosticContext,
  ): Promise<void> {
    let reasonCode = "invalid-target-binding";
    let sessionId: string | undefined;
    const targetKind =
      header.target.kind === "protected-tunnel"
        ? header.target.targetKind
        : "unknown";
    const context = () => ({
      tunnelId: header.tunnelId,
      attachmentId: header.attachmentId,
      connectionId: header.connectionId,
      mode: targetKind,
      ...(sessionId ? { sessionId } : {}),
      ...(diagnostics.diagnosticTraceId
        ? { diagnosticTraceId: diagnostics.diagnosticTraceId }
        : {}),
    });
    try {
      if (
        header.target.kind !== "protected-tunnel" ||
        header.target.recordId !== header.tunnelId
      ) {
        throw new Error("Protected tunnel target escaped its record binding.");
      }
      reasonCode = "protected-record-open-failed";
      const content = await openWorkerTunnelContentRecord({
        record: header.target.protectedRecord,
        serverId: this.encryption.serverIdentity(),
        service: this.encryption,
        tunnelId: header.tunnelId,
        workerId: this.workerId,
      });
      reasonCode = "worker-id-mismatch";
      if (content.destination.workerId !== this.workerId) {
        throw new Error("Protected tunnel target belongs to another endpoint.");
      }
      if (content.destination.kind === "worker-code") {
        sessionId = content.destination.sessionId;
      }
      reasonCode = "target-kind-mismatch";
      if (
        content.destination.kind === "worker-tcp" &&
        header.target.targetKind === "tcp"
      ) {
        reasonCode = "tcp-target-handoff-failed";
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          diagnosticTraceId: diagnostics.diagnosticTraceId,
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
        header.target.targetKind === "code"
      ) {
        reasonCode = "code-endpoint-preparation-failed";
        const endpoint = await this.codeEndpoints.prepareProtected(
          header.tunnelId,
          content.destination.sessionId,
          {
            attachmentId: header.attachmentId,
            connectionId: header.connectionId,
            diagnosticTraceId: diagnostics.diagnosticTraceId,
          },
        );
        reasonCode = "code-endpoint-handoff-failed";
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          diagnosticTraceId: diagnostics.diagnosticTraceId,
          targetKind: "tcp",
        });
        this.tcp.handleFrame(
          { ...header, target: endpoint },
          payload,
          (remotePort) =>
            this.codeEndpoints.bindProtectedConnection(
              header.tunnelId,
              endpoint.port,
              remotePort,
              {
                attachmentId: header.attachmentId,
                connectionId: header.connectionId,
                diagnosticTraceId: diagnostics.diagnosticTraceId,
              },
            ),
        );
        return;
      }
      if (
        content.destination.kind === "worker-project-share" &&
        header.target.targetKind === "project-share" &&
        content.destination.resourceId === header.target.recordId
      ) {
        reasonCode = "project-share-preparation-failed";
        const share = await this.projectShares.open({
          password: content.destination.password,
          publicBasePath: content.destination.publicBasePath,
          publicOrigin: content.destination.publicOrigin,
          realm: content.destination.realm,
          root: content.destination.root,
          shareId: content.destination.resourceId,
          username: content.destination.username,
        });
        reasonCode = "project-share-handoff-failed";
        this.#protections.set(connectionKey(header), {
          configuration: content.dataProtection,
          diagnosticTraceId: diagnostics.diagnosticTraceId,
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
    } catch (error) {
      this.#protections.delete(connectionKey(header));
      workerLogger.rateLimited(
        `tunnel-protected-target-rejected:${diagnostics.diagnosticTraceId ?? "untraced"}:${header.tunnelId}:${reasonCode}`,
        "warn",
        "Protected tunnel target rejected",
        {
          event: "tunnel.protected-target.rejected",
          subsystem: "tunnel",
          operation: "open-protected-target",
          reasonCode,
          status: "rejected",
          ...context(),
          ...workerLogErrorIdentity(error),
        },
      );
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
      } catch (error) {
        workerLogger.rateLimited(
          `tunnel-protected-frame-seal-failed:${header.tunnelId}`,
          "warn",
          "Protected tunnel response frame failed",
          {
            event: "tunnel.protected-frame.failed",
            subsystem: "tunnel",
            operation: "seal-protected-frame",
            reasonCode: "data-seal-failed",
            status: "failed",
            tunnelId: header.tunnelId,
            attachmentId: header.attachmentId,
            connectionId: header.connectionId,
            ...(connection.diagnosticTraceId
              ? { diagnosticTraceId: connection.diagnosticTraceId }
              : {}),
            ...workerLogErrorIdentity(error),
          },
        );
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
