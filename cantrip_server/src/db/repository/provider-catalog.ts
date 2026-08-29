import { createHash, randomUUID } from "node:crypto";

import {
  normalizeResponsesBaseUrl,
  type AgentTimeSummary,
  type EncryptedModelProviderCreate,
  type EncryptedModelProviderUpdate,
  type ModelProviderAccountWireSummary,
  type ModelProviderSummary,
  type ModelProviderWireSummary,
  type ProviderCatalogSyncState,
  type ProviderModelAvailability,
  type ProviderModelCatalogEntry,
  type ProviderModelCatalogResult,
  type TokenUsageTotals,
} from "@cantrip/protocol";
import type { ProtectedSecretEnvelope } from "@cantrip/protocol/protected-secrets";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  accountProviderLabel,
  isAccountProviderKind,
} from "../../models/account-provider.js";
import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";
import { toProviderAccountSummary } from "./provider-accounts.js";
import { ZERO_AGENT_TIME, ZERO_TOKEN_USAGE } from "./telemetry.js";

// Provider model rows bind roughly 30 values each, so this stays well below
// PostgreSQL's per-statement parameter limit while keeping catalog chatter low.
const PROVIDER_CATALOG_BATCH_SIZE = 500;

function providerCatalogBatches<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += PROVIDER_CATALOG_BATCH_SIZE
  ) {
    batches.push(values.slice(offset, offset + PROVIDER_CATALOG_BATCH_SIZE));
  }
  return batches;
}

export interface ModelProviderCatalogRuntime {
  id: string;
  ownerId: string;
  kind: ModelProviderSummary["kind"];
  baseUrl: string;
  protectedApiKey: ProtectedSecretEnvelope | null;
}

export type ModelProviderCatalogTarget = Pick<
  ModelProviderCatalogRuntime,
  "baseUrl" | "id" | "kind"
>;

export interface ModelProviderRefreshTarget {
  accounts: Array<{
    enabled: boolean;
    id: string;
    planType: ModelProviderAccountWireSummary["planType"];
  }>;
  baseUrl: string;
  id: string;
  kind: ModelProviderSummary["kind"];
  name: string;
}

export interface ProviderModelCatalogWrite {
  nativeModelId: string;
  canonicalModelId: string | null;
  displayName: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportsTools: boolean | null;
  supportsParallelTools: boolean | null;
  supportsStructuredOutput: boolean | null;
  supportsVision: boolean | null;
  supportsReasoning: boolean | null;
  supportedReasoningEfforts: ProviderModelCatalogEntry["supportedReasoningEfforts"];
  defaultReasoningEffort: string | null;
  reasoningMandatory: boolean | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  digest: string | null;
  metadataSource: ProviderModelCatalogEntry["metadataSource"];
  matchConfidenceBasisPoints: number | null;
  hidden?: boolean;
  isDefault?: boolean;
  rawMetadata: Record<string, unknown>;
}

const CATALOG_SENSITIVE_METADATA_KEY =
  /^(?:api[-_]?key|authorization|cookie|set-cookie|password|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|headers?)$/iu;

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !CATALOG_SENSITIVE_METADATA_KEY.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function catalogMetadataSnapshot(model: ProviderModelCatalogWrite) {
  const metadata = stableJsonValue(model) as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
}

export function toProviderSummary(
  provider: typeof schema.modelProviders.$inferSelect,
  tokenUsage: TokenUsageTotals = ZERO_TOKEN_USAGE,
  agentTime: AgentTimeSummary = ZERO_AGENT_TIME,
  accounts: ModelProviderAccountWireSummary[] = [],
): ModelProviderWireSummary {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind as ModelProviderSummary["kind"],
    baseUrl: provider.baseUrl,
    hasApiKey: provider.protectedApiKey !== null,
    weeklyUsageReservePercent: provider.weeklyUsageReservePercent,
    accounts,
    tokenUsage,
    agentTime,
    createdAt: toISOString(provider.createdAt),
    updatedAt: toISOString(provider.updatedAt),
  };
}

