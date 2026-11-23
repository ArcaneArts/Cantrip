// Existing browser MCP/encryption SDK -> real server -> unchanged full worker
// -> actual Codex -> a real disposable MCP stdio peer. Only model responses,
// owned config files, and the worker process's home boundary are controlled.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./build.mjs";
import { eventually } from "./full-worker.mjs";

export async function actualMcpSettingsClient({
  page,
  fixture,
  projectId,
  projectRoot,
  workerDataDirectory,
  workerId,
  startWorker,
  stopWorker,
  model,
  result,
  requests,
}) {
  const home = path.join(workerDataDirectory, "mcp-test-home"),
    script = path.join(
      repositoryRoot,
      "scripts/server-rust/mcp-settings-stdio-fixture.mjs",
    ),
    trace = path.join(workerDataDirectory, "mcp-peer-trace.jsonl"),
    secret = "private-actual-mcp-secret",
    name = "settings-native-proof",
    uri = "cantrip-proof://settings",
    baseline = model.requests.filter((r) => r.method === "POST").length,
    stdio = (name, label) => ({
      name,
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [script, label, trace],
      environment: { PRIVATE: secret },
    }),
    call = (operation, ...args) =>
      page.evaluate(
        async ({ operation, args }) =>
          (await import("/src/lib/api/mcp.ts"))[operation](...args),
        { operation, args },
      );
  result.mcpSettingsProgress = [];
  const step = (name) => result.mcpSettingsProgress.push(name);
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(
    path.join(home, ".codex/config.toml"),
    `[mcp_servers.settings-user-proof]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([script, "discovered-user", trace])}\nenv = { PRIVATE = ${JSON.stringify(secret)} }\n`,
  );
  await writeFile(
    path.join(projectRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "settings-project-proof": {
          command: process.execPath,
          args: [script, "discovered-project", trace],
          env: { PRIVATE: secret },
        },
      },
    }),
  );
  assert.deepEqual(await call("getGlobalMcpServers"), []);
  assert.deepEqual(await call("getProjectMcpServers", projectId), []);
  let global = await call(
    "createGlobalMcpServer",
    stdio(name, "global"),
    null,
    "both",
  );
  assert.equal(global.scope, "global");
  assert.equal(global.workerId, null);
  assert.equal(global.audience, "both");
  const globalId = global.id;
  global = await call(
    "updateGlobalMcpServer",
    globalId,
    { ...stdio(name, "global"), enabled: false },
    workerId,
  );
  assert.equal(global.id, globalId);
  assert.equal(global.enabled, false);
  assert.equal(global.audience, "both");
  assert.equal(global.workerId, workerId);
  global = await call(
    "updateGlobalMcpServer",
    globalId,
    stdio(name, "global"),
    null,
    "both",
  );
  assert.equal(global.enabled, true);
  assert.equal(global.workerId, null);
  step("existing browser encrypted global CRUD and omitted audience semantics");
  const http = {
    name: "settings-http-proof",
    enabled: true,
    transport: "http",
    url: "http://127.0.0.1:43219/private",
    bearerTokenEnvironmentVariable: "PRIVATE",
    headers: { Authorization: secret },
    environmentHeaders: { Private: "PRIVATE" },
  };
  let localHttp = await call(
    "createProjectMcpServer",
    projectId,
    http,
    workerId,
    "chat",
  );
  assert.equal(localHttp.headers.Authorization, secret);
  assert.equal(localHttp.projectId, projectId);
  assert.equal(localHttp.workerId, workerId);
  localHttp = await call(
    "updateProjectMcpServer",
    projectId,
    localHttp.id,
    { ...http, enabled: false },
    null,
  );
  assert.equal(localHttp.enabled, false);
  assert.equal(localHttp.audience, "chat");
  assert.equal(localHttp.workerId, null);
  await call("deleteProjectMcpServer", projectId, localHttp.id);
  step("existing browser encrypted project HTTP transport CRUD");
  for (const local of [false, true]) {
    const discovered = local
      ? await call("discoverProjectMcpServers", projectId, workerId)
      : await call("discoverGlobalMcpServers", workerId);
    assert.equal(discovered.workerId, workerId);
    const candidate = discovered.candidates.find(
      (c) =>
        c.configuration.name ===
        (local ? "settings-project-proof" : "settings-user-proof"),
    );
    assert.ok(candidate, "full production discovery found owned config");
    assert.equal(candidate.source, local ? "claude" : "codex");
    assert.equal(candidate.sourceScope, local ? "project" : "user");
    assert.equal(candidate.configuration.environment.PRIVATE, secret);
    assert.equal(candidate.encrypted.workerId, workerId);
    const imported = local
      ? await call(
          "addProjectDiscoveredMcpServer",
          projectId,
          candidate.encrypted,
        )
      : await call("addGlobalDiscoveredMcpServer", candidate.encrypted);
    assert.equal(imported.id, candidate.encrypted.id);
    assert.equal(imported.name, candidate.configuration.name);
    assert.equal(imported.workerId, workerId);
    if (local) await call("deleteProjectMcpServer", projectId, imported.id);
    else await call("deleteGlobalMcpServer", imported.id);
  }
  step(
    "actual full worker reads owned Codex/Claude configs and the browser authenticates discovery imports",
  );
  const local = await call(
    "createProjectMcpServer",
    projectId,
    stdio(name, "project"),
    workerId,
    "both",
  );
  const copyProject = await page.evaluate(
    async (workerId) =>
      window.folderCrypto.createManagedFolderProject({
        name: "Private MCP copy project",
        workerId,
      }),
    workerId,
  );
  await eventually(
    () =>
      page.evaluate(
        (id) => window.folderApi.getProjectFolderSetupJob(id),
        copyProject.id,
      ),
    (job) => assert.equal(job.state, "succeeded"),
  );
  const copied = await call("copyProjectMcpServer", copyProject.id, {
    sourceProjectId: projectId,
    sourceServerId: local.id,
  });
  assert.notEqual(copied.id, local.id);
  assert.equal(copied.name, name);
  assert.equal(copied.projectId, copyProject.id);
  assert.equal(copied.audience, "both");
  assert.deepEqual(copied.args, stdio(name, "project").args);
  await call("deleteProjectMcpServer", copyProject.id, copied.id);
  step(
    "existing cross-project copy decrypts and re-encrypts for a fresh row identity",
  );
  const chat = await page.evaluate(async (projectId) => {
    const create = await (
      await import("/src/lib/api/conversations.ts")
    ).prepareConversationCreation(projectId, "Private MCP runtime chat", false);
    return create();
  }, projectId);
  await eventually(
    () =>
      page.evaluate(
        async (chatId) =>
          (
            await (
              await import("/src/lib/api-client.ts")
            ).request(`/api/chats/${chatId}/preparation`)
          ).preparation,
        chat.id,
      ),
    (p) => assert.equal(p?.phase, "ready"),
  );
  const inventory = () =>
    page.evaluate(
      async (chatId) =>
        (await import("/src/lib/api/customization.ts")).getChatCustomizations(
          chatId,
          true,
        ),
      chat.id,
    );
  await eventually(inventory, (v) =>
    assert.ok(
      v.mcpServers.some(
        (s) =>
          s.name === name &&
          s.serverInfo?.name === "cantrip-mcp-settings-project",
      ),
    ),
  );
  const read = () =>
    page.evaluate(
      async ({ chatId, name, uri }) =>
        (await import("/src/lib/api/customization.ts")).readChatMcpResource(
          chatId,
          { server: name, uri },
        ),
      { chatId: chat.id, name, uri },
    );
  assert.ok(
    (await read()).contents.some(
      (c) => c.text === "private-native-mcp-proof:project",
    ),
  );
  const peerTrace = (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    peerTrace.some((v) => v.label === "project" && v.method === "initialize"),
  );
  assert.ok(
    peerTrace.some(
      (v) => v.label === "project" && v.method === "resources/read",
    ),
  );
  step(
    "real native Codex consumes the project override and reads a real MCP resource without inference",
  );
  const raw = () =>
    page.evaluate(async (projectId) => {
      const { request } = await import("/src/lib/api-client.ts");
      return {
        global: await request("/api/settings/mcp-servers"),
        project: await request(`/api/projects/${projectId}/mcp-servers`),
      };
    }, projectId);
  const before = await raw();
  await stopWorker();
  const port = Number(new URL(fixture.server.origin).port);
  await fixture.close();
  await fixture.start({ port });
  assert.deepEqual(await raw(), before);
  await startWorker();
  await page.evaluate(
    async (chatId) => (await import("/src/lib/api/chats.ts")).syncChat(chatId),
    chat.id,
  );
  assert.deepEqual(await raw(), before);
  // Node may already have resumed this new thread during reconnect. Explicit
  // Goal control guarantees a warm native thread before requiring resource IO;
  // raw persisted ciphertext was checked before any resume operation.
  assert.equal(
    (
      await page.evaluate(
        async (chatId) =>
          (await import("/src/lib/api/chats.ts")).clearChatGoal(chatId),
        chat.id,
      )
    ).cleared,
    false,
  );
  assert.ok(
    (await read()).contents.some(
      (c) => c.text === "private-native-mcp-proof:project",
    ),
  );
  assert.equal((await call("getGlobalMcpServers"))[0].id, global.id);
  assert.equal((await call("getProjectMcpServers", projectId))[0].id, local.id);
  await call("deleteProjectMcpServer", projectId, local.id);
  await call("deleteGlobalMcpServer", global.id);
  assert.deepEqual(await call("getGlobalMcpServers"), []);
  assert.deepEqual(await call("getProjectMcpServers", projectId), []);
  assert.equal(
    model.requests.filter((r) => r.method === "POST").length,
    baseline,
  );
  for (const value of [
    requests.filter(
      (r) =>
        r.pathname.includes("mcp-servers") ||
        r.pathname.includes("mcp-discovery"),
    ),
    fixture.server.diagnostics(),
  ])
    assert.equal(
      JSON.stringify(value).includes(secret),
      false,
      "server stays blind to MCP secrets",
    );
  step(
    "server/full worker restart preserves exact ciphertext and native MCP resource access; deletion retains no settings",
  );
  result.mcpSettingsSummary = {
    globalAndProjectCrud: true,
    stdioAndHttp: true,
    realDiscoveryImported: true,
    copiedWithFreshIdentity: true,
    nativeProjectOverride: true,
    nativeResourceRead: true,
    restartRetainedCiphertext: true,
    explicitResumeWithoutInference: true,
    deleted: true,
    extraInference: 0,
  };
  result.steps.push(
    "existing encrypted browser MCP SDK configures global/project servers, imports full-worker discovery, copies across projects, drives a real native MCP resource and retains exact ciphertext through server/worker restart",
  );
}
