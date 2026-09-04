import type {
  EncryptedRemoteSurfaceCreate,
  EncryptedRemoteSurfaceUpdate,
  PrivateDisplayLabelOpaque,
  RemoteDesktopWireSummary,
  RemoteSurfaceCapabilities,
  RemoteSurfaceStatus,
  RemoteSurfaceWireSummary,
  SurfacePrivateStateOpaque,
} from "@cantrip/protocol";
import { and, asc, eq, sql } from "drizzle-orm";

import * as schema from "../schema.js";
import { attachProjectTab } from "../tab-layouts.js";
import { SurfacePrivateStateConflictError } from "./browsers.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export interface RemoteSurfaceExecutionContext {
  remoteSurfaceCapabilities: RemoteSurfaceCapabilities;
  surface: RemoteSurfaceWireSummary;
  workerId: string;
}

export interface RemoteSurfaceRepositoryCollaborators {
  getRemoteDesktop(
    ownerId: string,
    desktopId: string,
  ): Promise<RemoteDesktopWireSummary | null>;
  getRemoteSurfaceExecutionContext(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null>;
  nextProjectTabPosition(projectId: string): Promise<number>;
}

function toRemoteSurfaceWireSummary(
  surface: typeof schema.remoteSurfaces.$inferSelect,
  titleProtection: PrivateDisplayLabelOpaque | null = surface.protectedLabel,
  stateProtection = surface.protectedState,
  stateRevision = surface.stateRevision,
): RemoteSurfaceWireSummary {
  if (!titleProtection) {
    throw new Error("Remote Surface is missing its canonical protected label.");
  }
  if (!stateProtection || !stateRevision) {
    throw new Error("Remote Surface is missing its canonical protected state.");
  }
  return {
    id: surface.id,
    projectId: surface.projectId,
    workerId: surface.workerId,
    kind: surface.kind as RemoteSurfaceWireSummary["kind"],
    titleProtection,
    status: surface.status as RemoteSurfaceWireSummary["status"],
    preferredTransport:
      surface.preferredTransport as RemoteSurfaceWireSummary["preferredTransport"],
    configuration: surface.configuration,
    stateProtection,
    stateRevision,
    lastError: surface.lastError,
    lastConnectedAt: surface.lastConnectedAt
      ? toISOString(surface.lastConnectedAt)
      : null,
    createdAt: toISOString(surface.createdAt),
    updatedAt: toISOString(surface.updatedAt),
  };
}

function toRemoteDesktopWireSummary(
  view: typeof schema.projectViews.$inferSelect,
  surface: typeof schema.remoteSurfaces.$inferSelect,
): RemoteDesktopWireSummary {
  if (surface.configuration.kind !== "desktop") {
    throw new Error("Remote Desktop is not backed by a desktop surface.");
  }
  if (!surface.protectedState || !surface.stateRevision) {
    throw new Error("Remote Desktop is missing its protected target state.");
  }
  return {
    id: view.id,
    projectId: view.projectId,
    titleProtection: view.protectedLabel,
    position: view.position,
    workerId: surface.workerId,
    stateProtection: surface.protectedState,
    stateRevision: surface.stateRevision,
    status: surface.status as RemoteDesktopWireSummary["status"],
    lastError: surface.lastError,
    createdAt: toISOString(view.createdAt),
    updatedAt: toISOString(
      view.updatedAt > surface.updatedAt ? view.updatedAt : surface.updatedAt,
    ),
  };
}

export class RemoteSurfaceRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: RemoteSurfaceRepositoryCollaborators,
  ) {}

  async listRemoteSurfaces(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteSurfaceWireSummary[]> {
    const rows = await this.database
      .select({
        surface: schema.remoteSurfaces,
        browserLabel: schema.browsers.protectedLabel,
        browserState: schema.browsers.protectedState,
        browserStateRevision: schema.browsers.stateRevision,
        viewLabel: schema.projectViews.protectedLabel,
      })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.browsers,
        eq(schema.browsers.id, schema.remoteSurfaces.id),
      )
      .leftJoin(
        schema.projectViews,
        eq(schema.projectViews.id, schema.remoteSurfaces.id),
      )
      .where(eq(schema.remoteSurfaces.projectId, projectId))
      .orderBy(
        asc(schema.remoteSurfaces.createdAt),
        asc(schema.remoteSurfaces.id),
      );
    return rows.map(
      ({
        surface,
        browserLabel,
        browserState,
        browserStateRevision,
        viewLabel,
      }) =>
        toRemoteSurfaceWireSummary(
          surface,
          surface.protectedLabel ?? browserLabel ?? viewLabel,
          browserState ?? surface.protectedState,
          browserStateRevision ?? surface.stateRevision,
        ),
    );
  }

  async createRemoteSurface(
    ownerId: string,
    projectId: string,
    input: EncryptedRemoteSurfaceCreate,
  ): Promise<RemoteSurfaceWireSummary | null> {
    const [projectRows, workerRows] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1),
    ]);
    if (!projectRows[0] || !workerRows[0]) return null;
    const result = await this.database
      .insert(schema.remoteSurfaces)
      .values({
        id: input.id,
        projectId,
        workerId: input.workerId,
        kind: input.configuration.kind,
        protectedLabel: input.titleProtection,
        protectedState: input.stateProtection ?? null,
        stateRevision: input.stateProtection ? 1 : null,
        configuration: input.configuration,
      })
      .returning();
    return toRemoteSurfaceWireSummary(
      firstOrThrow(result, "creating a Remote Surface"),
    );
  }

  async getRemoteSurfaceExecutionContext(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    const rows = await this.database
      .select({
        surface: schema.remoteSurfaces,
        remoteSurfaceCapabilities: schema.workers.remoteSurfaceCapabilities,
        browserLabel: schema.browsers.protectedLabel,
        browserState: schema.browsers.protectedState,
        browserStateRevision: schema.browsers.stateRevision,
        viewLabel: schema.projectViews.protectedLabel,
      })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.remoteSurfaces.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.browsers,
        eq(schema.browsers.id, schema.remoteSurfaces.id),
      )
      .leftJoin(
        schema.projectViews,
        eq(schema.projectViews.id, schema.remoteSurfaces.id),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
        ),
      )
      .where(eq(schema.remoteSurfaces.id, surfaceId))
      .limit(1);
    const surface = rows[0]?.surface;
    return surface
      ? {
          remoteSurfaceCapabilities: rows[0]!.remoteSurfaceCapabilities,
          surface: toRemoteSurfaceWireSummary(
            surface,
            surface.protectedLabel ??
              rows[0]!.browserLabel ??
              rows[0]!.viewLabel,
            rows[0]!.browserState ?? surface.protectedState,
            rows[0]!.browserStateRevision ?? surface.stateRevision,
          ),
          workerId: surface.workerId,
        }
      : null;
  }

  async updateRemoteSurface(
    ownerId: string,
    surfaceId: string,
    input: EncryptedRemoteSurfaceUpdate,
  ): Promise<RemoteSurfaceWireSummary | null> {
    const context = await this.collaborators.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
    if (
      !context ||
      (input.configuration &&
        input.configuration.kind !== context.surface.kind) ||
      (input.stateProtection &&
        input.stateProtection.classification.recordKind !==
          (context.surface.kind === "browser"
            ? "browser-state"
            : "remote-desktop-state")) ||
      (input.titleProtection &&
        context.surface.titleProtection.classification.recordKind !==
          "remote-surface")
    ) {
      return null;
    }
    const result = await this.database
      .update(schema.remoteSurfaces)
      .set({
        ...(input.titleProtection
          ? { protectedLabel: input.titleProtection }
          : {}),
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.stateProtection
          ? {
              protectedState: input.stateProtection,
              stateRevision: input.expectedStateRevision! + 1,
            }
          : {}),
        ...(input.preferredTransport
          ? { preferredTransport: input.preferredTransport }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.remoteSurfaces.id, surfaceId),
          ...(input.expectedStateRevision === undefined
            ? []
            : [
                eq(
                  schema.remoteSurfaces.stateRevision,
                  input.expectedStateRevision,
                ),
              ]),
        ),
      )
      .returning();
    if (!result[0] && input.expectedStateRevision !== undefined) {
      throw new SurfacePrivateStateConflictError(
        "Remote Surface private state changed before this update.",
      );
    }
    return result[0]
      ? toRemoteSurfaceWireSummary(
          result[0],
          result[0].protectedLabel ?? context.surface.titleProtection,
        )
      : null;
  }

  async setRemoteSurfaceStatus(
    surfaceId: string,
    status: RemoteSurfaceStatus,
    lastError: string | null = null,
  ): Promise<void> {
    await this.database
      .update(schema.remoteSurfaces)
      .set({
        status,
        lastError,
        lastConnectedAt: status === "active" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.remoteSurfaces.id, surfaceId));
  }

  async resetTransientRemoteSurfaceStatuses(): Promise<void> {
    await this.database.execute(sql`
      update ${schema.remoteSurfaces}
      set status = 'idle', last_error = null, updated_at = now()
      where status in ('connecting', 'active', 'offline')
    `);
  }

  async deleteRemoteSurface(
    ownerId: string,
    surfaceId: string,
  ): Promise<RemoteSurfaceExecutionContext | null> {
    const context = await this.collaborators.getRemoteSurfaceExecutionContext(
      ownerId,
      surfaceId,
    );
    if (!context) return null;
    await this.database
      .delete(schema.remoteSurfaces)
      .where(eq(schema.remoteSurfaces.id, surfaceId));
    return context;
  }

  async listRemoteDesktops(
    ownerId: string,
    projectId: string,
  ): Promise<RemoteDesktopWireSummary[]> {
    const rows = await this.database
      .select({ view: schema.projectViews, surface: schema.remoteSurfaces })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.projectViews.id),
      )
      .where(
        and(
          eq(schema.projectViews.projectId, projectId),
          eq(schema.projectViews.kind, "remote-desktop"),
          eq(schema.remoteSurfaces.kind, "desktop"),
        ),
      )
      .orderBy(
        asc(schema.projectViews.position),
        asc(schema.projectViews.createdAt),
      );
    return rows.map(({ view, surface }) =>
      toRemoteDesktopWireSummary(view, surface),
    );
  }

  async getRemoteDesktop(
    ownerId: string,
    desktopId: string,
  ): Promise<RemoteDesktopWireSummary | null> {
    const rows = await this.database
      .select({ view: schema.projectViews, surface: schema.remoteSurfaces })
      .from(schema.projectViews)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.projectViews.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.projectViews.id),
      )
      .where(
        and(
          eq(schema.projectViews.id, desktopId),
          eq(schema.projectViews.kind, "remote-desktop"),
          eq(schema.remoteSurfaces.kind, "desktop"),
        ),
      )
      .limit(1);
    return rows[0]
      ? toRemoteDesktopWireSummary(rows[0].view, rows[0].surface)
      : null;
  }

  async createRemoteDesktop(
    ownerId: string,
    projectId: string,
    desktopId: string,
    titleProtection: PrivateDisplayLabelOpaque,
    workerId: string,
    stateProtection: SurfacePrivateStateOpaque,
    paneId?: string,
  ): Promise<RemoteDesktopWireSummary | null> {
    const [projectRows, workerRows] = await Promise.all([
      this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1),
      this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1),
    ]);
    if (!projectRows[0] || !workerRows[0]) return null;
    const position = await this.collaborators.nextProjectTabPosition(projectId);
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.projectViews).values({
        id: desktopId,
        projectId,
        protectedLabel: titleProtection,
        kind: "remote-desktop",
        worktreeId: null,
        position,
      });
      await transaction.insert(schema.remoteSurfaces).values({
        id: desktopId,
        projectId,
        workerId,
        kind: "desktop",
        preferredTransport: "webrtc",
        configuration: { kind: "desktop" },
        protectedState: stateProtection,
        stateRevision: 1,
      });
      await attachProjectTab(transaction, {
        projectId,
        paneId,
        tabId: desktopId,
        tabKind: "remote-desktop",
      });
    });
    return this.collaborators.getRemoteDesktop(ownerId, desktopId);
  }
}
