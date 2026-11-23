import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import { SecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";
import {
  protectedDisplayLabelFields,
  protectedExplorerFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrations = fileURLToPath(
  new URL("../../../cantrip_server/drizzle/", import.meta.url),
);

it("retires the workbench while preserving native tab ciphertext, placement and file authority", async () => {
  const client = new PGlite();
  try {
    const names = (await readdir(migrations))
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const retirement = names.indexOf("0229_remove_vscode_runtime.sql");
    expect(retirement).toBeGreaterThan(0);
    for (const name of names.slice(0, retirement))
      await client.exec(await readFile(`${migrations}/${name}`, "utf8"));

    // Seed with the historical schema. The current repository reads columns
    // introduced after this migration.
    const workerId = "native-editor-worker";
    const project = protectedProjectFields();
    const sourceId = randomUUID();
    const worktreeId = randomUUID();
    const paneId = randomUUID();
    const root = "/tmp/native-editor-fixture";
    const tab = protectedDisplayLabelFields("code-tab");
    const explorer = protectedExplorerFields();
    const tabKey = `code:${tab.id}`;
    await client.query(
      "INSERT INTO users (id, kind, display_name) VALUES ($1, 'anonymous', 'Local')",
      [LOCAL_USER_ID],
    );
    await client.query(
      "INSERT INTO workers (id, owner_id, name, platform, architecture, started_at, last_seen_at) VALUES ($1,$2,'Native editor','linux','x64',now(),now())",
      [workerId, LOCAL_USER_ID],
    );
    await client.query(
      "INSERT INTO projects (id, owner_id, protected_label, github_repository_blind_index, tab_layout_revision, center_layout_root) VALUES ($1,$2,$3,$4,1,$5)",
      [
        project.id,
        LOCAL_USER_ID,
        project.nameProtection,
        "R".repeat(43),
        { kind: "pane", paneId },
      ],
    );
    await client.query(
      "INSERT INTO project_sources (id, project_id, worker_id, absolute_path, display_path) VALUES ($1,$2,$3,$4,$4)",
      [sourceId, project.id, workerId, root],
    );
    await client.query(
      "INSERT INTO project_worktrees (id, project_source_id, worker_id, name, absolute_path, display_path, is_primary, is_default, origin, lifecycle_state) VALUES ($1,$2,$3,'Primary',$4,$4,true,true,'cantrip','ready')",
      [worktreeId, sourceId, workerId, root],
    );
    await client.query(
      "INSERT INTO code_tabs (id, project_id, protected_label, active_worker_id, worktree_id) VALUES ($1,$2,$3,$4,$5)",
      [tab.id, project.id, tab.titleProtection, workerId, worktreeId],
    );
    await client.query(
      "INSERT INTO explorers (id, project_id, protected_label, protected_state, active_worker_id, worktree_id) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        explorer.id,
        project.id,
        explorer.titleProtection,
        explorer.stateProtection,
        workerId,
        worktreeId,
      ],
    );
    await client.query(
      "INSERT INTO tab_groups (id, project_id, anchor_tab_key) VALUES ($1,$2,$3)",
      [paneId, project.id, tabKey],
    );
    await client.query(
      "INSERT INTO tab_group_members (tab_key, group_id, project_id, tab_kind, tab_id) VALUES ($1,$2,$3,'code',$4)",
      [tabKey, paneId, project.id, tab.id],
    );
    const database = drizzle(client, { schema });
    const retainedRows = async () => {
      const result = await client.query(
        `
        SELECT jsonb_build_object(
          'tab', (SELECT to_jsonb(t) - ARRAY['profile_id','theme_mode','status','last_error'] FROM code_tabs t WHERE id = $1),
          'explorer', (SELECT to_jsonb(e) FROM explorers e WHERE id = $2),
          'worktree', (SELECT to_jsonb(w) FROM project_worktrees w WHERE id = $3),
          'pane', (SELECT to_jsonb(p) FROM tab_groups p WHERE id = $4),
          'placement', (SELECT to_jsonb(m) FROM tab_group_members m WHERE tab_key = $5),
          'layout', (SELECT center_layout_root FROM projects WHERE id = $6)
        ) AS snapshot`,
        [tab.id, explorer.id, worktreeId, paneId, tabKey, project.id],
      );
      return result.rows[0];
    };
    const before = await retainedRows();
    expect(before).toMatchObject({
      snapshot: {
        tab: { protected_label: tab.titleProtection, worktree_id: worktreeId },
        explorer: {
          protected_state: explorer.stateProtection,
          worktree_id: worktreeId,
        },
        worktree: { absolute_path: root },
        placement: { group_id: paneId, tab_id: tab.id },
        layout: { kind: "pane", paneId },
      },
    });
    const retiredTunnelId = randomUUID();
    const retainedTunnelId = randomUUID();
    const protectedContent = {
      ...tab.titleProtection.protectedLabel,
      domain: "tunnel-content",
    };
    await client.query(
      `INSERT INTO tunnels (id, owner_id, project_id, protocol_hint, source_kind, destination_worker_id,
                            origin, management, destination_kind, destination_adapter, destination_resource_id,
                            protected_revision, protected_content, protected_operation_id, managed_by_kind, managed_by_id)
       VALUES ($1,$3,$4,'http-websocket','desktop-loopback',$5,
               'code','managed-ephemeral','worker-adapter','code',$1,1,$6,$1,'code',$1),
              ($2,$3,$4,'http-websocket','desktop-loopback',$5,
               'user','user-managed','worker-tcp',NULL,NULL,1,$6,$2,NULL,NULL)`,
      [
        retiredTunnelId,
        retainedTunnelId,
        LOCAL_USER_ID,
        project.id,
        workerId,
        protectedContent,
      ],
    );
    await client.query(
      "INSERT INTO tunnel_attachments (id, tunnel_id, kind) VALUES ($1,$1,'desktop-loopback'),($2,$2,'desktop-loopback')",
      [retiredTunnelId, retainedTunnelId],
    );
    await client.query(
      `INSERT INTO code_settings_profiles (owner_id, profile_id, revision, protected_operation_id, protected_content) VALUES ($1,'default',1,$2,$3)`,
      [
        LOCAL_USER_ID,
        randomUUID(),
        { ...protectedContent, domain: "customization-content" },
      ],
    );
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO code_sessions (id, code_tab_id, project_id, worker_id, worktree_id, profile_id, editor_version, editor_upstream_revision, editor_patchset, editor_fingerprint) VALUES ($1,$2,$3,$4,$5,'default','old-editor',$6,1,$7)`,
      [
        sessionId,
        tab.id,
        project.id,
        workerId,
        worktreeId,
        "a".repeat(40),
        "b".repeat(64),
      ],
    );
    await client.exec(
      await readFile(`${migrations}/0229_remove_vscode_runtime.sql`, "utf8"),
    );
    expect(await retainedRows()).toEqual(before);
    expect((await client.query(`SELECT id FROM tunnels`)).rows).toEqual([
      { id: retainedTunnelId },
    ]);
    expect(
      (await client.query(`SELECT tunnel_id FROM tunnel_attachments`)).rows,
    ).toEqual([{ tunnel_id: retainedTunnelId }]);
    const tables = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_name IN ('code_sessions','code_settings_profiles')`,
    );
    expect(tables.rows).toEqual([]);
    const columns = await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns WHERE (table_name='code_tabs' AND column_name IN ('profile_id','theme_mode','status','last_error')) OR (table_name='workers' AND column_name='code_capabilities')`,
    );
    expect(columns.rows).toEqual([]);
    for (const name of names.slice(retirement + 1))
      await client.exec(await readFile(`${migrations}/${name}`, "utf8"));
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: randomBytes(32) }],
      }),
    );
    expect(await repository.listCodeTabs(LOCAL_USER_ID, project.id)).toEqual([
      expect.objectContaining({
        id: tab.id,
        titleProtection: tab.titleProtection,
        worktreeId,
      }),
    ]);
    expect(
      await repository.getExplorerExecutionContext(LOCAL_USER_ID, explorer.id),
    ).toMatchObject({ explorerId: explorer.id, workerId, worktreeId, root });
    expect(
      await repository.getExplorerExecutionContext(
        "another-owner",
        explorer.id,
      ),
    ).toBeNull();
  } finally {
    await client.close();
  }
}, 60_000);
