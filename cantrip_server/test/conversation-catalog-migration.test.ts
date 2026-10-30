import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("backfills usage without changing archive deadlines and scopes retry receipts", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      CREATE TABLE users (id text PRIMARY KEY);
      CREATE TABLE chats (
        id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id),
        project_id text, context_kind text, experience text,
        created_at timestamptz NOT NULL, updated_at timestamptz,
        archived_at timestamptz, UNIQUE(id, owner_id)
      );
      INSERT INTO users VALUES ('owner'), ('other');
      INSERT INTO chats VALUES
        ('active', 'owner', 'project', 'project', 'agent', '2026-01-01Z', '2026-02-01Z', NULL),
        ('archived', 'owner', 'project', 'project', 'agent', '2026-01-01Z', NULL, '2026-03-01Z');
    `);
    await database.exec(
      await readFile(
        new URL("../drizzle/0235_conversation_catalog.sql", import.meta.url),
        "utf8",
      ),
    );
    const rows = await database.query<{
      id: string;
      matches: boolean;
      archived_at: Date | null;
    }>(
      `SELECT id, last_used_at = COALESCE(updated_at, created_at) AS matches, archived_at FROM chats ORDER BY id`,
    );
    expect(rows.rows.map(({ matches }) => matches)).toEqual([true, true]);
    expect(rows.rows[1]?.archived_at?.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    await database.exec(
      `INSERT INTO conversation_usage_clients VALUES ('owner', 'client', 2), ('other', 'client', 0)`,
    );
    await expect(
      database.exec(
        `INSERT INTO conversation_usage_receipts VALUES ('other', 'client', 'operation', 'active', 1, now(), true)`,
      ),
    ).rejects.toThrow();
    await database.exec(
      `INSERT INTO conversation_usage_receipts VALUES ('owner', 'client', 'operation', 'active', 2, now(), true)`,
    );
    await database.exec(`DELETE FROM chats WHERE id = 'active'`);
    expect(
      (await database.query(`SELECT * FROM conversation_usage_receipts`)).rows,
    ).toHaveLength(0);
  } finally {
    await database.close();
  }
});
