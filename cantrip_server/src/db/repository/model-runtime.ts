import { randomUUID } from "node:crypto";

import type {
  AgentTimeSummary,
  ModelProfileCreate,
  ModelProfileSummary,
  ModelProfileUpdate,
  ModelProviderSummary,
  ModelRouteSummary,
  ProviderModelAvailability,
  ProviderModelCatalogEntry,
  ReasoningEffort,
  SettingsBundleWire,
  TokenUsageTotals,
} from "@cantrip/protocol";
import type { ProtectedSecretEnvelope } from "@cantrip/protocol/protected-secrets";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  enrichCatalogFromExactOpenRouterMatch,
  exactOpenRouterAliases,
} from "../../models/catalog-enrichment.js";
import * as schema from "../schema.js";
import { toISOString, type RepositoryDatabase } from "./database.js";
import { toProviderModelCatalogEntry } from "./provider-catalog.js";
import type { ModelProviderAccountRuntime } from "./provider-accounts.js";
import { ZERO_AGENT_TIME, ZERO_TOKEN_USAGE } from "./telemetry.js";

export interface ModelRepositoryCollaborators {
  readSettings(ownerId: string): Promise<SettingsBundleWire>;
}

export interface ModelRuntime {
  routeId: string;
  model: {
    id: string;
    profileName: string;
    routeId: string;
    name: string;
    reasoningEffort: ReasoningEffort | null;
    providerModelId: string | null;
    catalog: ProviderModelCatalogEntry | null;
  };
  provider: {
    id: string;
    name: string;
    kind: ModelProviderSummary["kind"];
    baseUrl: string;
    protectedApiKey: ProtectedSecretEnvelope | null;
    accountId: string | null;
    credentialHomeKey: string | null;
    weeklyUsageReservePercent: number;
  };
}

export function toModelRouteSummary(
  route: typeof schema.modelRoutes.$inferSelect,
  providerName: string,
): ModelRouteSummary {
  return {
    id: route.id,
    providerId: route.providerId,
    providerName,
    providerModelId: route.providerModelId,
    modelName: route.modelName,
    position: route.position,
    enabled: route.enabled,
    discoveryManaged: route.discoveryManaged,
  };
}

