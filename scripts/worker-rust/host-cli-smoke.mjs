import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationFileSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";
import { verifyHostCliExplorer } from "./host-cli-explorer-smoke.mjs";
import { verifyHostCliPolicies } from "./host-cli-policy-smoke.mjs";

export async function cliConnection(workerDirectory) {
  const file = path.join(workerDirectory, "cli-connection.json");
  const source = await readFile(file, "utf8");
  if (process.platform !== "win32") {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  const document = JSON.parse(source);
  assert.deepEqual(Object.keys(document), [
    "version",
    "endpoint",
    "serverUrl",
    "sessionToken",
    "workerId",
  ]);
  assert.equal(document.version, 1);
  assert.match(document.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(document.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(source, /ctwk_/u);
  return document;
}

async function handshake(endpoint, token) {
  const response = await fetch(`${endpoint}/v1/handshake`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { status: response.status, body: await response.json() };
}

export async function verifyHostCli({
  cli,
  previous,
  workerDirectory,
  workerId,
  projectId,
  ownerId,
  policyKey,
  explorerKeys,
  checkout,
  call,
  save,
  launchAndWait,
  readTail,
}) {
  const connection = await cliConnection(workerDirectory);
  assert.equal(connection.workerId, workerId);
  assert.notEqual(connection.sessionToken, previous.sessionToken);
  assert.deepEqual(
    await handshake(connection.endpoint, previous.sessionToken),
    {
      status: 401,
      body: { error: "Unauthorized" },
    },
  );
  if (previous.endpoint !== connection.endpoint) {
    await assert.rejects(
      handshake(previous.endpoint, previous.sessionToken),
      (error) => error.cause?.code === "ECONNREFUSED",
    );
  }

  const { CantripCliBroker } =
    await import("../../cantrip_worker/src/cli-broker.ts");
  const dataDirectory = path.join(path.dirname(workerDirectory), "oracle-cli");
  await mkdir(dataDirectory);
  const oracle = new CantripCliBroker(
    {
      dataDirectory,
      serverUrl: connection.serverUrl,
      workerId,
      token: "oracle-unused",
    },
    { binary: cli },
  );
  const savedEnvironment = {
    PATH: process.env.PATH,
    CANTRIP_CLI_CONNECTION: process.env.CANTRIP_CLI_CONNECTION,
  };
  try {
    const reference = await oracle.start();
    assert.deepEqual(
      await handshake(connection.endpoint, connection.sessionToken),
      await handshake(reference.endpoint, reference.sessionToken),
    );
    assert.deepEqual(
      await handshake(connection.endpoint),
      await handshake(reference.endpoint),
    );
  } finally {
    await oracle.close();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const fixture = (
    name,
    command,
    environment = { includeCodexEnvironment: false },
  ) =>
    runConfigurationFileSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name,
      provider: "shell",
      target: { kind: "command", command },
      options: { login: false },
      environment,
    });
  const run = async (document) => {
    await save(document);
    const result = await launchAndWait(document.id, "exited");
    const output = (await readTail(result)).data;
    assert.equal(result.exitCode, 0, output);
    return output;
  };
  const source = fixture(
    "Output for the native CLI",
    "printf 'cli-read-test\\n'",
  );
  await run(source);
  const reference = "cli/fixture-token";
  const secret = "owned-test-value-🗝";
  const command = [
    "set -e",
    "command -v cantrip >/dev/null",
    "cantrip --json status > .cantrip-cli-fixture-status",
    `cantrip --json run logs '${source.id}' > .cantrip-cli-fixture-logs`,
    `printf '%s' '${secret}' | cantrip --json run secret set '${reference}' > .cantrip-cli-fixture-secret`,
    "printf 'cli-end-to-end\\n'",
  ].join("\n");
  const ran = await run(fixture("Run invoking the native CLI", command));
  assert.match(ran, /cli-end-to-end/u);
  const read = async (name) =>
    JSON.parse(
      await readFile(
        path.join(checkout, `.cantrip-cli-fixture-${name}`),
        "utf8",
      ),
    );
  const observed = await read("status");
  assert.equal(
    observed.target?.projectId ?? observed.data.context.projectId,
    projectId,
  );
  const terminalId = observed.data.context.terminalId;
  assert.equal(typeof terminalId, "string");
  const logs = await read("logs");
  assert.equal(logs.data.configurationId, source.id);
  assert.match(logs.data.data, /cli-read-test/u);
  assert.equal(logs.data.protectedOutput, undefined);
  const stored = await read("secret");
  assert.equal(stored.data.secret.reference, reference);
  assert.equal(stored.data.secret.available, true);
  assert.ok(!JSON.stringify(stored).includes(secret));

  const discovered = await call(
    "GET",
    `/api/projects/${projectId}/run-configuration-secrets`,
  );
  assert.equal(discovered.status, 200, JSON.stringify(discovered));
  assert.ok(JSON.stringify(discovered.body).includes(reference));
  assert.ok(!JSON.stringify(discovered.body).includes(secret));

  const workerCredential = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-credential.json"),
      "utf8",
    ),
  );
  const core = async (command, arguments_) => {
    const response = await fetch(connection.serverUrl + "/api/internal/cli", {
      method: "POST",
      headers: {
        authorization: "Bearer " + workerCredential.credential,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command,
        context: { selection: "lane", terminalId },
        requestId: randomUUID(),
        workerId,
        arguments: arguments_,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() };
  };
  const conflict = await core("run.secret-set", {
    reference,
    expectedProjectId: randomUUID(),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "conflict");

  await verifyHostCliPolicies({
    call,
    core,
    projectId,
    ownerId,
    checkout,
    componentKey: policyKey,
    run: (command) =>
      run(fixture("Run invoking protected CLI policy commands", command)),
  });

  await verifyHostCliExplorer({
    call,
    core,
    cli,
    connection,
    terminalId,
    projectId,
    ownerId,
    checkout,
    workerDirectory,
    ...explorerKeys,
    run: (command) =>
      run(fixture("Run invoking protected CLI Explorer commands", command)),
  });

  const consumed = await run(
    fixture(
      "Run consuming the CLI-protected secret",
      `test "$CLI_SECRET" = '${secret}' && printf 'cli-secret-opened:%s\\n' "$CLI_SECRET"`,
      {
        includeCodexEnvironment: false,
        secrets: [{ name: "CLI_SECRET", secret: reference, enabled: true }],
      },
    ),
  );
  assert.match(consumed, /cli-secret-opened:/u);
  assert.ok(!consumed.includes(secret));
}
