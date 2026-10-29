// Real schema/trigger failures distinguish omitted columns and non-atomic
// post-write projection from an implementation that only matches happy paths.
import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
export async function tunnelCatalogFailures({
  seed,
  compare,
  snapshot,
  unchanged,
  id,
  input,
  operation,
  tunnels,
}) {
  const sqlFailure = {
    rejected: true,
    diagnostic: false,
    databaseCode: "42703",
  };
  const create = (label, extra = {}) =>
    compare(
      label,
      { op: "tunnel-create", input: input(extra) },
      { databaseDefaults: true },
    );
  const get = (label, tunnel = id) =>
    compare(label, { op: "tunnel-get", tunnel });
  const remove = (label, tunnel = id) =>
    compare(label, { op: "tunnel-delete", tunnel });
  await create("create before projection failures");
  await seed(
    "ALTER TABLE tunnels RENAME COLUMN source_adapter TO catalog_hidden_adapter",
  );
  for (const [name, request] of [
    ["catalog", { op: "tunnel-list" }],
    ["single read", { op: "tunnel-get", tunnel: id }],
    [
      "update pre-read",
      {
        op: "tunnel-update",
        tunnel: id,
        input: { protectedRecord: operation(2) },
      },
    ],
    [
      "insert",
      { op: "tunnel-create", input: input({ id: "missing-column-create" }) },
    ],
  ])
    await unchanged(
      "unused tunnel column missing " + name,
      request,
      sqlFailure,
    );
  assert.equal((await remove("delete only projects management"))[0], true);
  await seed(
    "ALTER TABLE tunnels RENAME COLUMN catalog_hidden_adapter TO source_adapter",
  );
  await create("create before missing attachment column");
  await seed(
    "ALTER TABLE tunnel_attachments RENAME COLUMN secret_hash TO catalog_hidden_hash",
  );
  await unchanged(
    "catalog selects unused attachment hash",
    { op: "tunnel-list" },
    sqlFailure,
  );
  await unchanged(
    "get selects unused attachment hash",
    { op: "tunnel-get", tunnel: tunnels.main },
    sqlFailure,
  );
  await compare("empty catalog skips attachment query", {
    op: "tunnel-list",
    owner: "missing-owner",
  });
  await create("create summary does not query attachments", {
    id: "no-attachment-read",
  });
  await remove("delete skips unused attachment column", "no-attachment-read");
  await compare(
    "post-write read actually fails after commit",
    {
      op: "tunnel-update",
      tunnel: id,
      input: { protectedRecord: operation(2) },
    },
    sqlFailure,
  );
  const committed = await snapshot(
    "failed post-write projection retains committed protected update",
  );
  for (const state of committed) {
    const row = state.tunnels.find((t) => t.id === id);
    assert.equal(row.protected_revision, 2);
    assert.equal(row.protected_operation_id, operation(2).operationId);
    assert.equal(
      Date.parse(row.updated_at),
      Date.parse("2026-10-29T00:00:00.000Z"),
    );
  }
  await seed(
    "ALTER TABLE tunnel_attachments RENAME COLUMN catalog_hidden_hash TO secret_hash",
  );
  assert.equal(
    (await get("repaired projection reads committed revision"))[0]
      .protectedRecord.revision,
    2,
  );
  await seed(
    "ALTER TABLE projects RENAME COLUMN preferred_worker_id TO catalog_hidden_worker",
  );
  await unchanged(
    "unused project projection is still required",
    {
      op: "tunnel-create",
      input: input({ id: "missing-project-projection", projectId: "github" }),
    },
    sqlFailure,
  );
  await unchanged(
    "references are read before foreign project result",
    {
      op: "tunnel-create",
      input: input({ id: "foreign-project-projection", projectId: "other" }),
    },
    sqlFailure,
  );
  await create("null project skips both project reads", {
    id: "null-project-projection",
  });
  await remove("cleanup null project projection", "null-project-projection");
  await seed(
    "ALTER TABLE projects RENAME COLUMN catalog_hidden_worker TO preferred_worker_id",
  );
  await seed(
    "UPDATE tunnels SET destination_resource_id='' WHERE id=" +
      literal(tunnels.ephemeralShare),
  );
  await compare(
    "empty managed adapter resource rejects routing",
    { op: "tunnel-get", tunnel: tunnels.ephemeralShare },
    { rejected: true },
  );
  await seed(
    "UPDATE tunnels SET destination_resource_id='opaque-resource' WHERE id=" +
      literal(tunnels.ephemeralShare),
  );
  await seed(
    "UPDATE tunnels SET protected_operation_id='' WHERE id=" + literal(id),
  );
  assert.equal(
    (await get("empty protected operation exposes null record"))[0]
      .protectedRecord,
    null,
  );
  await seed(
    "UPDATE tunnels SET protected_operation_id=" +
      literal(operation(2).operationId) +
      " WHERE id=" +
      literal(id),
  );
  await seed("ALTER TABLE tunnels DROP CONSTRAINT tunnels_source_worker_check");
  await seed(
    "UPDATE tunnels SET source_kind='worker-listener',source_worker_id=NULL WHERE id=" +
      literal(id),
  );
  await compare(
    "invalid stored source fails get",
    { op: "tunnel-get", tunnel: id },
    { rejected: true },
  );
  await unchanged("revision guard precedes invalid stored source", {
    op: "tunnel-update",
    tunnel: id,
    input: { protectedRecord: operation(1) },
  });
  await unchanged("valid revision then invalid stored source", {
    op: "tunnel-update",
    tunnel: id,
    input: { protectedRecord: operation(3) },
  });
  assert.equal(
    (await remove("invalid routing does not block management-only delete"))[0],
    true,
  );
  await seed(
    "ALTER TABLE tunnels ADD CONSTRAINT tunnels_source_worker_check CHECK ((source_kind='worker-listener' AND source_worker_id IS NOT NULL) OR (source_kind<>'worker-listener' AND source_worker_id IS NULL))",
  );
  await create("create before fresh post-write attachment");
  await seed(
    "CREATE FUNCTION catalog_post_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,status,created_at,updated_at) VALUES('catalog-post-update',NEW.id,'desktop-loopback','post-update-client','active'," +
      literal(stamp) +
      "," +
      literal(stamp) +
      "); RETURN NEW; END $$",
  );
  await seed(
    "CREATE TRIGGER catalog_post_write AFTER UPDATE ON tunnels FOR EACH ROW WHEN (NEW.id=" +
      literal(id) +
      ") EXECUTE FUNCTION catalog_post_write()",
  );
  const [fresh] = await compare("update performs fresh attachment read", {
    op: "tunnel-update",
    tunnel: id,
    input: { protectedRecord: operation(2) },
  });
  assert.equal(fresh.attachments[0].id, "catalog-post-update");
  assert.equal(fresh.capabilities.canEdit, false);
  await snapshot("post-write attachment participates in summary");
  await seed("DROP TRIGGER catalog_post_write ON tunnels");
  await seed("DROP FUNCTION catalog_post_write()");
  await seed("DELETE FROM tunnel_attachments WHERE id='catalog-post-update'");
  await remove("cleanup post-write trigger resource");
  // Both endpoint workers participate in local-Git source ownership.
  await seed(
    "UPDATE project_sources SET removed_at='2026-10-28' WHERE id='local-git-alpha'",
  );
  await unchanged("listener source worker also needs ready local Git source", {
    op: "tunnel-update",
    tunnel: tunnels.listener,
    input: {
      projectId: "local-git",
      destination: { kind: "worker-tcp", workerId: "beta" },
      protectedRecord: operation(2),
    },
  });
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='local-git-alpha'",
  );
  await compare("listener and destination on distinct ready workers", {
    op: "tunnel-update",
    tunnel: tunnels.listener,
    input: {
      projectId: "local-git",
      destination: { kind: "worker-tcp", workerId: "beta" },
      protectedRecord: operation(2),
    },
  });
  await snapshot("listener routing and ready sources retained");
}
