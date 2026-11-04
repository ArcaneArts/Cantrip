import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { accountStorageMeasurementQuery } from "../src/db/account-resource-usage.js";

it("attributes guest-source rows and OS metadata growth to their owning account", async () => {
  const client = new PGlite();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const owners = ["usage-guest-a", "usage-guest-b"];
    for (const owner of owners) {
      await client.query(
        "INSERT INTO users(id,kind,email,normalized_email,role,status,display_name) VALUES($1,'account',$1||'@usage.invalid',$1||'@usage.invalid','owner','active',$1)",
        [owner],
      );
      await client.query(
        "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Usage worker','linux','x64',now(),now())",
        [owner + "-worker", owner],
      );
      await client.query(
        "INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES($1,$2,'{}','managed-folder','external','direct',false,false)",
        [owner + "-project", owner],
      );
    }
    async function measure(category = "projects") {
      const result = await client.query<{
        owner_id: string;
        category: string;
        storage_class: string;
        logical_bytes: string;
        row_count: string;
      }>(accountStorageMeasurementQuery());
      return new Map(
        result.rows
          .filter(
            (row) =>
              row.category === category && row.storage_class === "server",
          )
          .map((row) => [
            row.owner_id,
            { bytes: BigInt(row.logical_bytes), rows: BigInt(row.row_count) },
          ]),
      );
    }
    const before = await measure();
    const conversationsBefore = await measure("conversations");
    const expected = new Map<string, bigint>();
    const expectedConversations = new Map<string, bigint>();
    const instances: string[] = [];
    for (const [index, owner] of owners.entries()) {
      const instance = randomUUID(),
        workspace = randomUUID(),
        source = randomUUID(),
        worktree = randomUUID(),
        binding = randomUUID(),
        operation = randomUUID();
      instances.push(instance);
      const worker = owner + "-worker",
        project = owner + "-project";
      const path = "/workspace/usage/sources/" + source;
      await client.query(
        "INSERT INTO cantrip_os_instances(id,owner_id,worker_id,guest_instance_id,attachment_generation,transport,name) VALUES($1,$2,$3,$4,$5,'{}','Usage OS')",
        [instance, owner, worker, randomUUID(), randomUUID()],
      );
      await client.query(
        "INSERT INTO cantrip_os_workspaces(id,instance_id,guest_workspace_id,uid,gid,home_guest_path) VALUES($1,$2,'usage',$3,$3,'/workspace/usage')",
        [workspace, instance, 1000 + index],
      );
      await client.query(
        "INSERT INTO project_source_identities(id,project_id,worker_id,location_kind) VALUES($1,$2,$3,'cantrip-os')",
        [source, project, worker],
      );
      await client.query(
        "INSERT INTO cantrip_os_project_sources(id,workspace_id,source_kind,guest_path,ownership_kind) VALUES($1,$2,'folder',$3,'cantrip')",
        [source, workspace, path],
      );
      await client.query(
        "INSERT INTO project_worktrees(id,project_source_id,worker_id,location_kind,guest_path,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES($1,$2,$3,'cantrip-os',$4,'main',NULL,$4,true,'cantrip','ready')",
        [worktree, source, worker, path],
      );
      await client.query(
        "INSERT INTO cantrip_os_source_bindings(id,owner_id,project_id,worker_id,project_source_id,worktree_id,workspace_id,mode,guest_path,binding_generation,state) VALUES($1,$2,$3,$4,$5,$6,$7,'linux-owned',$8,$9,'provisioning')",
        [
          binding,
          owner,
          project,
          worker,
          source,
          worktree,
          workspace,
          path,
          randomUUID(),
        ],
      );
      await client.query(
        "INSERT INTO cantrip_os_provision_admissions(operation_id,binding_id,scope,protected_request) VALUES($1,$2,'{}','{}')",
        [operation, binding],
      );
      const chat = owner + "-chat";
      await client.query(
        "INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,protected_label) VALUES($1,$2,$3,$4,$5,'{}')",
        [chat, owner, project, worker, worktree],
      );
      await client.query(
        "INSERT INTO cantrip_os_chat_placements(chat_id,binding_id,binding_generation,attachment_generation,runtime_generation) SELECT $1,b.id,b.binding_generation,i.attachment_generation,i.attachment_generation FROM cantrip_os_source_bindings b JOIN cantrip_os_workspaces w ON w.id=b.workspace_id JOIN cantrip_os_instances i ON i.id=w.instance_id WHERE b.id=$2",
        [chat, binding],
      );
      const conversationSize = await client.query<{ bytes: string }>(
        "SELECT sum(bytes)::text bytes FROM (SELECT pg_column_size(t.*) bytes FROM chats t WHERE id=$1 UNION ALL SELECT pg_column_size(t.*) bytes FROM cantrip_os_chat_placements t WHERE chat_id=$1) rows",
        [chat],
      );
      expectedConversations.set(owner, BigInt(conversationSize.rows[0]!.bytes));
      let bytes = 0n;
      for (const [table, column, id] of [
        ["cantrip_os_instances", "id", instance],
        ["cantrip_os_workspaces", "id", workspace],
        ["project_source_identities", "id", source],
        ["cantrip_os_project_sources", "id", source],
        ["project_worktrees", "id", worktree],
        ["cantrip_os_source_bindings", "id", binding],
        ["cantrip_os_provision_admissions", "operation_id", operation],
      ]) {
        const row = await client.query<{ bytes: number }>(
          `SELECT pg_column_size(t.*) AS bytes FROM ${table} t WHERE ${column}=$1`,
          [id],
        );
        bytes += BigInt(row.rows[0]!.bytes);
      }
      expected.set(owner, bytes);
    }
    const measured = await measure();
    const conversations = await measure("conversations");
    for (const owner of owners) {
      expect(measured.get(owner)!.rows - before.get(owner)!.rows).toBe(7n);
      expect(measured.get(owner)!.bytes - before.get(owner)!.bytes).toBe(
        expected.get(owner),
      );
      expect(
        conversations.get(owner)!.rows -
          (conversationsBefore.get(owner)?.rows ?? 0n),
      ).toBe(2n);
      expect(
        conversations.get(owner)!.bytes -
          (conversationsBefore.get(owner)?.bytes ?? 0n),
      ).toBe(expectedConversations.get(owner));
    }
    await client.query("UPDATE cantrip_os_instances SET name=$2 WHERE id=$1", [
      instances[0],
      "Tenant A workspace ".repeat(8),
    ]);
    const grown = await measure();
    expect(grown.get(owners[0]!)!.bytes).toBeGreaterThan(
      measured.get(owners[0]!)!.bytes,
    );
    expect(grown.get(owners[0]!)!.rows).toBe(measured.get(owners[0]!)!.rows);
    expect(grown.get(owners[1]!)).toEqual(measured.get(owners[1]!));
  } finally {
    await client.close();
  }
});
