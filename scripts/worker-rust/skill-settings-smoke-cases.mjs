import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

const selectedName = "cantrip-protected-skill-fixture";
const disabledName = "cantrip-disabled-skill-fixture";
const globalName = "cantrip-global-settings-fixture";
const privateText = "Protected nested skill notes 🌲";

async function createSkill(root, name) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Skills settings fixture.\n---\n\nFixture body.\n`,
  );
  return directory;
}

export async function verifySkillSettings({
  call,
  eventually,
  createModel,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  componentKey,
  data,
  codexHome,
}) {
  const globalRoot = path.join(codexHome, "skills");
  await createSkill(globalRoot, globalName);
  const model = await createModel("Protected skill settings fixture");
  const providerId = model.provider.id;
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
    autoNameChats: false,
  });
  let projectId;
  let projectRoot;
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Skill settings fixture",
    async beforeChat(project) {
      projectId = project.projectId;
      const projectPath = path.join(
        data,
        "workspaces",
        project.workspaceId,
        "folders",
        projectId,
      );
      projectRoot = path.join(projectPath, ".agents", "skills");
      const selected = await createSkill(projectRoot, selectedName);
      const disabled = await createSkill(projectRoot, disabledName);
      await mkdir(path.join(selected, "agents"));
      await writeFile(
        path.join(selected, "agents", "openai.yaml"),
        'interface:\n  display_name: "Fixture display name"\n',
      );
      await writeFile(path.join(selected, "agents", "notes.md"), privateText);
      await writeFile(path.join(selected, "binary"), Buffer.from([0, 1, 2]));
      const outside = path.join(projectPath, "outside.txt");
      await writeFile(outside, "Outside skill directory");
      await symlink(outside, path.join(selected, "outside.txt"), "file");
      await mkdir(path.join(data, "codex-home"), { recursive: true });
      await writeFile(
        path.join(data, "codex-home", "config.toml"),
        `[[skills.config]]\npath = ${JSON.stringify(path.join(disabled, "SKILL.md"))}\nenabled = false\n`,
      );
    },
  });
  const { id: serverId } = (await call("GET", "/api/bootstrap", 200)).server;
  const projectScope = { workerId, projectId, chatId: null, providerId };
  const globalScope = { ...projectScope, projectId: null };
  const context = (operation, operationId, scope, direction) => ({
    domain: "customization-content",
    workerId,
    serverId,
    scopeId: JSON.stringify([
      scope.workerId,
      scope.projectId,
      scope.chatId,
      scope.providerId,
    ]),
    operation,
    operationId,
    direction,
    sequence: 0,
  });
  async function open(wire, operation, operationId, scope) {
    assert.deepEqual(wire.scope, scope);
    assert.equal(wire.operation, operation);
    assert.equal(wire.operationId, operationId);
    assert.equal(wire.lifecycle, null);
    const encoded = JSON.stringify(wire);
    assert.ok(!encoded.includes(privateText));
    assert.ok(!encoded.includes(selectedName));
    const bytes = await crypto.decryptEndpointContentPayload({
      ownerId,
      componentKey,
      keyRevision,
      opaque: wire.protectedResponse,
      context: context(operation, operationId, scope, "response"),
    });
    const result = JSON.parse(new TextDecoder().decode(bytes));
    assert.equal(result.status, wire.result);
    return result;
  }
  async function inventory(scope) {
    const operationId = randomUUID();
    const query = new URLSearchParams({
      workerId,
      providerId: scope.providerId,
      operationId,
    });
    if (scope.projectId) query.set("projectId", scope.projectId);
    const wire = await call("GET", `/api/skills?${query}`, 200);
    const result = await open(wire, "skills.settings.list", operationId, scope);
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    return result.value;
  }
  const global = await inventory(globalScope);
  assert.deepEqual(global.project, []);
  assert.equal(
    global.global.find((entry) => entry.name === globalName)?.location,
    "codexUser",
  );
  const noModel = await call("POST", "/api/settings/providers", 201, {
    id: randomUUID(),
    name: "Skill provider without model routes",
    kind: "openai-compatible",
    baseUrl: model.model.baseUrl,
    initialAccount: null,
    protectedApiKey: null,
  });
  const unconfigured = await inventory({
    ...globalScope,
    providerId: noModel.id,
  });
  assert.ok(unconfigured.global.some((entry) => entry.name === globalName));
  const project = await inventory(projectScope);
  const selected = project.project.find((entry) => entry.name === selectedName);
  assert.ok(selected, JSON.stringify(project));
  assert.equal(
    selected.id,
    `project:${Buffer.from(selectedName).toString("base64url")}`,
  );
  assert.equal(
    selected.audienceKey,
    createHash("sha256")
      .update(
        `cantrip-skill-audience:v1\0project\0${projectRoot}\0${selectedName}`,
      )
      .digest("base64url"),
  );
  assert.equal(selected.displayName, "Fixture display name");
  assert.equal(selected.editable, true);
  assert.equal(
    project.project.find((entry) => entry.name === disabledName)?.enabled,
    false,
  );

  const listId = randomUUID();
  const listing = await open(
    await call("GET", `${chatUrl}/skills?operationId=${listId}`, 200),
    "skills.list",
    listId,
    { ...projectScope, chatId },
  );
  assert.equal(listing.status, "succeeded", JSON.stringify(listing));
  assert.ok(listing.value.some((skill) => skill.name === selectedName));
  assert.ok(!listing.value.some((skill) => skill.name === disabledName));

  async function request(file) {
    const operationId = randomUUID();
    const operation = "skills.settings.read";
    const protectedRequest = await crypto.encryptEndpointContentPayload({
      ownerId,
      componentKey,
      keyRevision,
      context: context(operation, operationId, projectScope, "request"),
      plaintext: new TextEncoder().encode(
        JSON.stringify({ skillId: selected.id, file }),
      ),
    });
    return { operationId, operation, scope: projectScope, protectedRequest };
  }
  async function read(file) {
    const input = await request(file);
    const wire = await call("POST", "/api/skills/read", 200, input);
    return open(wire, input.operation, input.operationId, projectScope);
  }
  const document = await read("agents/notes.md");
  assert.equal(document.status, "succeeded", JSON.stringify(document));
  assert.equal(document.value.content, privateText);
  assert.equal(document.value.file.sizeBytes, Buffer.byteLength(privateText));
  assert.equal(document.value.files[0].path, "SKILL.md");
  assert.ok(!document.value.files.some((file) => file.path === "outside.txt"));
  const defaultDocument = await read(undefined);
  assert.equal(defaultDocument.value.file.path, "SKILL.md");
  for (const file of ["outside.txt", "binary"])
    assert.equal((await read(file)).status, "failed");
  const wrongBinding = {
    ...(await request("agents/notes.md")),
    operationId: randomUUID(),
  };
  const rejected = await call("POST", "/api/skills/read", 409, wrongBinding);
  assert.ok(!JSON.stringify(rejected).includes(privateText));
  console.log(
    JSON.stringify({ suite: "native-skill-settings-read", passed: true }),
  );
}
