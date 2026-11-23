import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  encryptPrivateDisplayLabel,
  encryptSurfacePrivateState,
} from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import {
  approveManagedMcpTool,
  managedMcpClient,
  managedMcpRpc,
  managedMcpTurn,
} from "./mcp-tool-cases.mjs";

export async function verifyManagedMcpTerminal({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  surfaceKey,
  interactionKey,
  data,
}) {
  const { profile, model } = await createModel("Managed MCP Terminal");
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
      title: "Managed MCP Terminal",
    });
  const projectId = projectUrl.split("/").at(-1);
  const directory = path.join(
    data,
    "workspaces",
    workspaceId,
    "folders",
    projectId,
  );
  const pidPath = path.join(directory, "mcp-terminal-pid");
  const inputPath = path.join(directory, "mcp-terminal-input");
  const id = randomUUID();
  const target = {
    kind: "surface",
    projectId,
    surfaceKind: "terminal",
    surfaceId: id,
  };
  const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
  const serviceCommand = [
    'printf "%s" "$$" > mcp-terminal-pid',
    'printf "fixture-boot:%s\\n" "$$"',
    'while IFS= read -r line; do printf "%s" "$line" > mcp-terminal-input; printf "fixture-received:%s\\n" "$line"; done',
  ].join("; ");
  const stateProtection = await encryptSurfacePrivateState({
    ownerId,
    keyRevision,
    componentKey: surfaceKey,
    context: {
      serverId,
      resource: "terminal-row",
      resourceId: id,
      operationId: null,
      recordKind: "terminal-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory: { kind: "project-root" },
      serviceCommand,
    },
  });
  await call("POST", projectUrl + "/terminals", 201, {
    id,
    titleProtection: await encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      componentKey: labelKey,
      recordKind: "terminal",
      rowId: id,
      label: "Private MCP terminal",
    }),
    stateProtection,
  });
  const serviceUrl = "/api/terminals/" + id + "/service";
  const enabled = await call("PUT", serviceUrl, 200, {
    enabled: true,
    stateProtection,
  });
  assert.equal(enabled.status, "running");
  const waitPid = (previous) =>
    eventually(
      () => readFile(pidPath, "utf8").catch(() => ""),
      (pid) => {
        assert.match(pid, /^\d+$/u);
        assert.notEqual(pid, previous);
      },
    );
  const firstPid = await waitPid();
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

  const initial = await invoke("terminal_read", { target });
  assert.deepEqual(initial.target, target);
  assert.equal(initial.mutated, false);
  assert.equal(initial.data.status, "running");
  assert.equal(initial.data.exitCode, null);
  assert.ok(initial.data.data.includes("fixture-boot:" + firstPid));
  const short = await invoke("terminal_read", { target, maxChars: 5 });
  assert.equal(short.data.truncated, true);
  assert.ok(short.data.data.length <= 5);
  assert.equal(short.summary, "Terminal is running; scrollback was truncated.");

  const input = "mcp-input-" + randomUUID();
  const [accepted] = await managedMcpTurn(attachment, [
    {
      name: "terminal_send",
      args: { target, data: input + "\n" },
      afterInvoke: () =>
        approveManagedMcpTool({
          call,
          eventually,
          chatId,
          ownerId,
          keyRevision,
          interactionKey,
          expectedTool: /terminal[_ ]send|Send input to a Cantrip terminal/iu,
        }),
    },
  ]);
  assert.deepEqual(accepted.target, target);
  assert.equal(accepted.summary, "Sent protected terminal input.");
  assert.equal(accepted.mutated, true);
  assert.deepEqual(accepted.data, { accepted: true });
  await eventually(
    () => readFile(inputPath, "utf8").catch(() => ""),
    (value) => assert.equal(value, input),
  );
  const withInput = await invoke("terminal_read", { target });
  assert.ok(withInput.data.data.includes("fixture-received:" + input));

  const restarted = await invoke("terminal_restart", { target });
  assert.deepEqual(restarted.target, target);
  assert.deepEqual(restarted.data, { status: "running" });
  assert.equal(restarted.mutated, true);
  assert.equal(restarted.worktreeId, initial.worktreeId);
  const nextPid = await waitPid(firstPid);
  const after = await invoke("terminal_read", { target });
  assert.ok(after.data.data.includes("fixture-boot:" + nextPid));
  assert.ok(!after.data.data.includes("fixture-boot:" + firstPid));
  await invoke(
    "terminal_read",
    { target: { ...target, projectId: randomUUID() } },
    /target cannot receive protected operations/iu,
  );

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
      name: "terminal_read",
      args: { target },
      async verify(readOnly) {
        assert.ok(readOnly.data.data.includes("fixture-boot:" + nextPid));
        const rpc = await managedMcpRpc(data);
        const { tools } = await rpc("tools/list");
        assert.ok(tools.some(({ name }) => name === "terminal_read"));
        assert.ok(
          !tools.some(
            ({ name }) =>
              name === "terminal_send" || name === "terminal_restart",
          ),
        );
        const denied = await rpc("tools/call", {
          name: "terminal_send",
          arguments: { target, data: "unexpected read-only input\n" },
        });
        assert.equal(denied.isError, true);
        const deniedRestart = await rpc("tools/call", {
          name: "terminal_restart",
          arguments: { target },
        });
        assert.equal(deniedRestart.isError, true);
        assert.equal(await readFile(inputPath, "utf8"), input);
        assert.equal(await readFile(pidPath, "utf8"), nextPid);
      },
    },
  ]);
  console.log(
    JSON.stringify({ suite: "native-managed-mcp-terminal", passed: true }),
  );
}
