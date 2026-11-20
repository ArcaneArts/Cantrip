import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

const selectedName = "cantrip-protected-skill-fixture";
const disabledName = "cantrip-disabled-skill-fixture";
const globalName = "cantrip-global-settings-fixture";
const linkedName = "cantrip-readonly-linked-skill";
const privateText = "Protected nested skill notes 🌲";
const editedText = "Edited private skill notes 🗺️";

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
  restartWorker,
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
      await chmod(path.join(selected, "agents", "notes.md"), 0o640);
      await writeFile(path.join(selected, "binary"), Buffer.from([0, 1, 2]));
      const outside = path.join(projectPath, "outside.txt");
      await writeFile(outside, "Outside skill directory");
      await symlink(outside, path.join(selected, "outside.txt"), "file");
      const linked = await createSkill(
        path.join(data, "linked-skill-sources"),
        linkedName,
      );
      await symlink(linked, path.join(projectRoot, linkedName), "dir");
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
    assert.ok(!encoded.includes(editedText));
    assert.ok(!encoded.includes(selectedName));
    assert.ok(!encoded.includes("skill-recovery"));
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

  const chatScope = { ...projectScope, chatId };
  async function skillList() {
    const listId = randomUUID();
    const listing = await open(
      await call("GET", `${chatUrl}/skills?operationId=${listId}`, 200),
      "skills.list",
      listId,
      chatScope,
    );
    assert.equal(listing.status, "succeeded", JSON.stringify(listing));
    return listing.value;
  }
  const listing = await skillList();
  assert.ok(listing.some((skill) => skill.name === selectedName));
  assert.ok(!listing.some((skill) => skill.name === disabledName));

  async function request(operation, content, scope = projectScope) {
    const operationId = randomUUID();
    const protectedRequest = await crypto.encryptEndpointContentPayload({
      ownerId,
      componentKey,
      keyRevision,
      context: context(operation, operationId, scope, "request"),
      plaintext: new TextEncoder().encode(JSON.stringify(content)),
    });
    return { operationId, operation, scope, protectedRequest };
  }
  async function send(method, route, input) {
    return open(
      await call(method, route, 200, input),
      input.operation,
      input.operationId,
      input.scope,
    );
  }
  async function read(file) {
    return send(
      "POST",
      "/api/skills/read",
      await request("skills.settings.read", { skillId: selected.id, file }),
    );
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
    ...(await request("skills.settings.read", {
      skillId: selected.id,
      file: "agents/notes.md",
    })),
    operationId: randomUUID(),
  };
  const rejected = await call("POST", "/api/skills/read", 409, wrongBinding);
  assert.ok(!JSON.stringify(rejected).includes(privateText));

  const skillId = selected.id;
  const write = async (file, content, id = skillId) =>
    send(
      "PUT",
      "/api/skills/file",
      await request("skills.settings.write", { skillId: id, file, content }),
    );
  const firstEdit = await request("skills.settings.write", {
    skillId,
    file: "agents/notes.md",
    content: editedText,
  });
  assert.deepEqual(await send("PUT", "/api/skills/file", firstEdit), {
    status: "succeeded",
    value: { changed: true, recoveryPath: null },
  });
  assert.equal((await read("agents/notes.md")).value.content, editedText);
  const notesPath = path.join(projectRoot, selectedName, "agents", "notes.md");
  if (process.platform !== "win32")
    assert.equal((await stat(notesPath)).mode & 0o777, 0o640);
  assert.equal(
    (await write("agents/notes.md", privateText)).status,
    "succeeded",
  );
  const replay = await call("PUT", "/api/skills/file", 409, firstEdit);
  assert.match(JSON.stringify(replay), /already completed/iu);
  assert.equal((await read("agents/notes.md")).value.content, privateText);

  const invalid = await write("SKILL.md", "Missing required frontmatter.");
  assert.equal(invalid.status, "failed");
  assert.equal((await read()).value.content, defaultDocument.value.content);
  const updatedManifest = defaultDocument.value.content.replace(
    "Fixture body.",
    editedText,
  );
  assert.equal((await write("SKILL.md", updatedManifest)).status, "succeeded");
  assert.equal((await read()).value.content, updatedManifest);
  assert.equal(
    (await write("outside.txt", "Should remain untouched.")).status,
    "failed",
  );

  const linked = project.project.find((item) => item.name === linkedName);
  assert.equal(linked?.editable, false);
  assert.equal(
    (await write("SKILL.md", updatedManifest, linked.id)).status,
    "failed",
  );
  const remove = async (id) =>
    send(
      "DELETE",
      "/api/skills",
      await request("skills.settings.delete", { skillId: id }),
    );
  assert.equal((await remove(linked.id)).status, "failed");
  assert.match(
    await readFile(
      path.join(data, "linked-skill-sources", linkedName, "SKILL.md"),
      "utf8",
    ),
    new RegExp(linkedName),
  );

  const disabled = await send(
    "PATCH",
    "/api/skills/configuration",
    await request("skills.settings.configure", { skillId, enabled: false }),
  );
  assert.deepEqual(disabled, {
    status: "succeeded",
    value: { skillId, effectiveEnabled: false },
  });
  assert.equal(
    (await inventory(projectScope)).project.find(
      (skill) => skill.id === skillId,
    )?.enabled,
    false,
  );
  assert.ok(!(await skillList()).some((skill) => skill.name === selectedName));
  await restartWorker();
  await eventually(
    () => inventory(projectScope),
    ({ project }) =>
      assert.equal(
        project.find((skill) => skill.id === skillId)?.enabled,
        false,
      ),
  );
  const enabled = await send(
    "PATCH",
    `${chatUrl}/customizations/skill`,
    await request(
      "customization.skill.configure",
      { path: selected.path, enabled: true },
      chatScope,
    ),
  );
  assert.deepEqual(enabled, {
    status: "succeeded",
    value: { path: selected.path, effectiveEnabled: true },
  });
  assert.ok((await skillList()).some((skill) => skill.name === selectedName));

  const deleted = await remove(skillId);
  assert.equal(deleted.status, "succeeded", JSON.stringify(deleted));
  assert.equal(deleted.value.changed, true);
  const recoveryPath = deleted.value.recoveryPath;
  assert.ok(
    recoveryPath.startsWith(path.join(data, "skill-recovery") + path.sep),
  );
  assert.equal(
    await readFile(path.join(recoveryPath, "SKILL.md"), "utf8"),
    updatedManifest,
  );
  assert.equal(
    await readFile(path.join(recoveryPath, "agents", "notes.md"), "utf8"),
    privateText,
  );
  await assert.rejects(stat(path.join(projectRoot, selectedName)), {
    code: "ENOENT",
  });
  assert.ok(
    !(await inventory(projectScope)).project.some(
      (item) => item.id === skillId,
    ),
  );
  console.log(JSON.stringify({ suite: "native-skill-settings", passed: true }));
}