export function toModelSummary(
  model: typeof schema.modelProfiles.$inferSelect,
  routes: ModelRouteSummary[],
  tokenUsage: TokenUsageTotals = ZERO_TOKEN_USAGE,
  agentTime: AgentTimeSummary = ZERO_AGENT_TIME,
): ModelProfileSummary {
  return {
    id: model.id,
    name: model.name,
    canonicalModelId: model.canonicalModelId,
    defaultReasoningEffort: model.defaultReasoningEffort,
    discoveryManaged: model.discoveryManaged,
    routingPolicy: "priority",
    routes,
    tokenUsage,
    agentTime,
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

export class ModelRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ModelRepositoryCollaborators,
  ) {}

  async createModelProfile(
    ownerId: string,
    input: ModelProfileCreate,
  ): Promise<ModelProfileSummary | null> {
    const providers = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.ownerId, ownerId));
    const providerIds = new Set(providers.map(({ id }) => id));
    if (input.routes.some((route) => !providerIds.has(route.providerId))) {
      return null;
    }
    const modelId = randomUUID();
    await this.database.transaction(async (transaction) => {
      await transaction.insert(schema.modelProfiles).values({
        id: modelId,
        ownerId,
        name: input.name,
      });
      await transaction.insert(schema.modelRoutes).values(
        input.routes.map((route, position) => ({
          id: randomUUID(),
          modelId,
          providerId: route.providerId,
          modelName: route.modelName,
          position,
          enabled: route.enabled,
        })),
      );
    });
    return (
      (await this.collaborators.readSettings(ownerId)).models.find(
        (model) => model.id === modelId,
      ) ?? null
    );
  }

  async deleteModelProfile(ownerId: string, modelId: string) {
    return this.database.transaction(async (transaction) => {
      const managedRoutes = await transaction
        .select({ providerModelId: schema.modelRoutes.providerModelId })
        .from(schema.modelRoutes)
        .innerJoin(
          schema.modelProfiles,
          and(
            eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
            eq(schema.modelProfiles.ownerId, ownerId),
            eq(schema.modelProfiles.discoveryManaged, true),
          ),
        )
        .where(eq(schema.modelRoutes.modelId, modelId));
      const providerModelIds = managedRoutes.flatMap(({ providerModelId }) =>
        providerModelId ? [providerModelId] : [],
      );
      if (providerModelIds.length > 0) {
        await transaction
          .insert(schema.providerModelSuppressions)
          .values(
            providerModelIds.map((providerModelId) => ({
              ownerId,
              providerModelId,
            })),
          )
          .onConflictDoNothing();
      }
      const result = await transaction
        .delete(schema.modelProfiles)
        .where(
          and(
            eq(schema.modelProfiles.id, modelId),
            eq(schema.modelProfiles.ownerId, ownerId),
          ),
        )
        .returning({ id: schema.modelProfiles.id });
      return Boolean(result[0]);
    });
  }

  async updateModelProfile(
    ownerId: string,
    modelId: string,
    input: ModelProfileUpdate,
  ): Promise<ModelProfileSummary | null> {
    const providers = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.ownerId, ownerId));
    const providerIds = new Set(providers.map(({ id }) => id));
    if (input.routes.some((route) => !providerIds.has(route.providerId))) {
      return null;
    }
    const models = await this.database
      .select({ id: schema.modelProfiles.id })
      .from(schema.modelProfiles)
      .where(
        and(
          eq(schema.modelProfiles.id, modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!models[0]) return null;
    const existingRoutes = await this.database
      .select()
      .from(schema.modelRoutes)
      .where(eq(schema.modelRoutes.modelId, modelId));
    const existingRouteIds = new Set(existingRoutes.map(({ id }) => id));
    const suppliedRouteIds = input.routes.flatMap((route) =>
      route.id ? [route.id] : [],
    );
    if (
      new Set(suppliedRouteIds).size !== suppliedRouteIds.length ||
      suppliedRouteIds.some((id) => !existingRouteIds.has(id))
    ) {
      return null;
    }
    const existingRouteById = new Map(
      existingRoutes.map((route) => [route.id, route]),
    );
    const invalidatedRouteIds = new Set(
      existingRoutes.flatMap((route) => {
        const inputRoute = input.routes.find(
          (candidate) => candidate.id === route.id,
        );
        if (!inputRoute) return [route.id];
        const runtimeConfigurationChanged =
          route.providerId !== inputRoute.providerId ||
          route.modelName !== inputRoute.modelName;
        return runtimeConfigurationChanged ? [route.id] : [];
      }),
    );

    await this.database.transaction(async (transaction) => {
      await transaction
        .update(schema.modelProfiles)
        .set({
          name: input.name,
          updatedAt: new Date(),
        })
        .where(eq(schema.modelProfiles.id, modelId));
      for (const routeId of invalidatedRouteIds) {
        await transaction
          .update(schema.chatRuntimeSessions)
          .set({
            codexThreadId: null,
            status: "detached",
            updatedAt: new Date(),
          })
          .where(eq(schema.chatRuntimeSessions.modelRouteId, routeId));
      }
      const removedRouteIds = [...existingRouteById.keys()].filter(
        (id) => !suppliedRouteIds.includes(id),
      );
      for (const routeId of removedRouteIds) {
        await transaction
          .delete(schema.modelRoutes)
          .where(eq(schema.modelRoutes.id, routeId));
      }
      await transaction
        .update(schema.modelRoutes)
        .set({ position: sql`${schema.modelRoutes.position} + 1000` })
        .where(eq(schema.modelRoutes.modelId, modelId));
      for (const [position, route] of input.routes.entries()) {
        if (route.id) {
          await transaction
            .update(schema.modelRoutes)
            .set({
              providerId: route.providerId,
              modelName: route.modelName,
              position,
              enabled: route.enabled,
              updatedAt: new Date(),
            })
            .where(eq(schema.modelRoutes.id, route.id));
        } else {
          await transaction.insert(schema.modelRoutes).values({
            id: randomUUID(),
            modelId,
            providerId: route.providerId,
            modelName: route.modelName,
            position,
            enabled: route.enabled,
          });
        }
      }
    });
    return (
      (await this.collaborators.readSettings(ownerId)).models.find(
        (model) => model.id === modelId,
      ) ?? null
    );
  }

  async getModelRuntime(
    ownerId: string,
    modelId: string,
    routeId?: string,
  ): Promise<ModelRuntime | null> {
    return (await this.getModelRuntimes(ownerId, modelId, routeId))[0] ?? null;
  }

  async getModelRuntimeByRoute(
    ownerId: string,
    routeId: string,
  ): Promise<ModelRuntime | null> {
    return (
      (await this.getModelRuntimes(ownerId, undefined, routeId, true))[0] ??
      null
    );
  }

  async getModelRuntimes(
    ownerId: string,
    modelId?: string,
    routeId?: string,
    includeDisabled = false,
  ): Promise<ModelRuntime[]> {
    const rows = await this.database
      .select({
        model: schema.modelProfiles,
        route: schema.modelRoutes,
        provider: schema.modelProviders,
        providerModel: schema.providerModels,
      })
      .from(schema.modelProfiles)
      .innerJoin(
        schema.modelRoutes,
        eq(schema.modelRoutes.modelId, schema.modelProfiles.id),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .leftJoin(
        schema.providerModels,
        and(
          eq(schema.providerModels.providerId, schema.modelRoutes.providerId),
          or(
            eq(schema.providerModels.id, schema.modelRoutes.providerModelId),
            and(
              isNull(schema.modelRoutes.providerModelId),
              eq(
                schema.providerModels.nativeModelId,
                schema.modelRoutes.modelName,
              ),
            ),
          ),
        ),
      )
      .where(
        and(
          eq(schema.modelProfiles.ownerId, ownerId),
          ...(!includeDisabled ? [eq(schema.modelRoutes.enabled, true)] : []),
          ...(modelId ? [eq(schema.modelProfiles.id, modelId)] : []),
          ...(routeId ? [eq(schema.modelRoutes.id, routeId)] : []),
        ),
      )
      .orderBy(asc(schema.modelRoutes.position));
    const catalogRows = rows.flatMap((row) =>
      row.providerModel
        ? [
            {
              catalog: toProviderModelCatalogEntry(row.providerModel),
              providerKind: row.provider.kind as ModelProviderSummary["kind"],
            },
          ]
        : [],
    );
    const aliases = [
      ...new Set(
        catalogRows.flatMap(({ catalog, providerKind }) => [
          ...exactOpenRouterAliases(catalog, providerKind),
        ]),
      ),
    ];
    const enrichmentRows = aliases.length
      ? await this.database
          .select({
            model: schema.providerModels,
            provider: schema.modelProviders,
          })
          .from(schema.providerModels)
          .innerJoin(
            schema.modelProviders,
            and(
              eq(schema.modelProviders.id, schema.providerModels.providerId),
              eq(schema.modelProviders.ownerId, ownerId),
              eq(schema.modelProviders.kind, "openai-compatible"),
            ),
          )
          .where(
            or(
              inArray(schema.providerModels.nativeModelId, aliases),
              inArray(schema.providerModels.canonicalModelId, aliases),
            ),
          )
      : [];
    const openRouterCatalog = enrichmentRows.flatMap((row) => {
      try {
        const hostname = new URL(row.provider.baseUrl).hostname.toLowerCase();
        if (
          hostname !== "openrouter.ai" &&
          !hostname.endsWith(".openrouter.ai")
        ) {
          return [];
        }
      } catch {
        return [];
      }
      return [toProviderModelCatalogEntry(row.model)];
    });

    return rows.map((row) => ({
      routeId: row.route.id,
      model: {
        id: row.model.id,
        profileName: row.model.name,
        routeId: row.route.id,
        name: row.route.modelName,
        reasoningEffort: null,
        providerModelId:
          row.route.providerModelId ?? row.providerModel?.id ?? null,
        catalog: row.providerModel
          ? enrichCatalogFromExactOpenRouterMatch(
              toProviderModelCatalogEntry(row.providerModel),
              row.provider.kind as ModelProviderSummary["kind"],
              openRouterCatalog,
            )
          : null,
      },
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        kind: row.provider.kind as ModelProviderSummary["kind"],
        baseUrl: row.provider.baseUrl,
        protectedApiKey: row.provider.protectedApiKey,
        accountId: null,
        credentialHomeKey: null,
        weeklyUsageReservePercent: row.provider.weeklyUsageReservePercent,
      },
    }));
  }

  async listModelProviderAccountRuntimes(
    ownerId: string,
    providerId: string,
    workerId: string,
    providerModelId: string | null,
  ): Promise<ModelProviderAccountRuntime[]> {
    const [accounts, availability] = await Promise.all([
      this.database
        .select({
          account: schema.modelProviderAccounts,
          binding: schema.modelProviderAccountWorkers,
        })
        .from(schema.modelProviderAccounts)
        .innerJoin(
          schema.modelProviders,
          and(
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
            eq(schema.modelProviders.ownerId, ownerId),
            inArray(schema.modelProviders.kind, ["chatgpt", "grok"]),
          ),
        )
        .leftJoin(
          schema.modelProviderAccountWorkers,
          and(
            eq(
              schema.modelProviderAccountWorkers.accountId,
              schema.modelProviderAccounts.id,
            ),
            eq(schema.modelProviderAccountWorkers.workerId, workerId),
          ),
        )
        .where(eq(schema.modelProviderAccounts.providerId, providerId))
        .orderBy(asc(schema.modelProviderAccounts.position)),
      providerModelId
        ? this.database
            .select({
              providerAccountId:
                schema.providerModelAvailability.providerAccountId,
              state: schema.providerModelAvailability.state,
              workerId: schema.providerModelAvailability.workerId,
            })
            .from(schema.providerModelAvailability)
            .where(
              and(
                eq(
                  schema.providerModelAvailability.providerModelId,
                  providerModelId,
                ),
                or(
                  isNull(schema.providerModelAvailability.workerId),
                  eq(schema.providerModelAvailability.workerId, workerId),
                ),
              ),
            )
        : Promise.resolve([]),
    ]);
    const availabilityByAccount = new Map<
      string,
      { state: ProviderModelAvailability["state"]; workerId: string | null }
    >();
    for (const row of availability) {
      if (!row.providerAccountId) continue;
      const current = availabilityByAccount.get(row.providerAccountId);
      if (!current || row.workerId === null) {
        availabilityByAccount.set(row.providerAccountId, {
          state: row.state as ProviderModelAvailability["state"],
          workerId: row.workerId,
        });
      }
    }
    return accounts.map(({ account, binding }) => ({
      accountId: account.id,
      credentialState:
        account.credentialState as ModelProviderAccountRuntime["credentialState"],
      credentialHomeKey: account.credentialHomeKey,
      enabled: account.enabled,
      legacyWorkerAuthenticated: binding?.authState === "signed-in",
      modelAvailability: availabilityByAccount.get(account.id)?.state ?? null,
      position: account.position,
      weeklyUsageUsedPercent:
        account.weeklyUsageUsedBasisPoints === null
          ? null
          : account.weeklyUsageUsedBasisPoints / 100,
    }));
  }
}
