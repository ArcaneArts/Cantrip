import type {
  TunnelDataPlaneFrameHeader,
  TunnelDataPlaneRejectionCode,
} from "@cantrip/protocol";
import { clearSensitiveBytes } from "@cantrip/crypto";
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

type ProtectedTargetRejectionReason =
  | "invalid-target-binding"
  | "protected-record-open-failed"
  | "worker-id-mismatch"
  | "target-kind-mismatch"
  | "tcp-target-handoff-failed"
  | "code-endpoint-preparation-failed"
  | "code-endpoint-handoff-failed"
  | "project-share-preparation-failed"
  | "project-share-handoff-failed";

function protectedTargetRejectionCode(
  reasonCode: ProtectedTargetRejectionReason,
): TunnelDataPlaneRejectionCode {
  switch (reasonCode) {
    case "invalid-target-binding":
    case "worker-id-mismatch":
    case "target-kind-mismatch":
      return "protected-target-invalid";
    case "protected-record-open-failed":
      return "protected-record-unavailable";
    case "tcp-target-handoff-failed":
    case "code-endpoint-preparation-failed":
    case "code-endpoint-handoff-failed":
    case "project-share-preparation-failed":
    case "project-share-handoff-failed":
      return "protected-endpoint-unavailable";
  }
}

export class TunnelDestinationRouter {
  #emit: FrameEmitter | null = null;
  readonly #pendingProtections = new Map<string, symbol>();
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
      const connectionDiagnostics = diagnostics.diagnosticTraceId
        ? diagnostics
        : { diagnosticTraceId: header.diagnosticTraceId };
      if (header.target.kind === "protected-tunnel") {
        const key = connectionKey(header);
        const generation = Symbol();
        this.#pendingProtections.set(key, generation);
        void this.#handleProtectedConnect(
          header,
          payload,
          connectionDiagnostics,
          generation,
        );
      } else if (header.target.kind === "tcp") {
        this.#pendingProtections.delete(connectionKey(header));
        this.tcp.handleFrame(header, payload);
      }
      return;
    }
    const key = connectionKey(header);
    if (
      (header.kind === "close" || header.kind === "error") &&
      this.#pendingProtections.delete(key)
    ) {
      return;
    }
    const protection = this.#protections.get(key);
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
          this.#protections.delete(key);
        }
      }
      return;
    }
    this.tcp.handleFrame(header, payload);
  }

  disconnect(): void {
    this.#pendingProtections.clear();
    this.#protections.clear();
    this.tcp.disconnect();
  }

  close(): void {
    this.#pendingProtections.clear();
    this.#protections.clear();
    this.tcp.close();
  }

  async #handleProtectedConnect(
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    payload: Uint8Array,
    diagnostics: TunnelDiagnosticContext,
    generation: symbol,
  ): Promise<void> {
    const key = connectionKey(header);
    let reasonCode: ProtectedTargetRejectionReason = "invalid-target-binding";
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
      if (!this.#isPendingProtection(key, generation)) return;
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
        this.#handoffProtectedConnect(
          key,
          generation,
          {
            ...header,
            target: {
              kind: "tcp",
              host: content.destination.host,
              port: content.destination.port,
            },
          },
          payload,
          content.dataProtection,
          diagnostics,
        );
        return;
      }
      if (
        content.destination.kind === "worker-code" &&
        header.target.targetKind === "code" &&
        content.destination.resourceId === header.tunnelId
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
        if (!this.#isPendingProtection(key, generation)) return;
        reasonCode = "code-endpoint-handoff-failed";
        this.#handoffProtectedConnect(
          key,
          generation,
          { ...header, target: endpoint },
          payload,
          content.dataProtection,
          diagnostics,
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
        content.destination.kind === "worker-code-transport" &&
        header.target.targetKind === "code" &&
        content.destination.resourceId === header.tunnelId &&
        header.target.protectedRecord.operationId === header.tunnelId &&
        header.target.protectedRecord.revision === 1
      ) {
        reasonCode = "code-endpoint-preparation-failed";
        const activeKey = this.encryption.componentKey("tunnel-content");
        const protectedKeyRevision = activeKey.keyRevision;
        clearSensitiveBytes(activeKey.key);
        if (
          header.target.protectedRecord.protectedContent.keyRevision !==
          protectedKeyRevision
        ) {
          throw new Error(
            "The protected Code transport key revision is no longer active.",
          );
        }
        const endpoint = await this.codeEndpoints.prepareSharedProtected(
          header.tunnelId,
          {
            ownerId: this.encryption.ownerId(),
            serverId: this.encryption.serverIdentity(),
            protectedKeyRevision,
          },
          {
            attachmentId: header.attachmentId,
            connectionId: header.connectionId,
            diagnosticTraceId: diagnostics.diagnosticTraceId,
          },
        );
        if (!this.#isPendingProtection(key, generation)) return;
        reasonCode = "code-endpoint-handoff-failed";
        this.#handoffProtectedConnect(
          key,
          generation,
          { ...header, target: endpoint },
          payload,
          content.dataProtection,
          diagnostics,
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
        (content.destination.kind === "worker-project-share" ||
          content.destination.kind === "worker-chat-share") &&
        header.target.targetKind === "project-share" &&
        content.destination.resourceId === header.target.recordId
      ) {
        reasonCode = "project-share-preparation-failed";
        const share =
          content.destination.kind === "worker-project-share"
            ? await this.projectShares.open({
                password: content.destination.password,
                publicBasePath: content.destination.publicBasePath,
                publicOrigin: content.destination.publicOrigin,
                realm: content.destination.realm,
                root: content.destination.root,
                shareId: content.destination.resourceId,
                username: content.destination.username,
              })
            : this.projectShares.get(content.destination.resourceId);
        if (
          !share ||
          share.password !== content.destination.password ||
          share.publicBasePath !== content.destination.publicBasePath ||
          share.username !== content.destination.username
        ) {
          throw new Error(
            "The protected Chat share was not prepared for this connection.",
          );
        }
        if (!this.#isPendingProtection(key, generation)) return;
        reasonCode = "project-share-handoff-failed";
        this.#handoffProtectedConnect(
          key,
          generation,
          {
            ...header,
            target: {
              kind: "tcp",
              host: share.loopbackHost,
              port: share.loopbackPort,
            },
          },
          payload,
          content.dataProtection,
          diagnostics,
        );
        return;
      }
      throw new Error("Protected tunnel target belongs to another endpoint.");
    } catch (error) {
      if (!this.#finishPendingProtection(key, generation)) return;
      this.#protections.delete(key);
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
          code: protectedTargetRejectionCode(reasonCode),
        },
        new Uint8Array(),
      );
    }
  }

  #handoffProtectedConnect(
    key: string,
    generation: symbol,
    header: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>,
    payload: Uint8Array,
    configuration: TunnelDataProtectionConfiguration,
    diagnostics: TunnelDiagnosticContext,
    onConnected?: (remotePort: number) => void,
  ): void {
    if (!this.#isPendingProtection(key, generation)) return;
    this.#protections.set(key, {
      configuration,
      diagnosticTraceId: diagnostics.diagnosticTraceId,
      targetKind: "tcp",
    });
    this.tcp.handleFrame(header, payload, onConnected);
    this.#finishPendingProtection(key, generation);
  }

  #isPendingProtection(key: string, generation: symbol): boolean {
    return this.#pendingProtections.get(key) === generation;
  }

  #finishPendingProtection(key: string, generation: symbol): boolean {
    if (!this.#isPendingProtection(key, generation)) return false;
    this.#pendingProtections.delete(key);
    return true;
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
