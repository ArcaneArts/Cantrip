import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("token usage attribution migration", () => {
  it("marks historical transformed counters without pretending they were raw", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const attributionIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('ADD COLUMN "usage_semantics"'),
        ),
      );
      expect(attributionIndex).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, attributionIndex)) {
        for (const statement of migration.sql) await client.exec(statement);
      }
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO token_usage_records (
          id, owner_id, source_key, model_name, provider_name,
          provider_model_name, input_tokens, output_tokens,
          cached_input_tokens, reasoning_output_tokens, created_at, updated_at
        ) VALUES (
          'usage-1', 'owner-1', 'legacy-turn', 'Model', 'Provider',
          'provider-model', 100, 60, 20, 10,
          '2026-08-01T12:00:00Z', '2026-08-01T12:01:00Z'
        );
      `);
      for (const statement of migrations[attributionIndex]!.sql) {
        await client.exec(statement);
      }

      const result = await client.query<{
        attempt_kind: string;
        attempt_status: string;
        usage_semantics: string;
        reported_total_tokens: number | null;
        started_at: Date;
        completed_at: Date;
        finalized_at: Date;
      }>(`
        SELECT attempt_kind, attempt_status, usage_semantics,
               reported_total_tokens, started_at, completed_at, finalized_at
        FROM token_usage_records WHERE id = 'usage-1'
      `);
      expect(result.rows[0]).toMatchObject({
        attempt_kind: "legacy-aggregate",
        attempt_status: "completed",
        usage_semantics: "legacy-derived-v1",
        reported_total_tokens: null,
      });
      expect(result.rows[0]!.started_at.toISOString()).toBe(
        "2026-08-01T12:00:00.000Z",
      );
      expect(result.rows[0]!.completed_at.toISOString()).toBe(
        "2026-08-01T12:01:00.000Z",
      );
      expect(result.rows[0]!.finalized_at.toISOString()).toBe(
        "2026-08-01T12:01:00.000Z",
      );
    } finally {
      await client.close();
    }
  });
});
