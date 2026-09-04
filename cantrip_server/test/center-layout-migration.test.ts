import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function migrationFiles() {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

async function applyMigrations(
  database: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
  for (const migrationFile of await migrationFiles()) {
    const index = Number.parseInt(migrationFile.slice(0, 4), 10);
    if (index < firstIndex || index > lastIndex) continue;
    await database.exec(
      await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
    );
  }
}

async function centerBackfillSql() {
  const migrationFile = (await migrationFiles()).find((name) =>
    name.startsWith("0195_"),
  );
  expect(migrationFile).toBeDefined();
  const statements = (
    await readFile(`${migrationsDirectory}/${migrationFile!}`, "utf8")
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  expect(statements).toHaveLength(2);
  return statements[1]!;
}

type CenterNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: "horizontal" | "vertical";
      fraction: number;
      first: CenterNode;
      second: CenterNode;
    };

function topology(node: CenterNode | null): {
  depth: number;
  paneIds: string[];
  splitIds: string[];
} {
  if (node === null) return { depth: 0, paneIds: [], splitIds: [] };
  if (node.kind === "pane") {
    return { depth: 1, paneIds: [node.paneId], splitIds: [] };
  }
  const first = topology(node.first);
  const second = topology(node.second);
  return {
    depth: Math.max(first.depth, second.depth) + 1,
    paneIds: [...first.paneIds, ...second.paneIds],
    splitIds: [node.id, ...first.splitIds, ...second.splitIds],
  };
}

describe("center layout migration", () => {
  it("backfills zero, one, and many center panes as a stable balanced tree", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 0, 194);
      await database.exec(`
        INSERT INTO users (
          id, kind, role, status, display_name, email, normalized_email,
          password_hash
        ) VALUES (
          'owner-center', 'account', 'owner', 'active', 'Owner',
          'center@example.com', 'center@example.com', 'auth-hash'
        );

        INSERT INTO projects (
          id, owner_id, protected_label, position, tab_layout_revision,
          github_repository_blind_index
        ) VALUES
          ('project-zero', 'owner-center', '{}'::jsonb, 0, 7, 'zero-blind-index'),
          ('project-one', 'owner-center', '{}'::jsonb, 1, 11, 'one-blind-index'),
          ('project-many', 'owner-center', '{}'::jsonb, 2, 19, 'many-blind-index');

        INSERT INTO tab_groups (
          id, project_id, region, position, anchor_tab_key
        ) VALUES (
          'one-pane', 'project-one', 'center', 9, 'chat:one'
        );

        INSERT INTO tab_groups (
          id, project_id, region, position, anchor_tab_key
        )
        SELECT
          'many-pane-' || LPAD(number::text, 2, '0'),
          'project-many',
          'center',
          number * 3,
          'chat:many-' || number
        FROM generate_series(1, 40) AS number;
      `);

      await applyMigrations(database, 195, 195);
      const results = await database.query<{
        center_layout_root: CenterNode | null;
        id: string;
        tab_layout_revision: number;
      }>(`
        SELECT id, center_layout_root, tab_layout_revision
        FROM projects
        WHERE id LIKE 'project-%'
        ORDER BY id
      `);
      const byId = new Map(results.rows.map((row) => [row.id, row]));
      expect(byId.get("project-zero")).toMatchObject({
        center_layout_root: null,
        tab_layout_revision: 7,
      });
      expect(byId.get("project-one")).toMatchObject({
        center_layout_root: { kind: "pane", paneId: "one-pane" },
        tab_layout_revision: 11,
      });

      const manyRoot = byId.get("project-many")!.center_layout_root;
      const manyTopology = topology(manyRoot);
      expect(manyTopology.paneIds).toEqual(
        Array.from(
          { length: 40 },
          (_, index) => `many-pane-${String(index + 1).padStart(2, "0")}`,
        ),
      );
      expect(manyTopology.depth).toBeLessThanOrEqual(7);
      expect(new Set(manyTopology.splitIds).size).toBe(39);
      expect(
        manyTopology.splitIds.every((id) =>
          id.startsWith("migration:center:project-many:"),
        ),
      ).toBe(true);
      expect(byId.get("project-many")!.tab_layout_revision).toBe(19);

      const beforeReplay = JSON.stringify(results.rows);
      await database.exec(await centerBackfillSql());
      const afterReplay = await database.query(`
        SELECT id, center_layout_root, tab_layout_revision
        FROM projects
        WHERE id LIKE 'project-%'
        ORDER BY id
      `);
      expect(JSON.stringify(afterReplay.rows)).toBe(beforeReplay);

      await database.exec(`
        UPDATE projects
        SET center_layout_root = NULL
        WHERE id = 'project-many'
      `);
      await database.exec(await centerBackfillSql());
      const rebuilt = await database.query<{ center_layout_root: CenterNode }>(`
        SELECT center_layout_root
        FROM projects
        WHERE id = 'project-many'
      `);
      expect(rebuilt.rows[0]!.center_layout_root).toEqual(manyRoot);
    } finally {
      await database.close();
    }
  });
});