export function toProviderModelCatalogEntry(
  model: typeof schema.providerModels.$inferSelect,
): ProviderModelCatalogEntry {
  return {
    id: model.id,
    providerId: model.providerId,
    nativeModelId: model.nativeModelId,
    canonicalModelId: model.canonicalModelId,
    displayName: model.displayName,
    description: model.description,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities,
    outputModalities: model.outputModalities,
    supportsTools: model.supportsTools,
    supportsParallelTools: model.supportsParallelTools,
    supportsStructuredOutput: model.supportsStructuredOutput,
    supportsVision: model.supportsVision,
    supportsReasoning: model.supportsReasoning,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    reasoningMandatory: model.reasoningMandatory,
    family: model.family,
    parameterSize: model.parameterSize,
    quantization: model.quantization,
    digest: model.digest,
    metadataSource:
      model.metadataSource as ProviderModelCatalogEntry["metadataSource"],
    matchConfidence:
      model.matchConfidenceBasisPoints === null
        ? null
        : model.matchConfidenceBasisPoints / 10_000,
    hidden: model.hidden,
    isDefault: model.isDefault,
    lastSeenAt: toISOString(model.lastSeenAt),
    createdAt: toISOString(model.createdAt),
    updatedAt: toISOString(model.updatedAt),
  };
}

function toProviderModelAvailability(
  availability: typeof schema.providerModelAvailability.$inferSelect,
): ProviderModelAvailability {
  return {
    id: availability.id,
    providerModelId: availability.providerModelId,
    scopeKey: availability.scopeKey,
    workerId: availability.workerId,
    providerAccountId: availability.providerAccountId,
    state: availability.state as ProviderModelAvailability["state"],
    lastSeenAt: toISOString(availability.lastSeenAt),
    updatedAt: toISOString(availability.updatedAt),
  };
}

function toProviderCatalogSyncState(
  state: typeof schema.providerCatalogSyncStates.$inferSelect,
): ProviderCatalogSyncState {
  return {
    id: state.id,
    providerId: state.providerId,
    scopeKey: state.scopeKey,
    workerId: state.workerId,
    providerAccountId: state.providerAccountId,
    status: state.status as ProviderCatalogSyncState["status"],
    error: state.errorCode,
    etag: state.etag,
    refreshStartedAt: state.refreshStartedAt
      ? toISOString(state.refreshStartedAt)
      : null,
    lastSuccessAt: state.lastSuccessAt
      ? toISOString(state.lastSuccessAt)
      : null,
    updatedAt: toISOString(state.updatedAt),
  };
}

