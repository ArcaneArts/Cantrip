import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import {
  StandaloneChatRootJobConflictError,
  StandaloneChatRootJobRepository,
} from "../src/db/standalone-chat-root-jobs.js";
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

describe("standalone Chat lifecycle migration", () => {
  it("allows durable pauses and purges only currently expired archives", async () => {
    const database = new PGlite();
    const chatId = "22222222-2222-4222-8222-222222222222";
    const rootId = "33333333-3333-4333-8333-333333333333";
    try {
      await applyMigrations(database, 0, 169);
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('lifecycle-owner', 'anonymous', 'Lifecycle Owner');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'lifecycle-worker', 'lifecycle-owner', 'Lifecycle Worker', 'linux',
          'x64', now(), now()
        );

        BEGIN;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO chats (
          id, owner_id, context_kind, project_id, protected_label, experience,
          active_worker_id, active_worktree_id, active_scratch_root_id,
          worktree_mode
        ) VALUES (
          '${chatId}', 'lifecycle-owner', 'standalone', NULL, '{}', 'agent',
          'lifecycle-worker', NULL, '${rootId}', NULL
        );
        INSERT INTO standalone_chat_roots (
          id, chat_id, owner_id, worker_id, protected_path_handle, status
        ) VALUES (
          '${rootId}', '${chatId}', 'lifecycle-owner', 'lifecycle-worker',
          'ctrr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ready'
        );
        COMMIT;
      `);

      await expect(
        database.exec(`
          UPDATE chats SET automation_paused = true WHERE id = '${chatId}';
        `),
      ).rejects.toThrow();

      await applyMigrations(database, 170, 170);
      await database.exec(`
        UPDATE chats SET automation_paused = true WHERE id = '${chatId}';
      `);

      const paused = await database.query<{ automation_paused: boolean }>(`
        SELECT automation_paused FROM chats WHERE id = '${chatId}'
      `);
      expect(paused.rows[0]?.automation_paused).toBe(true);

      await database.exec(`
        UPDATE chats SET archived_at = now() WHERE id = '${chatId}';
        UPDATE standalone_chat_roots
        SET archived_at = now(), archive_expires_at = now() + interval '1 day'
        WHERE id = '${rootId}';
      `);
      const repository = new StandaloneChatRootJobRepository(
        drizzle(database, { schema }),
      );
      await expect(
        repository.purgeExpiredArchivedChats("lifecycle-owner", new Date()),
      ).resolves.toEqual([]);
      await expect(
        repository.createDeletionTombstoneAndPurge(
          {
            id: "44444444-4444-4444-8444-444444444444",
            ownerId: "lifecycle-owner",
            rootId,
            chatId,
            workerId: "lifecycle-worker",
          },
          { expiredBy: new Date() },
        ),
      ).rejects.toBeInstanceOf(StandaloneChatRootJobConflictError);

      await database.exec(`
        UPDATE standalone_chat_roots
        SET archived_at = now() - interval '2 seconds',
            archive_expires_at = now() - interval '1 second'
        WHERE id = '${rootId}';
      `);
      const changes = await repository.purgeExpiredArchivedChatsForAllOwners(
        new Date(),
      );
      expect(changes).toEqual([
        {
          ownerId: "lifecycle-owner",
          job: expect.objectContaining({
            chatId,
            rootId,
            workerId: "lifecycle-worker",
            kind: "delete",
            state: "queued",
          }),
        },
      ]);
      const rows = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM chats WHERE id = '${chatId}'
      `);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await database.close();
    }
  });
});
