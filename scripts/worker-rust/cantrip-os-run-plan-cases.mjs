import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { OsRunExecution } from "../../tests/reference-node-worker/src/os-executor/run-execution.ts";
import { CantripOsController } from "../../tests/reference-node-worker/src/os-executor/controller.ts";
import {
  openRunConfigurationSecretValue,
  protectRunConfigurationSecretValue,
} from "../../tests/reference-node-worker/src/run-configuration-secret-encryption.ts";
import { osRunPlanResponseSchema } from "../../packages/protocol/dist/index.js";

const helper = "/usr/lib/cantrip-os-executor/cantrip-os-run-definitions";
const legacy = "/usr/lib/cantrip-os-executor/run-plan.mjs";

export async function verifyRunPlan({
  definition,
  request,
  binding,
  target,
  workspace,
  os,
  actual,
  data,
  workerId,
  serverId,
  docker,
  container,
}) {
  const guest = (...args) =>
    docker("exec", "--user", String(actual.uid), container, ...args);
  const compare =
    (await guest(
      "/bin/sh",
      "-c",
      'if test -f "$1"; then printf yes; fi',
      "fixture",
      legacy,
    )) === "yes";
  const put = (file, data) =>
    guest("/bin/sh", "-ec", 'printf "%s" "$2" > "$1"', "fixture", file, data);
  const sourceRoot = binding.guestPath;
  const targetRoot = target.guestPath;
  await guest("mkdir", "-p", sourceRoot + "/.codex/environments");
  await put(
    sourceRoot + "/.codex/environments/environment.toml",
    "[setup]\nscript = \"printf 'setup 日本\\\\n'; export FROM_SETUP=shared; export PRECEDENCE=setup\"\n",
  );
  await put(
    targetRoot + "/.env",
    "FROM_FILE=target-file\nPRECEDENCE=file\nCANTRIP_RUN_GENERATION=overridden\nDOTENV.KEY=dotted\n",
  );
  const configurationId = randomUUID();
  const result = await definition(
    request("write", {
      request: {
        document: {
          schema: "cantrip.run-configuration",
          version: 1,
          id: configurationId,
          name: "Native guest setup",
          provider: "shell",
          target: {
            kind: "command",
            command:
              'printf "ready %s %s %s %s %s\n" "$FROM_SETUP" "$FROM_FILE" "$PRECEDENCE" "$CANTRIP_RUN_GENERATION" "$RUN_SECRET"',
          },
          environment: {
            includeCodexEnvironment: true,
            files: [".env"],
            variables: [
              { name: "PRECEDENCE", value: "declared", enabled: true },
            ],
            secrets: [
              { name: "RUN_SECRET", secret: "fixture/token", enabled: true },
            ],
          },
          beforeLaunch: [
            {
              kind: "command",
              command: 'printf "%s" "$PRECEDENCE" > before.txt',
              workingDirectory: ".",
            },
          ],
        },
        expectedRevision: null,
      },
    }),
  );
  assert.equal(result.result.result.outcome, "created");
  const get = await definition(request("get", { configurationId }));
  const revision = get.result.codexEnvironment.revision;
  assert.match(revision, /^[a-f0-9]{64}$/u);
  const projectId = binding.projectId;
  const identity = {
    runtimeId: randomUUID(),
    projectId,
    configurationId,
    worktreeId: target.worktreeId,
    workerId,
    definitionRevision: result.result.result.entry.revision,
    codexEnvironmentRevision: revision,
    generation: 1,
    operationId: randomUUID(),
    terminalId: randomUUID(),
  };
  const secret = "fixture-" + randomUUID();
  const reference = "fixture/token";
  const content = {
    identity,
    sourceRoot,
    targetRoot,
    secrets: [{ reference, value: secret }],
  };
  const plan = async (input, native) =>
    osRunPlanResponseSchema.parse(
      JSON.parse(
        await guest(
          "/bin/sh",
          "-c",
          'printf "%s\n" "$1" | "$2" "$3"',
          "fixture",
          JSON.stringify(input),
          native ? helper : "/usr/bin/node",
          native ? "--plan" : legacy,
        ),
      ),
    );
  const planned = await plan(content, true);
  assert.equal(planned.state, "ready", planned.message);
  if (compare) assert.deepEqual(planned, await plan(content, false));
  assert.equal(planned.environment.FROM_SETUP, "shared");
  assert.equal(planned.environment.FROM_FILE, "target-file");
  assert.equal(planned.environment["DOTENV.KEY"], "dotted");
  assert.equal(planned.environment.PRECEDENCE, "declared");
  assert.equal(planned.environment.CANTRIP_RUN_GENERATION, "1");
  assert.equal(planned.environment.RUN_SECRET, secret);
  assert.match(planned.preparationOutput, /setup 日本/u);
  const stale = {
    ...content,
    identity: { ...identity, definitionRevision: "0".repeat(64) },
  };
  const rejected = await plan(stale, true);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.phase, "definition");
  if (compare) assert.deepEqual(rejected, await plan(stale, false));

  const transport = { kind: "docker", container };
  const execution = (chosen) => ({
    kind: "cantrip-os",
    transport,
    scope: {
      ownerId: os.ownerId,
      workerId,
      instanceId: os.id,
      guestInstanceId: os.guestInstanceId,
      attachmentGeneration: os.attachmentGeneration,
      runtimeGeneration: os.runtimeGeneration,
      projectId,
      bindingId: chosen.id,
      bindingGeneration: chosen.bindingGeneration,
      projectSourceId: chosen.projectSourceId,
      sourceKind: "git",
      worktreeId: chosen.worktreeId,
      workspaceId: workspace.id,
      guestWorkspaceId: actual.id,
      mode: "linux-owned",
      uid: actual.uid,
      gid: actual.gid,
      homeGuestPath: actual.home,
      guestPath: chosen.guestPath,
      linkedWorkerPath: null,
      dependencyOverlays: [],
    },
  });
  const journal = path.join(data, "native-plan-supervisor");
  const controller = new CantripOsController(journal, workerId);
  const authority = {
    ownerId: () => os.ownerId,
    serverIdentity: () => serverId,
  };
  const cryptoService = {
    ...authority,
    componentKey: () => ({ key: new Uint8Array(32).fill(71), keyRevision: 1 }),
  };
  const protectedValue = await protectRunConfigurationSecretValue({
    projectId,
    reference,
    value: secret,
    service: cryptoService,
  });
  const driver = new OsRunExecution(
    journal,
    controller,
    authority,
    (projectId, record) =>
      openRunConfigurationSecretValue({
        projectId,
        secret: record,
        service: cryptoService,
      }),
  );
  // The disposable guest exposes only the new planner for this actual Run.
  const root = (...args) => docker("exec", "--user", "0", container, ...args);
  if (compare) await root("mv", legacy, legacy + ".fixture");
  try {
    let output = "";
    const job = driver.start(
      {
        identity,
        definitions: execution(binding),
        target: execution(target),
        protectedSecrets: [{ reference, revision: 1, protectedValue }],
      },
      {
        output: (data) => {
          output += data;
        },
        started: () => {},
      },
    );
    const outcome = await job.completion;
    assert.deepEqual(outcome, { outcome: "exited", exitCode: 0, signal: null });
    assert.match(output, /ready shared target-file declared 1 ••••/u);
    assert.ok(!output.includes(secret));
    assert.equal(await guest("cat", targetRoot + "/before.txt"), "declared");
  } finally {
    if (compare) await root("mv", legacy + ".fixture", legacy);
  }
  console.log(
    `Native guest Run preparation passed: separate roots, setup, secrets and actual execution${compare ? ", with Node plan parity" : ""}.`,
  );
}
