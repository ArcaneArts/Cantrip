// Actual Source/native catalogs, feature ownership, attachments and leases.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import {
  targetStateSql,
  localOwner as owner,
  otherOwner as other,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
import {
  tunnelStateSql,
  tunnelIds as tunnels,
  attachmentIds as attachments,
  tunnelRecord,
  tunnelNow,
  tunnelExpiry,
  secretExpiry,
} from "./tunnel-state.mjs";
import { tunnelRepositoryLocks } from "./tunnel-repository-locks.mjs";
import { tunnelCatalogLocks } from "./tunnel-catalog-locks.mjs";
import { tunnelManagedCases } from "./tunnel-managed-cases.mjs";
import { tunnelManagedLocks } from "./tunnel-managed-locks.mjs";
import {
  tunnelCatalogCases,
  catalogEarlierDate,
} from "./tunnel-catalog-cases.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite",
  reportPath = option("--report"),
  started = Date.now();
const root = await mkdtemp(path.join(tmpdir(), "cantrip-tunnel-repository-")),
  pair = [],
  urls = [],
  aliases = [new Map(), new Map()],
  defaultUpdates = [new Map(), new Map()];
const report = {
  suite: "actual-tunnel-attachment-repository",
  databaseMode,
  completeReplacement: false,
  cases: [],
  snapshots: [],
};
let executable,
  pg,
  failure,
  clock = tunnelNow;
const open = (kind, i) =>
  repositoryFixture({
    kind,
    executable,
    root,
    databaseMode,
    databaseUrl: urls[i],
  });
