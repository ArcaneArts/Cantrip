import { randomUUID } from "node:crypto";

import type {
  AgentTimeSummary,
  DetailedTokenUsageTotals,
  ProjectTokenUsage,
  ProviderTelemetryDeleteResult,
  ProviderTelemetryExport,
  ProviderTelemetryWireAnalytics,
  ReasoningEffort,
  TokenUsageTotals,
} from "@cantrip/protocol";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import {
  deriveQuotaTokenAnalytics,
  quotaValueStatistics,
  type QuotaTokenAnalytics,
} from "../../analytics/quota-token.js";
import {
  groupAgentTime,
  summarizeAgentTime,
} from "../../analytics/agent-time.js";
import {
  groupModelBehavior,
  sumDetailedTokenUsage,
  summarizeModelBehavior,
} from "../../analytics/telemetry-dashboard.js";
import { detectTelemetryChanges } from "../../analytics/telemetry-change-detection.js";
import { sampleProviderTelemetryQuotaHistory } from "../../models/provider-telemetry.js";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";

export interface TokenUsageRecordInput {
  sourceKey: string;
  projectId: string | null;
  chatId: string | null;
  modelRouteId: string;
  providerAccountId?: string | null;
  workerId?: string | null;
  turnId?: string | null;
  executionAttemptId?: string | null;
  attemptKind?: string;
  attemptStatus?:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "compacted";
  reasoningEffort?: ReasoningEffort | null;
  workerVersion?: string | null;
  serverVersion?: string | null;
  codexVersion?: string | null;
  startedAt?: Date;
  completedAt?: Date | null;
  finalizedAt?: Date | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    cacheWriteInputTokens?: number;
    visibleOutputTokens?: number | null;
  };
}

export interface ModelBehaviorObservationInput {
  sourceKey: string;
  projectId: string | null;
  chatId: string | null;
  modelRouteId: string;
  providerAccountId?: string | null;
  workerId?: string | null;
  turnId?: string | null;
  executionAttemptId: string;
  attemptKind?: string;
  attemptStatus:
    "running" | "completed" | "failed" | "cancelled" | "interrupted";
  reasoningEffort?: ReasoningEffort | null;
  routeAttemptIndex?: number;
  retryFailoverCount?: number;
  startedAt?: Date;
  firstActivityAt?: Date | null;
  firstVisibleResponseAt?: Date | null;
  completedAt?: Date | null;
  finalizedAt?: Date | null;
  durationMs?: number | null;
  finalAnswerAppeared?: boolean;
  toolCallCount?: number;
  invalidToolCallCount?: number;
  compactionCount?: number;
  approvalRequestCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  modelContextWindow?: number | null;
  contextUsedPercent?: number | null;
  filesChangedCount?: number;
  testCommandCount?: number;
  testPassCount?: number;
  testFailureCount?: number;
  userInterrupted?: boolean;
  userRetryRegeneration?: boolean | null;
  immediateCorrectiveFollowup?: boolean;
  workerVersion?: string | null;
  serverVersion?: string | null;
  codexVersion?: string | null;
  signalAvailability?: Record<string, boolean>;
}

export interface QuotaTokenAnalyticsQuery {
  providerId?: string;
  providerAccountId?: string;
  modelId?: string;
  reasoningEffort?: string;
  projectId?: string;
  from?: Date;
  to?: Date;
}

export interface AgentTimeAnalytics {
  models: Map<string, AgentTimeSummary>;
  providers: Map<string, AgentTimeSummary>;
  total: AgentTimeSummary;
}

export interface ProviderQuotaObservationInput {
  eventKey: string;
  observationBatchKey: string;
  providerId: string;
  providerAccountId: string;
  workerId: string | null;
  observedAt: Date;
  usedPercent: number;
  resetsAt: Date | null;
  windowDurationMinutes: number | null;
  limitId: string | null;
  windowKind: string;
  planType: string | null;
  reachedType: string | null;
  observationTrigger: string;
  isWeeklyProjection: boolean;
  chatId: string | null;
  turnId: string | null;
  executionAttemptId: string | null;
  workerVersion: string | null;
  serverVersion: string | null;
  codexVersion: string | null;
}

export const ZERO_TOKEN_USAGE: TokenUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export const ZERO_AGENT_TIME: AgentTimeSummary = {
  activeAgentCount: 0,
  agentTimeMs: 0,
  wallTimeMs: 0,
  averageConcurrency: 0,
};

