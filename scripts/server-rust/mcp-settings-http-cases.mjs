import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  encryptedMcpServerCreateSchema,
  encryptedMcpServerUpdateSchema,
} from "../../packages/protocol/dist/index.js";
import {
  settingsProject as project,
  settingsWorker as worker,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";
import { mcpSettingsWireFixtures } from "./mcp-settings-wire-fixtures.mjs";
import {
  mcpSettingsId as id,
  mcpSettingsKey as key,
} from "./mcp-settings-http-worker.mjs";
import { literal, json } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
import { LiveProbe } from "./live-sockets.mjs";

const queries = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/mcp-settings-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
).queries;
const globalRoute = "/api/settings/mcp-servers";
const projectRoute = `/api/projects/${project}/mcp-servers`;
const discovery = (local = false, selected = worker) =>
  local
    ? `/api/projects/${project}/mcp-discovery/${selected}`
    : `/api/settings/mcp-discovery/${selected}`;
const base = mcpSettingsWireFixtures().encryptedMcpServerCreateSchema[0];
const body = (n, patch = {}) => ({
  ...structuredClone(base),
  id: id(n),
  nameBlindIndex: key(n),
  ...patch,
});
const update = (input) => {
  const result = { ...input };
  delete result.id;
  return result;
};

export async function runMcpSettingsHttpCases({
  h,
  result,
  profile,
  controller: c,
  openRepository,
}) {
  let serial = 0;
  const call = (name, method, route, options) =>
    h.visit(`${serial++} ${name}`, method, route, options);
  const sql = (...statements) => h.fixture.sql(statements);
  async function snapshot() {
    const [value] = await h.fixture.sql(
      [],
      [
        "SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb)::text result FROM mcp_servers m",
      ],
    );
    return value;
  }
  async function unchanged(name, before) {
    assert.deepEqual(await snapshot(), before, name);
    result.durable.push({ name, unchanged: true, rows: before.length });
  }
  function queryFailure(raw, operation, scope, supplied, serverId) {
    const parsed =
      operation === "create"
        ? encryptedMcpServerCreateSchema.parse(supplied)
        : operation === "update"
          ? encryptedMcpServerUpdateSchema.parse(supplied)
          : null;
    const name = `${scope}-${operation}${operation === "update" ? `-${parsed.audience !== undefined}` : ""}`;
    const params =
      operation === "create"
        ? [
            parsed.id,
            h.owner,
            scope === "global" ? null : project,
            parsed.workerId,
            parsed.nameBlindIndex,
            JSON.stringify(parsed.protectedConfiguration),
            parsed.enabled,
            parsed.audience,
          ]
        : operation === "delete"
          ? [serverId, h.owner, ...(scope === "project" ? [project] : [])]
          : [
              parsed.workerId,
              parsed.nameBlindIndex,
              JSON.stringify(parsed.protectedConfiguration),
              parsed.enabled,
              ...(parsed.audience === undefined ? [] : [parsed.audience]),
            ];
    let timestamp;
    if (operation === "update") {
      const times = raw.error.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g);
      assert.equal(times?.length, 1);
      timestamp = times[0];
      assert.ok(Math.abs(Date.now() - Date.parse(timestamp)) < 15000);
      params.push(
        timestamp,
        serverId,
        h.owner,
        ...(scope === "project" ? [project] : []),
      );
    }
    assert.equal(
      raw.error,
      `Failed query: ${queries[name].sql}\nparams: ${params.join(",")}`,
    );
    // Alias only after checking the complete actual Source diagnostic and all
    // reflected parameters, including the generated current millisecond clock.
    result.observations.at(-1).body.error =
      `Failed query: ${queries[name].sql}\nparams: ${params.map((v) => (v === timestamp && timestamp ? "<verified SQL timestamp>" : h.fixture.normalize(v))).join(",")}`;
    result.sqlDiagnosticProofs++;
  }
  await call("global empty", "GET", globalRoute);
  await call("project empty", "GET", projectRoute);
  await call(
    "missing project list",
    "GET",
    "/api/projects/missing/mcp-servers",
    { status: 404 },
  );
  if (profile !== "none") {
    for (const route of [
      globalRoute,
      projectRoute,
      discovery(),
      discovery(true),
    ])
      await call("login required", "GET", route, {
        client: "stranger",
        status: 401,
      });
    for (const route of [globalRoute, projectRoute])
      for (const method of ["POST", "PUT", "DELETE"])
        await call(
          "CSRF required",
          method,
          route + (method === "POST" ? "" : "/" + id(1)),
          {
            json:
              method === "DELETE"
                ? undefined
                : method === "POST"
                  ? body(1)
                  : update(body(1)),
            csrf: false,
            status: 403,
          },
        );
  }
  const otherWorker = "mcp-owned-offline-worker";
  await sql(
    `INSERT INTO workers SELECT populated.* FROM workers original CROSS JOIN LATERAL jsonb_populate_record(NULL::workers,to_jsonb(original)||jsonb_build_object('id',${literal(otherWorker)})) populated WHERE original.id=${literal(worker)}`,
  );
  if (profile === "accounts") {
    const [other] = await h.fixture.sql(
      [],
      [
        "SELECT jsonb_build_object('owner',id)::text result FROM users WHERE email='other-settings@example.invalid'",
      ],
    );
    await sql(
      `INSERT INTO workers SELECT populated.* FROM workers original CROSS JOIN LATERAL jsonb_populate_record(NULL::workers,to_jsonb(original)||jsonb_build_object('id','mcp-foreign-worker','owner_id',${literal(other.owner)})) populated WHERE original.id=${literal(worker)}`,
    );
  }
  for (const [scope, route, offset] of [
    ["global", globalRoute, 0],
    ["project", projectRoute, 10],
  ]) {
    const input = body(1 + offset);
    const created = await call(`${scope} create defaults`, "POST", route, {
      status: 201,
      json: input,
    });
    assert.deepEqual(
      created.protectedConfiguration,
      input.protectedConfiguration,
    );
    assert.equal(created.audience, "ide");
    assert.equal(created.scope, scope);
    assert.equal(created.workerId, null);
    const bound = await call(
      `${scope} bind offline worker`,
      "PUT",
      route + "/" + input.id,
      {
        json: {
          ...update(input),
          workerId: otherWorker,
          enabled: false,
          audience: "both",
        },
      },
    );
    assert.equal(bound.workerId, otherWorker);
    assert.equal(bound.enabled, false);
    assert.equal(bound.audience, "both");
    const omitted = update(input);
    delete omitted.workerId;
    const saved = await call(
      `${scope} omitted audience preserved and omitted worker reset`,
      "PUT",
      route + "/" + input.id,
      { json: omitted },
    );
    assert.equal(saved.audience, "both");
    assert.equal(saved.workerId, null);
    assert.equal(saved.enabled, true);
    assert.equal(saved.createdAt, created.createdAt);
    assert.ok(Date.parse(saved.updatedAt) >= Date.parse(created.updatedAt));
    assert.deepEqual(
      await call(`${scope} opaque retained list`, "GET", route),
      [saved],
    );
    const opposite = scope === "global" ? projectRoute : globalRoute;
    await call(
      `${scope} cross-scope update`,
      "PUT",
      opposite + "/" + input.id,
      { json: update(input), status: 404 },
    );
    await call(
      `${scope} cross-scope delete`,
      "DELETE",
      opposite + "/" + input.id,
      { status: 404 },
    );
    if (profile === "accounts") {
      const foreignList = await call(`${scope} foreign list`, "GET", route, {
        client: "other",
        status: scope === "global" ? 200 : 404,
      });
      if (scope === "global") assert.deepEqual(foreignList, []);
      for (const method of ["PUT", "DELETE"])
        await call(
          `${scope} foreign mutation`,
          method,
          route + "/" + input.id,
          {
            client: "other",
            json: method === "PUT" ? update(input) : undefined,
            status: 404,
          },
        );
      await call(`${scope} foreign worker binding`, "POST", route, {
        json: body(2 + offset, { workerId: "mcp-foreign-worker" }),
        status: 409,
      });
    }
    await call(
      `${scope} missing binding checked before missing server`,
      "PUT",
      route + "/" + id(999),
      { json: { ...update(input), workerId: "missing" }, status: 409 },
    );
    await call(`${scope} missing worker create`, "POST", route, {
      json: body(2 + offset, { workerId: "missing" }),
      status: 409,
    });
    for (const invalid of [
      null,
      {},
      { ...input, enabled: undefined },
      { ...input, audience: null },
      { ...input, workerId: "" },
      { ...input, unknown: true },
      { ...input, protectedConfiguration: {} },
    ])
      await call(`${scope} invalid create`, "POST", route, {
        json: invalid,
        status: 400,
      });
    for (const invalid of [
      null,
      {},
      { ...update(input), enabled: undefined },
      { ...update(input), id: input.id },
      { ...update(input), audience: null },
    ])
      await call(`${scope} invalid update`, "PUT", route + "/" + input.id, {
        json: invalid,
        status: 400,
      });
    const before = await snapshot();
    for (const operation of ["create", "update", "delete"]) {
      await sql(
        "CREATE FUNCTION fixture_mcp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled MCP persistence failure'; END $$",
        `CREATE TRIGGER fixture_mcp_fail BEFORE ${operation === "create" ? "INSERT" : operation.toUpperCase()} ON mcp_servers FOR EACH ROW EXECUTE FUNCTION fixture_mcp_fail()`,
      );
      const inputBody =
          operation === "create" ? body(2 + offset) : update(input),
        raw = await call(
          `${scope} real SQL ${operation} failure`,
          operation === "create"
            ? "POST"
            : operation === "update"
              ? "PUT"
              : "DELETE",
          operation === "create" ? route : route + "/" + input.id,
          { json: operation === "delete" ? undefined : inputBody, status: 409 },
        );
      queryFailure(raw, operation, scope, inputBody, input.id);
      await unchanged(
        `${scope} failed ${operation} leaves every row unchanged`,
        before,
      );
      await sql(
        "DROP TRIGGER fixture_mcp_fail ON mcp_servers",
        "DROP FUNCTION fixture_mcp_fail()",
      );
    }
    await call(`${scope} delete`, "DELETE", route + "/" + input.id, {
      status: 204,
    });
    await call(`${scope} missing delete`, "DELETE", route + "/" + input.id, {
      status: 404,
    });
    await call(`${scope} missing update`, "PUT", route + "/" + input.id, {
      status: 404,
      json: update(input),
    });
    // A zero-row insert is distinct from a failed SQL statement.
    await sql(
      "CREATE FUNCTION fixture_mcp_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$",
      "CREATE TRIGGER fixture_mcp_skip BEFORE INSERT ON mcp_servers FOR EACH ROW EXECUTE FUNCTION fixture_mcp_skip()",
    );
    assert.deepEqual(
      await call(`${scope} insert no row`, "POST", route, {
        status: 409,
        json: input,
      }),
      { error: "Database returned no row after creating an MCP server." },
    );
    await sql(
      "DROP TRIGGER fixture_mcp_skip ON mcp_servers",
      "DROP FUNCTION fixture_mcp_skip()",
    );
    // Response validation runs after the write. Preserve Source's committed
    // opaque row even when that response fails, rather than inventing rollback.
    for (const operation of ["create", "update"]) {
      if (operation === "update")
        await call(`${scope} prepare output failure`, "POST", route, {
          json: input,
          status: 201,
        });
      await sql(
        "CREATE FUNCTION fixture_mcp_invalid_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.protected_configuration='{}'::jsonb; RETURN NEW; END $$",
        `CREATE TRIGGER fixture_mcp_invalid_output BEFORE ${operation === "create" ? "INSERT" : "UPDATE"} ON mcp_servers FOR EACH ROW EXECUTE FUNCTION fixture_mcp_invalid_output()`,
      );
      await call(
        `${scope} ${operation} malformed committed output`,
        operation === "create" ? "POST" : "PUT",
        operation === "create" ? route : route + "/" + input.id,
        {
          json:
            operation === "create"
              ? input
              : { ...update(input), audience: "chat" },
          status: 409,
        },
      );
      const persisted = await snapshot();
      assert.equal(persisted.length, 1);
      assert.deepEqual(persisted[0].protected_configuration, {});
      assert.equal(
        persisted[0].audience,
        operation === "create" ? "ide" : "chat",
      );
      await call(`${scope} list malformed stored output`, "GET", route, {
        status: 500,
      });
      await sql(
        "DROP TRIGGER fixture_mcp_invalid_output ON mcp_servers",
        "DROP FUNCTION fixture_mcp_invalid_output()",
      );
      await call(`${scope} repair opaque row`, "PUT", route + "/" + input.id, {
        json: update(input),
      });
      await call(
        `${scope} delete repaired row`,
        "DELETE",
        route + "/" + input.id,
        { status: 204 },
      );
      result.recovery.push({
        name: `${scope} ${operation} committed output failure and repair`,
        passed: true,
      });
    }
  }
  await call(
    "missing project create precedes missing worker",
    "POST",
    "/api/projects/missing/mcp-servers",
    { status: 404, json: body(50, { workerId: "missing" }) },
  );
  await call(
    "missing project update still checks worker",
    "PUT",
    "/api/projects/missing/mcp-servers/" + id(50),
    { status: 409, json: update(body(50, { workerId: "missing" })) },
  );
  await call(
    "missing project update without binding",
    "PUT",
    "/api/projects/missing/mcp-servers/" + id(50),
    { status: 404, json: update(body(50)) },
  );
  await call(
    "missing project delete is server not found",
    "DELETE",
    "/api/projects/missing/mcp-servers/" + id(50),
    { status: 404 },
  );
  for (const [index, route, scope, selected] of [
    [0, globalRoute, "global", null],
    [1, globalRoute, "global", worker],
    [2, projectRoute, "project", null],
    [3, projectRoute, "project", worker],
  ]) {
    const input = body(60 + index, {
      workerId: selected,
      nameBlindIndex: key(100),
    });
    await call(
      `${scope} distinct scope and binding uniqueness ${index}`,
      "POST",
      route,
      { json: input, status: 201 },
    );
    const duplicate = { ...input, id: id(70 + index) };
    queryFailure(
      await call(`${scope} duplicate blind index ${index}`, "POST", route, {
        json: duplicate,
        status: 409,
      }),
      "create",
      scope,
      duplicate,
    );
    const duplicateId = { ...input, nameBlindIndex: key(110 + index) };
    queryFailure(
      await call(`${scope} duplicate id ${index}`, "POST", route, {
        json: duplicateId,
        status: 409,
      }),
      "create",
      scope,
      duplicateId,
    );
  }
  await sql("DELETE FROM mcp_servers");
  for (const [scope, route, selectedProject] of [
    ["global", globalRoute, null],
    ["project", projectRoute, project],
  ]) {
    const values = Array.from(
      { length: 201 },
      (_, n) =>
        `(${literal(id(1000 + n))},${literal(h.owner)},${selectedProject ? literal(selectedProject) : "NULL"},${literal(key(n))},${json(base.protectedConfiguration)})`,
    );
    const insert =
      "INSERT INTO mcp_servers(id,owner_id,project_id,name_blind_index,protected_configuration) VALUES ";
    await sql(insert + values.slice(0, 200).join(","));
    assert.equal(
      (await call(`${scope} exact 200 list`, "GET", route)).length,
      200,
    );
    await sql(insert + values[200]);
    await call(`${scope} 201 list rejected without truncation`, "GET", route, {
      status: 500,
    });
    await sql("DELETE FROM mcp_servers");
  }
  // Real client-side envelopes round-trip unchanged, and the unchanged worker
  // can authenticate/decrypt the server's opaque runtime representation.
  for (const [n, route] of [
    [300, globalRoute],
    [301, projectRoute],
  ]) {
    const input = await c.body(n, { workerId: worker, audience: "both" });
    const created = await call("authenticated MCP create " + n, "POST", route, {
      json: input,
      status: 201,
    });
    await c.open(created);
    assert.deepEqual(
      created.protectedConfiguration,
      input.protectedConfiguration,
    );
    assert.equal((await c.openRuntime([created])).length, 1);
    const disabled = await call(
      "disable public metadata preserves encrypted content " + n,
      "PUT",
      route + "/" + input.id,
      { json: { ...update(input), enabled: false } },
    );
    await c.open(disabled);
    assert.deepEqual(
      disabled.protectedConfiguration,
      input.protectedConfiguration,
    );
    assert.deepEqual(await c.openRuntime([disabled]), []);
    await call(
      "delete authenticated round-trip MCP " + n,
      "DELETE",
      route + "/" + input.id,
      { status: 204 },
    );
  }
  for (const local of [false, true]) {
    const found = await call(
      "actual discovery " + local,
      "GET",
      discovery(local),
    );
    for (const candidate of found.candidates)
      await c.open(candidate.configuration);
    for (const [mode, status] of [
      ["wrong-worker", 200],
      ["invalid", 502],
      ["unknown", 502],
      ["unbound", 502],
      ["overflow", 502],
      ["failed", 502],
    ]) {
      c.setMode(mode);
      await call(`discovery ${local} ${mode}`, "GET", discovery(local), {
        status,
      });
    }
    c.setMode("normal");
    await call(
      "discovery missing worker " + local,
      "GET",
      discovery(local, "missing"),
      { status: 404 },
    );
    if (profile === "accounts")
      await call("discovery foreign worker " + local, "GET", discovery(local), {
        client: "other",
        status: 404,
      });
  }
  await call(
    "discovery missing project precedes worker",
    "GET",
    "/api/projects/missing/mcp-discovery/missing",
    { status: 404 },
  );
  await call(
    "discovery owned offline worker",
    "GET",
    discovery(false, otherWorker),
    { status: 503 },
  );
  await call(
    "discovery project without replica",
    "GET",
    discovery(true, otherWorker),
    { status: 409 },
  );
  await sql(
    `UPDATE project_worktrees SET lifecycle_state='removing' WHERE id=${literal(tree)}`,
  );
  await call(
    "discovery project without ready replica",
    "GET",
    discovery(true),
    { status: 409 },
  );
  await sql(
    `UPDATE project_worktrees SET lifecycle_state='ready' WHERE id=${literal(tree)}`,
  );
  // These five real HTTP writes share a name, with independent ciphertext
  // authenticated against each row. Selection must apply project + worker
  // priority after enabled/audience filtering, including an offline binding.
  for (const [n, route, workerId, audience, enabled] of [
    [400, globalRoute, null, "ide", true],
    [401, globalRoute, worker, "chat", true],
    [402, projectRoute, null, "both", true],
    [403, projectRoute, worker, "ide", true],
    [405, globalRoute, otherWorker, "both", false],
  ]) {
    const input = await c.body(n, {
      name: "shared-runtime-precedence",
      workerId,
      audience,
      enabled,
    });
    await c.open(
      await call("persist runtime MCP " + n, "POST", route, {
        json: input,
        status: 201,
      }),
    );
  }
  await sql(
    `UPDATE mcp_servers SET created_at='2026-10-25T00:00:00.123002Z' WHERE id=${literal(id(400))}`,
    `UPDATE mcp_servers SET created_at='2026-10-25T00:00:00.123001Z' WHERE id=${literal(id(401))}`,
  );
  const ordered = await call(
    "SQL microsecond order survives identical wire milliseconds",
    "GET",
    globalRoute,
  );
  const sameName = ordered.filter((row) => [id(400), id(401)].includes(row.id));
  assert.deepEqual(
    sameName.map((row) => row.id),
    [id(401), id(400)],
  );
  assert.equal(sameName[0].createdAt, "2026-10-25T00:00:00.123Z");
  assert.equal(sameName[0].createdAt, sameName[1].createdAt);
  await runMcpDiscoveryRecovery({
    h,
    result,
    profile,
    c,
    call,
    snapshot,
    unchanged,
    openRepository,
  });
  // Fail actual lookups after the worker is stopped, so the fault cannot be
  // mistaken for a heartbeat or command failure. Restore the owned tables even
  // when the compatibility assertion exposes a difference.
  for (const table of ["projects", "workers"]) {
    await sql(
      `ALTER TABLE ${table} RENAME TO fixture_mcp_unavailable_${table}`,
    );
    try {
      const queryName =
          table === "projects" ? "project-project-check" : "worker-lookup",
        params =
          table === "projects" ? [project, h.owner, 1] : [worker, h.owner, 1],
        target = table === "projects" ? projectRoute : globalRoute,
        input = body(51, { workerId: worker }),
        expected = `Failed query: ${queries[queryName].sql}\nparams: ${params.join(",")}`;
      const raw = await call(
        `actual ${table} lookup SQL failure`,
        "POST",
        target,
        { json: input, status: 409 },
      );
      assert.equal(raw.error, expected);
      result.observations.at(-1).body.error =
        `Failed query: ${queries[queryName].sql}\nparams: ${params.map((v) => h.fixture.normalize(v)).join(",")}`;
      result.sqlDiagnosticProofs++;
      await call(
        `${table} lookup read SQL failure`,
        "GET",
        table === "projects" ? projectRoute : discovery(),
        { status: 500 },
      );
      if (table === "workers") {
        const saved = await call(
          "worker binding update SQL failure",
          "PUT",
          globalRoute + "/" + id(400),
          { json: update(input), status: 409 },
        );
        assert.equal(saved.error, expected);
        result.observations.at(-1).body.error =
          `Failed query: ${queries[queryName].sql}\nparams: ${params.map((v) => h.fixture.normalize(v)).join(",")}`;
        result.sqlDiagnosticProofs++;
        const unicodeWorker = "\ud800",
          unicodeParams = [unicodeWorker, h.owner, 1];
        const unicode = await call(
          "worker query diagnostic preserves original UTF16",
          "POST",
          globalRoute,
          { json: body(52, { workerId: unicodeWorker }), status: 409 },
        );
        assert.equal(
          unicode.error,
          `Failed query: ${queries[queryName].sql}\nparams: ${unicodeParams.join(",")}`,
        );
        result.observations.at(-1).body.error =
          `Failed query: ${queries[queryName].sql}\nparams: ${unicodeParams.map((v) => h.fixture.normalize(v)).join(",")}`;
        result.sqlDiagnosticProofs++;
      }
    } finally {
      await sql(
        `ALTER TABLE fixture_mcp_unavailable_${table} RENAME TO ${table}`,
      );
    }
  }
}

