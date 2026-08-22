import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../drizzle/0142_wealthy_iron_man.sql", import.meta.url),
);

describe("project replica placement migration", () => {
  it("backfills managed ownership and enforces placement shapes", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE workers (
          id text PRIMARY KEY,
          project_replica_capabilities jsonb NOT NULL DEFAULT
            '{"provision":false,"synchronize":false,"remove":false,"exactRevision":false}'::jsonb
        );
        CREATE TABLE project_replica_jobs (id text PRIMARY KEY);
        CREATE TABLE project_sources (id text PRIMARY KEY);

        INSERT INTO workers (id) VALUES ('legacy-worker');
        INSERT INTO project_replica_jobs (id) VALUES ('legacy-job');
        INSERT INTO project_sources (id) VALUES ('legacy-source');
      `);
      await database.exec(await readFile(migrationPath, "utf8"));

      const legacy = await database.query<{
        ownership_kind: string;
        placement_mode: string;
      }>(`
        SELECT placement_mode, ownership_kind
        FROM project_sources
        WHERE id = 'legacy-source'
      `);
      expect(legacy.rows).toEqual([
        { placement_mode: "managed", ownership_kind: "cantrip" },
      ]);

      await database.exec(`
        INSERT INTO workers (id) VALUES ('new-worker');
        INSERT INTO project_replica_jobs (
          id, placement_mode, placement_path,
          resolved_materialization, resolved_ownership
        ) VALUES (
          'direct-job', 'direct', 'ctrr_${"p".repeat(43)}', 'attached', 'user'
        );
        INSERT INTO project_sources (
          id, placement_mode, ownership_kind, requested_path
        ) VALUES (
          'direct-source', 'direct', 'user', 'ctrr_${"p".repeat(43)}'
        );
      `);

      const workers = await database.query<{
        id: string;
        project_replica_capabilities: Record<string, boolean>;
      }>(`
        SELECT id, project_replica_capabilities FROM workers ORDER BY id
      `);
      expect(workers.rows).toEqual([
        {
          id: "legacy-worker",
          project_replica_capabilities: {
            provision: false,
            synchronize: false,
            remove: false,
            exactRevision: false,
            directPlacement: false,
            managedLinkPlacement: false,
            attachExisting: false,
            recursiveParentCreation: false,
          },
        },
        {
          id: "new-worker",
          project_replica_capabilities: {
            provision: false,
            synchronize: false,
            remove: false,
            exactRevision: false,
            directPlacement: false,
            managedLinkPlacement: false,
            attachExisting: false,
            recursiveParentCreation: false,
          },
        },
      ]);

      await expect(
        database.exec(`
          INSERT INTO project_replica_jobs (id, placement_mode)
          VALUES ('missing-custom-path', 'direct');
        `),
      ).rejects.toThrow();
      await expect(
        database.exec(`
          INSERT INTO project_sources (
            id, placement_mode, ownership_kind, requested_path
          ) VALUES (
            'missing-link', 'managed-link', 'cantrip',
            'ctrr_${"a".repeat(43)}'
          );
        `),
      ).rejects.toThrow();
    } finally {
      await database.close();
    }
  });
});
