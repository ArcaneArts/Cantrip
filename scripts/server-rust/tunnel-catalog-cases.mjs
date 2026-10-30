// Execute the actual Source methods and compare committed state and failures.
import assert from "node:assert/strict";
import {
  tunnelIds as tunnels,
  attachmentIds as attachments,
  tunnelRecord,
} from "./tunnel-state.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { tunnelCatalogFailures } from "./tunnel-catalog-failures.mjs";
const statuses = [
  "stopped",
  "starting",
  "active",
  "offline",
  "degraded",
  "stopping",
  "failed",
];
export const catalogEarlierDate = "2026-10-24T00:00:00.123Z";
const id = "99999999-9999-4999-8999-000000000001";
const operation = (revision) => ({
  ...tunnelRecord,
  revision,
  operationId: "99999999-9999-4999-8999-" + String(revision).padStart(12, "0"),
});
const input = (extra = {}) => ({
  id,
  projectId: null,
  protocolHint: "tcp",
  destination: { kind: "worker-tcp", workerId: "alpha" },
  protectedRecord: { ...tunnelRecord, operationId: id },
  ...extra,
});
export async function tunnelCatalogCases({
  seed,
  compare,
  snapshot,
  owner,
  other,
}) {
  const get = (label, tunnel = tunnels.main, extra = {}, options = {}) =>
    compare(label, { op: "tunnel-get", tunnel, ...extra }, options);
  const update = (label, value, options = {}) =>
    compare(
      label,
      {
        op: "tunnel-update",
        tunnel: id,
        input: { protectedRecord: operation(2), ...value },
      },
      options,
    );
  const remove = (label, tunnel = id, extra = {}, options = {}) =>
    compare(label, { op: "tunnel-delete", tunnel, ...extra }, options);
  const unchanged = async (label, request, options = { rejected: true }) => {
    const before = await snapshot(label + " before");
    await compare(label, request, options);
    assert.deepEqual(
      await snapshot(label + " after"),
      before,
      label + " preserves complete tunnel/attachment/lease state",
    );
  };
  const resetCreated = () =>
    seed("DELETE FROM tunnels WHERE id=" + literal(id));
  for (const [label, request] of [
    ["owner catalog", { op: "tunnel-list" }],
    ["project catalog", { op: "tunnel-list", project: "github" }],
    ["empty project catalog", { op: "tunnel-list", project: "folder" }],
    ["empty owner catalog", { op: "tunnel-list", owner: "missing-owner" }],
    ["empty project string is no filter", { op: "tunnel-list", project: "" }],
    ["foreign owner catalog", { op: "tunnel-list", owner: other }],
    [
      "foreign project catalog is hidden",
      { op: "tunnel-list", project: "other" },
    ],
    ["foreign tunnel is hidden", { op: "tunnel-get", tunnel: tunnels.foreign }],
    [
      "foreign owner cannot read tunnel",
      { op: "tunnel-get", tunnel: tunnels.main, owner: other },
    ],
    ["missing tunnel", { op: "tunnel-get", tunnel: "missing" }],
  ])
    await compare(label, request);
  await seed(
    "UPDATE tunnels SET position=20,created_at='2026-10-24T00:00:00.123Z' WHERE id=" +
      literal(tunnels.listener),
  );
  await seed(
    "UPDATE tunnels SET position=20 WHERE id=" + literal(tunnels.placement),
  );
  const [ordered] = await compare("catalog position then creation order", {
    op: "tunnel-list",
  });
  assert.deepEqual(
    ordered.slice(-2).map((v) => v.id),
    [tunnels.listener, tunnels.placement],
  );
  const [attachmentOrder] = await get("attachments tie-break by id");
  assert.deepEqual(
    attachmentOrder.attachments.map((a) => a.id),
    [attachments.main, attachments.sibling],
  );
  for (const status of statuses)
    for (const attachmentStatus of [...statuses, "none"]) {
      await seed(
        "UPDATE tunnels SET status=" +
          literal(status) +
          " WHERE id=" +
          literal(tunnels.main),
      );
      await seed(
        "UPDATE tunnel_attachments SET status=" +
          literal(attachmentStatus === "none" ? "stopped" : attachmentStatus) +
          " WHERE tunnel_id=" +
          literal(tunnels.main),
      );
      const target =
        attachmentStatus === "none" ? tunnels.listener : tunnels.main;
      if (attachmentStatus === "none")
        await seed(
          "UPDATE tunnels SET status=" +
            literal(status) +
            " WHERE id=" +
            literal(target),
        );
      await get(
        "catalog user capabilities " + status + "/" + attachmentStatus,
        target,
      );
    }
  for (const target of [
    tunnels.durable,
    tunnels.ephemeralBrowser,
    tunnels.ephemeralShare,
  ])
    for (const status of statuses) {
      await seed(
        "UPDATE tunnels SET status=" +
          literal(status) +
          " WHERE id=" +
          literal(target),
      );
      await get("managed capabilities " + target + "/" + status, target);
    }
  await seed("UPDATE tunnels SET status='stopped'");
  await seed("UPDATE tunnel_attachments SET status='stopped'");
  await seed(
    "UPDATE tunnels SET destination_kind='worker-adapter',destination_adapter='project-share',destination_resource_id='opaque-resource' WHERE id=" +
      literal(tunnels.ephemeralShare),
  );
  await get("managed adapter public destination", tunnels.ephemeralShare);
  await seed(
    "UPDATE tunnels SET bytes_from_source=9223372036854775807,bytes_to_source=9007199254740993 WHERE id=" +
      literal(tunnels.main),
  );
  await seed(
    "UPDATE tunnel_attachments SET bytes_from_source=9007199254740993,expires_at=NULL,last_seen_at='2026-10-25T00:00:00.123999Z' WHERE id=" +
      literal(attachments.main),
  );
  await get("catalog JS number rounding and nullable millisecond dates");
  await seed(
    "UPDATE tunnels SET protected_content=" +
      json({ private: "opaque", toString: "kept", 9: true }) +
      " WHERE id=" +
      literal(tunnels.main),
  );
  await get("opaque protected payload is never decoded");
  await seed(
    "UPDATE tunnels SET protected_content=" +
      json(tunnelRecord.protectedContent) +
      " WHERE id=" +
      literal(tunnels.main),
  );
  for (const at of [
    "2000-01-01 00:00:00.999999+00",
    "10000-01-01 00:00:00+00",
    "infinity",
    "-infinity",
  ]) {
    await seed(
      "UPDATE tunnel_attachments SET expires_at=" +
        literal(at) +
        " WHERE id=" +
        literal(attachments.main),
    );
    await get(
      "stored attachment date " + at,
      tunnels.main,
      {},
      { rejected: at.includes("infinity") },
    );
  }
  await seed(
    "UPDATE tunnel_attachments SET expires_at=NULL WHERE id=" +
      literal(attachments.main),
  );
  await compare(
    "create detached protected user tunnel",
    { op: "tunnel-create", input: input() },
    { databaseDefaults: true },
  );
  await snapshot("created row defaults and opaque bytes");
  assert.equal(
    (await get("created position follows owner maximum", id))[0].position,
    21,
  );
  await get("created row hidden from other owner", id, { owner: other });
  await unchanged(
    "foreign update is hidden",
    {
      op: "tunnel-update",
      owner: other,
      tunnel: id,
      input: { protectedRecord: operation(2) },
    },
    { rejected: false },
  );
  for (const [name, record] of [
    ["stale revision", operation(1)],
    ["skipped revision", operation(3)],
    ["reused operation", { ...operation(2), operationId: id }],
  ])
    await unchanged(name, {
      op: "tunnel-update",
      tunnel: id,
      input: { protectedRecord: record },
    });
  for (const status of [
    "starting",
    "active",
    "offline",
    "degraded",
    "stopping",
  ]) {
    await seed(
      "INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,status,created_at,updated_at) VALUES('catalog-attachment'," +
        literal(id) +
        ",'desktop-loopback','catalog-client'," +
        literal(status) +
        "," +
        literal(stamp) +
        "," +
        literal(stamp) +
        ")",
    );
    await unchanged("edit blocked by " + status, {
      op: "tunnel-update",
      tunnel: id,
      input: { protectedRecord: operation(2) },
    });
    await unchanged("delete blocked by " + status, {
      op: "tunnel-delete",
      tunnel: id,
    });
    await seed("DELETE FROM tunnel_attachments WHERE id='catalog-attachment'");
  }
  await seed(
    "INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,status,created_at,updated_at) VALUES('catalog-attachment'," +
      literal(id) +
      ",'desktop-loopback','catalog-client','failed'," +
      literal(stamp) +
      "," +
      literal(stamp) +
      ")",
  );
  await seed("UPDATE tunnels SET status='active' WHERE id=" + literal(id));
  await update(
    "failed attachment permits edit regardless of active tunnel status",
    { protocolHint: "http" },
  );
  await update("nullable project is explicitly assigned", {
    projectId: "github",
    protectedRecord: operation(3),
  });
  await update("omitted fields preserve project and destination", {
    protectedRecord: operation(4),
  });
  await update("explicit null clears project", {
    projectId: null,
    protectedRecord: operation(5),
  });
  await update("destination worker changes", {
    destination: { kind: "worker-tcp", workerId: "beta" },
    protectedRecord: operation(6),
  });
  await snapshot("updated protected revisions and retained attachments");
  for (const target of [tunnels.durable, tunnels.ephemeralBrowser])
    for (const op of ["tunnel-update", "tunnel-delete"])
      await unchanged("managed resource rejects " + op + " " + target, {
        op,
        tunnel: target,
        input: { protectedRecord: operation(2) },
      });
  for (const [name, extra] of [
    ["missing project", { projectId: "missing" }],
    ["foreign project", { projectId: "other" }],
    [
      "missing worker",
      { destination: { kind: "worker-tcp", workerId: "missing" } },
    ],
    [
      "foreign worker",
      { destination: { kind: "worker-tcp", workerId: "foreign" } },
    ],
  ]) {
    await unchanged(
      name + " update",
      {
        op: "tunnel-update",
        tunnel: id,
        input: { protectedRecord: operation(7), ...extra },
      },
      { rejected: false },
    );
    await unchanged(
      name + " create",
      { op: "tunnel-create", input: input({ ...extra, id: "unowned-create" }) },
      { rejected: false },
    );
  }
  await seed("UPDATE workers SET unlinked_at='2026-10-28' WHERE id='beta'");
  await unchanged(
    "unlinked worker create",
    {
      op: "tunnel-create",
      input: input({
        id: "unlinked-create",
        destination: { kind: "worker-tcp", workerId: "beta" },
      }),
    },
    { rejected: false },
  );
  await unchanged(
    "unlinked worker update",
    {
      op: "tunnel-update",
      tunnel: id,
      input: { protectedRecord: operation(7) },
    },
    { rejected: false },
  );
  await seed("UPDATE workers SET unlinked_at=NULL WHERE id='beta'");
  await unchanged("bound folder mismatch before worker ownership", {
    op: "tunnel-create",
    input: input({
      id: "bound-create",
      projectId: "folder",
      destination: { kind: "worker-tcp", workerId: "foreign" },
    }),
  });
  await unchanged("bound folder edit mismatch", {
    op: "tunnel-update",
    tunnel: id,
    input: { projectId: "folder", protectedRecord: operation(7) },
  });
  await update("bound folder on owning worker", {
    projectId: "folder",
    destination: { kind: "worker-tcp", workerId: "alpha" },
    protectedRecord: operation(7),
  });
  await seed(
    "UPDATE project_sources SET removed_at='2026-10-28' WHERE id='local-git-alpha'",
  );
  await unchanged("local git removed source", {
    op: "tunnel-update",
    tunnel: id,
    input: { projectId: "local-git", protectedRecord: operation(8) },
  });
  await seed(
    "UPDATE project_sources SET removed_at=NULL WHERE id='local-git-alpha'",
  );
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='failed' WHERE id='local-git-alpha-main'",
  );
  await unchanged("local git primary not ready", {
    op: "tunnel-update",
    tunnel: id,
    input: { projectId: "local-git", protectedRecord: operation(8) },
  });
  await seed(
    "UPDATE project_worktrees SET lifecycle_state='ready',is_primary=false WHERE id='local-git-alpha-main'",
  );
  await unchanged("local git secondary not sufficient", {
    op: "tunnel-update",
    tunnel: id,
    input: { projectId: "local-git", protectedRecord: operation(8) },
  });
  await seed(
    "UPDATE project_worktrees SET is_primary=true WHERE id='local-git-alpha-main'",
  );
  await update("local git ready source permits update", {
    projectId: "local-git",
    protectedRecord: operation(8),
  });
  await unchanged(
    "foreign delete is hidden",
    { op: "tunnel-delete", owner: other, tunnel: id },
    { rejected: false },
  );
  assert.equal((await remove("delete user with failed attachment"))[0], true);
  await snapshot("delete cascades attachment and leases");
  assert.equal((await remove("second delete is false"))[0], false);
  for (const hint of [
    "tcp",
    "http",
    "https",
    "http-websocket",
    "https-websocket",
    "webdav",
  ]) {
    await compare(
      "create protocol " + hint,
      {
        op: "tunnel-create",
        input: input({ protocolHint: hint, projectId: "github" }),
      },
      { databaseDefaults: true },
    );
    await remove("delete protocol " + hint);
  }
  await compare(
    "create bound folder",
    { op: "tunnel-create", input: input({ projectId: "folder" }) },
    { databaseDefaults: true },
  );
  await resetCreated();
  await compare(
    "create local git",
    { op: "tunnel-create", input: input({ projectId: "local-git" }) },
    { databaseDefaults: true },
  );
  await resetCreated();
  // Private driver diagnostics can differ. Retain them verbatim and compare the
  // failure outcome plus full persisted state; public HTTP mapping is separate.
  const sqlFailure = { rejected: true, diagnostic: false };
  await seed(
    "UPDATE tunnels SET position=2147483647 WHERE id=" + literal(tunnels.main),
  );
  await unchanged(
    "position overflow reaches PostgreSQL",
    { op: "tunnel-create", input: input() },
    { ...sqlFailure, databaseCode: "22003" },
  );
  await seed("UPDATE tunnels SET position=0 WHERE id=" + literal(tunnels.main));
  await compare(
    "create before duplicate",
    { op: "tunnel-create", input: input() },
    { databaseDefaults: true },
  );
  await unchanged(
    "duplicate tunnel primary key",
    { op: "tunnel-create", input: input() },
    { ...sqlFailure, databaseCode: "23505" },
  );
  await seed(
    "CREATE FUNCTION catalog_reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'catalog fixture write rejected'; END $$",
  );
  for (const [name, verb, request] of [
    [
      "insert",
      "INSERT",
      { op: "tunnel-create", input: input({ id: "trigger-create" }) },
    ],
    [
      "update",
      "UPDATE",
      {
        op: "tunnel-update",
        tunnel: id,
        input: { protectedRecord: operation(2) },
      },
    ],
    ["delete", "DELETE", { op: "tunnel-delete", tunnel: id }],
  ]) {
    await seed(
      "CREATE TRIGGER catalog_failure BEFORE " +
        verb +
        " ON tunnels FOR EACH ROW EXECUTE FUNCTION catalog_reject_write()",
    );
    await unchanged("actual trigger rejects " + name, request, {
      ...sqlFailure,
      databaseCode: "P0001",
    });
    await seed("DROP TRIGGER catalog_failure ON tunnels");
  }
  await seed("DROP FUNCTION catalog_reject_write()");
  await remove("cleanup catalog resource");
  await tunnelCatalogFailures({
    seed,
    compare,
    snapshot,
    unchanged,
    id,
    input,
    operation,
    tunnels,
    attachments,
    owner,
    other,
  });
}
