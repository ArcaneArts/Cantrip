import {
  providerQuotaSnapshotSchema,
  type AgentActivity,
  type ModelProviderKind,
  type ProviderQuotaSnapshot,
} from "@cantrip/protocol";
import { cantripVersion } from "@cantrip/version";

import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

const QUOTA_READ_TIMEOUT_MS = 2 * 60_000;

export interface ProviderQuotaCaptureContext {
  accountId: string;
  accountPlanType: string | null;
  chatId?: string | null;
  executionAttemptId?: string | null;
  ownerId: string;
  providerId: string;
  trigger: string;
  turnId?: string | null;
  workerId: string;
}

export async function persistProviderQuotaSnapshot(
  repository: ServerRepository,
  context: ProviderQuotaCaptureContext,
  input: ProviderQuotaSnapshot,
): Promise<number> {
  const snapshot = providerQuotaSnapshotSchema.parse(input);
  let inserted = 0;
  for (const [index, window] of snapshot.windows.entries()) {
    const recorded = await repository.recordProviderQuotaObservation(
      context.ownerId,
      {
        eventKey: `${context.providerId}:${context.accountId}:${snapshot.snapshotId}:${index}`,
        observationBatchKey: snapshot.snapshotId,
        providerId: context.providerId,
        providerAccountId: context.accountId,
        workerId: context.workerId,
        observedAt: new Date(snapshot.observedAt),
        usedPercent: window.usedPercent,
        resetsAt:
          window.resetsAt === null ? null : new Date(window.resetsAt * 1_000),
        windowDurationMinutes: window.windowDurationMinutes,
        limitId: window.limitId,
        limitName: window.limitName,
        windowKind: window.windowKind,
        planType: window.planType ?? context.accountPlanType,
        reachedType: window.reachedType,
        observationTrigger: context.trigger,
        isWeeklyProjection: window.isWeeklyProjection,
        chatId: context.chatId ?? null,
        turnId: context.turnId ?? null,
        executionAttemptId: context.executionAttemptId ?? null,
        workerVersion: snapshot.workerVersion,
        serverVersion: cantripVersion.version,
        codexVersion: snapshot.codexVersion,
        sanitizedRawPayload: {
          snapshotId: snapshot.snapshotId,
          ...window.rawPayload,
        },
      },
    );
    if (recorded) inserted += 1;
  }
  return inserted;
}

export async function readAndPersistProviderQuotaSnapshot(
  repository: ServerRepository,
  bridge: WorkerCommandBus,
  context: ProviderQuotaCaptureContext & {
    provider: {
      baseUrl: string;
      credentialHomeKey: string;
      kind: Extract<ModelProviderKind, "chatgpt" | "grok">;
      name: string;
    };
  },
): Promise<{ inserted: number; snapshot: ProviderQuotaSnapshot }> {
  const snapshot = providerQuotaSnapshotSchema.parse(
    await bridge.request(
      context.workerId,
      {
        type: "provider.quota.read",
        provider: {
          id: context.providerId,
          name: context.provider.name,
          kind: context.provider.kind,
          baseUrl: context.provider.baseUrl,
          protectedApiKey: null,
          accountId: context.accountId,
          credentialHomeKey: context.provider.credentialHomeKey,
        },
      },
      { ownerId: context.ownerId, timeoutMs: QUOTA_READ_TIMEOUT_MS },
    ),
  );
  return {
    inserted: await persistProviderQuotaSnapshot(repository, context, snapshot),
    snapshot,
  };
}

export async function persistProviderRateLimitActivity(
  repository: ServerRepository,
  context: ProviderQuotaCaptureContext,
  activity: Extract<AgentActivity, { type: "rateLimit" }>,
): Promise<number> {
  const observedAt = new Date(activity.updatedAtMs ?? Date.now());
  const batchKey =
    activity.correlation?.diagnosticId ??
    `${context.executionAttemptId ?? context.turnId ?? "turn"}:${activity.id}:${observedAt.getTime()}`;
  return persistProviderQuotaSnapshot(
    repository,
    context,
    providerQuotaSnapshotSchema.parse({
      snapshotId: batchKey,
      observedAt: observedAt.toISOString(),
      workerVersion: null,
      codexVersion: null,
      windows: (["primary", "secondary"] as const).flatMap((windowKind) => {
        const window = activity[windowKind];
        if (!window) return [];
        return [
          {
            limitId: activity.limitId,
            limitName: activity.limitName,
            planType: activity.planType,
            reachedType: activity.reachedType,
            windowKind,
            usedPercent: window.usedPercent,
            windowDurationMinutes: window.windowDurationMins,
            resetsAt: window.resetsAt,
            isWeeklyProjection:
              (activity.limitId === null || activity.limitId === "codex") &&
              window.windowDurationMins === 7 * 24 * 60,
            rawPayload: {
              source:
                activity.correlation?.sourceMethod ?? "rate-limit-activity",
              limitId: activity.limitId,
              limitName: activity.limitName,
              planType: activity.planType,
              reachedType: activity.reachedType,
              windowKind,
              usedPercent: window.usedPercent,
              windowDurationMinutes: window.windowDurationMins,
              resetsAt: window.resetsAt,
            },
          },
        ];
      }),
    }),
  );
}
