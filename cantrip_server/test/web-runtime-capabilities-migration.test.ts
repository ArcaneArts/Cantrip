import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migration = fileURLToPath(
  new URL(
    "../drizzle/0171_worker_web_runtime_capabilities.sql",
    import.meta.url,
  ),
);

describe("worker web runtime capability migration", () => {
  it("backfills existing workers with an unavailable rolling-compatible inventory", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE workers (id text PRIMARY KEY);
        INSERT INTO workers (id) VALUES ('worker-one');
      `);
      await database.exec(await readFile(migration, "utf8"));
      const result = await database.query<{
        web_runtime_capabilities: unknown;
      }>(`
        SELECT web_runtime_capabilities FROM workers WHERE id = 'worker-one'
      `);
      expect(result.rows[0]?.web_runtime_capabilities).toEqual({
        schemaVersion: 1,
        search: {
          component: "searxng",
          supported: false,
          state: "unsupported",
          installedVersion: null,
          previousVersion: null,
          latestVersion: null,
          lastCheckedAt: null,
          progress: null,
          failure: null,
        },
        browser: {
          component: "playwright",
          supported: false,
          state: "unsupported",
          installedVersion: null,
          previousVersion: null,
          latestVersion: null,
          lastCheckedAt: null,
          progress: null,
          failure: null,
        },
        staticReading: false,
      });
    } finally {
      await database.close();
    }
  });
});
