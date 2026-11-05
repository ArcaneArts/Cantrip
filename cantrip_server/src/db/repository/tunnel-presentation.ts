import type {
  TunnelAttachmentWireSummary,
  TunnelWireSummary,
} from "@cantrip/protocol";
import type {
  ProtectedTunnelContentRecord,
  TunnelPublicSourceEndpoint,
  TunnelPublicDestinationEndpoint,
} from "@cantrip/protocol/tunnel-content";
import type * as schema from "../schema.js";
type TunnelRow = typeof schema.tunnels.$inferSelect;
type TunnelAttachmentRow = typeof schema.tunnelAttachments.$inferSelect;

export function toTunnelAttachmentSummary(
  attachment: TunnelAttachmentRow,
): TunnelAttachmentWireSummary {
  return {
    id: attachment.id,
    tunnelId: attachment.tunnelId,
    kind: attachment.kind as TunnelAttachmentWireSummary["kind"],
    clientId: attachment.clientId,
    status: attachment.status as TunnelAttachmentWireSummary["status"],
    activeConnectionCount: attachment.activeConnectionCount,
    bytesFromSource: attachment.bytesFromSource,
    bytesToSource: attachment.bytesToSource,
    errorCode: attachment.errorCode as TunnelAttachmentWireSummary["errorCode"],
    expiresAt: attachment.expiresAt?.toISOString() ?? null,
    lastSeenAt: attachment.lastSeenAt?.toISOString() ?? null,
    createdAt: attachment.createdAt.toISOString(),
    updatedAt: attachment.updatedAt.toISOString(),
  };
}

function tunnelCapabilities(
  tunnel: TunnelRow,
  attachments: TunnelAttachmentWireSummary[],
): TunnelWireSummary["capabilities"] {
  const userManaged = tunnel.management === "user-managed";
  if (!userManaged) {
    const protectedDesktopAttachment =
      (tunnel.origin === "browser" || tunnel.origin === "project-share") &&
      tunnel.management === "managed-ephemeral" &&
      tunnel.sourceKind === "desktop-loopback";
    return {
      canEdit: false,
      canDelete: false,
      canStart: false,
      canStop: false,
      canAttach: protectedDesktopAttachment && tunnel.status !== "stopping",
      canOpenOwner: tunnel.managedByKind !== null,
    };
  }
  const attached = attachments.some(
    ({ status }) => status !== "stopped" && status !== "failed",
  );
  const stopped = tunnel.status === "stopped" || tunnel.status === "failed";
  return {
    canEdit: stopped && !attached,
    canDelete: stopped && !attached,
    canStart: stopped && !attached,
    canStop: attached || (!stopped && tunnel.status !== "stopping"),
    canAttach: tunnel.status !== "stopping",
    canOpenOwner: false,
  };
}

export function tunnelPublicSource(
  tunnel: TunnelRow,
): TunnelPublicSourceEndpoint {
  if (tunnel.sourceKind === "desktop-loopback") {
    return { kind: "desktop-loopback" };
  }
  if (tunnel.sourceKind === "worker-listener" && tunnel.sourceWorkerId) {
    return { kind: "worker-listener", workerId: tunnel.sourceWorkerId };
  }
  throw new Error("Tunnel source routing metadata is invalid.");
}

export function tunnelPublicDestination(
  tunnel: TunnelRow,
): TunnelPublicDestinationEndpoint {
  if (tunnel.destinationKind === "worker-tcp") {
    return { kind: "worker-tcp", workerId: tunnel.destinationWorkerId };
  }
  if (
    tunnel.destinationKind === "worker-adapter" &&
    tunnel.destinationAdapter &&
    tunnel.destinationResourceId
  ) {
    return {
      kind: "worker-adapter",
      workerId: tunnel.destinationWorkerId,
      adapter: tunnel.destinationAdapter as "project-share" | "cantrip-os",
      resourceId: tunnel.destinationResourceId,
    };
  }
  throw new Error("Tunnel destination routing metadata is invalid.");
}

export function tunnelProtectedRecord(
  tunnel: TunnelRow,
): ProtectedTunnelContentRecord | null {
  if (
    !tunnel.protectedContent ||
    !tunnel.protectedOperationId ||
    tunnel.protectedRevision < 1
  ) {
    return null;
  }
  return {
    operationId: tunnel.protectedOperationId,
    revision: tunnel.protectedRevision,
    protectedContent: tunnel.protectedContent,
  };
}

export function toTunnelSummary(
  tunnel: TunnelRow,
  attachmentRows: TunnelAttachmentRow[] = [],
): TunnelWireSummary {
  const attachments = attachmentRows.map(toTunnelAttachmentSummary);
  return {
    id: tunnel.id,
    projectId: tunnel.projectId,
    position: tunnel.position,
    origin: tunnel.origin as TunnelWireSummary["origin"],
    management: tunnel.management as TunnelWireSummary["management"],
    protocolHint: tunnel.protocolHint as TunnelWireSummary["protocolHint"],
    source: tunnelPublicSource(tunnel),
    destination: tunnelPublicDestination(tunnel),
    ...(tunnel.osSource ? { osSource: tunnel.osSource } : {}),
    managedBy:
      tunnel.managedByKind && tunnel.managedById
        ? {
            kind: tunnel.managedByKind as NonNullable<
              TunnelWireSummary["managedBy"]
            >["kind"],
            id: tunnel.managedById,
          }
        : null,
    desiredState: tunnel.desiredState as TunnelWireSummary["desiredState"],
    status: tunnel.status as TunnelWireSummary["status"],
    errorCode: tunnel.errorCode as TunnelWireSummary["errorCode"],
    activeConnectionCount: tunnel.activeConnectionCount,
    bytesFromSource: tunnel.bytesFromSource,
    bytesToSource: tunnel.bytesToSource,
    attachments,
    capabilities: tunnelCapabilities(tunnel, attachments),
    protectedRecord: tunnelProtectedRecord(tunnel),
    createdAt: tunnel.createdAt.toISOString(),
    updatedAt: tunnel.updatedAt.toISOString(),
  };
}