const seed = async (sql) => {
  for (const repo of pair) await repo.seed(sql);
};
function normalize(value, index, key = "") {
  if (Array.isArray(value)) {
    const normalized = value.map((v) => normalize(v, index));
    // Raw state is selected by generated ID. Canonicalize that unordered
    // snapshot after identity aliasing; public catalog ordering is untouched.
    return key === "tunnels"
      ? normalized.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : normalized;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, index, k)]),
    );
  if (typeof value !== "string") return value;
  if (aliases[index].has(value)) return aliases[index].get(value);
  if (
    [
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
      "lastSeenAt",
      "last_seen_at",
      "expiresAt",
      "expires_at",
      "secretExpiresAt",
      "secret_expires_at",
      "lease_expires_at",
      "finalized_at",
    ].includes(key) ||
    (!key && /^\d{4}-\d\d-\d\dT/.test(value))
  ) {
    const at = Date.parse(value);
    assert.ok(Number.isFinite(at), "real timestamp " + key);
    if (
      ["createdAt", "created_at"].includes(key) &&
      ![Date.parse(stamp), Date.parse(catalogEarlierDate)].includes(at)
    ) {
      assert.ok(
        at === Date.parse(clock) ||
          (at >= started - 1000 && at <= Date.now() + 1000),
        "database-default timestamp is the Source test clock or the native wall clock",
      );
      return "<database-default-created-time>";
    }
    if (
      ["updatedAt", "updated_at"].includes(key) &&
      defaultUpdates[index].has(at)
    )
      return defaultUpdates[index].get(at);
    return new Date(at).toISOString();
  }
  return value;
}
async function compare(label, operation = {}, options = {}) {
  const requests = [0, 1].map((i) => ({
    owner,
    attachment: attachments.main,
    now: clock,
    ...(typeof operation === "function" ? operation(i) : operation),
  }));
  const values = await Promise.all(pair.map((r, i) => r.request(requests[i])));
  report.cases.push({ label, requests, values });
  assert.equal(
    values[0].rejected,
    options.rejected ?? false,
    "Actual Source outcome " + label,
  );
  if (options.databaseCode)
    for (const value of values)
      assert.equal(
        value.databaseCode,
        options.databaseCode,
        label + " actual database SQLSTATE",
      );
  if (options.capture)
    for (let i = 0; i < 2; i++) {
      if (options.captureField === "id")
        assert.match(
          values[i].value.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      aliases[i].set(
        values[i].value[options.captureField ?? "attachmentId"],
        options.capture,
      );
    }
  if (options.databaseDefaults)
    for (let i = 0; i < 2; i++) {
      assert.equal(values[i].rejected, false, label + " creates a real row");
      for (const key of ["createdAt", "updatedAt"]) {
        const at = Date.parse(values[i].value[key]);
        assert.ok(
          at === Date.parse(clock) ||
            (at >= started - 1000 && at <= Date.now() + 1000),
          label +
            " " +
            key +
            " is the actual JS-hosted database clock or native database wall time",
        );
        if (key === "updatedAt") defaultUpdates[i].set(at, clock);
      }
    }
  const observable = (v, i) =>
    v.rejected
      ? {
          rejected: true,
          ...(options.diagnostic === false ? {} : { diagnostic: v.diagnostic }),
        }
      : { rejected: false, value: normalize(v.value, i) };
  assert.deepEqual(observable(values[1], 1), observable(values[0], 0), label);
  return values.map((v) => v.value);
}
async function snapshot(label) {
  const values = await Promise.all(
    pair.map((r) =>
      r.request({
        op: "query-json",
        sql: "SELECT jsonb_build_object('tunnels',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tunnels t),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tunnel_id,client_id,id) FROM tunnel_attachments a),'leases',(SELECT jsonb_agg(to_jsonb(l) ORDER BY capability_id) FROM tunnel_attachment_direct_leases l)) result",
      }),
    ),
  );
  values.forEach((v) => assert.equal(v.rejected, false));
  report.snapshots.push({ label, values });
  assert.deepEqual(
    normalize(values[1].value, 1),
    normalize(values[0].value, 0),
    label,
  );
  return values.map((v) => v.value);
}
const get = (label, extra = {}) =>
  compare(label, { op: "tunnel-attachment-get", ...extra });
const direct = (op, label, extra = {}) =>
  compare(label, {
    op: "tunnel-direct-" + op,
    capability: "capability-one",
    expires: "2027-01-01T00:00:00.000Z",
    secret: secretExpiry,
    ...extra,
  });
const rotate = (label, client = "client-main", extra = {}, options) =>
  compare(
    label,
    {
      op: "tunnel-attachment-create",
      tunnel: tunnels.main,
      input: {
        clientId: client,
        expiresAt: tunnelExpiry,
        secretExpiresAt: secretExpiry,
        secretHash: "rotated-" + client,
        ...extra,
      },
    },
    options,
  );
try {
  executable = await buildRustExample("project-repository-fixture");
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const [i, kind] of ["node", "rust"].entries()) {
    if (pg && (kind === "node" || databaseMode === "postgres"))
      urls[i] = await pg.database();
    pair.push(await open(kind, i));
  }
  for (const sql of [...targetStateSql(), ...tunnelStateSql()]) await seed(sql);
  await tunnelManagedCases({ seed, compare, snapshot, owner, other });
  await seed("DELETE FROM tunnels");
  for (const sql of tunnelStateSql()) await seed(sql);
  await tunnelCatalogCases({ seed, compare, snapshot, owner, other });
  await seed("DELETE FROM tunnels");
  for (const sql of tunnelStateSql()) await seed(sql);
  await compare("real-clock production credential rotation", {
    op: "tunnel-attachment-create",
    realClock: true,
    tunnel: tunnels.main,
    input: {
      clientId: "client-main",
      expiresAt: tunnelExpiry,
      secretExpiresAt: secretExpiry,
      secretHash: "real-clock-rotation",
    },
  });
  await seed("DELETE FROM tunnels");
  for (const sql of tunnelStateSql()) await seed(sql);
  for (const status of [
    "starting",
    "active",
    "offline",
    "degraded",
    "stopping",
    "failed",
    "stopped",
  ]) {
    await seed(
      `UPDATE tunnel_attachments SET status=${literal(status)} WHERE id=${literal(attachments.main)}`,
    );
    const values = await get("authorization status " + status);
    assert.equal(values[0] !== null, status !== "stopped");
    await compare("secret authorization status " + status, {
      op: "tunnel-attachment-authorize",
      hash: "hash-main",
    });
  }
  await seed(
    `UPDATE tunnel_attachments SET status='offline' WHERE id=${literal(attachments.main)}`,
  );
  assert.equal(
    (await get("foreign owner is hidden", { owner: other }))[0],
    null,
  );
  assert.equal(
    (
      await get("foreign attachment is hidden", {
        attachment: attachments.foreign,
      })
    )[0],
    null,
  );
  assert.equal(
    (await get("missing attachment", { attachment: "missing" }))[0],
    null,
  );
  for (const [set, label] of [
    ["client_id=NULL", "null client"],
    ["client_id=''", "empty client"],
    ["secret_expires_at=NULL", "missing credential generation"],
    [`expires_at=${literal(clock)}`, "hard lifetime boundary"],
  ]) {
    await seed(
      `UPDATE tunnel_attachments SET ${set} WHERE id=${literal(attachments.main)}`,
    );
    assert.equal((await get(label))[0], null);
    await seed(
      `UPDATE tunnel_attachments SET client_id='client-main',secret_expires_at=${literal(secretExpiry)},expires_at=${literal(tunnelExpiry)} WHERE id=${literal(attachments.main)}`,
    );
  }
  await seed(
    `UPDATE tunnel_attachments SET secret_expires_at=${literal(clock)} WHERE id=${literal(attachments.main)}`,
  );
  assert.ok(
    (await get("owner authorization is independent of relay-secret expiry"))[0],
  );
  assert.equal(
    (
      await compare("relay credential at expiry is rejected", {
        op: "tunnel-attachment-authorize",
        hash: "hash-main",
      })
    )[0],
    null,
  );
  await seed(
    `UPDATE tunnel_attachments SET secret_expires_at=${literal(secretExpiry)} WHERE id=${literal(attachments.main)}`,
  );
  await compare("wrong relay hash", {
    op: "tunnel-attachment-authorize",
    hash: "wrong",
  });
  for (const value of [null, false, 0, "", 42, [], {}]) {
    await seed(
      `UPDATE tunnels SET protected_content=${json(value)} WHERE id=${literal(tunnels.main)}`,
    );
    await get("opaque protected content truthiness " + JSON.stringify(value));
  }
  await seed(
    `UPDATE tunnels SET protected_content=${json(tunnelRecord.protectedContent)},destination_kind='worker-adapter',destination_adapter='project-share',destination_resource_id='private-share' WHERE id=${literal(tunnels.main)}`,
  );
  await get("opaque managed adapter destination");
  await seed(
    `UPDATE tunnels SET destination_kind='worker-tcp',destination_adapter=NULL,destination_resource_id=NULL WHERE id=${literal(tunnels.main)}`,
  );
  for (const [key, tunnel] of Object.entries(tunnels))
    await compare(
      "attachment admission " + key,
      {
        op: "tunnel-attachment-create",
        tunnel,
        input: {
          clientId: "new-client-" + key,
          expiresAt: tunnelExpiry,
          secretExpiresAt: secretExpiry,
          secretHash: "new-hash-" + key,
        },
      },
      {
        capture: [
          "main",
          "placement",
          "ephemeralBrowser",
          "ephemeralShare",
        ].includes(key)
          ? "<new-" + key + ">"
          : undefined,
      },
    );
  await snapshot("admitted desktop attachment rows");
  await rotate("credential rotation preserves attachment identity");
  let values = await get("rotated generation");
  let secret = values[0].secretExpiresAt;
  assert.equal(secret, "2029-01-01T00:00:00.001Z");
  await rotate("same-clock rotation advances public generation", undefined, {
    secretExpiresAt: "2028-01-01T00:00:00.000Z",
  });
  secret = (await get("second rotated generation"))[0].secretExpiresAt;
  assert.equal(secret, "2029-01-01T00:00:00.002Z");
  await compare("old generation cannot activate", {
    op: "tunnel-attachment-activate",
    client: "client-main",
    secret: secretExpiry,
  });
  const beforeFailure = await snapshot("before a real recompute write failure");
  await seed(
    `ALTER TABLE tunnels ADD CONSTRAINT fixture_tunnel_activation_failure CHECK(id<>${literal(tunnels.main)} OR status<>'active')`,
  );
  await compare(
    "recompute failure rolls back attachment activation",
    { op: "tunnel-attachment-activate", client: "client-main", secret },
    { rejected: true, diagnostic: false },
  );
  assert.deepEqual(
    await snapshot(
      "failed transaction preserves all tunnel and attachment rows",
    ),
    beforeFailure,
  );
  await seed(
    "ALTER TABLE tunnels DROP CONSTRAINT fixture_tunnel_activation_failure",
  );
  values = await compare("matching generation activates", {
    op: "tunnel-attachment-activate",
    client: "client-main",
    secret,
  });
  let activated = values[0];
  assert.equal(activated, clock);
  values = await compare("same-clock activation advances marker", {
    op: "tunnel-attachment-activate",
    client: "client-main",
    secret,
  });
  assert.equal(Date.parse(values[0]), Date.parse(activated) + 1);
  let newer = values[0];
  assert.equal(
    (
      await compare("stale relay cannot mark new generation offline", {
        op: "tunnel-attachment-offline",
        secret,
        activated,
      })
    )[0],
    false,
  );
  assert.equal(
    (
      await compare("current relay can mark offline", {
        op: "tunnel-attachment-offline",
        secret,
        activated: newer,
      })
    )[0],
    true,
  );
  for (const expires of ["invalid", clock, "2020-01-01T00:00:00.000Z"])
    await direct("activate", "invalid or expired lease " + expires, {
      expires,
      secret,
    });
  await direct("activate", "direct lease activates independently of relay", {
    secret,
    expires: "2031-01-01T00:00:00.000Z",
  });
  await snapshot("active direct lease is bounded by attachment lifetime");
  await direct("activate", "duplicate direct activation never shortens lease", {
    secret,
  });
  await direct("renew", "renewal never shortens lease", { secret });
  await direct("renew", "foreign owner cannot renew", { owner: other });
  await direct("activate", "credential fence rejects stale direct activation", {
    capability: "stale-capability",
    secret: secretExpiry,
  });
  await direct("activate", "another attachment cannot adopt capability", {
    attachment: attachments.sibling,
    secret: secretExpiry,
  });
  await direct("finalize", "another attachment cannot finalize capability", {
    attachment: attachments.sibling,
  });
  await direct("finalize", "finalization retains bounded final report", {
    expires: "2031-01-01T00:00:00.000Z",
  });
  await direct("activate", "finalized capability cannot be resurrected", {
    secret,
  });
  await direct("renew", "finalized capability cannot renew");
  await snapshot("finalized lease state");
  await direct(
    "expire",
    "expiry removes finalized rows without spurious change",
    { at: tunnelExpiry },
  );
  await snapshot("expired finalized rows removed");
  await direct("activate", "second direct capability", {
    capability: "capability-two",
    secret,
    expires: "2027-01-01T00:00:00.000Z",
  });
  await direct("expire", "lease sweep returns changed attachments once", {
    at: "2027-01-01T00:00:00.000Z",
  });
  await snapshot("expired direct owner becomes offline");
  await direct("activate", "direct owner survives credential rotation", {
    capability: "capability-three",
    secret,
  });
  await rotate("rotation clamps existing leases", undefined, {
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  await snapshot(
    "rotation clamps direct lifetime without invalidating direct owner",
  );
  await compare("stale stop fence is rejected", {
    op: "tunnel-attachment-stop",
    expected: {
      activatedAt: null,
      expiresAt: tunnelExpiry,
      secretExpiresAt: secret,
    },
  });
  await snapshot("failed fence preserves all state");
  values = await get("current stop fence");
  const auth = values[0];
  await compare("current stop fence stops only attachment", {
    op: "tunnel-attachment-stop",
    preserve: true,
    expected: {
      activatedAt: null,
      expiresAt: auth.expiresAt,
      secretExpiresAt: auth.secretExpiresAt,
    },
  });
  await direct(
    "finalize",
    "late finalization cannot resurrect stopped attachment",
    { capability: "capability-three" },
  );
  await snapshot("stopped attachment removes direct leases");
  await compare("foreign stop is hidden", {
    op: "tunnel-attachment-stop",
    owner: other,
    attachment: attachments.sibling,
  });
  await compare("explicit error stop propagates", {
    op: "tunnel-attachment-stop",
    attachment: attachments.sibling,
    error: "attachment-expired",
  });
  await snapshot("terminal attachment stop state");
  await compare("hard expiry sweeps nonterminal attachments", {
    op: "tunnel-attachment-expire",
    at: tunnelExpiry,
  });
  await snapshot("hard expiry state");
  await seed(
    `UPDATE tunnel_attachments SET status='offline',expires_at='2026-10-28T00:00:00.000500Z' WHERE id=${literal(attachments.sibling)}`,
  );
  assert.deepEqual(
    (
      await compare(
        "microsecond legacy expiry retains exact source stop fence",
        { op: "tunnel-attachment-expire" },
      )
    )[0],
    [],
  );
  await snapshot("microsecond row cannot match a millisecond Date fence");
  await seed(
    `UPDATE tunnel_attachments SET expires_at='2026-10-28T00:00:00.000Z' WHERE id=${literal(attachments.sibling)}`,
  );
  assert.equal(
    (
      await compare("millisecond API expiry can be stopped", {
        op: "tunnel-attachment-expire",
      })
    )[0].length,
    1,
  );
  await compare("startup recovery after terminal attachments", {
    op: "tunnel-reset",
  });
  await snapshot(
    "startup retains terminal errors and deletes ephemeral shares",
  );
  for (const sql of [
    "DELETE FROM tunnel_attachment_direct_leases",
    "DELETE FROM tunnel_attachments",
    "DELETE FROM tunnels",
    ...tunnelStateSql(),
  ])
    await seed(sql);
  await seed(`UPDATE tunnels SET status='active',desired_state='started';`);
  await seed("UPDATE tunnel_attachments SET status='active'");
  await direct("activate", "live direct lease before restart");
  await compare("restart preserves live direct ownership", {
    op: "tunnel-reset",
  });
  await snapshot(
    "restart clears relay credentials but preserves live direct leases",
  );
  if (databaseMode === "postgres")
    await tunnelRepositoryLocks({ pair, urls, owner, report });
  if (databaseMode === "postgres")
    await tunnelCatalogLocks({ pair, urls, owner, report });
  if (databaseMode === "postgres")
    await tunnelManagedLocks({ pair, urls, owner, report });
  const retained = await snapshot("retained durable tunnel state");
  for (let i = 0; i < 2; i++) {
    await pair[i].close();
    pair[i] = await open(i === 0 ? "node" : "rust", i);
  }
  assert.deepEqual(await snapshot("reopen retains tunnel rows"), retained);
} catch (error) {
  failure = error;
  report.error = { message: error.message, stack: error.stack };
} finally {
  const outcomes = await Promise.allSettled(pair.map((r) => r.close()));
  const errors = outcomes
    .filter((r) => r.status === "rejected")
    .map((r) => r.reason);
  try {
    await pg?.close();
  } catch (e) {
    errors.push(e);
  }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Tunnel repository cleanup failed",
    );
  await rm(root, { recursive: true, force: true });
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    cases: report.cases.length,
    snapshots: report.snapshots.length,
    error: report.error?.message,
  }),
);
if (failure) throw failure;