async function runMcpDiscoveryRecovery({
  h,
  result,
  profile,
  c,
  call,
  snapshot,
  unchanged,
  openRepository,
}) {
  const client = h.fixture.client(),
    headers = {
      origin: "http://127.0.0.1:5173",
      cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
    gate = c.hold(),
    abort = new AbortController();
  const abandoned = fetch(h.fixture.server.origin + discovery(), {
    headers,
    signal: abort.signal,
  }).then(
    () => assert.fail("held discovery completed"),
    (error) => error,
  );
  await eventually(
    () => gate.requests,
    (n) => assert.equal(n, 1),
    15000,
  );
  abort.abort();
  assert.equal((await abandoned).name, "AbortError");
  // The accepted first request still owns its command slot after HTTP disconnect.
  const second = call("held second discovery", "GET", discovery(true));
  await eventually(
    () => gate.requests,
    (n) => assert.equal(n, 2),
    15000,
  );
  await call("held discovery limit", "GET", discovery(), { status: 429 });
  c.release();
  await second;
  await eventually(
    () => gate.completed,
    (n) => assert.equal(n, 2),
    15000,
  );
  await call("discovery after abandoned HTTP completion", "GET", discovery());
  if (profile === "none") {
    const timed = c.hold(),
      started = Date.now();
    await call("discovery exact production deadline", "GET", discovery(), {
      status: 502,
      timeoutMs: 25000,
    });
    assert.equal(timed.requests, 1);
    assert.ok(Date.now() - started >= 19500 && Date.now() - started < 25000);
    c.release();
    await eventually(
      () => timed.completed,
      (n) => assert.equal(n, 1),
      15000,
    );
    await call(
      "late discovery response does not corrupt next request",
      "GET",
      discovery(),
    );
    result.recovery.push({
      name: "real 20 second deadline and ignored late response",
      passed: true,
    });
  }
  h.worker.close();
  await eventually(
    async () => {
      const response = await fetch(h.fixture.server.origin + "/api/workers", {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      return (await response.json()).find((w) => w.workerId === worker).online;
    },
    (online) => assert.equal(online, false),
    15000,
  );
  await call("discovery after worker disconnect", "GET", discovery(), {
    status: 503,
  });
  await call(
    "project discovery after worker disconnect",
    "GET",
    discovery(true),
    { status: 503 },
  );
  const before = await snapshot(),
    saved = await call("MCP offline persisted list", "GET", globalRoute),
    local = await call(
      "project MCP offline persisted list",
      "GET",
      projectRoute,
    ),
    history = h.live.history.slice(),
    port = Number(new URL(h.fixture.server.origin).port);
  await h.live.close();
  await h.fixture.close();
  const repository = await openRepository();
  try {
    for (const owner of [h.owner, "unowned"])
      for (const selectedProject of [null, project, "missing"])
        for (const selectedWorker of [
          worker,
          "mcp-owned-offline-worker",
          "missing",
        ])
          for (const audience of ["ide", "chat"]) {
            const actual = await repository.request({
              op: "mcp-effective",
              owner,
              project: selectedProject,
              worker: selectedWorker,
              audience,
            });
            assert.equal(actual.rejected, false, actual.diagnostic);
            const winner =
              owner !== h.owner
                ? null
                : selectedProject === project
                  ? selectedWorker === worker && audience === "ide"
                    ? 403
                    : 402
                  : audience === "ide"
                    ? 400
                    : selectedWorker === worker
                      ? 401
                      : null;
            assert.deepEqual(
              actual.value.map((row) => row.id),
              winner === null ? [] : [id(winner)],
            );
            for (const row of actual.value) await c.open(row);
            assert.equal(
              (await c.openRuntime(actual.value)).length,
              winner === null ? 0 : 1,
            );
            result.effective.push({
              owner: owner === h.owner ? "owned" : "unowned",
              project: selectedProject,
              worker: selectedWorker,
              audience,
              ids: actual.value.map((row) => row.id),
            });
          }
  } finally {
    await repository.close();
  }
  await h.fixture.start({ port });
  h.live = await new LiveProbe(h.fixture).open();
  await h.live.initialized();
  h.live.history.unshift(...history);
  assert.deepEqual(
    await call("MCP retained through actual restart", "GET", globalRoute),
    saved,
  );
  assert.deepEqual(
    await call(
      "project MCP retained through actual restart",
      "GET",
      projectRoute,
    ),
    local,
  );
  await unchanged(
    "all opaque MCP rows and raw timestamps retained through restart",
    before,
  );
  result.recovery.push(
    {
      name: "disconnect owns accepted discovery and command slot",
      passed: true,
    },
    { name: "worker offline and actual server restart", passed: true },
  );
}