export class ProviderCatalogRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async createModelProvider(
    ownerId: string,
    input: EncryptedModelProviderCreate,
  ): Promise<ModelProviderWireSummary> {
    // HTTP callers always allocate the ID before sealing protected fields.
    // The fallback keeps non-account internal/test callers ergonomic without
    // giving the server a way to fabricate an encrypted account label.
    const id = input.id ?? randomUUID();
    return this.database.transaction(async (transaction) => {
      if (isAccountProviderKind(input.kind)) {
        const existing = await transaction
          .select({ id: schema.modelProviders.id })
          .from(schema.modelProviders)
          .where(
            and(
              eq(schema.modelProviders.ownerId, ownerId),
              eq(schema.modelProviders.kind, input.kind),
            ),
          )
          .limit(1);
        if (existing[0]) {
          throw new Error(
            `A ${accountProviderLabel(input.kind)} provider already exists. Add another sign-in to that provider instead.`,
          );
        }
      }
      const result = await transaction
        .insert(schema.modelProviders)
        .values({
          id,
          ownerId,
          name: input.name,
          kind: input.kind,
          baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
          weeklyUsageReservePercent: input.weeklyUsageReservePercent ?? 3,
          protectedApiKey: input.protectedApiKey,
        })
        .returning();
      const provider = firstOrThrow(result, "creating a model provider");
      if (!isAccountProviderKind(input.kind))
        return toProviderSummary(provider);
      if (!input.initialAccount) {
        throw new Error("The provider is missing its protected account label.");
      }
      const accountRows = await transaction
        .insert(schema.modelProviderAccounts)
        .values({
          id: input.initialAccount.id,
          providerId: id,
          protectedLabel: input.initialAccount.protectedLabel,
          position: 0,
          credentialHomeKey: id,
        })
        .returning();
      return toProviderSummary(provider, ZERO_TOKEN_USAGE, ZERO_AGENT_TIME, [
        toProviderAccountSummary(
          firstOrThrow(
            accountRows,
            `creating a ${accountProviderLabel(input.kind)} account`,
          ),
        ),
      ]);
    });
  }

  async getModelProvider(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderWireSummary | null> {
    const rows = await this.database
      .select()
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toProviderSummary(rows[0]) : null;
  }

  async hasModelRoutesForProvider(
    ownerId: string,
    providerId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: schema.modelRoutes.id })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.providerId, providerId))
      .limit(1);
    return Boolean(rows[0]);
  }

  async deleteModelProvider(ownerId: string, providerId: string) {
    const result = await this.database
      .delete(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .returning({ id: schema.modelProviders.id });
    return Boolean(result[0]);
  }

  async updateModelProvider(
    ownerId: string,
    providerId: string,
    input: EncryptedModelProviderUpdate,
  ): Promise<ModelProviderWireSummary | null> {
    const current = await this.getModelProvider(ownerId, providerId);
    if (!current) return null;
    if (current.kind !== input.kind) {
      throw new Error(
        "Provider type cannot be changed. Create a new provider instead.",
      );
    }
    const result = await this.database
      .update(schema.modelProviders)
      .set({
        name: input.name,
        kind: input.kind,
        baseUrl: normalizeResponsesBaseUrl(input.baseUrl),
        ...(input.weeklyUsageReservePercent === undefined
          ? {}
          : {
              weeklyUsageReservePercent: input.weeklyUsageReservePercent,
            }),
        ...(input.protectedApiKey === undefined
          ? {}
          : { protectedApiKey: input.protectedApiKey }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .returning();
    const provider = result[0];
    if (provider) {
      const routes = await this.database
        .select({ id: schema.modelRoutes.id })
        .from(schema.modelRoutes)
        .where(eq(schema.modelRoutes.providerId, providerId));
      for (const route of routes) {
        await this.database
          .update(schema.chatRuntimeSessions)
          .set({
            codexThreadId: null,
            status: "detached",
            updatedAt: new Date(),
          })
          .where(eq(schema.chatRuntimeSessions.modelRouteId, route.id));
      }
    }
    return provider ? toProviderSummary(provider) : null;
  }

  async getModelProviderCatalogRuntime(
    ownerId: string,
    providerId: string,
  ): Promise<ModelProviderCatalogRuntime | null> {
    const rows = await this.database
      .select()
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    const provider = rows[0];
    if (!provider) return null;
    return {
      id: provider.id,
      ownerId: provider.ownerId,
      kind: provider.kind as ModelProviderSummary["kind"],
      baseUrl: provider.baseUrl,
      protectedApiKey: provider.protectedApiKey,
    };
  }

  async listModelProviderCatalogTargets(
    ownerId: string,
  ): Promise<ModelProviderCatalogTarget[]> {
    const rows = await this.database
      .select({
        baseUrl: schema.modelProviders.baseUrl,
        id: schema.modelProviders.id,
        kind: schema.modelProviders.kind,
      })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.ownerId, ownerId))
      .orderBy(asc(schema.modelProviders.createdAt));
    return rows.map((provider) => ({
      id: provider.id,
      kind: provider.kind as ModelProviderSummary["kind"],
      baseUrl: provider.baseUrl,
    }));
  }

  async listModelProviderRefreshTargets(
    ownerId: string,
  ): Promise<ModelProviderRefreshTarget[]> {
    const rows = await this.database
      .select({
        accountEnabled: schema.modelProviderAccounts.enabled,
        accountId: schema.modelProviderAccounts.id,
        accountPlanType: schema.modelProviderAccounts.planType,
        providerBaseUrl: schema.modelProviders.baseUrl,
        providerId: schema.modelProviders.id,
        providerKind: schema.modelProviders.kind,
        providerName: schema.modelProviders.name,
      })
      .from(schema.modelProviders)
      .leftJoin(
        schema.modelProviderAccounts,
        eq(schema.modelProviderAccounts.providerId, schema.modelProviders.id),
      )
      .where(eq(schema.modelProviders.ownerId, ownerId))
      .orderBy(
        asc(schema.modelProviders.createdAt),
        asc(schema.modelProviderAccounts.position),
      );
    const targets = new Map<string, ModelProviderRefreshTarget>();
    for (const row of rows) {
      let target = targets.get(row.providerId);
      if (!target) {
        target = {
          accounts: [],
          baseUrl: row.providerBaseUrl,
          id: row.providerId,
          kind: row.providerKind as ModelProviderSummary["kind"],
          name: row.providerName,
        };
        targets.set(row.providerId, target);
      }
      if (row.accountId) {
        target.accounts.push({
          enabled: row.accountEnabled!,
          id: row.accountId,
          planType: row.accountPlanType,
        });
      }
    }
    return [...targets.values()];
  }

  async setProviderCatalogSyncState(
    providerId: string,
    input: {
      scopeKey: string;
      status: ProviderCatalogSyncState["status"];
      errorCode?: string | null;
      etag?: string | null;
      refreshStartedAt?: Date | null;
      lastSuccessAt?: Date | null;
      workerId?: string | null;
      providerAccountId?: string | null;
    },
  ): Promise<void> {
    const now = new Date();
    await this.database
      .insert(schema.providerCatalogSyncStates)
      .values({
        id: randomUUID(),
        providerId,
        scopeKey: input.scopeKey,
        status: input.status,
        errorCode: input.errorCode ?? null,
        etag: input.etag ?? null,
        refreshStartedAt: input.refreshStartedAt ?? null,
        lastSuccessAt: input.lastSuccessAt ?? null,
        workerId: input.workerId ?? null,
        providerAccountId: input.providerAccountId ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.providerCatalogSyncStates.providerId,
          schema.providerCatalogSyncStates.scopeKey,
        ],
        set: {
          status: input.status,
          ...(input.errorCode === undefined
            ? {}
            : { errorCode: input.errorCode }),
          ...(input.etag === undefined ? {} : { etag: input.etag }),
          ...(input.refreshStartedAt === undefined
            ? {}
            : { refreshStartedAt: input.refreshStartedAt }),
          ...(input.lastSuccessAt === undefined
            ? {}
            : { lastSuccessAt: input.lastSuccessAt }),
          ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
          ...(input.providerAccountId === undefined
            ? {}
            : { providerAccountId: input.providerAccountId }),
          updatedAt: now,
        },
      });
  }

  async reconcileProviderModelCatalog(
    ownerId: string,
    providerId: string,
    input: {
      models: ProviderModelCatalogWrite[];
      availabilityScope: string;
      availableNativeModelIds: ReadonlySet<string>;
      autoCreateLogicalModels?: boolean;
      autoCreateNativeModelIds?: ReadonlySet<string>;
      availabilityWorkerId?: string | null;
      availabilityProviderAccountId?: string | null;
      defaultNativeModelId?: string | null;
    },
  ): Promise<boolean> {
    const provider = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return false;

    const now = new Date();
    await this.database.transaction(async (transaction) => {
      if (input.models.length > 0) {
        const modelBatches = providerCatalogBatches(input.models);
        for (const models of modelBatches) {
          await transaction
            .insert(schema.providerModelCatalogSnapshots)
            .values(
              models.map((model) => {
                return {
                  id: randomUUID(),
                  ownerId,
                  providerId,
                  providerAccountId:
                    input.availabilityProviderAccountId ?? null,
                  workerId: input.availabilityWorkerId ?? null,
                  availabilityScope: input.availabilityScope,
                  metadataSource: model.metadataSource,
                  metadataHash: catalogMetadataSnapshot(model),
                  observedAt: now,
                };
              }),
            )
            .onConflictDoNothing();
        }
        for (const models of modelBatches) {
          await transaction
            .insert(schema.providerModels)
            .values(
              models.map((model) => ({
                id: randomUUID(),
                providerId,
                ...model,
                lastSeenAt: now,
                updatedAt: now,
              })),
            )
            .onConflictDoUpdate({
              target: [
                schema.providerModels.providerId,
                schema.providerModels.nativeModelId,
              ],
              set: {
                canonicalModelId: sql`excluded.canonical_model_id`,
                displayName: sql`excluded.display_name`,
                description: sql`excluded.description`,
                contextWindow: sql`excluded.context_window`,
                maxOutputTokens: sql`excluded.max_output_tokens`,
                inputModalities: sql`excluded.input_modalities`,
                outputModalities: sql`excluded.output_modalities`,
                supportsTools: sql`excluded.supports_tools`,
                supportsParallelTools: sql`excluded.supports_parallel_tools`,
                supportsStructuredOutput: sql`excluded.supports_structured_output`,
                supportsVision: sql`excluded.supports_vision`,
                supportsReasoning: sql`excluded.supports_reasoning`,
                supportedReasoningEfforts: sql`excluded.supported_reasoning_efforts`,
                defaultReasoningEffort: sql`excluded.default_reasoning_effort`,
                reasoningMandatory: sql`excluded.reasoning_mandatory`,
                family: sql`excluded.family`,
                parameterSize: sql`excluded.parameter_size`,
                quantization: sql`excluded.quantization`,
                digest: sql`excluded.digest`,
                metadataSource: sql`excluded.metadata_source`,
                matchConfidenceBasisPoints: sql`excluded.match_confidence_basis_points`,
                hidden: sql`excluded.hidden`,
                isDefault: sql`excluded.is_default`,
                rawMetadata: sql`excluded.raw_metadata`,
                lastSeenAt: now,
                updatedAt: now,
              },
            });
        }
      }

      const providerModelRows = await transaction
        .select({
          id: schema.providerModels.id,
          nativeModelId: schema.providerModels.nativeModelId,
        })
        .from(schema.providerModels)
        .where(eq(schema.providerModels.providerId, providerId));
      if (providerModelRows.length === 0) return;

      const availableProviderModels = providerModelRows.filter((model) =>
        input.availableNativeModelIds.has(model.nativeModelId),
      );
      for (const models of providerCatalogBatches(availableProviderModels)) {
        await transaction
          .update(schema.modelRoutes)
          .set({
            providerModelId: schema.providerModels.id,
            updatedAt: now,
          })
          .from(schema.providerModels)
          .where(
            and(
              eq(schema.modelRoutes.providerId, providerId),
              eq(schema.providerModels.providerId, providerId),
              inArray(
                schema.providerModels.id,
                models.map(({ id }) => id),
              ),
              eq(
                schema.modelRoutes.modelName,
                schema.providerModels.nativeModelId,
              ),
              isNull(schema.modelRoutes.providerModelId),
            ),
          );
      }

      for (const models of providerCatalogBatches(providerModelRows)) {
        await transaction
          .insert(schema.providerModelAvailability)
          .values(
            models.map((model) => ({
              id: randomUUID(),
              providerModelId: model.id,
              scopeKey: input.availabilityScope,
              workerId: input.availabilityWorkerId ?? null,
              providerAccountId: input.availabilityProviderAccountId ?? null,
              state: input.availableNativeModelIds.has(model.nativeModelId)
                ? "available"
                : "unavailable",
              lastSeenAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoUpdate({
            target: [
              schema.providerModelAvailability.providerModelId,
              schema.providerModelAvailability.scopeKey,
            ],
            set: {
              state: sql`excluded.state`,
              workerId: sql`excluded.worker_id`,
              providerAccountId: sql`excluded.provider_account_id`,
              lastSeenAt: now,
              updatedAt: now,
            },
          });
      }

      if (input.autoCreateLogicalModels) {
        const [suppressions, existingRoutes] = await Promise.all([
          transaction
            .select({
              providerModelId: schema.providerModelSuppressions.providerModelId,
            })
            .from(schema.providerModelSuppressions)
            .where(eq(schema.providerModelSuppressions.ownerId, ownerId)),
          transaction
            .select({ modelName: schema.modelRoutes.modelName })
            .from(schema.modelRoutes)
            .innerJoin(
              schema.modelProfiles,
              and(
                eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
                eq(schema.modelProfiles.ownerId, ownerId),
              ),
            )
            .where(eq(schema.modelRoutes.providerId, providerId)),
        ]);
        const suppressed = new Set(
          suppressions.map(({ providerModelId }) => providerModelId),
        );
        const routedNames = new Set(
          existingRoutes.map(({ modelName }) => modelName),
        );
        const catalogByName = new Map(
          input.models.map((model) => [model.nativeModelId, model]),
        );
        const discovered = providerModelRows.filter(
          (model) =>
            (
              input.autoCreateNativeModelIds ?? input.availableNativeModelIds
            ).has(model.nativeModelId) &&
            !suppressed.has(model.id) &&
            !routedNames.has(model.nativeModelId),
        );
        const discoveredModels = discovered.map((model) => ({
          model,
          profileId: `discovered:model:${model.id}`,
          routeId: `discovered:route:${model.id}`,
        }));
        const discoveredModelBatches = providerCatalogBatches(discoveredModels);
        for (const models of discoveredModelBatches) {
          await transaction
            .insert(schema.modelProfiles)
            .values(
              models.map(({ model, profileId }) => ({
                id: profileId,
                ownerId,
                name: model.nativeModelId,
                canonicalModelId:
                  catalogByName.get(model.nativeModelId)?.canonicalModelId ??
                  null,
                discoveryManaged: true,
              })),
            )
            .onConflictDoNothing({ target: schema.modelProfiles.id });
        }
        for (const models of discoveredModelBatches) {
          await transaction
            .insert(schema.modelRoutes)
            .values(
              models.map(({ model, profileId, routeId }) => ({
                id: routeId,
                modelId: profileId,
                providerId,
                providerModelId: model.id,
                modelName: model.nativeModelId,
                position: 0,
                enabled: true,
                discoveryManaged: true,
              })),
            )
            .onConflictDoNothing({ target: schema.modelRoutes.id });
        }
        if (input.defaultNativeModelId) {
          const defaultRoutes = await transaction
            .select({ modelId: schema.modelRoutes.modelId })
            .from(schema.modelRoutes)
            .innerJoin(
              schema.providerModels,
              and(
                eq(
                  schema.providerModels.id,
                  schema.modelRoutes.providerModelId,
                ),
                eq(schema.providerModels.providerId, providerId),
                eq(
                  schema.providerModels.nativeModelId,
                  input.defaultNativeModelId,
                ),
              ),
            )
            .limit(1);
          if (defaultRoutes[0]) {
            await transaction
              .update(schema.userSettings)
              .set({ defaultModelId: defaultRoutes[0].modelId, updatedAt: now })
              .where(
                and(
                  eq(schema.userSettings.userId, ownerId),
                  isNull(schema.userSettings.defaultModelId),
                ),
              );
          }
        }
      }
    });
    return true;
  }

  async getProviderModelCatalog(
    ownerId: string,
    providerId: string,
    servedStale = false,
  ): Promise<ProviderModelCatalogResult | null> {
    const provider = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.id, providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return null;

    const [models, availability, syncStates] = await Promise.all([
      this.database
        .select()
        .from(schema.providerModels)
        .where(eq(schema.providerModels.providerId, providerId))
        .orderBy(asc(schema.providerModels.displayName)),
      this.database
        .select({ availability: schema.providerModelAvailability })
        .from(schema.providerModelAvailability)
        .innerJoin(
          schema.providerModels,
          and(
            eq(
              schema.providerModels.id,
              schema.providerModelAvailability.providerModelId,
            ),
            eq(schema.providerModels.providerId, providerId),
          ),
        ),
      this.database
        .select()
        .from(schema.providerCatalogSyncStates)
        .where(eq(schema.providerCatalogSyncStates.providerId, providerId))
        .orderBy(asc(schema.providerCatalogSyncStates.scopeKey)),
    ]);
    return {
      providerId,
      models: models.map(toProviderModelCatalogEntry),
      availability: availability.map(({ availability: row }) =>
        toProviderModelAvailability(row),
      ),
      syncStates: syncStates.map(toProviderCatalogSyncState),
      servedStale,
    };
  }

  async listProviderModelAvailability(
    ownerId: string,
    providerId: string,
    providerModelId: string,
  ): Promise<ProviderModelAvailability[]> {
    const rows = await this.database
      .select({ availability: schema.providerModelAvailability })
      .from(schema.providerModelAvailability)
      .innerJoin(
        schema.providerModels,
        and(
          eq(
            schema.providerModels.id,
            schema.providerModelAvailability.providerModelId,
          ),
          eq(schema.providerModels.id, providerModelId),
          eq(schema.providerModels.providerId, providerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.providerModels.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      );
    return rows.map(({ availability }) =>
      toProviderModelAvailability(availability),
    );
  }
}
