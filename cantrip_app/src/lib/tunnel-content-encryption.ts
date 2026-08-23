import {
  protectedTunnelContentRecordSchema,
  tunnelContentRecordSchema,
  tunnelPublicDestinationEndpoint,
  tunnelPublicSourceEndpoint,
  type ProtectedTunnelContentRecord,
  type TunnelContentErrorCode,
  type TunnelContentRecord,
} from "@cantrip/protocol/tunnel-content";
import {
  tunnelSummarySchema,
  tunnelWireSummarySchema,
  type TunnelSummary,
  type TunnelWireSummary,
} from "@cantrip/protocol";

import {
  openEndpointContent,
  protectEndpointContent,
} from "./endpoint-content-encryption";

const TUNNEL_RECORD_OPERATION = "tunnel.record";

function scopeId(tunnelId: string): string {
  return JSON.stringify(["tunnel", tunnelId]);
}

function context(input: {
  workerId: string;
  scopeId: string;
  operationId: string;
  revision: number;
}) {
  return {
    domain: "tunnel-content" as const,
    workerId: input.workerId,
    scopeId: input.scopeId,
    operationId: input.operationId,
    operation: TUNNEL_RECORD_OPERATION,
    direction: "stored" as const,
    sequence: input.revision,
  };
}

export async function protectTunnelContentRecord(input: {
  content: TunnelContentRecord;
  operationId: string;
  revision: number;
  tunnelId: string;
  workerId: string;
}): Promise<ProtectedTunnelContentRecord> {
  const content = tunnelContentRecordSchema.parse(input.content);
  return protectedTunnelContentRecordSchema.parse({
    operationId: input.operationId,
    revision: input.revision,
    protectedContent: await protectEndpointContent({
      context: context({
        workerId: input.workerId,
        scopeId: scopeId(input.tunnelId),
        operationId: input.operationId,
        revision: input.revision,
      }),
      content,
      schema: tunnelContentRecordSchema,
    }),
  });
}

export async function openTunnelContentRecord(input: {
  record: ProtectedTunnelContentRecord;
  tunnelId: string;
  workerId: string;
}): Promise<TunnelContentRecord> {
  const record = protectedTunnelContentRecordSchema.parse(input.record);
  return openEndpointContent({
    context: context({
      workerId: input.workerId,
      scopeId: scopeId(input.tunnelId),
      operationId: record.operationId,
      revision: record.revision,
    }),
    opaque: record.protectedContent,
    schema: tunnelContentRecordSchema,
  });
}

function stableErrorMessage(code: TunnelContentErrorCode | null): string | null {
  switch (code) {
    case "attachment-disconnected":
      return "The local tunnel endpoint disconnected.";
    case "attachment-expired":
      return "The tunnel attachment expired.";
    case "destination-offline":
      return "The destination worker is offline.";
    case "server-restarted":
      return "The tunnel must reconnect after the server restarted.";
    case "target-rejected":
      return "The destination rejected the tunnel target.";
    case "transport-failed":
      return "The tunnel transport failed.";
    case null:
      return null;
  }
}

function managedPresentation(tunnel: TunnelWireSummary): TunnelContentRecord {
  const presentation =
    tunnel.origin === "code"
      ? {
          name: "Cantrip Code",
          description: "Isolated editor access for the owning Code tab.",
        }
      : tunnel.origin === "project-share"
        ? {
            name: "Project files",
            description: "Secure WebDAV access to this project's files.",
          }
        : {
            name: `${tunnel.origin[0]?.toUpperCase() ?? ""}${tunnel.origin.slice(1)} tunnel`,
            description: null,
          };
  if (
    tunnel.source.kind === "worker-listener" ||
    tunnel.destination.kind === "worker-tcp"
  ) {
    throw new Error("Private tunnel configuration is unavailable.");
  }
  return {
    ...presentation,
    source: tunnel.source,
    destination: tunnel.destination,
  };
}

function publicEndpointsMatch(
  wire: TunnelWireSummary,
  content: TunnelContentRecord,
): boolean {
  return (
    JSON.stringify(tunnelPublicSourceEndpoint(content.source)) ===
      JSON.stringify(wire.source) &&
    JSON.stringify(tunnelPublicDestinationEndpoint(content.destination)) ===
      JSON.stringify(wire.destination)
  );
}

export async function openTunnelSummary(raw: unknown): Promise<TunnelSummary> {
  const wire = tunnelWireSummarySchema.parse(raw);
  const content = wire.protectedRecord
    ? await openTunnelContentRecord({
        tunnelId: wire.id,
        record: wire.protectedRecord,
        workerId: wire.destination.workerId,
      })
    : managedPresentation(wire);
  if (!publicEndpointsMatch(wire, content)) {
    throw new Error("Protected tunnel content does not match its routing record.");
  }
  const { errorCode, protectedRecord: _protectedRecord, ...publicSummary } = wire;
  return tunnelSummarySchema.parse({
    ...publicSummary,
    name: content.name,
    description: content.description,
    source: content.source,
    destination: content.destination,
    lastError: stableErrorMessage(errorCode),
    attachments: wire.attachments.map((attachment) => {
      const { errorCode: attachmentErrorCode, ...publicAttachment } = attachment;
      return {
        ...publicAttachment,
        localHost: null,
        localPort: null,
        lastError: stableErrorMessage(attachmentErrorCode),
      };
    }),
  });
}
