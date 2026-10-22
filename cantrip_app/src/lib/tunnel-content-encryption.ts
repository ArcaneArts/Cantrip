import {
  clearSensitiveBytes,
  encodeBase64Url,
  randomBytes,
} from "@cantrip/crypto";
import {
  protectedTunnelContentRecordSchema,
  tunnelDataProtectionConfigurationSchema,
  tunnelContentRecordSchema,
  tunnelPublicDestinationEndpoint,
  tunnelPublicSourceEndpoint,
  type ProtectedTunnelContentRecord,
  type TunnelContentErrorCode,
  type TunnelContentRecord,
  type TunnelDataProtectionConfiguration,
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
import { clientEncryption } from "./client-encryption";

const TUNNEL_RECORD_OPERATION = "tunnel.record";

export function createTunnelDataProtection(): TunnelDataProtectionConfiguration {
  const snapshot = clientEncryption.getSnapshot();
  if (snapshot.status !== "ready" || !snapshot.masterKeyRevision) {
    throw new Error("Encryption must be unlocked before creating a tunnel.");
  }
  const key = randomBytes(32);
  try {
    return tunnelDataProtectionConfigurationSchema.parse({
      formatVersion: 1,
      algorithm: "AES-256-GCM",
      keyRevision: snapshot.masterKeyRevision,
      key: encodeBase64Url(key),
    });
  } finally {
    clearSensitiveBytes(key);
  }
}

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

function stableErrorMessage(
  code: TunnelContentErrorCode | null,
): string | null {
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

type TunnelPresentation = Omit<TunnelContentRecord, "dataProtection">;

function publicEndpointsMatch(
  wire: TunnelWireSummary,
  content: TunnelPresentation,
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
  if (!wire.protectedRecord) {
    throw new Error("Private tunnel configuration is unavailable.");
  }
  const content = await openTunnelContentRecord({
    tunnelId: wire.id,
    record: wire.protectedRecord,
    workerId: wire.destination.workerId,
  });
  if (!publicEndpointsMatch(wire, content)) {
    throw new Error(
      "Protected tunnel content does not match its routing record.",
    );
  }
  const {
    errorCode,
    protectedRecord: _protectedRecord,
    ...publicSummary
  } = wire;
  return tunnelSummarySchema.parse({
    ...publicSummary,
    name: content.name,
    description: content.description,
    source: content.source,
    destination: content.destination,
    lastError: stableErrorMessage(errorCode),
    attachments: wire.attachments.map((attachment) => {
      const { errorCode: attachmentErrorCode, ...publicAttachment } =
        attachment;
      return {
        ...publicAttachment,
        localHost: null,
        localPort: null,
        lastError: stableErrorMessage(attachmentErrorCode),
      };
    }),
  });
}
