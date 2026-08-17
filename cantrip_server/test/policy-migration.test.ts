import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";
import { getPackagedPolicyTemplate } from "../src/policies/templates.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function applyMigrationRange(
  client: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
  const files = (await readdir(migrationsFolder))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .filter((name) => {
      const index = Number.parseInt(name.slice(0, 4), 10);
      return index >= firstIndex && index <= lastIndex;
    });
  for (const file of files) {
    await client.exec(await readFile(`${migrationsFolder}/${file}`, "utf8"));
  }
}

describe("policy domain migration", () => {
  it("gives every existing owner the default policy once", async () => {
    const client = new PGlite();
    try {
      await applyMigrationRange(client, 0, 90);
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES
          ('existing-1', 'anonymous', 'Existing One'),
          ('existing-2', 'anonymous', 'Existing Two');
      `);
      await applyMigrationRange(client, 91, 91);

      const policies = await client.query<{
        body_markdown: string;
        enabled: boolean;
        key: string;
        mandatory: boolean;
        owner_id: string;
        summary: string;
        template_key: string | null;
      }>(`
        SELECT owner_id, key, summary, body_markdown, enabled, mandatory,
               template_key
        FROM policies
        ORDER BY owner_id
      `);
      const template = getPackagedPolicyTemplate("manual-change-protocol")!;
      expect(policies.rows).toEqual(
        ["existing-1", "existing-2"].map((ownerId) => ({
          owner_id: ownerId,
          key: "manual-change-protocol",
          summary: template.summary,
          body_markdown: template.bodyMarkdown,
          enabled: true,
          mandatory: true,
          template_key: "manual-change-protocol",
        })),
      );
      const state = await client.query<{
        bootstrap_version: number;
        count: number;
      }>(`
        SELECT bootstrap_version, count(*)::int AS count
        FROM policy_owner_states
        GROUP BY bootstrap_version
      `);
      expect(state.rows).toEqual([{ bootstrap_version: 1, count: 2 }]);
    } finally {
      await client.close();
    }
  });

  it("enforces document bounds and cascades policy assignments", async () => {
    const client = new PGlite();
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder });
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');

        INSERT INTO projects (id, owner_id, name)
        VALUES ('project-1', 'owner-1', 'Cantrip');

        INSERT INTO project_workspaces (
          id, owner_id, name, position, is_default
        ) VALUES ('workspace-1', 'owner-1', 'Default', 0, true);

        INSERT INTO policy_owner_states (
          owner_id, bootstrap_version, collection_version
        ) VALUES ('owner-1', 1, 1);

        INSERT INTO policies (
          id, owner_id, key, name, summary, body_markdown, position,
          row_version
        ) VALUES (
          'policy-1', 'owner-1', 'review-policy', 'Review policy',
          'Review changes.', '# Review', 0, 1
        );

        INSERT INTO project_policy_assignments (policy_id, project_id)
        VALUES ('policy-1', 'project-1');

        INSERT INTO workspace_policy_assignments (policy_id, workspace_id)
        VALUES ('policy-1', 'workspace-1');
      `);

      await expect(
        client.exec(`
          INSERT INTO policies (
            id, owner_id, key, name, summary, body_markdown
          ) VALUES (
            'invalid-policy', 'owner-1', 'Invalid--Key', 'Invalid',
            'Invalid policy.', '# Invalid'
          );
        `),
      ).rejects.toThrow();
      await expect(
        client.exec(`
          UPDATE policies SET row_version = 0 WHERE id = 'policy-1';
        `),
      ).rejects.toThrow();

      await client.exec(`DELETE FROM policies WHERE id = 'policy-1';`);
      const assignments = await client.query<{ count: number }>(`
        SELECT (
          (SELECT count(*) FROM project_policy_assignments) +
          (SELECT count(*) FROM workspace_policy_assignments)
        )::int AS count
      `);
      expect(assignments.rows[0]?.count).toBe(0);

      await client.exec(`DELETE FROM users WHERE id = 'owner-1';`);
      const ownerState = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM policy_owner_states
      `);
      expect(ownerState.rows[0]?.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
