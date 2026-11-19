import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import * as definitions from "../../packages/protocol/dist/run-configuration-definitions.js";
import * as secrets from "../../packages/protocol/dist/run-configuration-secrets.js";
import { verifyCargoRunProvider } from "./cargo-run-provider-smoke.mjs";
import { verifyDartRunProvider } from "./dart-run-provider-smoke.mjs";
import { verifyFlutterRunProvider } from "./flutter-run-provider-smoke.mjs";
import { cliConnection, verifyHostCli } from "./host-cli-smoke.mjs";
import { verifyJavaRunProvider } from "./java-run-provider-smoke.mjs";
import { verifyNodeRunProvider } from "./node-run-provider-smoke.mjs";

const operations = "/api/run-configuration-runtimes/operations";
const status = "/api/run-configuration-runtimes/status";
const output = "/api/run-configuration-runtimes/output";

export async function verifyHostRuns({
  call,
  eventually,
  projectId,
  checkout,
  ownerId,
  serverId,
  workerId,
  componentKey,
  restartWorker,
  cli,
  policyKey,
  explorerKeys,
  workerDirectory,
}) {
  const secret = "native-test-secret-🗝";
  const reference = "run/native-fixture";
  const protectedValue = await crypto.encryptProtectedSecret({
    ownerId,
    component: "run-content",
    table: "run_configuration_secrets",
    rowId: JSON.stringify([projectId, reference]),
    field: "protected_value",
    keyRevision: 1,
    componentKey,
    content: { version: 1, value: secret },
    contentSchema: secrets.runConfigurationSecretValueContentSchema,
    maximumBytes:
      secrets.RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  const stored = await call(
    "PUT",
    `/api/projects/${projectId}/run-configuration-secrets`,
    {
      operationId: randomUUID(),
      reference,
      protectedValue,
    },
  );
  assert.equal(stored.status, 201, JSON.stringify(stored));
  const envDir = path.join(checkout, ".codex", "environments");
  await mkdir(envDir, { recursive: true });
  await writeFile(
    path.join(envDir, "environment.toml"),
    `[setup]
script = '''
export LAYER=codex
export CODEX_MARKER=prepared
printf 'setup-ok\\n'
'''
`,
  );
  await writeFile(
    path.join(checkout, ".env.fixture"),
    "LAYER=file\nFILE_MARKER=file\n",
  );
  const fixture = (id, name, command, overrides = {}) =>
    definitions.runConfigurationFileSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id,
      name,
      provider: "shell",
      target: { kind: "command", command },
      options: { shell: "automatic", login: false },
      beforeLaunch: [{ kind: "command", command: "printf 'before-ok\\n'" }],
      environment: {
        includeCodexEnvironment: true,
        files: [".env.fixture"],
        variables: [{ name: "LAYER", value: "definition", enabled: true }],
        secrets: [{ name: "PRIVATE", secret: reference, enabled: true }],
      },
      stop: { gracePeriodMs: 200 },
      ...overrides,
    });
  const configurationId = randomUUID();
  const command = `printf 'generation=%s layers=%s:%s:%s\\n' "$CANTRIP_RUN_GENERATION" "$LAYER" "$FILE_MARKER" "$CODEX_MARKER"
printf 'private=%s\\n' "$PRIVATE"
printf 'process=%s\\n' "$$"
exec /bin/sleep 120`;
  const doc = fixture(configurationId, "Owned lifecycle", command);
  const save = async (document) => {
    const created = await call(
      "PUT",
      `/api/projects/${projectId}/run-configurations/${document.id}`,
      {
        operationId: randomUUID(),
        expectedRevision: null,
        document,
      },
    );
    assert.equal(created.status, 201, JSON.stringify(created));
    return created.body.result.entry.revision;
  };
  await save(doc);
  const intent = (operation, configurationId, operationId = randomUUID()) => ({
    operationId,
    projectId,
    configurationId,
    targetWorktreeId: null,
    operation,
  });
  const operate = async (request, expected) => {
    const result = await call("POST", operations, request);
    assert.equal(result.status, expected, JSON.stringify(result));
    return result.body;
  };
  const getStatus = async (id) => {
    const result = await call("POST", status, {
      operationId: randomUUID(),
      projectId,
      configurationId: id,
      targetWorktreeId: null,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body.runtimes[0];
  };
  const awaitState = (id, state, generation) =>
    eventually(
      () => getStatus(id),
      (runtime) => {
        assert.ok(runtime);
        assert.equal(runtime.state, state, JSON.stringify(runtime));
        if (generation !== undefined)
          assert.equal(runtime.generation, generation);
      },
      `Run ${state}`,
    );
  const readTail = async (runtime, tail = 100_000) => {
    const operationId = randomUUID();
    const result = await call("POST", output, {
      operationId,
      projectId,
      configurationId: runtime.configurationId,
      worktreeId: runtime.worktreeId,
      tail,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.generation, runtime.generation);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /private=|before-ok|generation=/u,
    );
    const context = {
      domain: "run-content",
      serverId,
      workerId: null,
      scopeId: JSON.stringify([projectId, runtime.worktreeId]),
      operationId,
      operation: "run.configuration.output",
      direction: "response",
      sequence: 0,
    };
    const plaintext = await crypto.decryptEndpointContentPayload({
      ownerId,
      context,
      keyRevision: 1,
      componentKey,
      opaque: result.body.protectedOutput,
    });
    return JSON.parse(new TextDecoder().decode(plaintext));
  };
  const readyOutput = (runtime) =>
    eventually(
      () => readTail(runtime),
      (tail) => {
        assert.match(
          tail.data,
          new RegExp(
            `generation=${runtime.generation} layers=definition:file:prepared`,
          ),
        );
        assert.match(tail.data, /setup-ok\r?\nbefore-ok/u);
        assert.match(tail.data, /private=••••/u);
        assert.ok(!tail.data.includes(secret));
        assert.match(tail.data, /process=\d+/u);
      },
      "owned PTY output with environment and secret redaction",
    );
  const getPid = (text) =>
    Number([...text.matchAll(/process=(\d+)/gu)].at(-1)[1]);

  const start = intent("start", configurationId);
  const started = await operate(start, 202);
  const running = await awaitState(configurationId, "running", 1);
  assert.equal(running.id, started.runtime.id);
  assert.equal((await operate(start, 200)).replayed, true);
  const first = await readyOutput(running);
  assert.equal(getPid(first.data) > 0, true);
  assert.equal((await readTail(running, 10)).truncated, true);

  const restart = intent("restart", configurationId);
  await operate(restart, 202);
  const restarted = await awaitState(configurationId, "running", 2);
  const second = await readyOutput(restarted);
  assert.match(second.data, /Restarting · generation 2/u);
  assert.notEqual(getPid(first.data), getPid(second.data));
  assert.throws(() => process.kill(getPid(first.data), 0), { code: "ESRCH" });

  const stop = intent("stop", configurationId);
  await operate(stop, 202);
  const idle = await awaitState(configurationId, "idle", 2);
  assert.equal(idle.signal, "15");
  assert.equal((await operate(stop, 200)).replayed, true);
  assert.throws(() => process.kill(getPid(second.data), 0), { code: "ESRCH" });

  const naturalId = randomUUID();
  const natural = fixture(
    naturalId,
    "Owned natural exit",
    "printf 'normal-exit\\n'; exit 7",
    {
      beforeLaunch: [],
      environment: { includeCodexEnvironment: false },
    },
  );
  const definitionRevision = await save(natural);
  await operate(intent("start", naturalId), 202);
  const exited = await awaitState(naturalId, "exited", 1);
  assert.equal(exited.exitCode, 7);
  const nativeOutput = await readTail(exited);
  assert.match(nativeOutput.data, /normal-exit/u);

  const { RunConfigurationRuntimeSupervisor } =
    await import("../../cantrip_worker/src/run-configuration-runtime-supervisor.ts");
  const oracle = new RunConfigurationRuntimeSupervisor({
    authorize: async () => ({ sourceRoot: checkout, targetRoot: checkout }),
    environment: { ...process.env, SHELL: "/bin/sh" },
  });
  try {
    const identity = {
      runtimeId: randomUUID(),
      projectId,
      configurationId: naturalId,
      worktreeId: exited.worktreeId,
      workerId,
      terminalId: randomUUID(),
      definitionRevision,
      codexEnvironmentRevision: null,
      generation: 1,
      operationId: randomUUID(),
    };
    const result = await oracle.start({
      type: "project.run-configuration-runtime.start",
      identity,
      rootKind: "git-root",
      sourcePath: checkout,
      targetPath: checkout,
      protectedSecrets: [],
    });
    assert.equal(result.outcome, "accepted");
    const referenceExit = await eventually(
      () => oracle.status(identity),
      (status) => assert.equal(status.observation?.state, "exited"),
      "Node supervisor natural exit",
    );
    assert.equal(referenceExit.observation.exitCode, exited.exitCode);
    const observed = oracle.output({
      type: "project.run-configuration-runtime.output",
      identity,
      requestOperationId: randomUUID(),
      tail: 100_000,
    });
    assert.deepEqual(nativeOutput, {
      data: observed.data,
      truncated: observed.truncated,
    });
    assert.equal(
      (await readFile(path.join(checkout, ".env.fixture"), "utf8")).includes(
        secret,
      ),
      false,
    );
  } finally {
    await oracle.closeAll();
  }

  await operate(intent("start", configurationId), 202);
  const active = await awaitState(configurationId, "running", 3);
  const current = await readyOutput(active);
  const previous = cli && (await cliConnection(workerDirectory));
  await restartWorker();
  assert.throws(() => process.kill(getPid(current.data), 0), { code: "ESRCH" });
  await awaitState(configurationId, "lost", 3);
  const providerFixture = {
    call,
    projectId,
    checkout,
    save,
    readTail,
    async launchAndWait(id, state) {
      await operate(intent("start", id), 202);
      return awaitState(id, state, 1);
    },
  };
  if (cli)
    await verifyHostCli({
      ...providerFixture,
      cli,
      previous,
      workerDirectory,
      workerId,
      ownerId,
      policyKey,
      explorerKeys,
    });
  await verifyNodeRunProvider(providerFixture);
  await verifyCargoRunProvider(providerFixture);
  await verifyDartRunProvider(providerFixture);
  await verifyFlutterRunProvider(providerFixture);
  await verifyJavaRunProvider(providerFixture);
}
