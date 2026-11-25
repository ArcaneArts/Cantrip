// Exercise the native worker sandbox and existing Run lifecycle through the MCP SDK.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";

export async function verifyExecution({
  client,
  directory,
  workerDirectory,
  projectId,
  ownerVisit,
  unrelated,
  otherClient,
  eventually,
}) {
  const tools = (await client.listTools()).tools.map(({ name }) => name);
  const execution = [
    "command_start",
    "command_status",
    "command_output",
    "command_wait",
    "command_cancel",
    "cantrip_cli",
    "cantrip_cli_run",
  ];
  assert.deepEqual(
    unrelated ? tools : tools.filter((name) => execution.includes(name)),
    execution,
  );
  const call = async (name, arguments_, expectedError, conn = client) => {
    const reply = await conn.callTool({
      name,
      arguments: { projectId, ...arguments_ },
    });
    if (expectedError) {
      assert.equal(reply.isError, true, JSON.stringify(reply));
      assert.match(JSON.stringify(reply.content), expectedError);
      return;
    }
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    assert.equal(reply.structuredContent?.projectId, projectId);
    return reply.structuredContent;
  };
  const workspace = (
    await ownerVisit("GET", "/api/workspaces", 200)
  ).workspaces.find(({ projectIds }) => projectIds.includes(projectId));
  assert.ok(workspace);
  const policy = `/api/workspaces/${workspace.id}/external-mcp-execution`;
  const setPolicy = async (mode) =>
    assert.deepEqual(await ownerVisit("PUT", policy, 200, { policy: mode }), {
      policy: mode,
    });
  assert.deepEqual(await ownerVisit("GET", policy, 200), {
    policy: "disabled",
  });
  await unrelated?.visit(
    "workspace execution belongs to the owner",
    "GET",
    policy,
    { status: 404 },
  );
  await unrelated?.visit("only owner may enable execution", "PUT", policy, {
    status: 404,
    json: { policy: "workspace-write" },
  });

  const context = await call("cantrip_cli", { command: { name: "context" } });
  const worktreeId = context.worktreeId;
  assert.ok(worktreeId);
  assert.equal(context.data.context.projectId, projectId);
  assert.equal(context.data.context.worktreeId, worktreeId);
  assert.ok(
    (await call("cantrip_cli", { command: { name: "target_list" } })).data,
  );
  await call(
    "cantrip_cli",
    { command: { name: "terminal_send" } },
    /invalid|command/iu,
  );
  await call(
    "cantrip_cli",
    {
      command: { name: "run_logs", configurationId: randomUUID(), tail: 1000 },
    },
    /limit|input/iu,
  );

  const tree = (
    await ownerVisit("GET", `/api/projects/${projectId}/worktrees`, 200)
  ).find(({ id }) => id === worktreeId);
  assert.ok(tree);
  const checkout = await realpath(
    (
      await new WorkerRoutingRegistry(workerDirectory).resolveMetadata({
        path: tree.path,
      })
    ).path,
  );
  const relative = path.relative(await realpath(directory), checkout);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );

  const windows = process.platform === "win32";
  const invocation = (executable, args, options = {}) => ({
    worktreeId,
    operationId: randomUUID(),
    executable,
    args,
    ...options,
  });
  const shell = (source, options) =>
    windows
      ? invocation("cmd.exe", ["/d", "/c", source], options)
      : invocation("/bin/sh", ["-c", source], options);
  const grep = () =>
    windows
      ? invocation("findstr.exe", ["mcp-visible", "probe.txt"], {
          cwd: "execution",
        })
      : invocation("/usr/bin/grep", ["mcp-visible", "probe.txt"], {
          cwd: "execution",
        });
  const start = (input) => call("command_start", input);
  const output = (commandId, options = {}) =>
    call("command_output", { commandId, worktreeId, ...options });
  const wait = async (commandId) => {
    const result = await call("command_wait", {
      commandId,
      worktreeId,
      timeoutMs: 8000,
    });
    assert.equal(result.terminal, true, JSON.stringify(result));
    return result;
  };
  await call("command_start", grep(), /workspace.+execution/iu);
  await setPolicy("read-only");
  await mkdir(path.join(checkout, "execution"));
  await writeFile(
    path.join(checkout, "execution", "probe.txt"),
    "one mcp-visible line\n",
  );
  const outside = path.join(directory, "worker-private-fixture.txt");
  const outsideMarker = "protected fixture outside the authorized checkout";
  await writeFile(outside, outsideMarker);

  const replayable = grep();
  const accepted = await start(replayable);
  const finished = await wait(accepted.commandId);
  assert.equal(finished.state, "exited", JSON.stringify(finished));
  assert.equal(
    finished.exitCode,
    0,
    JSON.stringify(await output(accepted.commandId)),
  );
  assert.match(
    (await output(accepted.commandId)).text,
    /one mcp-visible line/u,
  );
  assert.equal((await start(replayable)).commandId, accepted.commandId);
  if (otherClient) {
    await call(
      "command_status",
      { commandId: accepted.commandId, worktreeId },
      /unavailable/iu,
      otherClient,
    );
  }
  await call(
    "command_start",
    { ...replayable, args: ["different", "probe.txt"] },
    /different request/iu,
  );

  const out = await start(
    windows ? shell(`type "${outside}"`) : invocation("/bin/cat", [outside]),
  );
  assert.notEqual((await wait(out.commandId)).exitCode, 0);
  assert.equal(
    (await output(out.commandId)).text.includes(outsideMarker),
    false,
  );
  const env = await start(
    windows ? shell("set") : invocation("/usr/bin/env", []),
  );
  await wait(env.commandId);
  const envOutput = (await output(env.commandId)).text;
  assert.doesNotMatch(
    envOutput,
    /CANTRIP_(?:WORKER_TOKEN|EXTERNAL_MCP_FIXTURE_SECRET)=/iu,
  );

  const create = windows
    ? shell("echo write-fixture>execution\\writable.txt")
    : invocation("/usr/bin/touch", ["execution/writable.txt"]);
  const readOnly = await start(create);
  assert.notEqual((await wait(readOnly.commandId)).exitCode, 0);
  await assert.rejects(
    lstat(path.join(checkout, "execution", "writable.txt")),
    { code: "ENOENT" },
  );
  await setPolicy("workspace-write");
  const written = await start({ ...create, operationId: randomUUID() });
  assert.equal((await wait(written.commandId)).exitCode, 0);
  assert.ok(
    (await lstat(path.join(checkout, "execution", "writable.txt"))).isFile(),
  );

  const long = () =>
    windows
      ? shell("ping -n 25 127.0.0.1 > nul")
      : invocation("/bin/sleep", ["20"]);
  const timed = await start({ ...long(), timeoutMs: 200 });
  assert.equal((await wait(timed.commandId)).state, "timed-out");
  const stopped = await start(
    windows ? long() : shell('sleep 20 & printf "child=%s\\n" "$!"; wait'),
  );
  const dispatched = await call("command_wait", {
    commandId: stopped.commandId,
    afterRevision: stopped.revision,
    timeoutMs: 2000,
  });
  assert.equal(dispatched.state, "running", JSON.stringify(dispatched));
  let child;
  if (!windows) {
    await eventually(async () => {
      const status = await output(stopped.commandId);
      child = Number(status.text.match(/child=(\d+)/u)?.[1]);
      assert.ok(child > 1, JSON.stringify(status));
      process.kill(child, 0);
    });
  }
  await setPolicy("disabled");
  await call("command_cancel", { commandId: stopped.commandId });
  assert.equal((await wait(stopped.commandId)).state, "cancelled");
  if (child) {
    await eventually(async () =>
      assert.throws(() => process.kill(child, 0), { code: "ESRCH" }),
    );
  }
  await setPolicy("workspace-write");

  if (!windows) {
    const printed = await start(
      invocation("/usr/bin/awk", [
        'BEGIN {for(i=0;i<30000;i++) print "chunk-012345678"}',
      ]),
    );
    const done = await wait(printed.commandId);
    assert.equal(done.outputTruncated, true, JSON.stringify(done));
    const first = await output(printed.commandId, { offset: 0, maxBytes: 48 });
    assert.ok(first.offset > 0 && first.nextOffset > first.offset);
    assert.ok(Buffer.byteLength(first.text) <= 48);
    const next = await output(printed.commandId, {
      offset: first.nextOffset,
      maxBytes: 48,
    });
    assert.equal(next.offset, first.nextOffset);
    assert.ok(next.nextOffset > next.offset);
  }

  const configurationId = randomUUID();
  await ownerVisit(
    "PUT",
    `/api/projects/${projectId}/run-configurations/${configurationId}`,
    201,
    {
      operationId: randomUUID(),
      expectedRevision: null,
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "External MCP lifecycle fixture",
        provider: "shell",
        target: {
          kind: "command",
          command: windows
            ? "echo external-run-ready"
            : "printf 'external-run-ready\\n'; exec /bin/sleep 30",
        },
        options: { shell: windows ? "cmd" : "automatic", login: false },
        environment: { includeCodexEnvironment: false },
      },
    },
  );
  const cli = (name, fields = {}) =>
    call("cantrip_cli", { command: { name, ...fields }, worktreeId });
  const lifecycle = (action, operationId = randomUUID()) =>
    call("cantrip_cli_run", {
      action,
      operationId,
      worktreeId,
      configurationId,
    });
  const runInventory = await cli("run_list");
  assert.ok(
    runInventory.data.inventory.entries.some(
      ({ id }) => id === configurationId,
    ),
  );
  const activate = randomUUID();
  await setPolicy("read-only");
  await call(
    "cantrip_cli_run",
    { action: "start", operationId: activate, worktreeId, configurationId },
    /workspace.+execution/iu,
  );
  await setPolicy("workspace-write");
  const launched = await lifecycle("start", activate);
  assert.equal(
    launched.data.operation.outcome,
    "accepted",
    JSON.stringify(launched),
  );
  assert.equal(
    (await lifecycle("start", activate)).data.operation.id,
    launched.data.operation.id,
  );
  await eventually(async () => {
    const logs = await cli("run_logs", { configurationId });
    assert.match(JSON.stringify(logs.data), /external-run-ready/u);
  });
  await lifecycle("stop");
  const leftRunning = await start(long());
  const alive = await call("command_wait", {
    commandId: leftRunning.commandId,
    afterRevision: leftRunning.revision,
    timeoutMs: 2000,
  });
  assert.equal(alive.state, "running");
  return async (conn) => {
    const interrupted = await call(
      "command_status",
      {
        worktreeId,
        commandId: leftRunning.commandId,
      },
      undefined,
      conn,
    );
    assert.equal(interrupted.state, "interrupted", JSON.stringify(interrupted));
    assert.equal(interrupted.terminal, true);
  };
}
