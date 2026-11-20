import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { mcpServerConfigurationSchema } from "../../packages/protocol/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";
import { oauthServer } from "./mcp-oauth-fixture.mjs";

const resourceUri = "fixture://private-note";
const serverName = "inventory_fixture";
const toolName = "inventory_fixture_tool";
const rootSkill = "cantrip-extra-root-fixture";
const globalSkill = "cantrip-global-inventory-fixture";
const instructions = "Read only the extra-root fixture instructions 🌲";
const markerA = "First project private resource";
const markerB = "Second project private resource";
const hookCommand = "/usr/bin/true inventory-fixture-hook";

const mcpFixture = `import readline from 'node:readline';
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result}) + '\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
  const request = JSON.parse(line);
  const {id,method,params} = request;
  if (id === undefined) continue;
  switch (method) {
    case 'initialize': send(id,{protocolVersion:params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}}); break;
    case 'tools/list': send(id,{tools:[{name:${JSON.stringify(toolName)},inputSchema:{type:'object'}}]}); break;
    case 'resources/list': send(id,{resources:[{uri:${JSON.stringify(resourceUri)},name:'Private note',mimeType:'text/plain'}]}); break;
    case 'resources/templates/list': send(id,{resourceTemplates:[{uriTemplate:'fixture://notes/{name}',name:'Notes'}]}); break;
    case 'resources/read': send(id,{contents:[{uri:params.uri,mimeType:'text/plain',text:process.argv[2]},{uri:params.uri,blob:'AQID'}]}); break;
    default: send(id,{});
  }
}
`;

