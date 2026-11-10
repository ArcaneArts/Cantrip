import assert from "node:assert/strict";
import captureQuery from "../../cantrip_server_rs/contracts/run-capture-query.json" with { type: "json" };
import {
  runConfigurationRuntimeStatusQuerySchema,
  runConfigurationRuntimeOutputQuerySchema,
  runConfigurationRuntimeLifecycleRequestSchema,
} from "../../packages/protocol/dist/run-configuration-runtime.js";
import {
  settingsProject,
  settingsTree,
  settingsWorker,
} from "./native-settings-http-fixture.mjs";
import {
  literal,
  json,
  stamp,
  osRoots,
  configuration,
  operation,
} from "./project-state-fixtures.mjs";

export async function runCaptureHttpCases(h, result, sql) {
  const ids = {
    worker: "66666666-6666-4666-8666-000000000101",
    os: "66666666-6666-4666-8666-000000000102",
    invalid: "66666666-6666-4666-8666-000000000103",
    missing: "66666666-6666-4666-8666-000000000104",
  };
  const before = (
    await sql(
      [],
      [
        "SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb)::text result FROM run_configuration_runtimes r",
      ],
    )
  )[0];
  assert.deepEqual(before, []);
  await sql(
    Object.entries(ids)
      .filter(([key]) => key !== "missing")
      .map(([key, id]) => {
        const roots =
          key === "worker"
            ? null
            : key === "os"
              ? osRoots
              : { ...osRoots, unexpectedCaptureField: "must-be-rejected" };
        const executionKey =
          key === "worker"
            ? "worker"
            : "cantrip-os:" + (key === "os" ? "a" : "b").repeat(64);
        return `INSERT INTO run_configuration_runtimes(id,owner_id,project_id,configuration_id,execution_key,os_execution,worktree_id,worker_id,definition_revision,requested_operation_id,state,ended_at,created_at,updated_at) VALUES(${literal(id)},${literal(h.owner)},${literal(settingsProject)},${literal(configuration)},${literal(executionKey)},${roots === null ? "NULL" : json(roots)},${literal(settingsTree)},${literal(settingsWorker)},'${"a".repeat(64)}',${literal(operation)},'exited',${literal(stamp)},${literal(stamp)},${literal(stamp)})`;
      }),
  );
  const snapshot = async () =>
    (
      await sql(
        [],
        [
          "SELECT jsonb_agg(to_jsonb(r) ORDER BY id)::text result FROM run_configuration_runtimes r",
        ],
      )
    )[0];
  const stored = await snapshot();
  result.captureProofs = { before: stored, sqlErrors: [] };
  const input = (runtimeId, overrides = {}) =>
    runConfigurationRuntimeStatusQuerySchema.parse({
      operationId: operation,
      projectId: settingsProject,
      configurationId: null,
      targetWorktreeId: null,
      runtimeId,
      limit: 256,
      ...overrides,
    });
  const visit = async (name, body, options = {}) =>
    h.visit(name, "POST", "/api/run-configuration-runtimes/status", {
      json: body,
      ...options,
    });
  for (const key of ["worker", "os"]) {
    const response = await visit(
      "public retained " + key + " runtime capture",
      input(ids[key]),
    );
    assert.equal(response.runtimes.length, 1);
    assert.equal(response.runtimes[0].id, ids[key]);
  }
  const invalidError = JSON.stringify(
    [
      {
        code: "unrecognized_keys",
        keys: ["unexpectedCaptureField"],
        path: [],
        message: 'Unrecognized key: "unexpectedCaptureField"',
      },
    ],
    null,
    2,
  );
  const rejected = await visit(
    "public invalid retained capture rejects",
    input(ids.invalid),
    { status: 502 },
  );
  assert.equal(rejected.error, invalidError);
  const sourceInput = (id, overrides = {}) =>
    input(undefined, {
      osSource: { kind: "runtime", runtimeId: id },
      ...overrides,
    });
  const selected = await visit(
    "public captured OS source",
    sourceInput(ids.os),
  );
  assert.equal(selected.runtimes[0].id, ids.os);
  const sourceFailure = await visit(
    "OS source preserves capture validation failure",
    sourceInput(ids.invalid),
    { status: 502 },
  );
  assert.equal(sourceFailure.error, invalidError);
  for (const id of [ids.worker, ids.missing]) {
    const conflict = await visit(
      "OS source expected target conflict " + id,
      sourceInput(id),
      { status: 409 },
    );
    assert.deepEqual(conflict, {
      code: "conflict",
      error: "The captured Linux Run was not found for this target.",
    });
  }
  const outputBody = runConfigurationRuntimeOutputQuerySchema.parse({
    operationId: operation,
    projectId: settingsProject,
    configurationId: configuration,
    worktreeId: settingsTree,
    osSource: { kind: "runtime", runtimeId: ids.invalid },
  });
  const outputFailure = await h.visit(
    "runtime output preserves capture validation failure",
    "POST",
    "/api/run-configuration-runtimes/output",
    { json: outputBody, status: 502 },
  );
  assert.equal(outputFailure.error, invalidError);
  const operationBody = runConfigurationRuntimeLifecycleRequestSchema.parse({
    operation: "stop",
    operationId: operation,
    projectId: settingsProject,
    configurationId: configuration,
    targetWorktreeId: settingsTree,
    osSource: { kind: "runtime", runtimeId: ids.invalid },
  });
  const operationFailure = await h.visit(
    "runtime operation preserves capture validation failure",
    "POST",
    "/api/run-configuration-runtimes/operations",
    { json: operationBody, status: 502 },
  );
  assert.equal(operationFailure.error, invalidError);
  const wrongProject = "11111111-1111-4111-8111-000000000001";
  for (const overrides of [
    { projectId: wrongProject },
    { configurationId: "77777777-7777-4777-8777-000000000001" },
    { targetWorktreeId: "33333333-3333-4333-8333-000000000001" },
  ]) {
    const empty = await visit(
      "public retained capture filter " + JSON.stringify(overrides),
      input(ids.worker, overrides),
    );
    assert.deepEqual(empty.runtimes, []);
  }
  const empty = await visit(
    "public absent retained capture",
    input(ids.missing),
  );
  assert.deepEqual(empty.runtimes, []);
  await visit(
    "capture validation precedes project filter",
    input(ids.invalid, { projectId: wrongProject }),
    { status: 502 },
  );
  await sql([
    "ALTER TABLE run_configuration_runtimes RENAME TO run_capture_hidden",
  ]);
  const sqlFailure = async (name, body, endpoint = "status") => {
    const response = await h.visit(
      name,
      "POST",
      "/api/run-configuration-runtimes/" + endpoint,
      { json: body, status: 502 },
    );
    const id = body.runtimeId ?? body.osSource.runtimeId;
    const expected =
      "Failed query: " +
      captureQuery.sql +
      "\nparams: " +
      [id, h.owner, 1].join(",");
    assert.equal(
      response.error,
      expected,
      "Actual query and owned parameters: " + name,
    );
    result.captureProofs.sqlErrors.push({
      name,
      error: response.error,
      owner: h.owner,
      runtimeId: id,
    });
    result.observations.at(-1).body.error =
      "Failed query: " +
      captureQuery.sql +
      "\nparams: " +
      [id, "<verified capture owner>", 1].join(",");
  };
  try {
    await sqlFailure("public capture actual SQL failure", input(ids.worker));
    await sqlFailure(
      "public OS source actual SQL failure",
      sourceInput(ids.os),
    );
    await sqlFailure(
      "runtime output actual capture SQL failure",
      outputBody,
      "output",
    );
    await sqlFailure(
      "runtime operation actual capture SQL failure",
      operationBody,
      "operations",
    );
  } finally {
    await sql([
      "ALTER TABLE run_capture_hidden RENAME TO run_configuration_runtimes",
    ]);
  }
  const recovered = await visit(
    "public capture recovers after SQL failure",
    input(ids.worker),
  );
  assert.equal(recovered.runtimes[0].id, ids.worker);
  if (result.profile !== "none") {
    await visit("retained capture requires authentication", input(ids.worker), {
      client: "anonymous",
      status: 401,
    });
    await visit("retained capture requires CSRF", input(ids.worker), {
      csrf: false,
      status: 403,
    });
  }
  if (result.profile === "accounts") {
    const foreign = await visit(
      "foreign invalid capture remains invisible",
      input(ids.invalid),
      { client: "other" },
    );
    assert.deepEqual(foreign.runtimes, []);
  }
  const after = await snapshot();
  result.captureProofs.after = after;
  assert.deepEqual(
    after,
    stored,
    "Public capture reads retain exact rows and clocks",
  );
  const receipts = (
    await sql(
      [],
      [
        "SELECT count(*)::text result FROM run_configuration_runtime_operations",
      ],
    )
  )[0];
  assert.equal(
    receipts,
    0,
    "Rejected captures do not admit operation receipts",
  );
  result.captureProofs.receipts = receipts;
  await sql([
    `DELETE FROM run_configuration_runtimes WHERE id IN (${Object.values(ids).map(literal).join(",")})`,
  ]);
}
