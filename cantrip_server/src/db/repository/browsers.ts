import type {
  BrowserWireSummary,
  EncryptedBrowserCreate,
  EncryptedBrowserUpdate,
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
  RemoteSurfaceWireSummary,
} from "@cantrip/protocol";
import { and, asc, eq, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  attachProjectTab,
  detachProjectTab,
  projectTabKey,
} from "../tab-layouts.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export class SurfacePrivateStateConflictError extends Error {}

interface BrowserRemoteSurfaceExecutionContext {
  surface: Pick<RemoteSurfaceWireSummary, "kind" | "projectId">;
  workerId: string;
}

export interface BrowserRepositoryCollaborators {
  getProjectSource(
    ownerId: string,
    projectId: string,
  ): Promise<{ workerId: string } | null>;
  getRemoteSurfaceExecutionContext(
    ownerId: string,
    surfaceId: string,
  ): Promise<BrowserRemoteSurfaceExecutionContext | null>;
  nextProjectTabPosition(projectId: string): Promise<number>;
  resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit?: boolean,
  ): Promise<ExecutionPlacementResolution>;
}

function toBrowserWireSummary(
  browser: typeof schema.browsers.$inferSelect,
  workerId: string | null = null,
): BrowserWireSummary {
  return {
    id: browser.id,
    projectId: browser.projectId,
    titleProtection: browser.protectedLabel,
    position: browser.position,
    stateProtection: browser.protectedState,
    stateRevision: browser.stateRevision,
    workerId,
    createdAt: toISOString(browser.createdAt),
    updatedAt: toISOString(browser.updatedAt),
  };
}

export class BrowserRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: BrowserRepositoryCollaborators,
  ) {}

  async listBrowsers(
    ownerId: string,
    projectId: string,
  ): Promise<BrowserWireSummary[]> {
    const rows = await this.database
      .select({
        browser: schema.browsers,
        workerId: schema.remoteSurfaces.workerId,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.browsers.id),
      )
      .where(eq(schema.browsers.projectId, projectId))
      .orderBy(asc(schema.browsers.position), asc(schema.browsers.createdAt));
    return rows.map(({ browser, workerId }) =>
      toBrowserWireSummary(browser, workerId),
    );
  }

  async createBrowser(
    ownerId: string,
    projectId: string,
    input: EncryptedBrowserCreate,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<BrowserWireSummary | null> {
    const { placement } =
      await this.collaborators.resolveProjectExecutionPlacement(
        ownerId,
        projectId,
        "browser",
        input.target,
        isWorkerConnected,
      );
    const position = await this.collaborators.nextProjectTabPosition(projectId);
    return this.database.transaction(async (transaction) => {
      const browserId = input.id;
      const result = await transaction
        .insert(schema.browsers)
        .values({
          id: browserId,
          projectId,
          protectedLabel: input.titleProtection,
          protectedState: input.stateProtection,
          stateRevision: 1,
          position,
        })
        .returning();
      const browser = firstOrThrow(result, "creating a browser");
      await transaction.insert(schema.remoteSurfaces).values({
        id: browserId,
        projectId,
        workerId: placement.workerId,
        kind: "browser",
        preferredTransport: "webrtc",
        configuration: {
          kind: "browser",
          profileId: null,
        },
      });
      await attachProjectTab(transaction, {
        projectId,
        paneId: input.paneId ?? input.tabGroupId,
        region: input.targetRegion,
        tabId: browser.id,
        tabKind: "browser",
      });
      return toBrowserWireSummary(browser, placement.workerId);
    });
  }

  async updateBrowser(
    ownerId: string,
    browserId: string,
    input: EncryptedBrowserUpdate,
  ): Promise<BrowserWireSummary | null> {
    if (!(await this.browserIsOwnedBy(ownerId, browserId))) return null;
    const surface = await this.collaborators.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    return this.database.transaction(async (transaction) => {
      const result = await transaction
        .update(schema.browsers)
        .set({
          ...(input.titleProtection
            ? { protectedLabel: input.titleProtection }
            : {}),
          ...(input.stateProtection
            ? {
                protectedState: input.stateProtection,
                stateRevision: input.expectedStateRevision! + 1,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.browsers.id, browserId),
            ...(input.expectedStateRevision === undefined
              ? []
              : [
                  eq(
                    schema.browsers.stateRevision,
                    input.expectedStateRevision,
                  ),
                ]),
          ),
        )
        .returning();
      const browser = result[0];
      if (!browser) {
        if (input.expectedStateRevision === undefined) return null;
        throw new SurfacePrivateStateConflictError(
          "Browser private state changed before this update.",
        );
      }
      await transaction
        .update(schema.remoteSurfaces)
        .set({ updatedAt: new Date() })
        .where(eq(schema.remoteSurfaces.id, browserId));
      return toBrowserWireSummary(browser, surface?.workerId ?? null);
    });
  }

  async deleteBrowser(ownerId: string, browserId: string): Promise<boolean> {
    const context = await this.collaborators.getRemoteSurfaceExecutionContext(
      ownerId,
      browserId,
    );
    if (!context || context.surface.kind !== "browser") return false;
    return this.database.transaction(async (transaction) => {
      await detachProjectTab(
        transaction,
        context.surface.projectId,
        projectTabKey("browser", browserId),
      );
      await transaction
        .delete(schema.remoteSurfaces)
        .where(eq(schema.remoteSurfaces.id, browserId));
      const result = await transaction
        .delete(schema.browsers)
        .where(eq(schema.browsers.id, browserId))
        .returning({ id: schema.browsers.id });
      return result.length === 1;
    });
  }

  async ensureBrowserRemoteSurfaces(ownerId: string): Promise<void> {
    const rows = await this.database
      .select({
        browser: schema.browsers,
        surfaceId: schema.remoteSurfaces.id,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.remoteSurfaces,
        eq(schema.remoteSurfaces.id, schema.browsers.id),
      )
      .where(isNull(schema.remoteSurfaces.id));
    if (rows.length === 0) return;
    const values = (
      await Promise.all(
        rows.map(async ({ browser }) => ({
          browser,
          source: await this.collaborators.getProjectSource(
            ownerId,
            browser.projectId,
          ),
        })),
      )
    ).flatMap(({ browser, source }) =>
      source ? [{ browser, workerId: source.workerId }] : [],
    );
    if (values.length === 0) return;
    await this.database
      .insert(schema.remoteSurfaces)
      .values(
        values.map(({ browser, workerId }) => ({
          id: browser.id,
          projectId: browser.projectId,
          workerId,
          kind: "browser",
          preferredTransport: "webrtc",
          configuration: {
            kind: "browser" as const,
            profileId: null,
          },
        })),
      )
      .onConflictDoNothing();
  }

  async browserIsOwnedBy(ownerId: string, browserId: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.browsers.id })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.browsers.id, browserId))
      .limit(1);
    return rows.length === 1;
  }
}
