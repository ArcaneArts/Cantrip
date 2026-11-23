import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

const api = "run-configuration-api";
const privateSecret = "private-cantrip-os-run-acceptance-secret";
const readyMarker = "private-cantrip-os-run-acceptance-output";

export async function actualCantripOsRunClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
  selected,
  fixture,
  workerId,
  projectId,
  crashWorker,
  startWorker,
  report,
}) {
  const binding = await os("createCantripOsBinding", projectId, {
    mode: "linux-owned",
    workspaceId: selected.id,
    sourceKind: "folder",
  });
  const provision = await os("prepareCantripOsProvisionRequest", binding, {
    mode: "linux-owned",
    source: { kind: "folder" },
  });
  const created = await os("submitCantripOsProvision", binding, provision);
  assert.equal(created.state, "ready", JSON.stringify(created));
  const verified = await os("verifyCantripOsBinding", projectId, binding.id);
  assert.equal(verified.state, "ready", JSON.stringify(verified));
  assert.equal(
    verified.provisionedRuntimeGeneration,
    instance.runtimeGeneration,
  );
  const { worktreeId, guestPath } = verified;
  const selection = {
    kind: "binding",
    bindingId: verified.id,
    bindingGeneration: verified.bindingGeneration,
    attachmentGeneration: verified.provisionedAttachmentGeneration,
    runtimeGeneration: verified.provisionedRuntimeGeneration,
  };
  const configurationId = randomUUID();
  const save = await os("executeCantripOsRunDefinition", verified, {
    type: "project.run-configuration-definitions.write",
    projectId,
    operationId: randomUUID(),
    request: {
      expectedRevision: null,
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Guest process lifecycle acceptance",
        provider: "shell",
        target: {
          kind: "command",
          command: "./cantrip-run-acceptance.sh",
        },
        environment: {
          includeCodexEnvironment: false,
          secrets: [
            { name: "RUN_ACCEPTANCE_PROBE", secret: "run/os-acceptance" },
          ],
        },
        stop: { gracePeriodMs: 3000 },
      },
    },
  });
  assert.equal(save.result.result.outcome, "created", JSON.stringify(save));
  await call(
    api,
    "setRunConfigurationSecret",
    projectId,
    "run/os-acceptance",
    privateSecret,
  );
  const worker = (await call("api/worker-wire", "getWorkers")).find(
    (entry) => entry.workerId === workerId,
  );
  await call(
    "endpoint-content-worker-encryption",
    "ensureEndpointContentWorkerEncryption",
    { domains: ["run-content"], worker },
  );
  const script = [
    "#!/bin/sh",
    "set -eu",
    'printf "%s\\n" "$$" > run.pid',
    'printf "%s\\n" "$RUN_ACCEPTANCE_PROBE"',
    'test "$RUN_ACCEPTANCE_PROBE" = "' + privateSecret + '"',
    'printf "%s\\n" "' + readyMarker + '"',
    'trap \'printf "%s\\n" "$$" >> run.exits; exit 0\' TERM HUP INT',
    "while :; do sleep 1; done",
  ].join("\n");
  await guest.docker(
    "exec",
    "-u",
    `${selected.uid}:${selected.gid}`,
    "-w",
    guestPath,
    guest.id,
    "sh",
    "-c",
    'printf "%s\\n" "$1" > cantrip-run-acceptance.sh && chmod 700 cantrip-run-acceptance.sh',
    "sh",
    script,
  );

  const operate = (operation, osSource, operationId = randomUUID()) =>
    call(
      api,
      "operateRunConfigurationRuntime",
      {
        projectId,
        configurationId,
        targetWorktreeId: worktreeId,
        operation,
        osSource,
      },
      operationId,
    );
  const status = async (runtimeId) => {
    const values = await call(api, "listRunConfigurationRuntimes", projectId, {
      runtimeId,
    });
    assert.equal(values.length, 1);
    const [run] = values;
    assert.equal(run.id, runtimeId);
    assert.equal(run.workerId, workerId);
    assert.equal(run.worktreeId, worktreeId);
    assert.equal(run.configurationId, configurationId);
    return run;
  };
  const running = (runtimeId, generation) =>
    eventually(
      () => status(runtimeId),
      (run) => {
        assert.equal(run.state, "running", JSON.stringify(run));
        assert.equal(run.generation, generation);
      },
    );
  const output = async (runtimeId, generation) => {
    const request = {
      projectId,
      configurationId,
      worktreeId,
      osSource: { kind: "runtime", runtimeId },
      tail: 4096,
    };
    await eventually(
      () =>
        call(api, "readRunConfigurationRuntimeOutput", request).catch(
          (error) => ({ error: error.message }),
        ),
      (reply) => {
        assert.ok(reply.data?.includes(readyMarker), JSON.stringify(reply));
        assert.equal(reply.generation, generation);
      },
    );
    const operationId = randomUUID();
    const [response, opened] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            "/api/run-configuration-runtimes/output" &&
          response.request().postDataJSON()?.operationId === operationId,
      ),
      call(api, "readRunConfigurationRuntimeOutput", request, operationId),
    ]);
    assert.equal(response.status(), 200);
    const raw = await response.json();
    assert.equal(raw.operationId, operationId);
    assert.equal(raw.generation, generation);
    assert.equal(raw.protectedOutput.domain, "run-content");
    assert.ok(raw.protectedOutput.envelope.ciphertext.length > 16);
    assert.equal(JSON.stringify(raw).includes(readyMarker), false);
    assert.equal(JSON.stringify(raw).includes(privateSecret), false);
    assert.equal(opened.generation, generation);
    assert.ok(opened.data.includes(readyMarker));
    assert.ok(opened.data.includes("••••"));
    assert.equal(opened.data.includes(privateSecret), false);
    report.runOutputProofs.push({ raw, bytes: opened.data.length });
  };
  const guestPid = async () => {
    const value = (
      await guest.exec("cat", path.posix.join(guestPath, "run.pid"))
    ).trim();
    assert.match(value, /^[1-9][0-9]*$/);
    await guest.exec("kill", "-0", value);
    return value;
  };
  const phase = (label, run) =>
    record(label, {
      state: run.state,
      generation: run.generation,
      runtimeId: run.id,
      terminalId: run.terminalId,
      worktreeId: run.worktreeId,
      workerId: run.workerId,
    });
  report.runOutputProofs = [];
  const startId = randomUUID();
  const started = await operate("start", selection, startId);
  assert.equal(started.operation.outcome, "accepted");
  const { id: runtimeId, generation } = started.runtime;
  const captured = { kind: "runtime", runtimeId };
  const initial = await running(runtimeId, generation);
  phase("run-started", initial);
  await output(runtimeId, generation);
  const pid = await guestPid();
  const replay = await operate("start", selection, startId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.runtime.id, runtimeId);
  assert.equal(await guestPid(), pid);
  phase("run-start-replayed", await running(runtimeId, generation));

  report.runServerCrash = fixture.workerFixture
    ? await fixture.replacePeer(0, fixture.peers[0].kind, { crash: true })
    : await fixture.restart({ crash: true });
  await output(runtimeId, generation);
  assert.equal(await guestPid(), pid);
  phase(
    "run-reconciled-after-server-loss",
    await running(runtimeId, generation),
  );

  await crashWorker();
  await startWorker();
  await output(runtimeId, generation);
  assert.equal(await guestPid(), pid);
  phase(
    "run-reconciled-after-worker-loss",
    await running(runtimeId, generation),
  );

  const restarted = await operate("restart", selection);
  assert.equal(restarted.operation.outcome, "accepted");
  assert.equal(restarted.runtime.id, runtimeId);
  const nextGeneration = generation + 1;
  const next = await running(runtimeId, nextGeneration);
  assert.equal(next.terminalId, initial.terminalId);
  phase("run-restarted", next);
  await output(runtimeId, nextGeneration);
  const newPid = await guestPid();
  assert.notEqual(newPid, pid);
  await assert.rejects(guest.exec("kill", "-0", pid));

  const stopId = randomUUID();
  const stopped = await operate("stop", captured, stopId);
  assert.equal(stopped.operation.outcome, "accepted");
  const terminal = await eventually(
    () => status(runtimeId),
    (run) => {
      assert.equal(run.state, "idle", JSON.stringify(run));
      assert.equal(run.generation, nextGeneration);
    },
  );
  await assert.rejects(guest.exec("kill", "-0", newPid));
  phase("run-stopped", terminal);
  const stopReplay = await operate("stop", captured, stopId);
  assert.equal(stopReplay.replayed, true);
  assert.deepEqual(stopReplay.operation, stopped.operation);
  assert.deepEqual(await status(runtimeId), terminal);
  report.runPids = { initial: pid, restarted: newPid };
}
