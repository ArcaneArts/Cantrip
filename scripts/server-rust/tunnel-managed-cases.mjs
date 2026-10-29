// Actual feature-owned repository methods, including post-write read failures.
import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";
import { tunnelRecord, tunnelIds } from "./tunnel-state.mjs";

const id = "66666666-6666-4666-8666-000000000001";
const foreignId = "66666666-6666-4666-8666-000000000002";
const managedBy = { kind: "project-share", id: "managed-share" };
const record = (revision) => ({
  ...tunnelRecord,
  revision,
  operationId:
    "66666666-6666-4666-8666-" + String(revision + 100).padStart(12, "0"),
});
const input = (extra = {}) => ({
  name: "Private managed fixture name",
  description: "Private managed fixture description",
  projectId: "github",
  origin: "project-share",
  management: "managed-durable",
  protocolHint: "webdav",
  source: { kind: "desktop-loopback" },
  destination: {
    kind: "worker-adapter",
    workerId: "alpha",
    adapter: "project-share",
    resourceId: managedBy.id,
  },
  managedBy,
  desiredState: "started",
  status: "starting",
  ...extra,
});
const tcp = {
  kind: "worker-tcp",
  workerId: "alpha",
  host: "localhost",
  port: 54321,
};
export async function tunnelManagedCases({
  seed,
  compare,
  snapshot,
  owner,
  other,
}) {
  const register = (
    label,
    value = input(),
    protectedInput,
    options = {},
    extra = {},
  ) =>
    compare(
      label,
      {
        op: "tunnel-managed-register",
        input: value,
        ...(protectedInput === undefined ? {} : { protected: protectedInput }),
        ...extra,
      },
      options,
    );
  const get = (label, extra = {}) =>
    compare(label, { op: "tunnel-managed-get", managedBy, ...extra });
  const remove = (label, extra = {}) =>
    compare(label, { op: "tunnel-managed-remove", managedBy, ...extra });
  const unchanged = async (label, operation, options = {}) => {
    const before = await snapshot(label + " before");
    await compare(label, operation, { rejected: true, ...options });
    assert.deepEqual(
      await snapshot(label + " after"),
      before,
      label + " preserves complete state",
    );
  };
  await get("missing managed tuple");
  assert.equal((await remove("missing managed removal"))[0], false);
  await unchanged(
    "private destination requires protected content before ownership reads",
    {
      op: "tunnel-managed-register",
      input: input({ projectId: "missing", destination: tcp }),
    },
  );
  await unchanged("private listener requires protected content", {
    op: "tunnel-managed-register",
    input: input({
      source: {
        kind: "worker-listener",
        workerId: "alpha",
        host: "::1",
        port: 12345,
      },
    }),
  });
  for (const destinationId of ["\ud801", "�"]) {
    const [hidden] = await register(
      "distinct UTF16 worker identities retain reference cardinality " +
        JSON.stringify(destinationId),
      input({
        source: {
          kind: "worker-listener",
          workerId: "\ud800",
          host: "localhost",
          port: 12345,
        },
        destination: { ...tcp, workerId: destinationId },
      }),
      { id, protectedRecord: record(1) },
    );
    assert.equal(hidden, null);
  }
  const identicalWorkers = await register(
    "identical UTF16 worker identities deduplicate before text binding",
    input({
      source: {
        kind: "worker-listener",
        workerId: "\ud800",
        host: "localhost",
        port: 12345,
      },
      destination: { ...tcp, workerId: "\ud800" },
    }),
    { id, protectedRecord: record(1) },
    { databaseDefaults: true },
  );
  for (const row of identicalWorkers) {
    assert.equal(row.source.workerId, "�");
    assert.equal(row.destination.workerId, "�");
  }
  assert.equal((await remove("remove UTF16 managed fixture"))[0], true);
  await register(
    "unprotected public registration reaches the actual database constraint",
    input(),
    undefined,
    { rejected: true, diagnostic: false, databaseCode: "23514" },
  );
  const [publicRow] = await register(
    "public adapter registration uses native ID/defaults",
    input(),
    { protectedRecord: record(1) },
    { capture: "<managed-public>", captureField: "id", databaseDefaults: true },
  );
  assert.equal(publicRow.protectedRecord.revision, 1);
  assert.deepEqual(publicRow.destination, input().destination);
  assert.deepEqual(
    (await get("managed tuple selects public row"))[0],
    publicRow,
  );
  await get("foreign owner cannot see managed tuple", { owner: other });
  assert.equal(
    (
      await remove("foreign owner cannot remove managed tuple", {
        owner: other,
      })
    )[0],
    false,
  );
  const beforeProtection = await snapshot(
    "public registration strips private display fields",
  );
  for (const state of beforeProtection) {
    assert.ok(!JSON.stringify(state).includes("Private managed fixture"));
    const row = state.tunnels.find((row) => row.managed_by_id === managedBy.id);
    assert.equal(row.source_adapter, null);
    assert.equal(row.protected_revision, 1);
  }
  assert.equal((await remove("remove public managed row"))[0], true);
  const protectedInput = { id, protectedRecord: record(1) };
  const createdPrivateRows = await register(
    "private TCP managed registration",
    input({ destination: tcp }),
    protectedInput,
    { databaseDefaults: true },
  );
  const [privateRow] = createdPrivateRows;
  assert.deepEqual(privateRow.destination, {
    kind: "worker-tcp",
    workerId: "alpha",
  });
  assert.equal(privateRow.id, id);
  assert.equal(privateRow.protectedRecord.revision, 1);
  await unchanged(
    "managed identity takes precedence over stale protected revision",
    {
      op: "tunnel-managed-register",
      input: input(),
      protected: { id: foreignId, protectedRecord: record(1) },
    },
  );
  for (const [label, protectedRecord] of [
    ["stale revision", record(1)],
    ["reused operation", { ...record(2), operationId: record(1).operationId }],
    ["numeric string is not a revision", { ...record(2), revision: "2" }],
  ])
    await unchanged("managed " + label, {
      op: "tunnel-managed-register",
      input: input(),
      protected: { id, protectedRecord },
    });
  assert.equal(
    (
      await register(
        "missing ownership wins over stale identity",
        input({ projectId: "missing" }),
        { id: foreignId, protectedRecord: record(1) },
      )
    )[0],
    null,
  );
  assert.equal(
    (
      await register(
        "foreign worker is hidden",
        input({ destination: { ...tcp, workerId: "foreign" } }),
        { id, protectedRecord: record(2) },
      )
    )[0],
    null,
  );
  await unchanged("managed folder worker placement is enforced", {
    op: "tunnel-managed-register",
    input: input({
      projectId: "folder",
      destination: { ...tcp, workerId: "beta" },
    }),
    protected: { id, protectedRecord: record(2) },
  });
  await unchanged("local Git ready-source placement is enforced", {
    op: "tunnel-managed-register",
    input: input({
      projectId: "local-git",
      destination: { ...tcp, workerId: "�" },
    }),
    protected: { id, protectedRecord: record(2) },
  });
  await seed(
    `UPDATE tunnels SET active_connection_count=3,bytes_from_source=11,bytes_to_source=17,error_code='fixture-old-error' WHERE id=${literal(id)}`,
  );
  const updatedPrivateRows = await register(
    "managed update advances protected revision and preserves identity/counters",
    input({
      destination: tcp,
      status: "active",
      management: "managed-ephemeral",
    }),
    { id, protectedRecord: record(2) },
  );
  const [updated] = updatedPrivateRows;
  for (let i = 0; i < 2; i++) {
    assert.equal(updatedPrivateRows[i].id, createdPrivateRows[i].id);
    assert.equal(
      updatedPrivateRows[i].createdAt,
      createdPrivateRows[i].createdAt,
    );
    assert.equal(
      updatedPrivateRows[i].position,
      createdPrivateRows[i].position,
    );
  }
  assert.equal(updated.position, privateRow.position);
  assert.equal(updated.createdAt, privateRow.createdAt);
  assert.equal(updated.activeConnectionCount, 3);
  assert.equal(updated.errorCode, null);
  assert.equal(updated.protectedRecord.revision, 2);
  const [publicUpdate] = await register(
    "unprotected public update preserves previous protected record",
    input(),
  );
  assert.deepEqual(publicUpdate.protectedRecord, updated.protectedRecord);
  assert.deepEqual(publicUpdate.destination, input().destination);
  await register(
    "listener endpoint is stripped to routing metadata",
    input({
      source: {
        kind: "worker-listener",
        workerId: "alpha",
        host: "::1",
        port: 12345,
      },
    }),
    { id, protectedRecord: record(3) },
  );
  const [listener] = await get("read listener managed tunnel");
  assert.deepEqual(listener.source, {
    kind: "worker-listener",
    workerId: "alpha",
  });
  assert.ok(
    !JSON.stringify(
      await snapshot("managed private endpoints remain opaque"),
    ).includes('"host"'),
  );
  await register(
    "same managed identity is isolated by owner",
    input({ projectId: "other", destination: { ...tcp, workerId: "foreign" } }),
    { id: foreignId, protectedRecord: record(1) },
    { databaseDefaults: true },
    { owner: other },
  );
  assert.equal(
    (await get("foreign owner selects its own tuple", { owner: other }))[0].id,
    foreignId,
  );
  assert.equal((await get("original owner retains its tuple"))[0].id, id);
  assert.equal(
    (await remove("remove foreign tuple only", { owner: other }))[0],
    true,
  );
  assert.equal(
    (
      await get("managed lookup does not address ordinary user tunnel IDs", {
        managedBy: { kind: "system", id: tunnelIds.main },
      })
    )[0],
    null,
  );
  assert.equal(
    (
      await remove("managed removal does not delete ordinary user tunnel IDs", {
        managedBy: { kind: "system", id: tunnelIds.main },
      })
    )[0],
    false,
  );
  assert.equal(
    (
      await register(
        "registration retains source identity across protected updates",
        input(),
        { id, protectedRecord: record(4) },
      )
    )[0].id,
    id,
  );
  await seed(
    `UPDATE tunnels SET protected_revision=2147483647 WHERE id=${literal(id)}`,
  );
  await unchanged(
    "managed revision overflow is a real database failure",
    {
      op: "tunnel-managed-register",
      input: input(),
      protected: { id, protectedRecord: record(2147483648) },
    },
    { diagnostic: false, databaseCode: "22003" },
  );
  await seed(`UPDATE tunnels SET protected_revision=4 WHERE id=${literal(id)}`);
  await seed(
    `INSERT INTO tunnel_attachments(id,tunnel_id,kind,client_id,status,created_at,updated_at) VALUES('managed-cascade-attachment',${literal(id)},'desktop-loopback','managed-client','active',${literal(stamp)},${literal(stamp)})`,
  );
  await seed(
    `INSERT INTO tunnel_attachment_direct_leases(capability_id,attachment_id,lease_expires_at,status,created_at,updated_at) VALUES('managed-cascade-lease','managed-cascade-attachment','2030-01-01','active',${literal(stamp)},${literal(stamp)})`,
  );
  assert.equal(
    (
      await remove(
        "managed removal cascades active attachments and direct leases",
      )
    )[0],
    true,
  );
  const cascaded = await snapshot("managed cascade is durable");
  for (const state of cascaded) {
    assert.ok(
      !state.attachments.some((row) => row.id === "managed-cascade-attachment"),
    );
    assert.ok(
      !(state.leases ?? []).some(
        (row) => row.capability_id === "managed-cascade-lease",
      ),
    );
  }
  await seed(
    "ALTER TABLE tunnel_attachments RENAME COLUMN secret_hash TO managed_hidden_hash",
  );
  await register(
    "managed post-write projection fails after committed insert",
    input({ destination: tcp }),
    { id, protectedRecord: record(1) },
    { rejected: true, diagnostic: false, databaseCode: "42703" },
  );
  for (const state of await snapshot(
    "failed managed projection retains committed row",
  )) {
    const row = state.tunnels.find((row) => row.id === id);
    assert.equal(row.protected_revision, 1);
    assert.deepEqual(row.protected_content, tunnelRecord.protectedContent);
  }
  assert.equal(
    (
      await remove("managed delete ignores unrelated missing projection column")
    )[0],
    true,
  );
  await seed(
    "ALTER TABLE tunnel_attachments RENAME COLUMN managed_hidden_hash TO secret_hash",
  );
  await seed(
    `UPDATE tunnels SET position=2147483647 WHERE id=${literal(tunnelIds.main)}`,
  );
  await register(
    "managed position overflow is a real insert failure",
    input(),
    { id, protectedRecord: record(1) },
    { rejected: true, diagnostic: false, databaseCode: "22003" },
  );
  await seed(
    `UPDATE tunnels SET position=0 WHERE id=${literal(tunnelIds.main)}`,
  );
  await snapshot("managed repository cases leave baseline catalog intact");
}
