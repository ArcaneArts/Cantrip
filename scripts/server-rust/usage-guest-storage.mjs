import assert from "node:assert/strict";

export async function verifyGuestStorage({ owners, seed, compare, literal }) {
  const row = (rows, owner, category = "projects") =>
    rows.find(
      (v) =>
        v.ownerId === owner &&
        v.storageClass === "server" &&
        v.category === category,
    );
  const before = await compare("guest storage before OS rows", {
    op: "measure",
  });
  const bytes = new Map();
  const conversationBytes = new Map();
  for (const [index, owner] of owners.entries()) {
    const id = literal("usage-os-" + owner),
      worker = literal("usage-goal-" + owner),
      project = literal("usage-alert-" + owner),
      path = literal("/workspace/usage/" + owner),
      generation = "'11111111-1111-4111-8111-111111111111'";
    for (const sql of [
      `INSERT INTO cantrip_os_instances(id,owner_id,worker_id,guest_instance_id,attachment_generation,transport,name) VALUES(${id},${literal(owner)},${worker},${generation},${generation},'{}','Usage OS')`,
      `INSERT INTO cantrip_os_workspaces(id,instance_id,guest_workspace_id,uid,gid,home_guest_path) VALUES(${id},${id},'usage',${1000 + index},${1000 + index},'/workspace/usage')`,
      `INSERT INTO project_source_identities(id,project_id,worker_id,location_kind) VALUES(${id},${project},${worker},'cantrip-os')`,
      `INSERT INTO cantrip_os_project_sources(id,workspace_id,source_kind,guest_path,ownership_kind) VALUES(${id},${id},'folder',${path},'cantrip')`,
      `INSERT INTO project_worktrees(id,project_source_id,worker_id,location_kind,guest_path,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${id},${id},${worker},'cantrip-os',${path},'main',NULL,${path},true,'cantrip','ready')`,
      `INSERT INTO cantrip_os_source_bindings(id,owner_id,project_id,worker_id,project_source_id,worktree_id,workspace_id,mode,guest_path,binding_generation,state) VALUES(${id},${literal(owner)},${project},${worker},${id},${id},${id},'linux-owned',${path},${generation},'provisioning')`,
      `INSERT INTO cantrip_os_provision_admissions(operation_id,binding_id,scope,protected_request) VALUES(${id},${id},'{}','{}')`,
      `INSERT INTO chats(id,owner_id,project_id,active_worker_id,active_worktree_id,protected_label) VALUES(${id},${literal(owner)},${project},${worker},${id},'{}')`,
      `INSERT INTO cantrip_os_chat_placements(chat_id,binding_id,binding_generation,attachment_generation,runtime_generation) VALUES(${id},${id},${generation},${generation},${generation})`,
    ])
      await seed(sql);
    const sizes = [
      ["cantrip_os_instances", "id"],
      ["cantrip_os_workspaces", "id"],
      ["project_source_identities", "id"],
      ["cantrip_os_project_sources", "id"],
      ["project_worktrees", "id"],
      ["cantrip_os_source_bindings", "id"],
      ["cantrip_os_provision_admissions", "operation_id"],
    ].map(
      ([table, column]) =>
        `SELECT pg_column_size(t.*)::bigint bytes FROM ${table} t WHERE ${column}=${id}`,
    );
    bytes.set(
      owner,
      BigInt(
        (
          await compare("guest row bytes for " + owner, {
            op: "query-json",
            sql: `SELECT jsonb_build_object('bytes',sum(bytes)::text) result FROM (${sizes.join(" UNION ALL ")}) sizes`,
          })
        ).bytes,
      ),
    );
    conversationBytes.set(
      owner,
      BigInt(
        (
          await compare("captured guest chat bytes for " + owner, {
            op: "query-json",
            sql: `SELECT jsonb_build_object('bytes',sum(bytes)::text) result FROM (SELECT pg_column_size(t.*)::bigint bytes FROM chats t WHERE id=${id} UNION ALL SELECT pg_column_size(t.*)::bigint bytes FROM cantrip_os_chat_placements t WHERE chat_id=${id}) sizes`,
          })
        ).bytes,
      ),
    );
  }
  const measured = await compare(
    "all six OS tables and guest worktree measured",
    {
      op: "measure",
    },
  );
  for (const owner of owners) {
    assert.equal(
      BigInt(row(measured, owner).rowCount) -
        BigInt(row(before, owner).rowCount),
      7n,
    );
    assert.equal(
      BigInt(row(measured, owner).logicalBytes) -
        BigInt(row(before, owner).logicalBytes),
      bytes.get(owner),
    );
    assert.equal(
      BigInt(row(measured, owner, "conversations").rowCount) -
        BigInt(row(before, owner, "conversations").rowCount),
      2n,
    );
    assert.equal(
      BigInt(row(measured, owner, "conversations").logicalBytes) -
        BigInt(row(before, owner, "conversations").logicalBytes),
      conversationBytes.get(owner),
    );
  }
  await seed(
    `UPDATE cantrip_os_instances SET name=${literal("Tenant A workspace ".repeat(8))} WHERE id=${literal("usage-os-" + owners[0])}`,
  );
  const grown = await compare("guest metadata growth remains tenant isolated", {
    op: "measure",
  });
  assert.ok(
    BigInt(row(grown, owners[0]).logicalBytes) >
      BigInt(row(measured, owners[0]).logicalBytes),
  );
  assert.equal(
    row(grown, owners[0]).rowCount,
    row(measured, owners[0]).rowCount,
  );
  assert.deepEqual(row(grown, owners[1]), row(measured, owners[1]));
}
