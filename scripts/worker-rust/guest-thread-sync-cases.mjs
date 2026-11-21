import assert from "node:assert/strict";
import { decryptPrivateDisplayLabel } from "../../packages/crypto/dist/index.js";
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
  const { chatId, chatUrl, projectUrl } = await createPreparedProjectChat({
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

  assert.deepEqual(await stopWorker(), { code: 0, signal: null });
  await startWorker();
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
  console.log(
    JSON.stringify({ suite: "native-guest-thread-sync", passed: true }),
  );
}
