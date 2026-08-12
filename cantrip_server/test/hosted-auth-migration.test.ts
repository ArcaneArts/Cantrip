import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function applyMigrations(
  database: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
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

describe("hosted authentication foundation migration", () => {
  it("backfills identities and stores only hashed session and worker material", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 46);
      await database.exec(`
        INSERT INTO users (id, kind, display_name, email, password_hash)
        VALUES
          ('local-user', 'anonymous', 'Local User', NULL, NULL),
          ('account-user', 'account', 'Account User', 'User@Example.com', 'argon2-placeholder');

        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', 'account-user', 'Desktop', 'darwin', 'arm64', now(), now()
        );
      `);

      await applyMigrations(database, 47, 47);

      const identities = await database.query<{
        id: string;
        normalized_email: string | null;
        role: string;
        status: string;
      }>(`
        SELECT id, normalized_email, role, status
        FROM users
        ORDER BY id
      `);
      expect(identities.rows).toEqual([
        {
          id: "account-user",
          normalized_email: "user@example.com",
          role: "member",
          status: "active",
        },
        {
          id: "local-user",
          normalized_email: null,
          role: "owner",
          status: "active",
        },
      ]);

      await database.exec(`
        INSERT INTO user_sessions (
          id, user_id, token_hash, auth_method, expires_at
        ) VALUES (
          'session-1', 'account-user', 'session-sha256', 'account-password', now() + interval '1 day'
        );

        INSERT INTO worker_enrollment_codes (
          id, owner_id, created_by_session_id, code_hash, expires_at
        ) VALUES (
          'enrollment-1', 'account-user', 'session-1', 'enrollment-sha256', now() + interval '10 minutes'
        );

        INSERT INTO worker_credentials (
          id, owner_id, worker_id, secret_hash, scopes
        ) VALUES (
          'credential-1', 'account-user', 'worker-1', 'worker-sha256', '["connect","heartbeat"]'::jsonb
        );
      `);

      const secretColumns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name IN (
          'user_sessions',
          'worker_enrollment_codes',
          'worker_credentials'
        )
          AND column_name IN ('token', 'code', 'secret')
      `);
      expect(secretColumns.rows).toEqual([]);

      await expect(
        database.exec(`
          INSERT INTO users (
            id, kind, role, status, display_name, email, normalized_email
          ) VALUES (
            'duplicate-account', 'account', 'member', 'active', 'Duplicate',
            'USER@example.com', 'user@example.com'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
