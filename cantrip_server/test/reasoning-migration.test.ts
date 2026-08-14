import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("per-turn reasoning migration", () => {
  it("preserves legacy defaults as chat, prompt, message, and automation snapshots", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const reasoningMigrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('ADD COLUMN "applied_reasoning_effort"'),
        ),
      );
      const reasoningMigration = migrations[reasoningMigrationIndex];
      expect(reasoningMigration).toBeDefined();
      for (const migration of migrations.slice(0, reasoningMigrationIndex)) {
        for (const statement of migration.sql) await client.exec(statement);
      }

      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'owner-1', 'Worker', 'darwin', 'arm64', now(), now()
        );

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-1', 'owner-1', 'Cantrip');

        INSERT INTO project_sources (
          id, project_id, worker_id, absolute_path, display_path
        ) VALUES (
          'source-1', 'project-1', 'worker-1', '/repo', 'repo'
        );

        INSERT INTO project_worktrees (
          id, project_source_id, worker_id, name, absolute_path, display_path,
          is_primary, is_default, origin, lifecycle_state, branch
        ) VALUES (
          'worktree-1', 'source-1', 'worker-1', 'Primary', '/repo', 'repo',
          true, true, 'cantrip', 'ready', 'main'
        );

        INSERT INTO model_providers (id, owner_id, name, kind, base_url)
        VALUES (
          'provider-1', 'owner-1', 'OpenRouter', 'openai-compatible',
          'https://openrouter.ai/api/v1'
        );

        INSERT INTO model_profiles (id, owner_id, name, reasoning_effort)
        VALUES ('model-1', 'owner-1', 'GPT Test', 'medium');

        INSERT INTO model_routes (
          id, model_id, provider_id, model_name, position, reasoning_effort
        ) VALUES (
          'route-1', 'model-1', 'provider-1', 'openai/gpt-test', 0, 'high'
        );

        INSERT INTO chats (
          id, project_id, title, active_worker_id, active_worktree_id, model_id
        ) VALUES (
          'chat-1', 'project-1', 'Legacy chat', 'worker-1', 'worktree-1', 'model-1'
        );

        INSERT INTO chat_messages (
          id, chat_id, worktree_id, role, content, model_id, model_route_id,
          provider_id
        ) VALUES (
          'message-1', 'chat-1', 'worktree-1', 'user',
          '[{"type":"text","text":"Legacy turn"}]'::jsonb,
          'model-1', 'route-1', 'provider-1'
        );

        INSERT INTO queued_prompts (
          id, chat_id, text, model_id, idempotency_key
        ) VALUES (
          'prompt-1', 'chat-1', 'Queued turn', 'model-1', 'prompt-1'
        );

        INSERT INTO project_automations (
          id, owner_id, project_id, chat_id, name, prompt, schedule
        ) VALUES (
          'automation-1', 'owner-1', 'project-1', 'chat-1', 'Daily', 'Run it',
          '{"kind":"interval","every":1,"unit":"days"}'::jsonb
        );

        INSERT INTO project_automation_runs (
          id, automation_id, owner_id, project_id, chat_id, worker_id,
          automation_revision, scheduled_for, dispatch_instance_id, lease_token,
          lease_expires_at
        ) VALUES (
          'run-1', 'automation-1', 'owner-1', 'project-1', 'chat-1', 'worker-1',
          1, now(), 'server-1', 'lease-1', now() + interval '1 minute'
        );
      `);

      for (const statement of reasoningMigration!.sql) {
        await client.exec(statement);
      }

      const snapshots = await client.query<{
        automation_effort: string | null;
        chat_effort: string | null;
        message_applied_effort: string | null;
        message_effort: string | null;
        prompt_effort: string | null;
      }>(`
        SELECT
          (SELECT reasoning_effort FROM chats WHERE id = 'chat-1') AS chat_effort,
          (SELECT reasoning_effort FROM queued_prompts WHERE id = 'prompt-1') AS prompt_effort,
          (SELECT reasoning_effort FROM chat_messages WHERE id = 'message-1') AS message_effort,
          (SELECT applied_reasoning_effort FROM chat_messages WHERE id = 'message-1') AS message_applied_effort,
          (SELECT reasoning_effort FROM project_automation_runs WHERE id = 'run-1') AS automation_effort
      `);
      expect(snapshots.rows).toEqual([
        {
          chat_effort: "medium",
          prompt_effort: "medium",
          message_effort: "high",
          message_applied_effort: "high",
          automation_effort: "medium",
        },
      ]);

      const cleanupMigrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes(
            'ALTER TABLE "model_profiles" DROP COLUMN "reasoning_effort"',
          ),
        ),
      );
      expect(cleanupMigrationIndex).toBeGreaterThan(reasoningMigrationIndex);
      for (const migration of migrations.slice(
        reasoningMigrationIndex + 1,
        cleanupMigrationIndex + 1,
      )) {
        for (const statement of migration.sql) await client.exec(statement);
      }

      const preserved = await client.query<{
        chat_effort: string | null;
        message_effort: string | null;
        prompt_effort: string | null;
      }>(`
        SELECT
          (SELECT reasoning_effort FROM chats WHERE id = 'chat-1') AS chat_effort,
          (SELECT reasoning_effort FROM queued_prompts WHERE id = 'prompt-1') AS prompt_effort,
          (SELECT reasoning_effort FROM chat_messages WHERE id = 'message-1') AS message_effort
      `);
      expect(preserved.rows).toEqual([
        {
          chat_effort: "medium",
          prompt_effort: "medium",
          message_effort: "high",
        },
      ]);
      const obsoleteColumns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name IN ('model_profiles', 'model_routes')
          AND column_name = 'reasoning_effort'
      `);
      expect(obsoleteColumns.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