export function tokenUsageTotals(
  inputTokens: number,
  outputTokens: number,
): TokenUsageTotals {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function detailedTokenUsageTotals(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number,
  reasoningOutputTokens: number,
): DetailedTokenUsageTotals {
  return {
    ...tokenUsageTotals(inputTokens, outputTokens),
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningOutputTokens,
  };
}

export class TelemetryRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async getAgentTimeAnalytics(
    ownerId: string,
    projectId?: string,
    now = new Date(),
  ): Promise<AgentTimeAnalytics> {
    const rows = await this.database
      .select({
        attemptStatus: schema.tokenUsageRecords.attemptStatus,
        completedAt: schema.tokenUsageRecords.completedAt,
        modelId: schema.tokenUsageRecords.modelId,
        providerId: schema.tokenUsageRecords.providerId,
        startedAt: schema.tokenUsageRecords.startedAt,
      })
      .from(schema.tokenUsageRecords)
      .where(
        and(
          eq(schema.tokenUsageRecords.ownerId, ownerId),
          ...(projectId
            ? [eq(schema.tokenUsageRecords.projectId, projectId)]
            : []),
        ),
      );
    return {
      total: summarizeAgentTime(rows, now),
      providers: groupAgentTime(rows, (row) => row.providerId, now),
      models: groupAgentTime(rows, (row) => row.modelId, now),
    };
  }

  async recordTokenUsage(
    ownerId: string,
    input: TokenUsageRecordInput,
  ): Promise<void> {
    const routeRows = await this.database
      .select({
        modelId: schema.modelProfiles.id,
        modelRouteId: schema.modelRoutes.id,
        providerId: schema.modelProviders.id,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.id, input.modelRouteId))
      .limit(1);
    const route = routeRows[0];
    const exactCount = (value: number | undefined): number =>
      Math.max(0, Math.round(value ?? 0));
    const usage = input.usage;
    const inputTokens = exactCount(usage?.inputTokens);
    const outputTokens = exactCount(usage?.outputTokens);
    const cachedInputTokens = exactCount(usage?.cachedInputTokens);
    const reasoningOutputTokens = exactCount(usage?.reasoningOutputTokens);
    const cacheWriteInputTokens = exactCount(usage?.cacheWriteInputTokens);
    const visibleOutputTokens =
      typeof usage?.visibleOutputTokens === "number"
        ? exactCount(usage.visibleOutputTokens)
        : null;
    const reportedTotalTokens = usage ? exactCount(usage.totalTokens) : null;
    const updatedAt = new Date();
    const attemptStatus = input.attemptStatus ?? "completed";
    const completedAt =
      input.completedAt ?? (attemptStatus === "running" ? null : updatedAt);
    const finalizedAt =
      input.finalizedAt ?? (attemptStatus === "running" ? null : updatedAt);
    await this.database
      .insert(schema.tokenUsageRecords)
      .values({
        id: randomUUID(),
        ownerId,
        projectId: input.projectId,
        chatId: input.chatId,
        sourceKey: input.sourceKey,
        modelId: route?.modelId ?? null,
        modelRouteId: route?.modelRouteId ?? null,
        providerId: route?.providerId ?? null,
        providerAccountId: input.providerAccountId ?? null,
        workerId: input.workerId ?? null,
        turnId: input.turnId ?? null,
        executionAttemptId: input.executionAttemptId ?? null,
        attemptKind: input.attemptKind ?? "turn",
        attemptStatus,
        reasoningEffort: input.reasoningEffort ?? null,
        workerVersion: input.workerVersion ?? null,
        serverVersion: input.serverVersion ?? null,
        codexVersion: input.codexVersion ?? null,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens,
        cacheWriteInputTokens,
        visibleOutputTokens,
        reportedTotalTokens,
        usageSemantics: "provider-reported-v2",
        startedAt: input.startedAt ?? updatedAt,
        completedAt,
        finalizedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.tokenUsageRecords.ownerId,
          schema.tokenUsageRecords.sourceKey,
        ],
        set: {
          projectId: input.projectId,
          chatId: input.chatId,
          modelId: route?.modelId ?? null,
          modelRouteId: route?.modelRouteId ?? null,
          providerId: route?.providerId ?? null,
          providerAccountId: input.providerAccountId ?? null,
          workerId: input.workerId ?? null,
          turnId: input.turnId ?? null,
          executionAttemptId: input.executionAttemptId ?? null,
          attemptKind: input.attemptKind ?? "turn",
          attemptStatus,
          reasoningEffort: input.reasoningEffort ?? null,
          workerVersion: input.workerVersion ?? null,
          serverVersion: input.serverVersion ?? null,
          codexVersion: input.codexVersion ?? null,
          ...(usage
            ? {
                inputTokens,
                outputTokens,
                cachedInputTokens,
                reasoningOutputTokens,
                cacheWriteInputTokens,
                visibleOutputTokens,
                reportedTotalTokens,
                usageSemantics: "provider-reported-v2",
              }
            : {}),
          ...(input.completedAt !== undefined
            ? { completedAt: input.completedAt }
            : {}),
          ...(input.finalizedAt !== undefined
            ? { finalizedAt: input.finalizedAt }
            : {}),
          updatedAt,
        },
      });
  }

  async recordModelBehaviorObservation(
    ownerId: string,
    input: ModelBehaviorObservationInput,
  ): Promise<void> {
    const routeRows = await this.database
      .select({
        modelId: schema.modelProfiles.id,
        modelRouteId: schema.modelRoutes.id,
        providerId: schema.modelProviders.id,
      })
      .from(schema.modelRoutes)
      .innerJoin(
        schema.modelProfiles,
        and(
          eq(schema.modelProfiles.id, schema.modelRoutes.modelId),
          eq(schema.modelProfiles.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, schema.modelRoutes.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(eq(schema.modelRoutes.id, input.modelRouteId))
      .limit(1);
    const route = routeRows[0];
    const count = (value: number | undefined): number =>
      Math.max(0, Math.round(value ?? 0));
    const nullableCount = (value: number | null | undefined): number | null =>
      typeof value === "number" ? count(value) : null;
    const contextUsedPercentBasisPoints =
      typeof input.contextUsedPercent === "number"
        ? Math.max(0, Math.round(input.contextUsedPercent * 100))
        : null;
    const updatedAt = new Date();
    const values = {
      projectId: input.projectId,
      chatId: input.chatId,
      modelId: route?.modelId ?? null,
      modelRouteId: route?.modelRouteId ?? null,
      providerId: route?.providerId ?? null,
      providerAccountId: input.providerAccountId ?? null,
      workerId: input.workerId ?? null,
      turnId: input.turnId ?? null,
      executionAttemptId: input.executionAttemptId,
      attemptKind: input.attemptKind ?? "chat-turn",
      attemptStatus: input.attemptStatus,
      reasoningEffort: input.reasoningEffort ?? null,
      routeAttemptIndex: count(input.routeAttemptIndex),
      retryFailoverCount: count(input.retryFailoverCount),
      firstActivityAt: input.firstActivityAt ?? null,
      firstVisibleResponseAt: input.firstVisibleResponseAt ?? null,
      completedAt: input.completedAt ?? null,
      finalizedAt: input.finalizedAt ?? null,
      durationMs: nullableCount(input.durationMs),
      finalAnswerAppeared: input.finalAnswerAppeared ?? false,
      toolCallCount: count(input.toolCallCount),
      invalidToolCallCount: count(input.invalidToolCallCount),
      compactionCount: count(input.compactionCount),
      approvalRequestCount: count(input.approvalRequestCount),
      inputTokens: count(input.inputTokens),
      cachedInputTokens: count(input.cachedInputTokens),
      cacheWriteInputTokens: count(input.cacheWriteInputTokens),
      outputTokens: count(input.outputTokens),
      reasoningOutputTokens: count(input.reasoningOutputTokens),
      modelContextWindow: nullableCount(input.modelContextWindow),
      contextUsedPercentBasisPoints,
      filesChangedCount: count(input.filesChangedCount),
      testCommandCount: count(input.testCommandCount),
      testPassCount: count(input.testPassCount),
      testFailureCount: count(input.testFailureCount),
      userInterrupted: input.userInterrupted ?? false,
      userRetryRegeneration: input.userRetryRegeneration ?? null,
      immediateCorrectiveFollowup: input.immediateCorrectiveFollowup ?? false,
      workerVersion: input.workerVersion ?? null,
      serverVersion: input.serverVersion ?? null,
      codexVersion: input.codexVersion ?? null,
      signalAvailability: input.signalAvailability ?? {},
      updatedAt,
    };
    await this.database
      .insert(schema.modelBehaviorObservations)
      .values({
        id: randomUUID(),
        ownerId,
        sourceKey: input.sourceKey,
        startedAt: input.startedAt ?? updatedAt,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          schema.modelBehaviorObservations.ownerId,
          schema.modelBehaviorObservations.sourceKey,
        ],
        set: values,
      });
  }

  async getProjectTokenUsage(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectTokenUsage | null> {
    const projects = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!projects[0]) return null;

    const now = new Date();
    const rangeStart = new Date(now);
    rangeStart.setUTCHours(0, 0, 0, 0);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - 364);
    const rangeEnd = new Date(now);
    rangeEnd.setUTCHours(0, 0, 0, 0);
    const filter = and(
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      eq(schema.tokenUsageRecords.projectId, projectId),
    );
    const sumInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.inputTokens}), 0)`.mapWith(
        Number,
      );
    const sumOutput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.outputTokens}), 0)`.mapWith(
        Number,
      );
    const sumCachedInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.cachedInputTokens}), 0)`.mapWith(
        Number,
      );
    const sumCacheWriteInput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.cacheWriteInputTokens}), 0)`.mapWith(
        Number,
      );
    const sumReasoningOutput =
      sql<number>`coalesce(sum(${schema.tokenUsageRecords.reasoningOutputTokens}), 0)`.mapWith(
        Number,
      );
    const tokenSums = {
      inputTokens: sumInput,
      outputTokens: sumOutput,
      cachedInputTokens: sumCachedInput,
      cacheWriteInputTokens: sumCacheWriteInput,
      reasoningOutputTokens: sumReasoningOutput,
    };
    const day = sql<string>`to_char(${schema.tokenUsageRecords.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const [totalRows, dailyRows, providerRows, modelRows, agentTime] =
      await Promise.all([
        this.database
          .select(tokenSums)
          .from(schema.tokenUsageRecords)
          .where(filter),
        this.database
          .select({
            date: day,
            ...tokenSums,
          })
          .from(schema.tokenUsageRecords)
          .where(
            and(filter, gte(schema.tokenUsageRecords.startedAt, rangeStart)),
          )
          .groupBy(day)
          .orderBy(day),
        this.database
          .select({
            id: schema.tokenUsageRecords.providerId,
            name: sql<string>`coalesce(${schema.modelProviders.name}, 'Deleted provider')`,
            ...tokenSums,
          })
          .from(schema.tokenUsageRecords)
          .leftJoin(
            schema.modelProviders,
            eq(schema.modelProviders.id, schema.tokenUsageRecords.providerId),
          )
          .where(filter)
          .groupBy(
            schema.tokenUsageRecords.providerId,
            schema.modelProviders.name,
          ),
        this.database
          .select({
            id: schema.tokenUsageRecords.modelId,
            name: sql<string>`coalesce(${schema.modelProfiles.name}, 'Deleted model')`,
            ...tokenSums,
          })
          .from(schema.tokenUsageRecords)
          .leftJoin(
            schema.modelProfiles,
            eq(schema.modelProfiles.id, schema.tokenUsageRecords.modelId),
          )
          .where(filter)
          .groupBy(schema.tokenUsageRecords.modelId, schema.modelProfiles.name),
        this.getAgentTimeAnalytics(ownerId, projectId, now),
      ]);
    const mergeBreakdowns = (
      rows: Array<{
        id: string | null;
        name: string;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        cacheWriteInputTokens: number;
        reasoningOutputTokens: number;
      }>,
      timeById: ReadonlyMap<string, AgentTimeSummary>,
    ) => {
      const merged = new Map<
        string,
        {
          id: string | null;
          name: string;
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
          cacheWriteInputTokens: number;
          reasoningOutputTokens: number;
        }
      >();
      for (const row of rows) {
        const key = row.id ?? `deleted:${row.name}`;
        const existing = merged.get(key);
        merged.set(key, {
          id: row.id,
          name: row.name,
          inputTokens: (existing?.inputTokens ?? 0) + row.inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + row.outputTokens,
          cachedInputTokens:
            (existing?.cachedInputTokens ?? 0) + row.cachedInputTokens,
          cacheWriteInputTokens:
            (existing?.cacheWriteInputTokens ?? 0) + row.cacheWriteInputTokens,
          reasoningOutputTokens:
            (existing?.reasoningOutputTokens ?? 0) + row.reasoningOutputTokens,
        });
      }
      return [...merged.values()]
        .map((row) => ({
          id: row.id,
          name: row.name,
          agentTime: row.id
            ? (timeById.get(row.id) ?? ZERO_AGENT_TIME)
            : ZERO_AGENT_TIME,
          ...detailedTokenUsageTotals(
            row.inputTokens,
            row.outputTokens,
            row.cachedInputTokens,
            row.cacheWriteInputTokens,
            row.reasoningOutputTokens,
          ),
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens);
    };
    const totalRow = totalRows[0] ?? {
      ...ZERO_TOKEN_USAGE,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    return {
      total: detailedTokenUsageTotals(
        totalRow.inputTokens,
        totalRow.outputTokens,
        totalRow.cachedInputTokens,
        totalRow.cacheWriteInputTokens,
        totalRow.reasoningOutputTokens,
      ),
      agentTime: agentTime.total,
      daily: dailyRows.map((row) => ({
        date: row.date,
        ...detailedTokenUsageTotals(
          row.inputTokens,
          row.outputTokens,
          row.cachedInputTokens,
          row.cacheWriteInputTokens,
          row.reasoningOutputTokens,
        ),
      })),
      providers: mergeBreakdowns(providerRows, agentTime.providers),
      models: mergeBreakdowns(modelRows, agentTime.models),
      range: {
        start: rangeStart.toISOString().slice(0, 10),
        end: rangeEnd.toISOString().slice(0, 10),
      },
    };
  }

  async recordProviderQuotaObservation(
    ownerId: string,
    input: ProviderQuotaObservationInput,
  ): Promise<boolean> {
    if (
      !Number.isFinite(input.usedPercent) ||
      input.usedPercent < 0 ||
      input.usedPercent > 100 ||
      Number.isNaN(input.observedAt.getTime()) ||
      (input.windowDurationMinutes !== null &&
        (!Number.isInteger(input.windowDurationMinutes) ||
          input.windowDurationMinutes < 0))
    ) {
      return false;
    }
    const accountRows = await this.database
      .select({
        providerKind: schema.modelProviders.kind,
      })
      .from(schema.modelProviderAccounts)
      .innerJoin(
        schema.modelProviders,
        and(
          eq(schema.modelProviders.id, input.providerId),
          eq(schema.modelProviders.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(schema.modelProviderAccounts.id, input.providerAccountId),
          eq(schema.modelProviderAccounts.providerId, input.providerId),
        ),
      )
      .limit(1);
    const account = accountRows[0];
    if (!account) return false;

    if (input.workerId) {
      const workerRows = await this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!workerRows[0]) return false;
    }

    return this.database.transaction(async (transaction) => {
      const inserted = await transaction
        .insert(schema.providerQuotaObservations)
        .values({
          id: randomUUID(),
          ownerId,
          eventKey: input.eventKey,
          observationBatchKey: input.observationBatchKey,
          providerId: input.providerId,
          providerKind: account.providerKind,
          providerAccountId: input.providerAccountId,
          workerId: input.workerId,
          observedAt: input.observedAt,
          usedPercentMicros: Math.round(input.usedPercent * 1_000_000),
          resetsAt: input.resetsAt,
          windowDurationMinutes: input.windowDurationMinutes,
          limitId: input.limitId,
          windowKind: input.windowKind,
          reachedType: input.reachedType,
          observationTrigger: input.observationTrigger,
          isWeeklyProjection: input.isWeeklyProjection,
          chatId: input.chatId,
          turnId: input.turnId,
          executionAttemptId: input.executionAttemptId,
          workerVersion: input.workerVersion,
          serverVersion: input.serverVersion,
          codexVersion: input.codexVersion,
        })
        .onConflictDoNothing({
          target: [
            schema.providerQuotaObservations.ownerId,
            schema.providerQuotaObservations.eventKey,
          ],
        })
        .returning({ id: schema.providerQuotaObservations.id });
      if (!inserted[0]) return false;
      if (!input.isWeeklyProjection) return true;

      const projection = {
        ...(input.planType ? { planType: input.planType } : {}),
        weeklyUsageUsedBasisPoints: Math.round(input.usedPercent * 100),
        weeklyUsageResetsAt: input.resetsAt,
        weeklyUsageObservedAt: input.observedAt,
        updatedAt: new Date(),
      };
      await transaction
        .update(schema.modelProviderAccounts)
        .set(projection)
        .where(
          and(
            eq(schema.modelProviderAccounts.id, input.providerAccountId),
            or(
              isNull(schema.modelProviderAccounts.weeklyUsageObservedAt),
              lte(
                schema.modelProviderAccounts.weeklyUsageObservedAt,
                input.observedAt,
              ),
            ),
          ),
        );
      if (input.workerId) {
        await transaction
          .update(schema.modelProviderAccountWorkers)
          .set({
            weeklyUsageUsedBasisPoints: projection.weeklyUsageUsedBasisPoints,
            weeklyUsageResetsAt: projection.weeklyUsageResetsAt,
            weeklyUsageObservedAt: projection.weeklyUsageObservedAt,
            updatedAt: projection.updatedAt,
          })
          .where(
            and(
              eq(
                schema.modelProviderAccountWorkers.accountId,
                input.providerAccountId,
              ),
              eq(schema.modelProviderAccountWorkers.workerId, input.workerId),
              or(
                isNull(
                  schema.modelProviderAccountWorkers.weeklyUsageObservedAt,
                ),
                lte(
                  schema.modelProviderAccountWorkers.weeklyUsageObservedAt,
                  input.observedAt,
                ),
              ),
            ),
          );
      }
      return true;
    });
  }

  async getQuotaTokenAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<QuotaTokenAnalytics> {
    const quotaFilters = [
      eq(schema.providerQuotaObservations.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.providerQuotaObservations.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.providerQuotaObservations.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.to
        ? [lte(schema.providerQuotaObservations.observedAt, query.to)]
        : []),
    ];
    const tokenFilters = [
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.tokenUsageRecords.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.tokenUsageRecords.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.tokenUsageRecords.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [eq(schema.tokenUsageRecords.reasoningEffort, query.reasoningEffort)]
        : []),
      ...(query.projectId
        ? [eq(schema.tokenUsageRecords.projectId, query.projectId)]
        : []),
      ...(query.from
        ? [gte(schema.tokenUsageRecords.startedAt, query.from)]
        : []),
      ...(query.to ? [lte(schema.tokenUsageRecords.startedAt, query.to)] : []),
    ];
    const [quotaRows, tokenRows] = await Promise.all([
      this.database
        .select()
        .from(schema.providerQuotaObservations)
        .where(and(...quotaFilters))
        .orderBy(asc(schema.providerQuotaObservations.observedAt)),
      this.database
        .select()
        .from(schema.tokenUsageRecords)
        .where(and(...tokenFilters))
        .orderBy(asc(schema.tokenUsageRecords.startedAt)),
    ]);
    const readings = quotaRows.map((row) => ({
      id: row.id,
      providerId: row.providerId,
      providerAccountId: row.providerAccountId,
      limitId: row.limitId,
      limitName: row.limitId ?? row.windowKind,
      windowKind: row.windowKind,
      windowDurationMinutes: row.windowDurationMinutes,
      resetsAt: row.resetsAt,
      observedAt: row.observedAt,
      receivedAt: row.receivedAt,
      usedPercent: row.usedPercentMicros / 1_000_000,
    }));
    const rangedReadings = query.from
      ? [
          ...new Map(
            readings
              .filter((reading) => reading.observedAt >= query.from!)
              .flatMap((reading) => {
                const prior = readings
                  .filter(
                    (candidate) =>
                      candidate.providerAccountId ===
                        reading.providerAccountId &&
                      candidate.limitId === reading.limitId &&
                      candidate.windowKind === reading.windowKind &&
                      candidate.resetsAt?.getTime() ===
                        reading.resetsAt?.getTime() &&
                      candidate.observedAt < query.from!,
                  )
                  .at(-1);
                return [prior, reading].filter(
                  (candidate): candidate is (typeof readings)[number] =>
                    Boolean(candidate),
                );
              })
              .map((reading) => [reading.id, reading]),
          ).values(),
        ]
      : readings;
    return deriveQuotaTokenAnalytics(
      rangedReadings,
      tokenRows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        providerAccountId: row.providerAccountId,
        modelId: row.modelId,
        modelName: row.modelId ?? row.modelRouteId ?? "unattributed",
        reasoningEffort: row.reasoningEffort,
        projectId: row.projectId,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        finalizedAt: row.finalizedAt,
        attemptStatus: row.attemptStatus,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        visibleOutputTokens: row.visibleOutputTokens,
        reportedTotalTokens: row.reportedTotalTokens,
      })),
      query.to ?? new Date(),
    );
  }

  async getProviderTelemetryAnalytics(
    ownerId: string,
    query: QuotaTokenAnalyticsQuery = {},
  ): Promise<ProviderTelemetryWireAnalytics> {
    const from = query.from ?? new Date(Date.now() - 364 * 86_400_000);
    const to = query.to ?? new Date();
    const scopedQuery = { ...query, from, to };
    const tokenFilters = [
      eq(schema.tokenUsageRecords.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.tokenUsageRecords.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.tokenUsageRecords.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.tokenUsageRecords.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [eq(schema.tokenUsageRecords.reasoningEffort, query.reasoningEffort)]
        : []),
      ...(query.projectId
        ? [eq(schema.tokenUsageRecords.projectId, query.projectId)]
        : []),
      gte(schema.tokenUsageRecords.startedAt, from),
      lte(schema.tokenUsageRecords.startedAt, to),
    ];
    const behaviorFilters = [
      eq(schema.modelBehaviorObservations.ownerId, ownerId),
      ...(query.providerId
        ? [eq(schema.modelBehaviorObservations.providerId, query.providerId)]
        : []),
      ...(query.providerAccountId
        ? [
            eq(
              schema.modelBehaviorObservations.providerAccountId,
              query.providerAccountId,
            ),
          ]
        : []),
      ...(query.modelId
        ? [eq(schema.modelBehaviorObservations.modelId, query.modelId)]
        : []),
      ...(query.reasoningEffort
        ? [
            eq(
              schema.modelBehaviorObservations.reasoningEffort,
              query.reasoningEffort,
            ),
          ]
        : []),
      ...(query.projectId
        ? [eq(schema.modelBehaviorObservations.projectId, query.projectId)]
        : []),
      gte(schema.modelBehaviorObservations.startedAt, from),
      lte(schema.modelBehaviorObservations.startedAt, to),
    ];
    const [quota, tokenRows, behaviorRows, currentAccounts] = await Promise.all(
      [
        this.getQuotaTokenAnalytics(ownerId, scopedQuery),
        this.database
          .select()
          .from(schema.tokenUsageRecords)
          .where(and(...tokenFilters))
          .orderBy(asc(schema.tokenUsageRecords.startedAt)),
        this.database
          .select()
          .from(schema.modelBehaviorObservations)
          .where(and(...behaviorFilters))
          .orderBy(asc(schema.modelBehaviorObservations.startedAt)),
        this.database
          .select({
            id: schema.modelProviderAccounts.id,
            providerId: schema.modelProviderAccounts.providerId,
          })
          .from(schema.modelProviderAccounts)
          .innerJoin(
            schema.modelProviders,
            eq(
              schema.modelProviders.id,
              schema.modelProviderAccounts.providerId,
            ),
          )
          .where(
            and(
              eq(schema.modelProviders.ownerId, ownerId),
              ...(query.providerId
                ? [eq(schema.modelProviders.id, query.providerId)]
                : []),
            ),
          ),
      ],
    );

    const accountById = new Map(
      currentAccounts.map((account) => [account.id, account] as const),
    );
    for (const reading of quota.readings) {
      if (accountById.has(reading.providerAccountId)) continue;
      accountById.set(reading.providerAccountId, {
        id: reading.providerAccountId,
        providerId: reading.providerId,
      });
    }

    const quotaHistory = quota.readings.map((reading) => ({
      id: reading.id,
      providerId: reading.providerId,
      providerAccountId: reading.providerAccountId,
      limitId: reading.limitId,
      windowKind: reading.windowKind,
      usedPercent: reading.usedPercent,
      remainingPercent: Math.max(0, 100 - reading.usedPercent),
      resetsAt: reading.resetsAt?.toISOString() ?? null,
      observedAt: reading.observedAt.toISOString(),
    }));
    const currentQuotaByBucket = new Map<
      string,
      (typeof quotaHistory)[number]
    >();
    for (const reading of quotaHistory) {
      currentQuotaByBucket.set(
        [
          reading.providerId,
          reading.providerAccountId,
          reading.limitId ?? "unidentified-limit",
          reading.windowKind,
        ].join(":"),
        reading,
      );
    }

    const dailyTokens = new Map<string, typeof tokenRows>();
    for (const row of tokenRows) {
      const date = row.startedAt.toISOString().slice(0, 10);
      dailyTokens.set(date, [...(dailyTokens.get(date) ?? []), row]);
    }
    const detailedBreakdown = (entries: typeof quota.breakdowns.model) =>
      entries.map((entry) => ({
        key: entry.key,
        sampleCount: entry.sampleCount,
        highConfidenceSamples: entry.highConfidenceSamples,
        unattributedSamples: entry.unattributedSamples,
        tokens: detailedTokenUsageTotals(
          entry.totals.inputTokens,
          entry.totals.outputTokens,
          entry.totals.cachedInputTokens,
          entry.totals.cacheWriteInputTokens,
          entry.totals.reasoningOutputTokens,
        ),
        effectiveTokensPer100Percent: entry.effectiveTokensPer100Percent,
      }));

    const behaviorBreakdown = <Row extends (typeof behaviorRows)[number]>(
      rows: Row[],
      keyFor: (row: Row) => string,
    ) =>
      [...groupModelBehavior(rows, keyFor).entries()]
        .map(([key, summary]) => ({ key, ...summary }))
        .sort((left, right) => right.attemptCount - left.attemptCount);
    const dailyBehavior = behaviorBreakdown(behaviorRows, (row) =>
      row.startedAt.toISOString().slice(0, 10),
    ).map(({ key: date, ...summary }) => ({ date, ...summary }));
    const changePoints = detectTelemetryChanges(
      quota.movementSamples,
      behaviorRows,
    );
    const estimates = quota.movementSamples;
    const attributableEstimates = estimates.filter(
      ({ unattributed }) => !unattributed,
    );
    const resetBoundaries = new Map<
      string,
      { providerAccountId: string; resetsAt: string; firstObservedAt: string }
    >();
    for (const reading of quotaHistory) {
      if (!reading.resetsAt) continue;
      const key = `${reading.providerAccountId}:${reading.resetsAt}`;
      const current = resetBoundaries.get(key);
      if (!current || reading.observedAt < current.firstObservedAt) {
        resetBoundaries.set(key, {
          providerAccountId: reading.providerAccountId,
          resetsAt: reading.resetsAt,
          firstObservedAt: reading.observedAt,
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      range: { from: from.toISOString(), to: to.toISOString() },
      accounts: [...accountById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      currentQuota: [...currentQuotaByBucket.values()].sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt),
      ),
      quotaHistory: sampleProviderTelemetryQuotaHistory(quotaHistory),
      resetBoundaries: [...resetBoundaries.values()].sort((left, right) =>
        left.resetsAt.localeCompare(right.resetsAt),
      ),
      tokens: {
        total: sumDetailedTokenUsage(tokenRows),
        daily: [...dailyTokens.entries()]
          .map(([date, rows]) => ({ date, ...sumDetailedTokenUsage(rows) }))
          .sort((left, right) => left.date.localeCompare(right.date)),
      },
      estimates: {
        sampleCount: estimates.length,
        highConfidenceSamples: estimates.filter(
          ({ confidence }) => confidence === "high",
        ).length,
        unattributedSamples: estimates.filter(
          ({ unattributed }) => unattributed,
        ).length,
        tokensPerPercent: quotaValueStatistics(
          attributableEstimates.map(
            ({ tokensPerPercent }) => tokensPerPercent.comparableTokens,
          ),
        ),
        effectiveTokensPer100Percent: quotaValueStatistics(
          attributableEstimates.map(
            ({ effectiveTokensPer100Percent }) => effectiveTokensPer100Percent,
          ),
        ),
      },
      comparisons: {
        rolling7Days: quota.rolling7Days,
        rolling30Days: quota.rolling30Days,
        monthOverMonth: quota.monthOverMonth,
      },
      breakdowns: {
        accounts: detailedBreakdown(quota.breakdowns.account),
        models: detailedBreakdown(quota.breakdowns.model),
        reasoningEfforts: detailedBreakdown(quota.breakdowns.reasoningEffort),
        months: detailedBreakdown(quota.breakdowns.month),
      },
      behavior: {
        total: summarizeModelBehavior(behaviorRows),
        daily: dailyBehavior,
        accounts: behaviorBreakdown(
          behaviorRows,
          (row) => row.providerAccountId ?? "unattributed",
        ),
        models: behaviorBreakdown(
          behaviorRows,
          (row) => row.modelId ?? row.modelRouteId ?? "unattributed",
        ),
        reasoningEfforts: behaviorBreakdown(
          behaviorRows,
          (row) => row.reasoningEffort ?? "provider-default",
        ),
      },
      changePoints,
    };
  }

  async exportProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryExport | null> {
    const providerRows = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
        ),
      )
      .limit(1);
    const provider = providerRows[0];
    if (!provider) return null;

    const [quotaRows, tokenRows, behaviorRows, catalogRows] = await Promise.all(
      [
        this.database
          .select()
          .from(schema.providerQuotaObservations)
          .where(
            and(
              eq(schema.providerQuotaObservations.ownerId, ownerId),
              eq(schema.providerQuotaObservations.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.providerQuotaObservations.observedAt)),
        this.database
          .select()
          .from(schema.tokenUsageRecords)
          .where(
            and(
              eq(schema.tokenUsageRecords.ownerId, ownerId),
              eq(schema.tokenUsageRecords.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.tokenUsageRecords.startedAt)),
        this.database
          .select()
          .from(schema.modelBehaviorObservations)
          .where(
            and(
              eq(schema.modelBehaviorObservations.ownerId, ownerId),
              eq(schema.modelBehaviorObservations.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.modelBehaviorObservations.startedAt)),
        this.database
          .select()
          .from(schema.providerModelCatalogSnapshots)
          .where(
            and(
              eq(schema.providerModelCatalogSnapshots.ownerId, ownerId),
              eq(schema.providerModelCatalogSnapshots.providerId, providerId),
            ),
          )
          .orderBy(asc(schema.providerModelCatalogSnapshots.observedAt)),
      ],
    );

    return {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      provider,
      privacy: {
        includesMessageContent: false,
        rawPayloadsStored: false,
        dimensionLabels: "opaque-ids",
        retention: "owner-controlled-indefinite",
      },
      quotaObservations: quotaRows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        observationBatchKey: row.observationBatchKey,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        observedAt: row.observedAt.toISOString(),
        receivedAt: row.receivedAt.toISOString(),
        usedPercent: row.usedPercentMicros / 1_000_000,
        resetsAt: row.resetsAt?.toISOString() ?? null,
        windowDurationMinutes: row.windowDurationMinutes,
        limitId: row.limitId,
        windowKind: row.windowKind,
        reachedType: row.reachedType,
        observationTrigger: row.observationTrigger,
        chatId: row.chatId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
      })),
      tokenUsage: tokenRows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        chatId: row.chatId,
        sourceKey: row.sourceKey,
        modelId: row.modelId,
        modelRouteId: row.modelRouteId,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        attemptKind: row.attemptKind,
        attemptStatus: row.attemptStatus,
        reasoningEffort: row.reasoningEffort,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        visibleOutputTokens: row.visibleOutputTokens,
        reportedTotalTokens: row.reportedTotalTokens,
        usageSemantics: row.usageSemantics,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        finalizedAt: row.finalizedAt?.toISOString() ?? null,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
      })),
      modelBehavior: behaviorRows.map((row) => ({
        id: row.id,
        sourceKey: row.sourceKey,
        projectId: row.projectId,
        chatId: row.chatId,
        modelId: row.modelId,
        modelRouteId: row.modelRouteId,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        turnId: row.turnId,
        executionAttemptId: row.executionAttemptId,
        attemptStatus: row.attemptStatus,
        reasoningEffort: row.reasoningEffort,
        startedAt: row.startedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        finalizedAt: row.finalizedAt?.toISOString() ?? null,
        durationMs: row.durationMs,
        finalAnswerAppeared: row.finalAnswerAppeared,
        toolCallCount: row.toolCallCount,
        invalidToolCallCount: row.invalidToolCallCount,
        retryFailoverCount: row.retryFailoverCount,
        compactionCount: row.compactionCount,
        approvalRequestCount: row.approvalRequestCount,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        filesChangedCount: row.filesChangedCount,
        testCommandCount: row.testCommandCount,
        testPassCount: row.testPassCount,
        testFailureCount: row.testFailureCount,
        userInterrupted: row.userInterrupted,
        userRetryRegeneration: row.userRetryRegeneration,
        immediateCorrectiveFollowup: row.immediateCorrectiveFollowup,
        forkCount: row.forkCount,
        copyCount: row.copyCount,
        ratingValue: row.ratingValue,
        workerVersion: row.workerVersion,
        serverVersion: row.serverVersion,
        codexVersion: row.codexVersion,
        signalAvailability: row.signalAvailability,
      })),
      modelCatalogSnapshots: catalogRows.map((row) => ({
        id: row.id,
        providerAccountId: row.providerAccountId,
        workerId: row.workerId,
        availabilityScope: row.availabilityScope,
        metadataSource: row.metadataSource,
        metadataHash: row.metadataHash,
        observedAt: row.observedAt.toISOString(),
      })),
    };
  }

  async deleteProviderTelemetry(
    ownerId: string,
    providerId: string,
  ): Promise<ProviderTelemetryDeleteResult | null> {
    const provider = await this.database
      .select({ id: schema.modelProviders.id })
      .from(schema.modelProviders)
      .where(
        and(
          eq(schema.modelProviders.ownerId, ownerId),
          eq(schema.modelProviders.id, providerId),
        ),
      )
      .limit(1);
    if (!provider[0]) return null;

    return this.database.transaction(async (transaction) => {
      const quotaObservations = await transaction
        .delete(schema.providerQuotaObservations)
        .where(
          and(
            eq(schema.providerQuotaObservations.ownerId, ownerId),
            eq(schema.providerQuotaObservations.providerId, providerId),
          ),
        )
        .returning({ id: schema.providerQuotaObservations.id });
      const tokenUsage = await transaction
        .delete(schema.tokenUsageRecords)
        .where(
          and(
            eq(schema.tokenUsageRecords.ownerId, ownerId),
            eq(schema.tokenUsageRecords.providerId, providerId),
          ),
        )
        .returning({ id: schema.tokenUsageRecords.id });
      const modelBehavior = await transaction
        .delete(schema.modelBehaviorObservations)
        .where(
          and(
            eq(schema.modelBehaviorObservations.ownerId, ownerId),
            eq(schema.modelBehaviorObservations.providerId, providerId),
          ),
        )
        .returning({ id: schema.modelBehaviorObservations.id });
      const modelCatalogSnapshots = await transaction
        .delete(schema.providerModelCatalogSnapshots)
        .where(
          and(
            eq(schema.providerModelCatalogSnapshots.ownerId, ownerId),
            eq(schema.providerModelCatalogSnapshots.providerId, providerId),
          ),
        )
        .returning({ id: schema.providerModelCatalogSnapshots.id });
      return {
        providerId,
        deleted: {
          quotaObservations: quotaObservations.length,
          tokenUsage: tokenUsage.length,
          modelBehavior: modelBehavior.length,
          modelCatalogSnapshots: modelCatalogSnapshots.length,
        },
      };
    });
  }
}
