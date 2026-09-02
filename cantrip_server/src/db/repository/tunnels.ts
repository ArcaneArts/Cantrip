import { randomUUID } from "node:crypto";

import type {
  TunnelAttachmentWireSummary,
  TunnelDestinationEndpoint,
  TunnelManagedRegistration,
  TunnelSourceEndpoint,
  TunnelUserWireCreate,
  TunnelUserWireUpdate,
  TunnelWireSummary,
} from "@cantrip/protocol";
import {
  isLocalGitProject,
  isWorkerBoundFolderProject,
} from "@cantrip/protocol";
import type {
  ProtectedTunnelContentRecord,
  TunnelContentErrorCode,
  TunnelPublicDestinationEndpoint,
  TunnelPublicSourceEndpoint,
} from "@cantrip/protocol/tunnel-content";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  type RepositoryDatabase,
  type RepositoryTransaction,
} from "./database.js";

type TunnelRow = typeof schema.tunnels.$inferSelect;
type TunnelAttachmentRow = typeof schema.tunnelAttachments.$inferSelect;

export class TunnelManagementError extends Error {}

export interface TunnelAttachmentAuthorization {
  attachmentId: string;
  clientId: string;
  destination:
    | Extract<TunnelPublicDestinationEndpoint, { kind: "worker-tcp" }>
    | (Extract<TunnelPublicDestinationEndpoint, { kind: "worker-adapter" }> & {
        adapter: "code" | "project-share";
      });
  expiresAt: Date;
  ownerId: string;
  origin: TunnelWireSummary["origin"];
  projectId: string | null;
  protectedRecord: ProtectedTunnelContentRecord;
  secretExpiresAt: Date;
  tunnelId: string;
}

export interface DesktopTunnelAttachmentStopFence {
  activatedAt: Date | null;
  expiresAt: Date | null;
  secretExpiresAt: Date | null;
}

export interface DesktopTunnelAttachmentLeaseChange {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}

export interface TunnelRepositoryCollaborators {
  getTunnel(
    ownerId: string,
    tunnelId: string,
  ): Promise<TunnelWireSummary | null>;
  stopDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
    errorCode?: TunnelContentErrorCode | null,
    preserveTunnelState?: boolean,
    expected?: DesktopTunnelAttachmentStopFence,
  ): Promise<{ projectId: string | null; tunnelId: string } | null>;
}

function toTunnelAttachmentSummary(
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
      (tunnel.origin === "browser" ||
        tunnel.origin === "code" ||
        tunnel.origin === "project-share") &&
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

function tunnelPublicSource(tunnel: TunnelRow): TunnelPublicSourceEndpoint {
  if (tunnel.sourceKind === "desktop-loopback") {
    return { kind: "desktop-loopback" };
  }
  if (tunnel.sourceKind === "worker-listener" && tunnel.sourceWorkerId) {
    return { kind: "worker-listener", workerId: tunnel.sourceWorkerId };
  }
  throw new Error("Tunnel source routing metadata is invalid.");
}

function tunnelPublicDestination(
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
      adapter: tunnel.destinationAdapter as "code" | "project-share",
      resourceId: tunnel.destinationResourceId,
    };
  }
  throw new Error("Tunnel destination routing metadata is invalid.");
}

