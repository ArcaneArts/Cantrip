import type {
  EncryptedMcpServerCreate,
  EncryptedMcpServerUpdate,
  McpServerOpaqueRuntime,
  McpServerWireSummary,
  ModelProviderWireSummary,
  ResourceAudience,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

type McpServerRow = typeof schema.mcpServers.$inferSelect;

export class ManagedMcpServerInvariantError extends Error {}
export class McpServerWorkerBindingError extends Error {}

export interface McpRepositoryCollaborators {
  getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderWireSummary | null>;
  getWorker(ownerId: string, workerId: string): Promise<WorkerSummary | null>;
}

function toMcpServerWireSummary(server: McpServerRow): McpServerWireSummary {
  return {
    id: server.id,
    audience: server.audience,
    scope: server.projectId ? "project" : "global",
    projectId: server.projectId,
    workerId: server.workerId,
    enabled: server.enabled,
    nameBlindIndex: server.nameBlindIndex,
    protectedConfiguration: server.protectedConfiguration,
    createdAt: toISOString(server.createdAt),
    updatedAt: toISOString(server.updatedAt),
  };
}

function toMcpServerOpaqueRuntime(
  server: McpServerRow,
): McpServerOpaqueRuntime {
  return {
    id: server.id,
    enabled: server.enabled,
    nameBlindIndex: server.nameBlindIndex,
    protectedConfiguration: server.protectedConfiguration,
  };
}

export class McpRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: McpRepositoryCollaborators,
  ) {}

  async listMcpServers(
    ownerId: string,
    projectId: string | null,
  ): Promise<McpServerWireSummary[] | null> {
    if (projectId) {
      const project = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!project[0]) return null;
    }
    const rows = await this.database
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .orderBy(
        asc(schema.mcpServers.nameBlindIndex),
        asc(schema.mcpServers.createdAt),
      );
    return rows.map(toMcpServerWireSummary);
  }

  async listEffectiveMcpServers(
    ownerId: string,
    projectId: string | null,
    workerId: string,
    audience: Exclude<ResourceAudience, "both"> = "ide",
  ): Promise<McpServerOpaqueRuntime[]> {
    const rows = await this.database
      .select()
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.ownerId, ownerId),
          eq(schema.mcpServers.enabled, true),
          inArray(schema.mcpServers.audience, [audience, "both"]),
          or(
            isNull(schema.mcpServers.projectId),
            ...(projectId ? [eq(schema.mcpServers.projectId, projectId)] : []),
          ),
          or(
            isNull(schema.mcpServers.workerId),
            eq(schema.mcpServers.workerId, workerId),
          ),
        ),
      )
      .orderBy(
        asc(schema.mcpServers.nameBlindIndex),
        asc(schema.mcpServers.createdAt),
      );
    const effective = new Map<string, McpServerRow>();
    for (const row of rows) {
      const current = effective.get(row.nameBlindIndex);
      const priority =
        (projectId && row.projectId === projectId ? 2 : 0) +
        (row.workerId === workerId ? 1 : 0);
      const currentPriority = current
        ? (projectId && current.projectId === projectId ? 2 : 0) +
          (current.workerId === workerId ? 1 : 0)
        : -1;
      if (!current || priority > currentPriority) {
        effective.set(row.nameBlindIndex, row);
      }
    }
    return [...effective.values()].map(toMcpServerOpaqueRuntime);
  }

  async createMcpServer(
    ownerId: string,
    projectId: string | null,
    input: EncryptedMcpServerCreate,
  ): Promise<McpServerWireSummary | null> {
    if (projectId) {
      const project = await this.database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!project[0]) return null;
    }
    if (
      input.workerId &&
      !(await this.collaborators.getWorker(ownerId, input.workerId))
    ) {
      throw new McpServerWorkerBindingError(
        "The selected MCP worker is not available to this account.",
      );
    }
    const rows = await this.database
      .insert(schema.mcpServers)
      .values({
        id: input.id,
        ownerId,
        projectId,
        workerId: input.workerId,
        enabled: input.enabled,
        audience: input.audience,
        nameBlindIndex: input.nameBlindIndex,
        protectedConfiguration: input.protectedConfiguration,
      })
      .returning();
    return toMcpServerWireSummary(firstOrThrow(rows, "creating an MCP server"));
  }

  async updateMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
    input: EncryptedMcpServerUpdate,
  ): Promise<McpServerWireSummary | null> {
    if (
      input.workerId &&
      !(await this.collaborators.getWorker(ownerId, input.workerId))
    ) {
      throw new McpServerWorkerBindingError(
        "The selected MCP worker is not available to this account.",
      );
    }
    const rows = await this.database
      .update(schema.mcpServers)
      .set({
        workerId: input.workerId,
        enabled: input.enabled,
        audience: input.audience,
        nameBlindIndex: input.nameBlindIndex,
        protectedConfiguration: input.protectedConfiguration,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .returning();
    return rows[0] ? toMcpServerWireSummary(rows[0]) : null;
  }

  async deleteMcpServer(
    ownerId: string,
    projectId: string | null,
    serverId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.id, serverId),
          eq(schema.mcpServers.ownerId, ownerId),
          projectId
            ? eq(schema.mcpServers.projectId, projectId)
            : isNull(schema.mcpServers.projectId),
        ),
      )
      .returning({ id: schema.mcpServers.id });
    return rows.length > 0;
  }

  async listSkillAudiences(
    ownerId: string,
    workerId: string,
    providerId: string,
  ): Promise<Array<{
    audienceKey: string;
    audience: ResourceAudience;
  }> | null> {
    const [worker, provider] = await Promise.all([
      this.collaborators.getWorker(ownerId, workerId),
      this.collaborators.getModelProvider(ownerId, providerId),
    ]);
    if (!worker || !provider) return null;
    return this.database
      .select({
        audienceKey: schema.skillAudiences.audienceKey,
        audience: schema.skillAudiences.audience,
      })
      .from(schema.skillAudiences)
      .where(
        and(
          eq(schema.skillAudiences.ownerId, ownerId),
          eq(schema.skillAudiences.workerId, workerId),
          eq(schema.skillAudiences.providerId, providerId),
        ),
      )
      .orderBy(asc(schema.skillAudiences.audienceKey));
  }

  async updateSkillAudience(
    ownerId: string,
    input: {
      audienceKey: string;
      audience: ResourceAudience;
      providerId: string;
      workerId: string;
    },
  ): Promise<{ audienceKey: string; audience: ResourceAudience } | null> {
    const [worker, provider] = await Promise.all([
      this.collaborators.getWorker(ownerId, input.workerId),
      this.collaborators.getModelProvider(ownerId, input.providerId),
    ]);
    if (!worker || !provider) return null;
    const rows = await this.database
      .insert(schema.skillAudiences)
      .values({ ownerId, ...input })
      .onConflictDoUpdate({
        target: [
          schema.skillAudiences.ownerId,
          schema.skillAudiences.workerId,
          schema.skillAudiences.providerId,
          schema.skillAudiences.audienceKey,
        ],
        set: { audience: input.audience, updatedAt: new Date() },
      })
      .returning({
        audienceKey: schema.skillAudiences.audienceKey,
        audience: schema.skillAudiences.audience,
      });
    return rows[0] ?? null;
  }

  async listChatSkillAudienceKeys(
    ownerId: string,
    workerId: string,
    providerId: string,
  ): Promise<string[]> {
    const rows = await this.database
      .select({ audienceKey: schema.skillAudiences.audienceKey })
      .from(schema.skillAudiences)
      .where(
        and(
          eq(schema.skillAudiences.ownerId, ownerId),
          eq(schema.skillAudiences.workerId, workerId),
          eq(schema.skillAudiences.providerId, providerId),
          inArray(schema.skillAudiences.audience, ["chat", "both"]),
        ),
      )
      .orderBy(asc(schema.skillAudiences.audienceKey));
    return rows.map(({ audienceKey }) => audienceKey);
  }
}
