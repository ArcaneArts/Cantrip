import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { StandaloneChatRootJobRepository } from "../src/db/standalone-chat-root-jobs.js";
import * as schema from "../src/db/schema.js";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function applyMigrations(
  database: PGlite,
  firstIndex: number,
  lastIndex: number,
): Promise<void> {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .filter((name) => {
      const index = Number.parseInt(name.slice(0, 4), 10);
      return index >= firstIndex && index <= lastIndex;
    });
  for (const migrationFile of migrationFiles) {
    await database.exec(
      await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
    );
  }
}

describe("standalone Chat worker scratch migration", () => {
  it("defaults capability off and keeps cleanup tombstones after Chat deletion", async () => {
    const database = new PGlite();
    const chatId = "22222222-2222-4222-8222-222222222222";
    const rootId = "33333333-3333-4333-8333-333333333333";
    const provisionJobId = "44444444-4444-4444-8444-444444444444";
    const deleteJobId = "55555555-5555-4555-8555-555555555555";
    try {
      await applyMigrations(database, 0, 166);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('scratch-owner', 'anonymous', 'Scratch Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'scratch-worker', 'scratch-owner', 'Scratch Worker', 'linux', 'x64',
          now(), now()
        );

        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label, experience,
          active_worker_id, active_worktree_id, active_scratch_root_id,
          worktree_mode
        ) VALUES (
          '${chatId}', 'scratch-owner', 'standalone', NULL, '{}', 'agent',
          'scratch-worker', NULL, '${rootId}', NULL
        );
        INSERT INTO standalone_chat_roots (
          id, chat_id, owner_id, worker_id, protected_path_handle
        ) VALUES (
          '${rootId}', '${chatId}', 'scratch-owner', 'scratch-worker',
          'pre-capability-placeholder'
        );
        COMMIT;
      `);

      await applyMigrations(database, 167, 167);

      const workers = await database.query<{
        standalone_chat_capabilities: {
          scratch: { provision: boolean; routingHandles: boolean };
        };
      }>(`
        SELECT standalone_chat_capabilities FROM workers
        WHERE id = 'scratch-worker'
      `);
      expect(
        workers.rows[0]?.standalone_chat_capabilities.scratch,
      ).toMatchObject({ provision: false, routingHandles: false });

      await expect(
        database.exec(`
          UPDATE standalone_chat_roots SET status = 'ready'
          WHERE id = '${rootId}';
        `),
      ).rejects.toThrow();
      await database.exec(`
        UPDATE standalone_chat_roots
        SET status = 'ready',
            protected_path_handle = 'ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        WHERE id = '${rootId}';

        INSERT INTO standalone_chat_root_jobs (
          id, owner_id, root_id, chat_id, worker_id, kind, state
        ) VALUES
          ('${provisionJobId}', 'scratch-owner', '${rootId}', '${chatId}',
           'scratch-worker', 'provision', 'succeeded'),
          ('${deleteJobId}', 'scratch-owner', '${rootId}', '${chatId}',
           'scratch-worker', 'delete', 'queued');

        UPDATE standalone_chat_roots
        SET status = 'deleting', deletion_job_id = '${deleteJobId}'
        WHERE id = '${rootId}';

        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        DELETE FROM chats WHERE id = '${chatId}';
        COMMIT;
      `);

      const jobs = await database.query<{ id: string; kind: string }>(`
        SELECT id, kind FROM standalone_chat_root_jobs
        WHERE root_id = '${rootId}' ORDER BY kind
      `);
      expect(jobs.rows).toEqual([
        { id: deleteJobId, kind: "delete" },
        { id: provisionJobId, kind: "provision" },
      ]);
      const roots = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM standalone_chat_roots
        WHERE id = '${rootId}'
      `);
      expect(roots.rows[0]?.count).toBe(0);

      const repository = new StandaloneChatRootJobRepository(
        drizzle(database, { schema }),
      );
      const claimed = await repository.claimNext();
      expect(claimed?.job).toMatchObject({
        id: deleteJobId,
        kind: "delete",
        attempt: 1,
        state: "running",
      });
      if (!claimed) throw new Error("Cleanup tombstone was not claimable.");
      await expect(
        repository.completeDelete(deleteJobId, claimed.commandId, {
          jobId: deleteJobId,
          attempt: claimed.job.attempt,
          rootId,
          chatId,
          deleted: true,
        }),
      ).resolves.toMatchObject({ state: "succeeded" });

      const racingChatId = "66666666-6666-4666-8666-666666666666";
      const racingRootId = "77777777-7777-4777-8777-777777777777";
      const racingProvisionId = "88888888-8888-4888-8888-888888888888";
      const racingDeleteId = "99999999-9999-4999-8999-999999999999";
      await database.exec(`
        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label, experience,
          active_worker_id, active_worktree_id, active_scratch_root_id,
          worktree_mode
        ) VALUES (
          '${racingChatId}', 'scratch-owner', 'standalone', NULL, '{}', 'agent',
          'scratch-worker', NULL, '${racingRootId}', NULL
        );
        INSERT INTO standalone_chat_roots (
          id, chat_id, owner_id, worker_id, status
        ) VALUES (
          '${racingRootId}', '${racingChatId}', 'scratch-owner',
          'scratch-worker', 'deleting'
        );
        INSERT INTO standalone_chat_root_jobs (
          id, owner_id, root_id, chat_id, worker_id, kind, state, attempt,
          command_id
        ) VALUES
          ('${racingProvisionId}', 'scratch-owner', '${racingRootId}',
           '${racingChatId}', 'scratch-worker', 'provision', 'running', 1,
           'interrupted-provision'),
          ('${racingDeleteId}', 'scratch-owner', '${racingRootId}',
           '${racingChatId}', 'scratch-worker', 'delete', 'queued', 0, NULL);
        UPDATE standalone_chat_roots
        SET deletion_job_id = '${racingDeleteId}'
        WHERE id = '${racingRootId}';
        DELETE FROM chats WHERE id = '${racingChatId}';
        COMMIT;
      `);

      await expect(repository.claimNext()).resolves.toBeNull();
      await expect(repository.recoverInterrupted(true)).resolves.toBe(1);
      const recoveredCleanup = await repository.claimNext();
      expect(recoveredCleanup?.job).toMatchObject({
        id: racingDeleteId,
        kind: "delete",
        state: "running",
      });
      await expect(
        repository.get("scratch-owner", racingRootId, "provision"),
      ).resolves.toMatchObject({
        id: racingProvisionId,
        state: "failed",
        error: { code: "root-conflict", retryable: false },
      });
    } finally {
      await database.close();
    }
  });
});