function tunnelProtectedRecord(
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

function toTunnelSummary(
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

function sourceWorkerId(
  source: TunnelSourceEndpoint | TunnelPublicSourceEndpoint,
): string | null {
  return source.kind === "worker-listener" ? source.workerId : null;
}

function destinationWorkerId(
  destination: TunnelDestinationEndpoint | TunnelPublicDestinationEndpoint,
): string {
  return destination.workerId;
}

export class TunnelRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: TunnelRepositoryCollaborators,
  ) {}

  private async tunnelReferencesAreOwned(
    ownerId: string,
    projectId: string | null,
    source: TunnelSourceEndpoint | TunnelPublicSourceEndpoint,
    destination: TunnelDestinationEndpoint | TunnelPublicDestinationEndpoint,
  ): Promise<boolean> {
    const workerIds = [
      ...new Set(
        [sourceWorkerId(source), destinationWorkerId(destination)].filter(
          (workerId): workerId is string => workerId !== null,
        ),
      ),
    ];
    const [projectRows, workerRows, sourceWorkerRows] = await Promise.all([
      projectId
        ? this.database
            .select({
              gitCapability: schema.projects.gitCapability,
              id: schema.projects.id,
              originKind: schema.projects.originKind,
              preferredWorkerId: schema.projects.preferredWorkerId,
            })
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.id, projectId),
                eq(schema.projects.ownerId, ownerId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
            inArray(schema.workers.id, workerIds),
          ),
        ),
      projectId
        ? this.database
            .select({ workerId: schema.projectSources.workerId })
            .from(schema.projectSources)
            .innerJoin(
              schema.projectWorktrees,
              and(
                eq(
                  schema.projectWorktrees.projectSourceId,
                  schema.projectSources.id,
                ),
                eq(schema.projectWorktrees.isPrimary, true),
                eq(schema.projectWorktrees.lifecycleState, "ready"),
              ),
            )
            .where(
              and(
                eq(schema.projectSources.projectId, projectId),
                isNull(schema.projectSources.removedAt),
              ),
            )
        : Promise.resolve([]),
    ]);
    const project = projectRows[0];
    if (projectId && !project) return false;
    if (
      project &&
      isWorkerBoundFolderProject(project.originKind, project.gitCapability) &&
      workerIds.some((workerId) => workerId !== project.preferredWorkerId)
    ) {
      throw new TunnelManagementError(
        "This worker-managed folder is bound to its owning worker.",
      );
    }
    if (
      project &&
      isLocalGitProject(project.originKind, project.gitCapability) &&
      workerIds.some(
        (workerId) =>
          !sourceWorkerRows.some((source) => source.workerId === workerId),
      )
    ) {
      throw new TunnelManagementError(
        "This local Git project has no ready source on the selected worker.",
      );
    }
    return workerRows.length === workerIds.length;
  }

  private async nextTunnelPosition(ownerId: string): Promise<number> {
    const rows = await this.database
      .select({ position: schema.tunnels.position })
      .from(schema.tunnels)
      .where(eq(schema.tunnels.ownerId, ownerId))
      .orderBy(desc(schema.tunnels.position))
      .limit(1);
    return (rows[0]?.position ?? -1) + 1;
  }

  async listTunnels(
    ownerId: string,
    projectId?: string,
  ): Promise<TunnelWireSummary[]> {
    const tunnelRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          projectId ? eq(schema.tunnels.projectId, projectId) : undefined,
        ),
      )
      .orderBy(asc(schema.tunnels.position), asc(schema.tunnels.createdAt));
    if (tunnelRows.length === 0) return [];
    const attachmentRows = await this.database
      .select()
      .from(schema.tunnelAttachments)
      .where(
        inArray(
          schema.tunnelAttachments.tunnelId,
          tunnelRows.map(({ id }) => id),
        ),
      )
      .orderBy(
        asc(schema.tunnelAttachments.createdAt),
        asc(schema.tunnelAttachments.id),
      );
    const attachmentsByTunnel = new Map<string, TunnelAttachmentRow[]>();
    for (const attachment of attachmentRows) {
      const attachments = attachmentsByTunnel.get(attachment.tunnelId) ?? [];
      attachments.push(attachment);
      attachmentsByTunnel.set(attachment.tunnelId, attachments);
    }
    return tunnelRows.map((tunnel) =>
      toTunnelSummary(tunnel, attachmentsByTunnel.get(tunnel.id)),
    );
  }

  async getTunnel(
    ownerId: string,
    tunnelId: string,
  ): Promise<TunnelWireSummary | null> {
    const tunnelRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const tunnel = tunnelRows[0];
    if (!tunnel) return null;
    const attachments = await this.database
      .select()
      .from(schema.tunnelAttachments)
      .where(eq(schema.tunnelAttachments.tunnelId, tunnel.id))
      .orderBy(
        asc(schema.tunnelAttachments.createdAt),
        asc(schema.tunnelAttachments.id),
      );
    return toTunnelSummary(tunnel, attachments);
  }

  async createUserTunnel(
    ownerId: string,
    input: TunnelUserWireCreate,
  ): Promise<TunnelWireSummary | null> {
    const source = { kind: "desktop-loopback" as const };
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        input.projectId,
        source,
        input.destination,
      ))
    ) {
      return null;
    }
    const rows = await this.database
      .insert(schema.tunnels)
      .values({
        id: input.id,
        ownerId,
        projectId: input.projectId,
        position: await this.nextTunnelPosition(ownerId),
        origin: "user",
        management: "user-managed",
        protocolHint: input.protocolHint,
        sourceKind: source.kind,
        sourceAdapter: null,
        sourceWorkerId: null,
        destinationKind: input.destination.kind,
        destinationAdapter: null,
        destinationResourceId: null,
        destinationWorkerId: input.destination.workerId,
        protectedContent: input.protectedRecord.protectedContent,
        protectedOperationId: input.protectedRecord.operationId,
        protectedRevision: input.protectedRecord.revision,
        managedByKind: null,
        managedById: null,
        desiredState: "stopped",
        status: "stopped",
      })
      .returning();
    return toTunnelSummary(firstOrThrow(rows, "creating a tunnel"));
  }

  async updateUserTunnel(
    ownerId: string,
    tunnelId: string,
    input: TunnelUserWireUpdate,
  ): Promise<TunnelWireSummary | null> {
    const existingRows = await this.database
      .select()
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return null;
    if (existing.management !== "user-managed") {
      throw new TunnelManagementError(
        "Managed tunnels are controlled by their owning feature.",
      );
    }
    const activeAttachments = await this.database
      .select({ id: schema.tunnelAttachments.id })
      .from(schema.tunnelAttachments)
      .where(
        and(
          eq(schema.tunnelAttachments.tunnelId, tunnelId),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      )
      .limit(1);
    if (activeAttachments.length > 0) {
      throw new TunnelManagementError(
        "Stop every tunnel attachment before editing this tunnel.",
      );
    }
    if (
      input.protectedRecord.revision !== existing.protectedRevision + 1 ||
      input.protectedRecord.operationId === existing.protectedOperationId
    ) {
      throw new TunnelManagementError(
        "Tunnel protected content has a stale revision.",
      );
    }
    const projectId =
      input.projectId === undefined ? existing.projectId : input.projectId;
    const source = tunnelPublicSource(existing);
    const destination = input.destination ?? tunnelPublicDestination(existing);
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        projectId,
        source,
        destination,
      ))
    ) {
      return null;
    }
    const rows = await this.database
      .update(schema.tunnels)
      .set({
        ...(input.projectId === undefined ? {} : { projectId }),
        ...(input.protocolHint === undefined
          ? {}
          : { protocolHint: input.protocolHint }),
        ...(input.destination === undefined
          ? {}
          : {
              destinationKind: destination.kind,
              destinationAdapter:
                destination.kind === "worker-adapter"
                  ? destination.adapter
                  : null,
              destinationResourceId:
                destination.kind === "worker-adapter"
                  ? destination.resourceId
                  : null,
              destinationWorkerId: destination.workerId,
            }),
        protectedContent: input.protectedRecord.protectedContent,
        protectedOperationId: input.protectedRecord.operationId,
        protectedRevision: input.protectedRecord.revision,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.management, "user-managed"),
        ),
      )
      .returning();
    return rows[0] ? this.collaborators.getTunnel(ownerId, rows[0].id) : null;
  }

  async deleteUserTunnel(ownerId: string, tunnelId: string): Promise<boolean> {
    const existingRows = await this.database
      .select({ management: schema.tunnels.management })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return false;
    if (existing.management !== "user-managed") {
      throw new TunnelManagementError(
        "Managed tunnels are controlled by their owning feature.",
      );
    }
    const activeAttachments = await this.database
      .select({ id: schema.tunnelAttachments.id })
      .from(schema.tunnelAttachments)
      .where(
        and(
          eq(schema.tunnelAttachments.tunnelId, tunnelId),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      )
      .limit(1);
    if (activeAttachments.length > 0) {
      throw new TunnelManagementError(
        "Stop every tunnel attachment before deleting this tunnel.",
      );
    }
    const rows = await this.database
      .delete(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.id, tunnelId),
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.management, "user-managed"),
        ),
      )
      .returning({ id: schema.tunnels.id });
    return rows.length === 1;
  }

  async registerManagedTunnel(
    ownerId: string,
    input: Omit<TunnelManagedRegistration, "source" | "destination"> & {
      source: TunnelSourceEndpoint | TunnelPublicSourceEndpoint;
      destination: TunnelDestinationEndpoint | TunnelPublicDestinationEndpoint;
    },
    protectedInput?: {
      id?: string;
      protectedRecord: ProtectedTunnelContentRecord;
    },
  ): Promise<TunnelWireSummary | null> {
    if (
      (input.source.kind === "worker-listener" ||
        input.destination.kind === "worker-tcp") &&
      !protectedInput
    ) {
      throw new TunnelManagementError(
        "Private tunnel endpoints require protected content.",
      );
    }
    if (
      !(await this.tunnelReferencesAreOwned(
        ownerId,
        input.projectId,
        input.source,
        input.destination,
      ))
    ) {
      return null;
    }
    const existingRows = await this.database
      .select({
        id: schema.tunnels.id,
        protectedOperationId: schema.tunnels.protectedOperationId,
        protectedRevision: schema.tunnels.protectedRevision,
      })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          eq(schema.tunnels.managedByKind, input.managedBy.kind),
          eq(schema.tunnels.managedById, input.managedBy.id),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing && protectedInput?.id && protectedInput.id !== existing.id) {
      throw new TunnelManagementError("Managed tunnel identity is stale.");
    }
    if (protectedInput) {
      const expectedRevision = existing ? existing.protectedRevision + 1 : 1;
      if (
        protectedInput.protectedRecord.revision !== expectedRevision ||
        protectedInput.protectedRecord.operationId ===
          existing?.protectedOperationId
      ) {
        throw new TunnelManagementError(
          "Tunnel protected content has a stale revision.",
        );
      }
    }
    const source: TunnelPublicSourceEndpoint =
      input.source.kind === "worker-listener"
        ? { kind: input.source.kind, workerId: input.source.workerId }
        : input.source;
    const destination: TunnelPublicDestinationEndpoint =
      input.destination.kind === "worker-tcp"
        ? {
            kind: input.destination.kind,
            workerId: input.destination.workerId,
          }
        : input.destination;
    const values = {
      projectId: input.projectId,
      origin: input.origin,
      management: input.management,
      protocolHint: input.protocolHint,
      sourceKind: source.kind,
      sourceAdapter: null,
      sourceWorkerId: sourceWorkerId(source),
      destinationKind: destination.kind,
      destinationAdapter:
        destination.kind === "worker-adapter" ? destination.adapter : null,
      destinationResourceId:
        destination.kind === "worker-adapter" ? destination.resourceId : null,
      destinationWorkerId: destinationWorkerId(destination),
      ...(protectedInput
        ? {
            protectedContent: protectedInput.protectedRecord.protectedContent,
            protectedOperationId: protectedInput.protectedRecord.operationId,
            protectedRevision: protectedInput.protectedRecord.revision,
          }
        : {}),
      managedByKind: input.managedBy.kind,
      managedById: input.managedBy.id,
      desiredState: input.desiredState,
      status: input.status,
      errorCode: null,
      updatedAt: new Date(),
    };
    if (existing) {
      await this.database
        .update(schema.tunnels)
        .set(values)
        .where(eq(schema.tunnels.id, existing.id));
      return this.collaborators.getTunnel(ownerId, existing.id);
    }
    const id = protectedInput?.id ?? randomUUID();
    await this.database.insert(schema.tunnels).values({
      id,
      ownerId,
      position: await this.nextTunnelPosition(ownerId),
      ...values,
    });
    return this.collaborators.getTunnel(ownerId, id);
  }

  async getManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelWireSummary["managedBy"]>,
  ): Promise<TunnelWireSummary | null> {
    const rows = await this.database
      .select({ id: schema.tunnels.id })
      .from(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          ne(schema.tunnels.management, "user-managed"),
          eq(schema.tunnels.managedByKind, managedBy.kind),
          eq(schema.tunnels.managedById, managedBy.id),
        ),
      )
      .limit(1);
    return rows[0] ? this.collaborators.getTunnel(ownerId, rows[0].id) : null;
  }

  async removeManagedTunnel(
    ownerId: string,
    managedBy: NonNullable<TunnelWireSummary["managedBy"]>,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.tunnels)
      .where(
        and(
          eq(schema.tunnels.ownerId, ownerId),
          ne(schema.tunnels.management, "user-managed"),
          eq(schema.tunnels.managedByKind, managedBy.kind),
          eq(schema.tunnels.managedById, managedBy.id),
        ),
      )
      .returning({ id: schema.tunnels.id });
    return rows.length === 1;
  }

  async #recomputeDesktopTunnelState(
    transaction: RepositoryTransaction,
    tunnelId: string,
    now: Date,
  ): Promise<void> {
    const attachments = await transaction
      .select({
        errorCode: schema.tunnelAttachments.errorCode,
        id: schema.tunnelAttachments.id,
        lastSeenAt: schema.tunnelAttachments.lastSeenAt,
        status: schema.tunnelAttachments.status,
      })
      .from(schema.tunnelAttachments)
      .where(eq(schema.tunnelAttachments.tunnelId, tunnelId));
    if (attachments.length === 0) return;
    const activeDirectLeases = await transaction
      .select({
        attachmentId: schema.tunnelAttachmentDirectLeases.attachmentId,
      })
      .from(schema.tunnelAttachmentDirectLeases)
      .where(
        and(
          inArray(
            schema.tunnelAttachmentDirectLeases.attachmentId,
            attachments.map(({ id }) => id),
          ),
          eq(schema.tunnelAttachmentDirectLeases.status, "active"),
          gt(schema.tunnelAttachmentDirectLeases.leaseExpiresAt, now),
        ),
      );
    const directlyActive = new Set(
      activeDirectLeases.map(({ attachmentId }) => attachmentId),
    );
    const effectiveStatuses = new Map<string, string>();
    for (const attachment of attachments) {
      if (attachment.status === "stopped" || attachment.status === "failed") {
        effectiveStatuses.set(attachment.id, attachment.status);
        continue;
      }
      const hasOwner =
        attachment.lastSeenAt !== null || directlyActive.has(attachment.id);
      const status = hasOwner
        ? "active"
        : attachment.status === "starting" ||
            attachment.status === "degraded" ||
            attachment.status === "stopping"
          ? attachment.status
          : "offline";
      effectiveStatuses.set(attachment.id, status);
      const errorCode =
        status === "active" || status === "starting"
          ? null
          : (attachment.errorCode ?? "attachment-disconnected");
      if (attachment.status !== status || attachment.errorCode !== errorCode) {
        await transaction
          .update(schema.tunnelAttachments)
          .set({ errorCode, status, updatedAt: now })
          .where(eq(schema.tunnelAttachments.id, attachment.id));
      }
    }

    const nonterminal = [...effectiveStatuses.values()].filter(
      (status) => status !== "stopped" && status !== "failed",
    );
    const status = nonterminal.includes("active")
      ? "active"
      : nonterminal.includes("degraded")
        ? "degraded"
        : nonterminal.includes("starting")
          ? "starting"
          : nonterminal.includes("stopping")
            ? "stopping"
            : nonterminal.includes("offline")
              ? "offline"
              : null;
    if (!status) return;
    const errorCode =
      status === "active" || status === "starting"
        ? null
        : (attachments.find(
            (attachment) =>
              effectiveStatuses.get(attachment.id) === status &&
              attachment.errorCode,
          )?.errorCode ?? "attachment-disconnected");
    await transaction
      .update(schema.tunnels)
      .set({
        activeConnectionCount: 0,
        desiredState: "started",
        errorCode,
        status,
        updatedAt: now,
      })
      .where(eq(schema.tunnels.id, tunnelId));
  }

  async createDesktopTunnelAttachment(
    ownerId: string,
    tunnelId: string,
    input: {
      clientId: string;
      expiresAt: Date;
      secretExpiresAt: Date;
      secretHash: string;
    },
  ): Promise<{
    attachmentId: string;
    expiresAt: Date;
    projectId: string | null;
    secretExpiresAt: Date;
  } | null> {
    return this.database.transaction(async (transaction) => {
      const tunnels = await transaction
        .select({
          id: schema.tunnels.id,
          management: schema.tunnels.management,
          origin: schema.tunnels.origin,
          projectId: schema.tunnels.projectId,
          sourceKind: schema.tunnels.sourceKind,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        // The tunnel row serializes all client rotations, including the first
        // insert before an attachment row exists. This keeps the public
        // secret-expiry generation strictly increasing across server processes.
        .for("update")
        .limit(1);
      const tunnel = tunnels[0];
      if (
        !tunnel ||
        !(
          tunnel.management === "user-managed" ||
          (tunnel.management === "managed-ephemeral" &&
            (tunnel.origin === "browser" ||
              tunnel.origin === "code" ||
              tunnel.origin === "project-share") &&
            tunnel.sourceKind === "desktop-loopback")
        ) ||
        tunnel.sourceKind !== "desktop-loopback"
      ) {
        return null;
      }
      const existing = await transaction
        .select({
          id: schema.tunnelAttachments.id,
          secretExpiresAt: schema.tunnelAttachments.secretExpiresAt,
        })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.tunnelId, tunnelId),
            eq(schema.tunnelAttachments.clientId, input.clientId),
          ),
        )
        .limit(1);
      const now = new Date();
      const attachmentId = existing[0]?.id ?? randomUUID();
      // Treat the public expiry as the relay-credential generation. Concurrent
      // renderer refreshes can finish out of order, so every accepted rotation
      // must advance it even when both requests were created in the same
      // millisecond. Native clients can then reject an older response without
      // retaining or comparing the credential itself.
      const secretExpiresAt = new Date(
        Math.max(
          input.secretExpiresAt.getTime(),
          (existing[0]?.secretExpiresAt?.getTime() ?? 0) + 1,
        ),
      );
      const values = {
        activeConnectionCount: 0,
        expiresAt: input.expiresAt,
        errorCode: null,
        lastSeenAt: null,
        secretExpiresAt,
        secretHash: input.secretHash,
        status: "starting",
        updatedAt: now,
      } as const;
      if (existing[0]) {
        await transaction
          .update(schema.tunnelAttachments)
          .set(values)
          .where(eq(schema.tunnelAttachments.id, attachmentId));
        await transaction
          .update(schema.tunnelAttachmentDirectLeases)
          .set({
            leaseExpiresAt: sql`LEAST(${schema.tunnelAttachmentDirectLeases.leaseExpiresAt}, ${input.expiresAt})`,
            updatedAt: now,
          })
          .where(
            eq(schema.tunnelAttachmentDirectLeases.attachmentId, attachmentId),
          );
      } else {
        await transaction.insert(schema.tunnelAttachments).values({
          id: attachmentId,
          tunnelId,
          kind: "desktop-loopback",
          clientId: input.clientId,
          ...values,
        });
      }
      await this.#recomputeDesktopTunnelState(transaction, tunnelId, now);
      return {
        attachmentId,
        expiresAt: input.expiresAt,
        projectId: tunnel.projectId,
        secretExpiresAt,
      };
    });
  }

  async authorizeDesktopTunnelAttachment(
    attachmentId: string,
    secretHash: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    const now = new Date();
    const rows = await this.database
      .select({ attachment: schema.tunnelAttachments, tunnel: schema.tunnels })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          eq(schema.tunnelAttachments.kind, "desktop-loopback"),
          eq(schema.tunnelAttachments.secretHash, secretHash),
          gt(schema.tunnelAttachments.secretExpiresAt, now),
          gt(schema.tunnelAttachments.expiresAt, now),
          ne(schema.tunnelAttachments.status, "stopped"),
        ),
      )
      .limit(1);
    const row = rows[0];
    const protectedRecord = row ? tunnelProtectedRecord(row.tunnel) : null;
    const destination = row ? tunnelPublicDestination(row.tunnel) : null;
    if (
      !row?.attachment.clientId ||
      row.tunnel.sourceKind !== "desktop-loopback" ||
      !destination ||
      (destination.kind !== "worker-tcp" &&
        !(
          destination.kind === "worker-adapter" &&
          (destination.adapter === "code" ||
            destination.adapter === "project-share")
        )) ||
      !protectedRecord
    ) {
      return null;
    }
    return {
      attachmentId,
      clientId: row.attachment.clientId,
      destination:
        destination.kind === "worker-tcp" ? destination : destination,
      expiresAt: row.attachment.expiresAt!,
      ownerId: row.tunnel.ownerId,
      origin: row.tunnel.origin as TunnelWireSummary["origin"],
      projectId: row.tunnel.projectId,
      protectedRecord,
      secretExpiresAt: row.attachment.secretExpiresAt!,
      tunnelId: row.tunnel.id,
    };
  }

  async getDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
  ): Promise<TunnelAttachmentAuthorization | null> {
    const now = new Date();
    const rows = await this.database
      .select({ attachment: schema.tunnelAttachments, tunnel: schema.tunnels })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          eq(schema.tunnelAttachments.id, attachmentId),
          eq(schema.tunnelAttachments.kind, "desktop-loopback"),
          eq(schema.tunnels.ownerId, ownerId),
          gt(schema.tunnelAttachments.expiresAt, now),
          ne(schema.tunnelAttachments.status, "stopped"),
        ),
      )
      .limit(1);
    const row = rows[0];
    const protectedRecord = row ? tunnelProtectedRecord(row.tunnel) : null;
    const destination = row ? tunnelPublicDestination(row.tunnel) : null;
    if (
      !row?.attachment.clientId ||
      !row.attachment.expiresAt ||
      !row.attachment.secretExpiresAt ||
      row.tunnel.sourceKind !== "desktop-loopback" ||
      !destination ||
      (destination.kind !== "worker-tcp" &&
        !(
          destination.kind === "worker-adapter" &&
          (destination.adapter === "code" ||
            destination.adapter === "project-share")
        )) ||
      !protectedRecord
    ) {
      return null;
    }
    return {
      attachmentId,
      clientId: row.attachment.clientId,
      destination:
        destination.kind === "worker-tcp" ? destination : destination,
      expiresAt: row.attachment.expiresAt,
      ownerId: row.tunnel.ownerId,
      origin: row.tunnel.origin as TunnelWireSummary["origin"],
      projectId: row.tunnel.projectId,
      protectedRecord,
      secretExpiresAt: row.attachment.secretExpiresAt!,
      tunnelId: row.tunnel.id,
    };
  }

  async activateDesktopTunnelAttachment(
    attachmentId: string,
    clientId: string,
    secretExpiresAt: Date,
  ): Promise<Date | null> {
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({ tunnelId: schema.tunnelAttachments.tunnelId })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.clientId, clientId),
          ),
        )
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return null;
      const tunnelRows = await transaction
        .select({ id: schema.tunnels.id })
        .from(schema.tunnels)
        .where(eq(schema.tunnels.id, attachment.tunnelId))
        .for("update")
        .limit(1);
      if (!tunnelRows[0]) return null;
      const now = new Date();
      const currentRows = await transaction
        .select({ activatedAt: schema.tunnelAttachments.lastSeenAt })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.clientId, clientId),
            eq(schema.tunnelAttachments.secretExpiresAt, secretExpiresAt),
          ),
        )
        .limit(1);
      if (!currentRows[0]) return null;
      const activatedAt = new Date(
        Math.max(
          now.getTime(),
          (currentRows[0].activatedAt?.getTime() ?? 0) + 1,
        ),
      );
      const attachments = await transaction
        .update(schema.tunnelAttachments)
        .set({
          errorCode: null,
          lastSeenAt: activatedAt,
          status: "active",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.clientId, clientId),
            eq(schema.tunnelAttachments.secretExpiresAt, secretExpiresAt),
            ne(schema.tunnelAttachments.status, "stopped"),
            gt(schema.tunnelAttachments.expiresAt, now),
          ),
        )
        .returning({
          activatedAt: schema.tunnelAttachments.lastSeenAt,
          tunnelId: schema.tunnelAttachments.tunnelId,
        });
      if (!attachments[0]?.activatedAt) return null;
      await this.#recomputeDesktopTunnelState(
        transaction,
        attachments[0].tunnelId,
        now,
      );
      return attachments[0].activatedAt;
    });
  }

  async markDesktopTunnelAttachmentOffline(
    attachmentId: string,
    secretExpiresAt: Date,
    activatedAt: Date,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({ tunnelId: schema.tunnelAttachments.tunnelId })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId))
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return false;
      const tunnelRows = await transaction
        .select({ id: schema.tunnels.id })
        .from(schema.tunnels)
        .where(eq(schema.tunnels.id, attachment.tunnelId))
        .for("update")
        .limit(1);
      if (!tunnelRows[0]) return false;
      const now = new Date();
      const rows = await transaction
        .update(schema.tunnelAttachments)
        .set({
          activeConnectionCount: 0,
          errorCode: "attachment-disconnected",
          lastSeenAt: null,
          status: "offline",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.secretExpiresAt, secretExpiresAt),
            eq(schema.tunnelAttachments.lastSeenAt, activatedAt),
            ne(schema.tunnelAttachments.status, "stopped"),
            gt(schema.tunnelAttachments.expiresAt, now),
          ),
        )
        .returning({ tunnelId: schema.tunnelAttachments.tunnelId });
      if (!rows[0]) return false;
      await this.#recomputeDesktopTunnelState(
        transaction,
        rows[0].tunnelId,
        now,
      );
      return true;
    });
  }

  async activateDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
    secretExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    if (
      !capabilityId ||
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt.getTime() <= Date.now() ||
      !Number.isFinite(secretExpiresAt.getTime())
    ) {
      return null;
    }
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({ tunnelId: schema.tunnelAttachments.tunnelId })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId))
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return null;
      const tunnelRows = await transaction
        .select({
          ownerId: schema.tunnels.ownerId,
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, attachment.tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const tunnel = tunnelRows[0];
      if (!tunnel) return null;
      const now = new Date();
      const currentRows = await transaction
        .select({ expiresAt: schema.tunnelAttachments.expiresAt })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            eq(schema.tunnelAttachments.secretExpiresAt, secretExpiresAt),
            notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
            gt(schema.tunnelAttachments.expiresAt, now),
          ),
        )
        .limit(1);
      const current = currentRows[0];
      if (!current?.expiresAt) return null;
      const boundedLeaseExpiresAt = new Date(
        Math.min(leaseExpiresAt.getTime(), current.expiresAt.getTime()),
      );
      if (boundedLeaseExpiresAt <= now) return null;
      const leases = await transaction
        .insert(schema.tunnelAttachmentDirectLeases)
        .values({
          attachmentId,
          capabilityId,
          leaseExpiresAt: boundedLeaseExpiresAt,
          status: "active",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.tunnelAttachmentDirectLeases.capabilityId,
          set: {
            leaseExpiresAt: sql`LEAST(GREATEST(${schema.tunnelAttachmentDirectLeases.leaseExpiresAt}, ${boundedLeaseExpiresAt}), ${current.expiresAt})`,
            updatedAt: now,
          },
          setWhere: and(
            eq(schema.tunnelAttachmentDirectLeases.status, "active"),
            eq(schema.tunnelAttachmentDirectLeases.attachmentId, attachmentId),
          ),
        })
        .returning({
          capabilityId: schema.tunnelAttachmentDirectLeases.capabilityId,
        });
      if (!leases[0]) return null;
      await this.#recomputeDesktopTunnelState(
        transaction,
        tunnel.tunnelId,
        now,
      );
      return { attachmentId, ...tunnel };
    });
  }

  async renewDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    if (
      !capabilityId ||
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({
          expiresAt: schema.tunnelAttachments.expiresAt,
          status: schema.tunnelAttachments.status,
          tunnelId: schema.tunnelAttachments.tunnelId,
        })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId))
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return null;
      const tunnelRows = await transaction
        .select({
          ownerId: schema.tunnels.ownerId,
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, attachment.tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const tunnel = tunnelRows[0];
      if (
        !tunnel ||
        !attachment.expiresAt ||
        attachment.status === "stopped" ||
        attachment.status === "failed"
      ) {
        return null;
      }
      const now = new Date();
      const boundedLeaseExpiresAt = new Date(
        Math.min(leaseExpiresAt.getTime(), attachment.expiresAt.getTime()),
      );
      if (boundedLeaseExpiresAt <= now) return null;
      const rows = await transaction
        .update(schema.tunnelAttachmentDirectLeases)
        .set({
          leaseExpiresAt: sql`LEAST(GREATEST(${schema.tunnelAttachmentDirectLeases.leaseExpiresAt}, ${boundedLeaseExpiresAt}), ${attachment.expiresAt})`,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachmentDirectLeases.capabilityId, capabilityId),
            eq(schema.tunnelAttachmentDirectLeases.attachmentId, attachmentId),
            eq(schema.tunnelAttachmentDirectLeases.status, "active"),
          ),
        )
        .returning({
          capabilityId: schema.tunnelAttachmentDirectLeases.capabilityId,
        });
      return rows[0] ? { attachmentId, ...tunnel } : null;
    });
  }

  async finalizeDesktopTunnelDirectLease(
    ownerId: string,
    attachmentId: string,
    capabilityId: string,
    leaseExpiresAt: Date,
  ): Promise<DesktopTunnelAttachmentLeaseChange | null> {
    if (!capabilityId || !Number.isFinite(leaseExpiresAt.getTime()))
      return null;
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({
          expiresAt: schema.tunnelAttachments.expiresAt,
          status: schema.tunnelAttachments.status,
          tunnelId: schema.tunnelAttachments.tunnelId,
        })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId))
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return null;
      const tunnelRows = await transaction
        .select({
          ownerId: schema.tunnels.ownerId,
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, attachment.tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const tunnel = tunnelRows[0];
      if (!tunnel) return null;
      if (attachment.status === "stopped" || attachment.status === "failed") {
        await transaction
          .delete(schema.tunnelAttachmentDirectLeases)
          .where(
            and(
              eq(
                schema.tunnelAttachmentDirectLeases.capabilityId,
                capabilityId,
              ),
              eq(
                schema.tunnelAttachmentDirectLeases.attachmentId,
                attachmentId,
              ),
            ),
          );
        return null;
      }
      const now = new Date();
      const boundedLeaseExpiresAt = new Date(
        Math.min(
          leaseExpiresAt.getTime(),
          attachment.expiresAt?.getTime() ?? leaseExpiresAt.getTime(),
        ),
      );
      const hardExpiresAt = attachment.expiresAt ?? boundedLeaseExpiresAt;
      const rows = await transaction
        .insert(schema.tunnelAttachmentDirectLeases)
        .values({
          attachmentId,
          capabilityId,
          finalizedAt: now,
          leaseExpiresAt: boundedLeaseExpiresAt,
          status: "finalized",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.tunnelAttachmentDirectLeases.capabilityId,
          set: {
            finalizedAt: now,
            leaseExpiresAt: sql`LEAST(GREATEST(${schema.tunnelAttachmentDirectLeases.leaseExpiresAt}, ${boundedLeaseExpiresAt}), ${hardExpiresAt})`,
            status: "finalized",
            updatedAt: now,
          },
          setWhere: eq(
            schema.tunnelAttachmentDirectLeases.attachmentId,
            attachmentId,
          ),
        })
        .returning({
          capabilityId: schema.tunnelAttachmentDirectLeases.capabilityId,
        });
      if (!rows[0]) return null;
      await this.#recomputeDesktopTunnelState(
        transaction,
        tunnel.tunnelId,
        now,
      );
      return { attachmentId, ...tunnel };
    });
  }

  async expireDesktopTunnelDirectLeases(
    now = new Date(),
  ): Promise<DesktopTunnelAttachmentLeaseChange[]> {
    const expired = await this.database
      .select({
        attachmentId: schema.tunnelAttachmentDirectLeases.attachmentId,
        ownerId: schema.tunnels.ownerId,
        projectId: schema.tunnels.projectId,
        tunnelId: schema.tunnels.id,
      })
      .from(schema.tunnelAttachmentDirectLeases)
      .innerJoin(
        schema.tunnelAttachments,
        eq(
          schema.tunnelAttachments.id,
          schema.tunnelAttachmentDirectLeases.attachmentId,
        ),
      )
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(lte(schema.tunnelAttachmentDirectLeases.leaseExpiresAt, now));
    const changes = new Map<string, DesktopTunnelAttachmentLeaseChange>();
    const processedAttachments = new Set<string>();
    for (const observed of expired) {
      if (processedAttachments.has(observed.attachmentId)) continue;
      processedAttachments.add(observed.attachmentId);
      const changed = await this.database.transaction(async (transaction) => {
        const tunnelRows = await transaction
          .select({ id: schema.tunnels.id })
          .from(schema.tunnels)
          .where(eq(schema.tunnels.id, observed.tunnelId))
          .for("update")
          .limit(1);
        if (!tunnelRows[0]) return false;
        const rows = await transaction
          .update(schema.tunnelAttachmentDirectLeases)
          .set({ finalizedAt: now, status: "finalized", updatedAt: now })
          .where(
            and(
              eq(
                schema.tunnelAttachmentDirectLeases.attachmentId,
                observed.attachmentId,
              ),
              eq(schema.tunnelAttachmentDirectLeases.status, "active"),
              lte(schema.tunnelAttachmentDirectLeases.leaseExpiresAt, now),
            ),
          )
          .returning({
            capabilityId: schema.tunnelAttachmentDirectLeases.capabilityId,
          });
        await transaction
          .delete(schema.tunnelAttachmentDirectLeases)
          .where(
            and(
              eq(
                schema.tunnelAttachmentDirectLeases.attachmentId,
                observed.attachmentId,
              ),
              eq(schema.tunnelAttachmentDirectLeases.status, "finalized"),
              lte(schema.tunnelAttachmentDirectLeases.leaseExpiresAt, now),
            ),
          );
        if (!rows[0]) return false;
        await this.#recomputeDesktopTunnelState(
          transaction,
          observed.tunnelId,
          now,
        );
        return true;
      });
      if (changed) changes.set(observed.attachmentId, observed);
    }
    return [...changes.values()];
  }

  async stopDesktopTunnelAttachment(
    ownerId: string,
    attachmentId: string,
    errorCode: TunnelContentErrorCode | null = null,
    preserveTunnelState = false,
    expected?: DesktopTunnelAttachmentStopFence,
  ): Promise<{ projectId: string | null; tunnelId: string } | null> {
    return this.database.transaction(async (transaction) => {
      const attachmentRows = await transaction
        .select({ tunnelId: schema.tunnelAttachments.tunnelId })
        .from(schema.tunnelAttachments)
        .where(eq(schema.tunnelAttachments.id, attachmentId))
        .limit(1);
      const attachment = attachmentRows[0];
      if (!attachment) return null;
      // All attachment lifecycle writers take the owning tunnel lock before
      // updating the attachment row. This single lock order prevents stop,
      // activation, and credential rotation from deadlocking each other.
      const rows = await transaction
        .select({
          projectId: schema.tunnels.projectId,
          tunnelId: schema.tunnels.id,
        })
        .from(schema.tunnels)
        .where(
          and(
            eq(schema.tunnels.id, attachment.tunnelId),
            eq(schema.tunnels.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const now = new Date();
      const stoppedAttachments = await transaction
        .update(schema.tunnelAttachments)
        .set({
          activeConnectionCount: 0,
          errorCode,
          secretExpiresAt: null,
          secretHash: null,
          status: errorCode ? "failed" : "stopped",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tunnelAttachments.id, attachmentId),
            ...(expected
              ? [
                  expected.activatedAt === null
                    ? isNull(schema.tunnelAttachments.lastSeenAt)
                    : eq(
                        schema.tunnelAttachments.lastSeenAt,
                        expected.activatedAt,
                      ),
                  expected.expiresAt === null
                    ? isNull(schema.tunnelAttachments.expiresAt)
                    : eq(
                        schema.tunnelAttachments.expiresAt,
                        expected.expiresAt,
                      ),
                  expected.secretExpiresAt === null
                    ? isNull(schema.tunnelAttachments.secretExpiresAt)
                    : eq(
                        schema.tunnelAttachments.secretExpiresAt,
                        expected.secretExpiresAt,
                      ),
                ]
              : []),
          ),
        )
        .returning({ id: schema.tunnelAttachments.id });
      if (!stoppedAttachments[0]) return null;
      await transaction
        .delete(schema.tunnelAttachmentDirectLeases)
        .where(
          eq(schema.tunnelAttachmentDirectLeases.attachmentId, attachmentId),
        );
      const remaining = await transaction
        .select({ id: schema.tunnelAttachments.id })
        .from(schema.tunnelAttachments)
        .where(
          and(
            eq(schema.tunnelAttachments.tunnelId, row.tunnelId),
            ne(schema.tunnelAttachments.id, attachmentId),
            notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
          ),
        )
        .limit(1);
      if (remaining.length === 0 && !preserveTunnelState) {
        await transaction
          .update(schema.tunnels)
          .set({
            activeConnectionCount: 0,
            desiredState: "stopped",
            errorCode,
            status: errorCode ? "failed" : "stopped",
            updatedAt: now,
          })
          .where(eq(schema.tunnels.id, row.tunnelId));
      } else if (remaining.length > 0) {
        await this.#recomputeDesktopTunnelState(transaction, row.tunnelId, now);
      }
      return row;
    });
  }

  async resetTransientTunnelAttachments(): Promise<void> {
    const now = new Date();
    const transientStatuses = [
      "starting",
      "active",
      "degraded",
      "stopping",
    ] as const;
    const candidates = await this.database
      .select({ id: schema.tunnels.id })
      .from(schema.tunnels)
      .where(
        or(
          inArray(schema.tunnels.status, transientStatuses),
          and(
            inArray(schema.tunnels.origin, ["code", "project-share"]),
            eq(schema.tunnels.management, "managed-ephemeral"),
          ),
        ),
      );
    for (const candidate of candidates) {
      await this.database.transaction(async (transaction) => {
        const tunnelRows = await transaction
          .select({
            id: schema.tunnels.id,
            management: schema.tunnels.management,
            origin: schema.tunnels.origin,
            status: schema.tunnels.status,
          })
          .from(schema.tunnels)
          .where(eq(schema.tunnels.id, candidate.id))
          .for("update")
          .limit(1);
        const tunnel = tunnelRows[0];
        if (!tunnel) return;
        const liveDirectAttachments = await transaction
          .select({ id: schema.tunnelAttachmentDirectLeases.attachmentId })
          .from(schema.tunnelAttachmentDirectLeases)
          .innerJoin(
            schema.tunnelAttachments,
            eq(
              schema.tunnelAttachments.id,
              schema.tunnelAttachmentDirectLeases.attachmentId,
            ),
          )
          .where(
            and(
              eq(schema.tunnelAttachments.tunnelId, tunnel.id),
              notInArray(schema.tunnelAttachments.status, [
                "stopped",
                "failed",
              ]),
              eq(schema.tunnelAttachmentDirectLeases.status, "active"),
              gt(schema.tunnelAttachmentDirectLeases.leaseExpiresAt, now),
            ),
          );
        const liveDirectAttachmentIds = [
          ...new Set(liveDirectAttachments.map(({ id }) => id)),
        ];
        await transaction
          .update(schema.tunnelAttachments)
          .set({
            activeConnectionCount: 0,
            errorCode: "server-restarted",
            lastSeenAt: null,
            secretExpiresAt: null,
            secretHash: null,
            status: "offline",
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.tunnelAttachments.tunnelId, tunnel.id),
              inArray(schema.tunnelAttachments.status, transientStatuses),
            ),
          );
        if (liveDirectAttachmentIds.length > 0) {
          await this.#recomputeDesktopTunnelState(transaction, tunnel.id, now);
          return;
        }
        if (
          tunnel.management === "managed-ephemeral" &&
          (tunnel.origin === "code" || tunnel.origin === "project-share")
        ) {
          await transaction
            .delete(schema.tunnels)
            .where(eq(schema.tunnels.id, tunnel.id));
          return;
        }
        if (transientStatuses.includes(tunnel.status as never)) {
          await transaction
            .update(schema.tunnels)
            .set({
              activeConnectionCount: 0,
              errorCode: "server-restarted",
              status: "offline",
              updatedAt: now,
            })
            .where(eq(schema.tunnels.id, tunnel.id));
        }
      });
    }
  }

  async expireDesktopTunnelAttachments(now = new Date()): Promise<
    Array<{
      attachmentId: string;
      ownerId: string;
      projectId: string | null;
      tunnelId: string;
    }>
  > {
    const expired = await this.database
      .select({
        attachmentId: schema.tunnelAttachments.id,
        activatedAt: schema.tunnelAttachments.lastSeenAt,
        expiresAt: schema.tunnelAttachments.expiresAt,
        ownerId: schema.tunnels.ownerId,
        projectId: schema.tunnels.projectId,
        secretExpiresAt: schema.tunnelAttachments.secretExpiresAt,
        tunnelId: schema.tunnels.id,
      })
      .from(schema.tunnelAttachments)
      .innerJoin(
        schema.tunnels,
        eq(schema.tunnels.id, schema.tunnelAttachments.tunnelId),
      )
      .where(
        and(
          lte(schema.tunnelAttachments.expiresAt, now),
          notInArray(schema.tunnelAttachments.status, ["stopped", "failed"]),
        ),
      );
    const stopped: Array<{
      attachmentId: string;
      ownerId: string;
      projectId: string | null;
      tunnelId: string;
    }> = [];
    for (const attachment of expired) {
      if (
        await this.collaborators.stopDesktopTunnelAttachment(
          attachment.ownerId,
          attachment.attachmentId,
          "attachment-expired",
          false,
          {
            activatedAt: attachment.activatedAt,
            expiresAt: attachment.expiresAt,
            secretExpiresAt: attachment.secretExpiresAt,
          },
        )
      ) {
        stopped.push({
          attachmentId: attachment.attachmentId,
          ownerId: attachment.ownerId,
          projectId: attachment.projectId,
          tunnelId: attachment.tunnelId,
        });
      }
    }
    return stopped;
  }
}
