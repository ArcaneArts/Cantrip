import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { cantripOsRunLaunchSchema } from "../../packages/protocol/dist/cantrip-os-run.js";
import {
  RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
  runConfigurationSecretValueContentSchema,
} from "../../packages/protocol/dist/run-configuration-secrets.js";

const runtimes = "/api/run-configuration-runtimes";
const oldPlanner = "/usr/lib/cantrip-os-executor/run-plan.mjs";

export async function verifyGuestRuns({
  call,
  definition,
  request,
  binding,
  target,
  os,
  actual,
  data,
  serverId,
  hash,
  docker,
  container,
  key,
  eventually,
  crashWorker,
}) {
  const guest = (...args) =>
    docker("exec", "--user", String(actual.uid), container, ...args);
  const root = (...args) => docker("exec", "--user", "0", container, ...args);
  const projectId = binding.projectId;
  const ownerId = os.ownerId;
  const worktreeId = target.worktreeId;
  const configurationId = randomUUID();
  const reference = "run/guest-fixture";
  const secret = "guest-fixture-" + randomUUID();
  const protectedValue = await crypto.encryptProtectedSecret({
    ownerId,
    component: "run-content",
    table: "run_configuration_secrets",
    rowId: JSON.stringify([projectId, reference]),
    field: "protected_value",
    keyRevision: 1,
    componentKey: key,
    content: { version: 1, value: secret },
    contentSchema: runConfigurationSecretValueContentSchema,
    maximumBytes: RUN_CONFIGURATION_SECRET_PROTECTED_CONTENT_BYTES_LIMIT,
  });
  await call(
    "PUT",
    "/api/projects/" + projectId + "/run-configuration-secrets",
    {
      operationId: randomUUID(),
      reference,
      protectedValue,
    },
    201,
  );

  const setup = binding.guestPath + "/.codex/environments";
  await guest("mkdir", "-p", setup);
  const put = (file, contents) =>
    guest(
      "/bin/sh",
      "-ec",
      'printf "%s" "$2" > "$1"',
      "fixture",
      file,
      contents,
    );
  await put(
    setup + "/environment.toml",
    "[setup]\nscript = \"printf 'guest-setup 日本\\\\n'; export SETUP=primary\"\n",
  );
  await put(target.guestPath + "/.runtime", "TARGET=worktree\n");
  const created = await definition(
    request("write", {
      request: {
        expectedRevision: null,
        document: {
          schema: "cantrip.run-configuration",
          version: 1,
          id: configurationId,
          name: "Native guest Run lifecycle",
          provider: "shell",
          target: {
            kind: "command",
            command: [
              'printf "guest-generation=%s roots=%s:%s private=%s process=%s\\n" "$CANTRIP_RUN_GENERATION" "$SETUP" "$TARGET" "$PRIVATE" "$$"',
              "exec /bin/sleep 120",
            ].join("\n"),
          },
          environment: {
            includeCodexEnvironment: true,
            files: [".runtime"],
            secrets: [{ name: "PRIVATE", secret: reference, enabled: true }],
          },
          beforeLaunch: [
            {
              kind: "command",
              workingDirectory: ".",
              command:
                'printf "guest-before\\n" >> .launch-count; printf "guest-before\\n"',
            },
          ],
          stop: { gracePeriodMs: 200 },
        },
      },
    }),
  );
  assert.equal(created.result.result.outcome, "created");
  const fromBinding = {
    kind: "binding",
    bindingId: binding.id,
    bindingGeneration: binding.bindingGeneration,
    attachmentGeneration: os.attachmentGeneration,
    runtimeGeneration: os.runtimeGeneration,
  };
  const operate = (
    operation,
    osSource,
    operationId = randomUUID(),
    expected = 202,
  ) =>
    call(
      "POST",
      runtimes + "/operations",
      {
        projectId,
        configurationId,
        targetWorktreeId: worktreeId,
        operationId,
        operation,
        osSource,
      },
      expected,
    );
  const status = async (osSource, state, generation) =>
    eventually(async () => {
      const response = await call("POST", runtimes + "/status", {
        projectId,
        configurationId,
        targetWorktreeId: worktreeId,
        operationId: randomUUID(),
        osSource,
      });
      const runtime = response.runtimes[0];
      assert.ok(runtime, JSON.stringify(response));
      assert.equal(runtime.state, state, JSON.stringify(runtime));
      assert.equal(runtime.generation, generation, JSON.stringify(runtime));
      return runtime;
    });
  const output = (osSource, generation, answer) =>
    eventually(async () => {
      const operationId = randomUUID();
      const response = await call("POST", runtimes + "/output", {
        projectId,
        configurationId,
        worktreeId,
        operationId,
        osSource,
      });
      assert.equal(response.generation, generation);
      assert.doesNotMatch(
        JSON.stringify(response),
        /guest-generation=|guest-before|guest-setup/u,
      );
      const plaintext = await crypto.decryptEndpointContentPayload({
        ownerId,
        context: {
          domain: "run-content",
          serverId,
          workerId: null,
          scopeId: JSON.stringify([projectId, worktreeId]),
          operationId,
          operation: "run.configuration.output",
          direction: "response",
          sequence: 0,
        },
        keyRevision: 1,
        componentKey: key,
        opaque: response.protectedOutput,
      });
      const { data } = JSON.parse(new TextDecoder().decode(plaintext));
      assert.ok(
        !data.includes(secret),
        "Run output must redact the protected value",
      );
      const match = data.match(
        new RegExp(
          "guest-generation=" +
            generation +
            " roots=primary:worktree private=•••• process=(\\d+)",
          "u",
        ),
      );
      assert.ok(match, data);
      answer?.(data);
      return Number(match[1]);
    });
  const journal = async (runtimeId, generation) =>
    JSON.parse(
      await readFile(
        path.join(data, "os-run-generations", runtimeId, generation + ".json"),
        "utf8",
      ),
    );
  const processExists = async (pid) => {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    return (
      (await guest(
        "/bin/sh",
        "-c",
        'test -d "/proc/$1" && printf alive',
        "fixture",
        String(pid),
      ).catch(() => "")) === "alive"
    );
  };
  await root("mv", oldPlanner, oldPlanner + ".fixture");
  try {
    const operationId = randomUUID();
    const started = await operate("start", fromBinding, operationId);
    const osSource = { kind: "runtime", runtimeId: started.runtime.id };
    await status(osSource, "running", 1);
    assert.equal(
      (await operate("start", fromBinding, operationId, 200)).replayed,
      true,
    );
    const firstPid = await output(osSource, 1, (text) => {
      assert.match(text, /guest-setup 日本/u);
      assert.match(text, /guest-before/u);
    });
    assert.ok(await processExists(firstPid));
    const first = await journal(osSource.runtimeId, 1);
    assert.deepEqual(
      first.processes.map(({ phase, exited }) => [phase, exited]),
      [
        ["prepare", true],
        ["before-launch", true],
        ["runtime", false],
      ],
    );
    const {
      identity,
      definitions,
      target: capturedTarget,
      protectedSecrets,
    } = first;
    assert.equal(
      first.fingerprint,
      hash(
        cantripOsRunLaunchSchema.parse({
          identity,
          definitions,
          target: capturedTarget,
          protectedSecrets,
        }),
      ),
    );
    assert.ok(!JSON.stringify(first).includes(secret));

    await crashWorker();
    await status(osSource, "running", 1);
    assert.equal(await output(osSource, 1), firstPid);
    assert.deepEqual(await journal(osSource.runtimeId, 1), first);
    assert.equal(
      await guest("cat", target.guestPath + "/.launch-count"),
      "guest-before",
    );

    await operate("restart", osSource);
    await status(osSource, "running", 2);
    const secondPid = await output(osSource, 2);
    assert.notEqual(secondPid, firstPid);
    assert.equal(await processExists(firstPid), false);
    const ended = await journal(osSource.runtimeId, 1);
    assert.equal(ended.result.outcome, "interrupted");
    assert.ok(ended.processes.every(({ exited }) => exited));

    const stopOperation = randomUUID();
    await operate("stop", osSource, stopOperation);
    await status(osSource, "idle", 2);
    assert.equal(
      (await operate("stop", osSource, stopOperation, 200)).replayed,
      true,
    );
    assert.equal(await processExists(secondPid), false);
    const second = await journal(osSource.runtimeId, 2);
    assert.equal(second.result.outcome, "interrupted");
    assert.equal(second.stopRequested, true);
    assert.match(second.gracefulWriteId, /^[a-f0-9-]{36}$/u);
    assert.ok(second.processes.every(({ exited }) => exited));
    assert.equal(
      await guest("cat", target.guestPath + "/.launch-count"),
      "guest-before\nguest-before",
    );
  } finally {
    await root("mv", oldPlanner + ".fixture", oldPlanner);
    key.fill(0);
  }
  console.log(
    "Native guest Run lifecycle passed: encrypted output, exact restart recovery, replacement and stop.",
  );
}