async function addSkill(root, name, content) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture skill.\n---\n\n${content}\n`,
  );
}

export async function verifyCustomizationInventory({
  call,
  eventually,
  createModel,
  encryptedTurn,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  componentKey,
  mcpKey,
  data,
  codexHome,
  oauth,
}) {
  const fixture = path.join(data, "inventory-fixture.mjs");
  const runtimeHome = path.join(data, "codex-home");
  await mkdir(runtimeHome, { recursive: true });
  await writeFile(fixture, mcpFixture);
  await writeFile(path.join(runtimeHome, "config.toml"), oauth.config);
  await writeFile(
    path.join(runtimeHome, "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: hookCommand,
                statusMessage: "Inventory fixture hook",
              },
            ],
          },
        ],
      },
    }),
  );
  await addSkill(
    path.join(codexHome, "skills"),
    globalSkill,
    "Global fixture.",
  );
  const outside = path.join(data, "outside-skill-root");
  await mkdir(outside);
  const model = await createModel("Native customization inventory fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
    autoNameChats: false,
  });
  const server = (await call("GET", "/api/bootstrap", 200)).server;
  const lookup = crypto.deriveLookupKey({
    componentKey: mcpKey,
    ownerId,
    component: "mcp-secret",
    table: "mcp_servers",
    field: "name",
    keyRevision,
  });

  async function registerMcp(projectId, input) {
    const id = randomUUID();
    const config = mcpServerConfigurationSchema.parse(input);
    const protectedConfiguration = await crypto.encryptProtectedSecret({
      ownerId,
      component: "mcp-secret",
      table: "mcp_servers",
      rowId: id,
      field: "protected_configuration",
      keyRevision,
      componentKey: mcpKey,
      content: config,
      contentSchema: mcpServerConfigurationSchema,
      maximumBytes: 1024 * 1024,
    });
    await call("POST", `/api/projects/${projectId}/mcp-servers`, 201, {
      id,
      workerId,
      enabled: true,
      audience: "ide",
      nameBlindIndex: crypto.computeBlindLookupTag(lookup, config.name),
      protectedConfiguration,
    });
  }

  async function createProject(marker, withRoots, workspaceId) {
    let projectId;
    let directory;
    const chat = await createPreparedProjectChat({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      title: "Project customization inventory",
      workspaceId,
      projectName: withRoots
        ? "Inventory project one"
        : "Inventory project two",
      async beforeChat(project) {
        projectId = project.projectId;
        directory = path.join(
          data,
          "workspaces",
          project.workspaceId,
          "folders",
          projectId,
        );
        if (withRoots) {
          await addSkill(
            path.join(directory, "extras"),
            rootSkill,
            instructions,
          );
          await symlink(outside, path.join(directory, "outside"), "dir");
        }
        await registerMcp(projectId, {
          name: serverName,
          transport: "stdio",
          command: process.execPath,
          args: [fixture, marker],
        });
        await registerMcp(projectId, {
          name: oauthServer,
          transport: "http",
          url: oauth.url,
        });
      },
    });
    return {
      ...chat,
      directory,
      scope: {
        workerId,
        projectId,
        chatId: chat.chatId,
        providerId: model.provider.id,
      },
    };
  }

  const a = await createProject(markerA, true);
  const b = await createProject(markerB, false, a.workspaceId);
  lookup.fill(0);
  const context = (scope, operationId, operation, direction) => ({
    domain: "customization-content",
    serverId: server.id,
    workerId,
    scopeId: JSON.stringify([
      scope.workerId,
      scope.projectId,
      scope.chatId,
      scope.providerId,
    ]),
    operationId,
    operation,
    direction,
    sequence: 0,
  });

  async function request(chat, operation, method, suffix = "", content) {
    const operationId = randomUUID();
    const { scope } = chat;
    const route = chat.chatUrl + "/customizations" + suffix;
    const wire =
      method === "GET"
        ? await call(
            method,
            `${route}?operationId=${operationId}&refresh=true`,
            200,
          )
        : await call(method, route, 200, {
            operationId,
            operation,
            scope,
            protectedRequest: await crypto.encryptEndpointContentPayload({
              ownerId,
              keyRevision,
              componentKey,
              context: context(scope, operationId, operation, "request"),
              plaintext: new TextEncoder().encode(JSON.stringify(content)),
            }),
          });
    assert.deepEqual(wire.scope, scope);
    assert.equal(wire.operation, operation);
    assert.equal(wire.operationId, operationId);
    for (const secret of [
      markerA,
      markerB,
      resourceUri,
      hookCommand,
      chat.directory,
    ])
      assert.ok(!JSON.stringify(wire).includes(secret));
    const plaintext = await crypto.decryptEndpointContentPayload({
      ownerId,
      keyRevision,
      componentKey,
      context: context(scope, operationId, operation, "response"),
      opaque: wire.protectedResponse,
    });
    const result = JSON.parse(new TextDecoder().decode(plaintext));
    assert.equal(result.status, wire.result);
    if (result.value?.authorizationUrl)
      assert.equal(
        JSON.stringify(wire).includes(result.value.authorizationUrl),
        false,
      );
    let lifecycle = null;
    if (result.status === "succeeded") {
      if (operation === "customization.mcp.oauth.start") lifecycle = "pending";
      if (operation === "customization.mcp.oauth.status") {
        lifecycle = ["unknown", "pending"].includes(result.value.status)
          ? result.value.status
          : "completed";
      }
    }
    assert.equal(wire.lifecycle, lifecycle);
    return result;
  }
  function success(result) {
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    return result.value;
  }
  const inventory = (chat) =>
    request(chat, "customization.inventory.read", "GET").then(success);
  const roots = (value) =>
    request(a, "customization.skill-roots.set", "PUT", "/skill-roots", {
      roots: value,
    });
  const readResource = (chat) =>
    request(chat, "customization.mcp.resource.read", "POST", "/mcp-resource", {
      server: serverName,
      uri: resourceUri,
    }).then(success);
  const reload = () =>
    request(a, "customization.mcp.reload", "POST", "/mcp-reload", {}).then(
      success,
    );

  async function verifyResource(chat, marker) {
    const resource = await readResource(chat);
    assert.deepEqual(resource.contents, [
      { type: "text", uri: resourceUri, mimeType: "text/plain", text: marker },
      { type: "blob", uri: resourceUri, mimeType: null, blob: "AQID" },
    ]);
  }
  const initial = await eventually(
    () => inventory(a),
    (view) =>
      assert.ok(
        view.mcpServers.some(
          (entry) =>
            entry.name === serverName &&
            entry.resources.some((resource) => resource.uri === resourceUri),
        ),
      ),
  );
  assert.deepEqual(initial.skillRoots, []);
  assert.ok(initial.skills.items.some(({ name }) => name === globalSkill));
  assert.ok(!initial.skills.items.some(({ name }) => name === rootSkill));
  assert.equal(initial.capabilities.skills.extraRoots.available, true);
  assert.equal(initial.capabilities.mcp.resourceRead.available, true);
  const hook = initial.hooks.items.find(
    (entry) => entry.statusMessage === "Inventory fixture hook",
  );
  assert.ok(hook, JSON.stringify(initial.hooks));
  assert.equal(hook.eventName, "sessionStart");
  assert.equal(
    hook.command,
    ["managed", "trusted"].includes(hook.trust) ? hookCommand : null,
  );
  const mcp = initial.mcpServers.find((entry) => entry.name === serverName);
  assert.ok(mcp.tools.some(({ name }) => name === toolName));
  assert.ok(
    mcp.resourceTemplates.some(
      ({ uriTemplate }) => uriTemplate === "fixture://notes/{name}",
    ),
  );
  await verifyResource(a, markerA);
  await verifyResource(b, markerB);
  assert.deepEqual(await reload(), { reloaded: true });
  await verifyResource(a, markerA);
  await verifyResource(b, markerB);

  const installed = path.join(a.directory, "extras");
  assert.deepEqual(success(await roots(["extras", installed])), {
    roots: [installed],
  });
  assert.equal((await roots(["outside"])).status, "failed");
  const extended = await inventory(a);
  assert.deepEqual(extended.skillRoots, [installed]);
  assert.ok(extended.skills.items.some(({ name }) => name === rootSkill));
  assert.ok(extended.skills.items.some(({ name }) => name === globalSkill));
  const reply = model.model.reply({ text: "Applied the registered skill." });
  await call(
    "POST",
    `${a.chatUrl}/turns`,
    202,
    await encryptedTurn(`Use $${rootSkill} now.`, model.profile.id),
  );
  await eventually(
    () => reply.request,
    (event) => assert.equal(event?.completed, true),
    35_000,
  );
  assert.ok(JSON.stringify(reply.request.input.input).includes(instructions));
  assert.deepEqual(success(await roots([])), { roots: [] });
  const cleared = await inventory(a);
  assert.deepEqual(cleared.skillRoots, []);
  assert.ok(!cleared.skills.items.some(({ name }) => name === rootSkill));
  assert.ok(cleared.skills.items.some(({ name }) => name === globalSkill));
  assert.equal(cleared.capabilities.mcp.oauth.available, true);

  const startOauth = (chat, server = oauthServer) =>
    request(chat, "customization.mcp.oauth.start", "POST", "/mcp-oauth", {
      server,
    });
  const oauthStatus = (chat, server = oauthServer) =>
    request(
      chat,
      "customization.mcp.oauth.status",
      "POST",
      "/mcp-oauth/status",
      { server },
    ).then(success);
  assert.deepEqual(await oauthStatus(a), {
    server: oauthServer,
    status: "unknown",
    error: null,
  });
  const allowed = success(await startOauth(a));
  assert.equal((await oauthStatus(a)).status, "pending");
  assert.equal((await oauthStatus(b)).status, "unknown");
  const rejected = success(await startOauth(b));
  assert.equal((await oauthStatus(b)).status, "pending");
  await oauth.callback(rejected.authorizationUrl, false);
  await eventually(
    () => oauthStatus(b),
    (status) =>
      assert.deepEqual(status, {
        server: oauthServer,
        status: "failed",
        error:
          "MCP authorization failed. Review the authorization page and try again.",
      }),
  );
  assert.equal((await oauthStatus(a)).status, "pending");
  await oauth.callback(allowed.authorizationUrl, true);
  await eventually(
    () => oauthStatus(a),
    (status) =>
      assert.deepEqual(status, {
        server: oauthServer,
        status: "succeeded",
        error: null,
      }),
  );
  oauth.verifyExchange();
  assert.equal((await oauthStatus(b)).status, "failed");
  assert.deepEqual(await reload(), { reloaded: true });
  await eventually(
    () => inventory(a),
    (view) => {
      assert.equal(
        view.mcpServers.find(({ name }) => name === oauthServer)?.authStatus,
        "oAuth",
      );
      oauth.verifyConnection();
    },
    25_000,
  );

  const absent = "missing_oauth_fixture";
  assert.deepEqual(await startOauth(a, absent), {
    status: "failed",
    error: { message: "Codex could not start MCP authorization." },
  });
  assert.equal((await oauthStatus(a, absent)).status, "failed");
  console.log(
    JSON.stringify({
      suite: "native-customization-inventory-and-mcp-oauth",
      passed: true,
    }),
  );
}
