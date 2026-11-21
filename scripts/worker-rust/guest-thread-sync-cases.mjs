import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  decryptEndpointContentPayload,
  decryptPrivateDisplayLabel,
  encryptEndpointContentPayload,
} from "../../packages/crypto/dist/index.js";
import { createPreparedProjectChat } from "./console-interaction-cases.mjs";

export async function verifyGuestThreadSync({
  call,
  eventually,
  createModel,
  encryptedTurn,
  openMessage,
  ownerId,
  workerId,
  keyRevision,
  labelKey,
  repositoryKey,
  customizationKey,
  guest,
  startWorker,
  stopWorker,
  workerDiagnostics,
}) {
  const { model, profile } = await createModel("Guest observation fixture");
  const naming = await createModel("Guest label fixture");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    labelingModelId: naming.profile.id,
    autoNameChats: true,
    randomAgentNames: false,
  });
  const { chatId, chatUrl, projectUrl, placement } =
    await createPreparedProjectChat({
      call,
      eventually,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      title: "Retained guest Chat",
      autoTitle: true,
      beforeChat: ({ projectId }) =>
        guest.placeProject({
          call,
          ownerId,
          workerId,
          keyRevision,
          projectId,
          repositoryKey,
        }),
    });
  const sync = () => call("POST", chatUrl + "/sync", 200, {});
  const observe = (threadId, status) => ({
    threadId,
    status,
    statusSource: "native-thread",
    turns: [],
  });
  const original = await sync();
  assert.match(original.threadId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(original, observe(original.threadId, "idle"));
  const response = "Private reply retained in the Linux Chat.";
  const prompt = "Read this private prompt.";
  const title = "Guest Project Notes";
  const labelReply = naming.model.reply({ text: title });
  const reply = model.reply({ hold: true, text: response });
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(prompt, profile.id),
    );
    await eventually(
      () => reply.request,
      (request) => assert.ok(request),
    );
    assert.deepEqual(await sync(), observe(original.threadId, "running"));
  } finally {
    reply.release();
  }
  await eventually(
    async () => {
      const history = await call("GET", chatUrl + "/messages", 200);
      return Promise.all(history.messages.map(openMessage));
    },
    (messages) =>
      assert.ok(
        messages.some(({ content }) =>
          content.some(({ text }) => text === response),
        ),
      ),
  );
  await eventually(sync, (value) => assert.deepEqual(value, original));
  await eventually(
    async () => {
      const chats = await call("GET", `${projectUrl}/chats`, 200);
      const chat = chats.find((entry) => entry.id === chatId);
      assert.ok(chat);
      assert.ok(!JSON.stringify(chat).includes(title));
      return decryptPrivateDisplayLabel({
        ownerId,
        keyRevision,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labelKey,
        opaque: chat.titleProtection,
      });
    },
    (value) => assert.equal(value, title, "separate-provider guest Chat title"),
  );
  assert.equal(labelReply.request?.completed, true);
  assert.ok(JSON.stringify(labelReply.request.input.input).includes(prompt));
  const retained = async () => {
    const history = await call("GET", chatUrl + "/messages", 200);
    assert.equal(history.kind, "chat-encrypted");
    return Promise.all(
      history.messages.map(async (message) => ({
        id: message.id,
        sequence: message.sequence,
        idempotencyKey: message.idempotencyKey,
        text: (await openMessage(message)).content
          .filter((item) => item.type === "text")
          .map((item) => item.text),
      })),
    );
  };
  const messages = await retained();
  const requests = model.requests.filter(
    ({ method }) => method === "POST",
  ).length;
  assert.equal(requests, 1);

  const skillName = "cantrip-guest-inventory-fixture";
  const skillPath = await guest.writeProjectSkill(
    placement,
    skillName,
    `---\nname: ${skillName}\ndescription: Read the guest-only fixture.\n---\n\nGuest content.\n`,
  );
  const extraRoot = "additional skills";
  const extraName = "cantrip-guest-extra-skill-fixture";
  const extraPath = await guest.writeProjectSkill(
    placement,
    extraName,
    `---\nname: ${extraName}\ndescription: Read the extra guest skill.\n---\n\nGuest content.\n`,
    extraRoot,
  );
  await guest.linkProjectDirectory(placement, "outside-skill-root", "/");
  const scope = await call("GET", chatUrl + "/customizations/target", 200);
  const { id: serverId } = (await call("GET", "/api/bootstrap", 200)).server;
  async function customization(
    route,
    operation,
    { method = "GET", content, status = "succeeded" } = {},
  ) {
    const operationId = randomUUID();
    const context = (direction) => ({
      domain: "customization-content",
      serverId,
      workerId,
      scopeId: JSON.stringify([
        workerId,
        scope.projectId,
        chatId,
        scope.providerId,
      ]),
      operationId,
      operation,
      direction,
      sequence: 0,
    });
    const wire =
      method === "GET"
        ? await call(
            method,
            `${chatUrl}${route}?operationId=${operationId}&refresh=true`,
            200,
          )
        : await call(method, `${chatUrl}${route}`, 200, {
            operationId,
            operation,
            scope,
            protectedRequest: await encryptEndpointContentPayload({
              ownerId,
              componentKey: customizationKey,
              keyRevision,
              context: context("request"),
              plaintext: new TextEncoder().encode(JSON.stringify(content)),
            }),
          });
    assert.deepEqual(wire.scope, scope);
    assert.equal(wire.operation, operation);
    assert.equal(wire.operationId, operationId);
    assert.ok(!JSON.stringify(wire).includes(skillName));
    const clear = await decryptEndpointContentPayload({
      ownerId,
      componentKey: customizationKey,
      keyRevision,
      opaque: wire.protectedResponse,
      context: context("response"),
    });
    const result = JSON.parse(new TextDecoder().decode(clear));
    assert.equal(result.status, status, JSON.stringify(result));
    return result.value ?? result.error;
  }

  assert.deepEqual(await stopWorker(), { code: 0, signal: null });
  await startWorker();
  await eventually(
    () => customization("/skills", "skills.list"),
    (value) =>
      assert.ok(
        value.some(({ name }) => name === skillName),
        JSON.stringify(value),
      ),
  );
  const inventory = await customization(
    "/customizations",
    "customization.inventory.read",
  );
  assert.equal(
    inventory.skills.items.find(({ name }) => name === skillName)?.path,
    skillPath,
  );
  assert.ok(!inventory.skills.items.some(({ name }) => name === extraName));
  const setRoots = (roots, status) =>
    customization(
      "/customizations/skill-roots",
      "customization.skill-roots.set",
      {
        method: "PUT",
        content: { roots },
        status,
      },
    );
  const roots = { roots: [`${placement.guestPath}/${extraRoot}`] };
  assert.deepEqual(await setRoots([extraRoot, ...roots.roots]), roots);
  const extraInventory = await customization(
    "/customizations",
    "customization.inventory.read",
  );
  assert.deepEqual(extraInventory.skillRoots, roots.roots);
  assert.equal(
    extraInventory.skills.items.find(({ name }) => name === extraName)?.path,
    extraPath,
  );
  const rootsError = await setRoots(["outside-skill-root"], "failed");
  assert.match(
    rootsError.message,
    /resolve within the selected project checkout/,
  );
  const configured = await customization(
    "/customizations/skill",
    "customization.skill.configure",
    { method: "PATCH", content: { path: skillPath, enabled: false } },
  );
  assert.deepEqual(configured, { path: skillPath, effectiveEnabled: false });
  const updated = await customization(
    "/customizations",
    "customization.inventory.read",
  );
  assert.equal(
    updated.skills.items.find(({ name }) => name === skillName)?.enabled,
    false,
  );
  assert.deepEqual(updated.skillRoots, roots.roots);
  await eventually(sync, (value) => assert.deepEqual(value, original));
  assert.deepEqual(await sync(), original);
  assert.match(
    workerDiagnostics(),
    /event=codex\.runtime\.lifecycle[^\n]*:os:cantrip-os-[a-f0-9]{48}[^\n]*status=ready/,
  );
  assert.deepEqual(await retained(), messages);
  assert.equal(
    model.requests.filter(({ method }) => method === "POST").length,
    requests,
  );
  assert.equal(
    naming.model.requests.filter(({ method }) => method === "POST").length,
    1,
  );

  const skillReply = model.reply({ text: "Guest skill inventory read." });
  await call(
    "POST",
    chatUrl + "/turns",
    202,
    await encryptedTurn("Inspect the available skills.", profile.id),
  );
  await eventually(
    () => skillReply.request,
    (request) => assert.equal(request?.completed, true),
  );
  const nativeInput = JSON.stringify(skillReply.request.input.input);
  assert.ok(nativeInput.includes(extraName));
  await eventually(sync, (value) => assert.deepEqual(value, original));
  assert.deepEqual(await setRoots([]), { roots: [] });
  const cleared = await customization(
    "/customizations",
    "customization.inventory.read",
  );
  assert.deepEqual(cleared.skillRoots, []);
  assert.ok(!cleared.skills.items.some(({ name }) => name === extraName));
  assert.ok(cleared.skills.items.some(({ name }) => name === skillName));
  console.log(
    JSON.stringify({ suite: "native-guest-thread-sync", passed: true }),
  );
}
