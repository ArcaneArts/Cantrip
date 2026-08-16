import { fileURLToPath } from "node:url";

import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { persistProviderQuotaSnapshot } from "../src/models/provider-quota.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("provider quota observation ledger", () => {
  it("appends independent readings, deduplicates delivery, and never regresses the projection", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 31) }],
      }),
    );
    try {
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        kind: "chatgpt",
        name: "Observed account",
      });
      const account = provider.accounts[0]!;
      await repository.recordWorker(LOCAL_USER_ID, {
        architecture: "arm64",
        codexRuntime: unprobedCodexRuntimeReport,
        codexVersion: "0.147.0",
        name: "Telemetry worker",
        platform: "darwin",
        startedAt: "2026-08-16T10:00:00.000Z",
        workerId: "worker-telemetry",
      });
      await repository.recordModelProviderAccountStatus(
        account.id,
        "worker-telemetry",
        {
          authenticated: true,
          email: "observed@example.test",
          planType: "observed-plan",
          weeklyUsage: null,
        },
      );

      const base = {
        providerId: provider.id,
        providerAccountId: account.id,
        workerId: "worker-telemetry",
        resetsAt: new Date("2026-08-23T00:00:00.000Z"),
        windowDurationMinutes: 10_080,
        limitId: "opaque-limit",
        limitName: "Observed meter",
        windowKind: "secondary",
        planType: "observed-plan",
        reachedType: null,
        observationTrigger: "rate-limit-event",
        isWeeklyProjection: true,
        chatId: "chat-historical-dimension",
        turnId: "turn-historical-dimension",
        executionAttemptId: "attempt-historical-dimension",
        workerVersion: "worker-build",
        serverVersion: "server-build",
        codexVersion: "0.147.0",
        sanitizedRawPayload: { meter: "opaque", usedPercent: 42.125 },
      } as const;

      await expect(
        repository.recordProviderQuotaObservation(LOCAL_USER_ID, {
          ...base,
          eventKey: "quota-event-newer",
          observationBatchKey: "quota-batch-newer",
          observedAt: new Date("2026-08-16T12:00:00.000Z"),
          usedPercent: 42.125,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.recordProviderQuotaObservation(LOCAL_USER_ID, {
          ...base,
          eventKey: "quota-event-older",
          observationBatchKey: "quota-batch-older",
          observedAt: new Date("2026-08-16T11:00:00.000Z"),
          usedPercent: 12,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.recordProviderQuotaObservation(LOCAL_USER_ID, {
          ...base,
          eventKey: "quota-event-newer",
          observationBatchKey: "redelivered-batch",
          observedAt: new Date("2026-08-16T12:00:00.000Z"),
          usedPercent: 42.125,
        }),
      ).resolves.toBe(false);
      await expect(
        repository.recordProviderQuotaObservation(LOCAL_USER_ID, {
          ...base,
          eventKey: "quota-event-independent",
          observationBatchKey: "quota-batch-independent",
          observedAt: new Date("2026-08-16T12:01:00.000Z"),
          usedPercent: 42.125,
        }),
      ).resolves.toBe(true);

      const observations = await client.query<{
        event_key: string;
        provider_name: string;
        used_percent_micros: number;
        worker_name: string;
      }>(`
        SELECT event_key, provider_name, used_percent_micros, worker_name
        FROM provider_quota_observations
        ORDER BY observed_at
      `);
      expect(observations.rows).toHaveLength(3);
      expect(observations.rows.at(-1)).toMatchObject({
        event_key: "quota-event-independent",
        provider_name: "Observed account",
        used_percent_micros: 42_125_000,
        worker_name: "Telemetry worker",
      });

      const current = await client.query<{
        weekly_usage_observed_at: Date;
        weekly_usage_used_basis_points: number;
      }>(`
        SELECT weekly_usage_observed_at, weekly_usage_used_basis_points
        FROM model_provider_accounts WHERE id = '${account.id}'
      `);
      expect(current.rows[0]?.weekly_usage_used_basis_points).toBe(4213);
      expect(current.rows[0]?.weekly_usage_observed_at.toISOString()).toBe(
        "2026-08-16T12:01:00.000Z",
      );

      await expect(
        persistProviderQuotaSnapshot(
          repository,
          {
            ownerId: LOCAL_USER_ID,
            providerId: provider.id,
            accountId: account.id,
            accountPlanType: "observed-plan",
            workerId: "worker-telemetry",
            trigger: "turn-completed",
            chatId: "chat-one",
            turnId: "turn-one",
            executionAttemptId: "attempt-one",
          },
          {
            snapshotId: "snapshot-all-windows",
            observedAt: "2026-08-16T12:02:00.000Z",
            workerVersion: "1.1.520",
            codexVersion: "0.147.0",
            windows: [
              {
                limitId: "codex",
                limitName: "Codex",
                planType: "observed-plan",
                reachedType: null,
                windowKind: "primary",
                usedPercent: 7,
                windowDurationMinutes: 300,
                resetsAt: 1_787_000_000,
                isWeeklyProjection: false,
                rawPayload: { source: "test" },
              },
              {
                limitId: "codex",
                limitName: "Codex",
                planType: "observed-plan",
                reachedType: null,
                windowKind: "secondary",
                usedPercent: 44,
                windowDurationMinutes: 10_080,
                resetsAt: 1_787_000_000,
                isWeeklyProjection: true,
                rawPayload: { source: "test" },
              },
            ],
          },
        ),
      ).resolves.toBe(2);
      const captured = await client.query<{
        observation_trigger: string;
        window_kind: string;
      }>(`
        SELECT observation_trigger, window_kind
        FROM provider_quota_observations
        WHERE observation_batch_key = 'snapshot-all-windows'
        ORDER BY window_kind
      `);
      expect(captured.rows).toEqual([
        { observation_trigger: "turn-completed", window_kind: "primary" },
        { observation_trigger: "turn-completed", window_kind: "secondary" },
      ]);

      await expect(
        repository.deleteModelProvider(LOCAL_USER_ID, provider.id),
      ).resolves.toBe(true);
      const retained = await client.query<{ count: number }>(`
        SELECT count(*)::integer AS count FROM provider_quota_observations
      `);
      expect(retained.rows[0]?.count).toBe(5);
    } finally {
      await client.close();
    }
  });
});
