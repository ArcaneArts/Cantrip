import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { ProjectTabLayoutRepository } from "../src/db/tab-layouts.js";

it.each([true, false])(
  "retires Overview and repairs panes with surviving members=%s",
  async (hasSurvivor) => {
    const client = new PGlite();
    try {
      const directory = new URL("../drizzle/", import.meta.url);
      for (const name of (await readdir(directory))
        .filter((name) => /^\d{4}.*\.sql$/.test(name))
        .sort()) {
        await client.exec(await readFile(new URL(name, directory), "utf8"));
      }
      await client.exec(`
      INSERT INTO users (id, kind, role, status, display_name, email, normalized_email, password_hash)
      VALUES ('owner-1','account','owner','active','Owner','owner@example.com','owner@example.com','hash');
      INSERT INTO projects (id, owner_id, protected_label, position, tab_layout_revision, github_repository_blind_index, center_layout_root)
      VALUES ('project-1','owner-1','{}',0,41,'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB','{"kind":"pane","paneId":"pane-1"}');
      INSERT INTO project_builtin_surface_states (project_id, definition_id) VALUES ('project-1','project.overview'),('project-1','project.tasks');
      INSERT INTO tab_groups (id,project_id,position,region,anchor_tab_key) VALUES ('pane-1','project-1',0,'center','builtin:project-1:project.overview');
      INSERT INTO tab_group_members (tab_key,group_id,project_id,tab_kind,tab_id,position) VALUES
      ('builtin:project-1:project.overview','pane-1','project-1','builtin','project.overview',0),
      ('builtin:project-1:project.tasks','pane-1','project-1','builtin','project.tasks',1);
    `);
      if (!hasSurvivor)
        await client.exec(
          "DELETE FROM tab_group_members WHERE tab_id = 'project.tasks'",
        );
      const repository = new ProjectTabLayoutRepository(
        drizzle(client, { schema }),
      );
      const layout = await repository.get("owner-1", "project-1");
      if (hasSurvivor) {
        expect(layout?.panes[0]?.members.map((member) => member.tabId)).toEqual(
          ["project.tasks"],
        );
        expect(layout?.panes[0]?.anchorTabKey).toBe(
          "builtin:project-1:project.tasks",
        );
      } else {
        expect(layout?.panes).toEqual([]);
        expect(layout?.centerRoot).toBeNull();
        expect(
          (await client.query("SELECT * FROM tab_groups")).rows,
        ).toHaveLength(0);
      }
      expect(layout?.revision).toBe(42);
      expect((await repository.get("owner-1", "project-1"))?.revision).toBe(
        layout?.revision,
      );
      expect(
        (
          await client.query(
            "SELECT * FROM tab_group_members WHERE tab_id = 'project.overview'",
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        repository.openSurfaceView("owner-1", "project-1", {
          revision: layout!.revision,
          surfaceRef: { kind: "builtin", definitionId: "project.overview" },
        }),
      ).rejects.toThrow("not a tab");
    } finally {
      await client.close();
    }
  },
  60000,
);
