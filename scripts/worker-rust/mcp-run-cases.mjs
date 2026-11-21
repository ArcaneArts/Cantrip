import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationFileSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import {
  approveManagedMcpTool,
  managedMcpClient,
  managedMcpRpc,
  managedMcpTurn,
} from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpRun({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  interactionKey,
  data,
}) {
  const { profile, model } = await createModel("Managed MCP Run");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl, projectUrl, workspaceId } =
    await createPreparedProjectChat({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      title: "Managed MCP Run",
    });
  const projectId = projectUrl.split("/").at(-1);
  const project = { kind: "project", projectId };
  const directory = path.join(
    data,
    "workspaces",
    workspaceId,
    "folders",
    projectId,
  );
  const pidFile = path.join(directory, "managed-run-pid");
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "managed-run-detection",
      scripts: { dev: "node fixture.js" },
    }),
  );
  const attachment = {
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatId,
    chatUrl,
    projectUrl,
  };
  const invoke = managedMcpClient(attachment);
  const approved = async (name, args, expectedTool) => {
    const [result] = await managedMcpTurn(attachment, [
      {
        name,
        args,
        afterInvoke: () =>
          approveManagedMcpTool({
            call,
            eventually,
            chatId,
            ownerId,
            keyRevision,
            interactionKey,
            expectedTool,
          }),
      },
    ]);
    return result;
  };
  const empty = await invoke("run_configuration_list", {});
  assert.deepEqual(empty.target, project);
  assert.deepEqual(empty.data.inventory.entries, []);
  assert.ok(empty.worktreeId);
  const worktreeId = empty.worktreeId;
  const worktree = { kind: "worktree", projectId, worktreeId };
  const detected = await invoke("run_configuration_detect", {
    provider: "node",
  });
  assert.equal(detected.worktreeId, worktreeId);
  assert.ok(
    detected.data.candidates.some((entry) => entry.provider === "node"),
  );

  const configurationId = randomUUID();
  const reference = "run/managed-mcp-fixture";
  const secret = "managed-fixture-secret-" + randomUUID();
  const document = runConfigurationFileSchema.parse({
    schema: "cantrip.run-configuration",
    version: 1,
    id: configurationId,
    name: "Owned MCP Run fixture",
    provider: "shell",
    target: {
      kind: "command",
      command: [
        'printf "%s" "$$" > managed-run-pid',
        'printf "managed-run-ready:%s\\n" "$CANTRIP_RUN_GENERATION"',
        'printf "fixture-private=%s\\n" "$PRIVATE"',
        "exec /bin/sleep 120",
      ].join("\n"),
    },
    options: { shell: "automatic", login: false },
    environment: {
      secrets: [{ name: "PRIVATE", secret: reference, enabled: true }],
    },
    stop: { gracePeriodMs: 200 },
  });
  const created = await invoke("run_configuration_create", {
    operationId: randomUUID(),
    document,
  });
  assert.equal(created.data.result.outcome, "created");
  assert.equal(created.worktreeId, worktreeId);
  const updated = await invoke("run_configuration_update", {
    operationId: randomUUID(),
    configurationId,
    expectedRevision: created.data.result.entry.revision,
    document: { ...document, name: "Updated MCP Run fixture" },
  });
  const revision = updated.data.result.entry.revision;
  assert.notEqual(revision, created.data.result.entry.revision);
  const fetched = await invoke("run_configuration_get", { configurationId });
  assert.equal(
    fetched.data.result.entry.document.name,
    "Updated MCP Run fixture",
  );
  assert.equal(fetched.data.result.entry.revision, revision);
  await invoke(
    "run_configuration_update",
    {
      operationId: randomUUID(),
      configurationId,
      expectedRevision: created.data.result.entry.revision,
      document,
    },
    /conflict|rejected/iu,
  );

  const stored = await invoke("run_configuration_secret_set", {
    operationId: randomUUID(),
    reference,
    value: secret,
  });
  assert.deepEqual(stored.target, project);
  assert.equal(stored.data.secret.reference, reference);
  assert.equal(stored.data.secret.available, true);
  assert.ok(!JSON.stringify(stored).includes(secret));
  const intent = (worktreeId = null) => ({
    operationId: randomUUID(),
    configurationId,
    worktreeId,
  });
  const started = await approved(
    "run_configuration_start",
    intent(),
    /run_configuration_start|Start a Run configuration/iu,
  );
  assert.deepEqual(started.target, worktree);
  assert.equal(started.data.operation.outcome, "accepted");
  const waitStatus = (state, generation) =>
    eventually(
      () =>
        call("POST", "/api/run-configuration-runtimes/status", 200, {
          operationId: randomUUID(),
          projectId,
          configurationId,
          targetWorktreeId: worktreeId,
        }),
      ({ runtimes }) => {
        assert.equal(runtimes[0]?.state, state);
        assert.equal(runtimes[0]?.generation, generation);
      },
    );
  await waitStatus("running", 1);
  const status = await invoke("run_configuration_status", {
    configurationId,
    worktreeId,
  });
  assert.equal(status.data.runtimes[0].state, "running");
  const pid = (previous) =>
    eventually(
      () => readFile(pidFile, "utf8").catch(() => ""),
      (value) => {
        assert.match(value, /^\d+$/u);
        assert.notEqual(value, previous);
      },
    );
  const firstPid = await pid();
  const output = await invoke("run_configuration_read_output", {
    ...intent(worktreeId),
    tail: 1024,
  });
  assert.match(output.data.data, /managed-run-ready:1/u);
  assert.match(output.data.data, /fixture-private=••••/u);
  assert.ok(!output.data.data.includes(secret));
  assert.equal(output.data.generation, 1);
  const opaque = await call(
    "POST",
    "/api/run-configuration-runtimes/output",
    200,
    {
      operationId: randomUUID(),
      projectId,
      configurationId,
      worktreeId,
      tail: 1024,
    },
  );
  assert.ok(opaque.protectedOutput);
  assert.ok(!JSON.stringify(opaque).includes("managed-run-ready:"));

  const restarted = await approved(
    "run_configuration_restart",
    intent(worktreeId),
    /run_configuration_restart|Restart a Run configuration/iu,
  );
  assert.equal(restarted.data.operation.outcome, "accepted");
  await waitStatus("running", 2);
  const secondPid = await pid(firstPid);
  assert.throws(() => process.kill(Number(firstPid), 0), { code: "ESRCH" });
  const stopped = await approved(
    "run_configuration_stop",
    intent(worktreeId),
    /run_configuration_stop|Stop a Run configuration/iu,
  );
  assert.equal(stopped.data.operation.outcome, "accepted");
  await waitStatus("idle", 2);
  assert.throws(() => process.kill(Number(secondPid), 0), { code: "ESRCH" });
  const deleted = await approved(
    "run_configuration_delete",
    {
      operationId: randomUUID(),
      configurationId,
      expectedRevision: revision,
    },
    /run_configuration_delete|Delete a Run configuration/iu,
  );
  assert.equal(deleted.data.result.outcome, "deleted");

  const settings = await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.ok(state.binding && state.effective),
  );
  await call("PATCH", chatUrl + "/permission-profile", 200, {
    id: ":read-only",
    bindingId: settings.binding.bindingId,
    expectedRevision: settings.permissionPolicy?.revision ?? "0",
    operationId: randomUUID(),
  });
  await eventually(
    () => call("GET", chatUrl + "/native-settings", 200),
    (state) => assert.equal(state.permissionPolicy?.effectiveId, ":read-only"),
  );
  await managedMcpTurn(attachment, [
    {
      name: "run_configuration_list",
      args: {},
      async verify(result) {
        assert.deepEqual(result.data.inventory.entries, []);
        const rpc = await managedMcpRpc(data);
        const { tools } = await rpc("tools/list");
        assert.ok(
          !tools.some(
            ({ name }) =>
              name === "run_configuration_create" ||
              name === "run_configuration_start",
          ),
        );
        const denied = await rpc("tools/call", {
          name: "run_configuration_create",
          arguments: { operationId: randomUUID(), document },
        });
        assert.equal(denied.isError, true);
      },
    },
  ]);
  console.log(
    JSON.stringify({ suite: "native-managed-mcp-run", passed: true }),
  );
}
