import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  decryptChatMessageProtectedContent,
  decryptQueuedPromptProtectedContent,
  deriveFieldKey,
  encryptPayload,
} from "../../packages/crypto/dist/index.js";
import { protectChatTurn } from "../../tests/reference-node-worker/src/chat-message-encryption.ts";
import { createManagedQueueInputCodec } from "../../tests/reference-node-worker/src/managed-queue-input.ts";

export async function verifyQueuePreparation({
  request,
  expectSuccess,
  oracle,
  chatId,
  goalId,
  goalText,
  media,
}) {
  const ownerId = oracle.ownerId();
  const { key: componentKey, keyRevision } =
    oracle.componentKey("chat-content");
  const codec = createManagedQueueInputCodec({
    chatId,
    encryption: oracle,
    defaults: () => ({
      modelId: "gpt-5",
      mode: "default",
      reasoningEffort: null,
    }),
  });
  const command = (prompt) => ({
    type: "chat.queue.prepare",
    chatId,
    prompt,
    attachments: [],
  });
  const prepared = async (prompt) => {
    const actual = await expectSuccess(command(prompt));
    const reference = await codec.normalizePrompt(prompt);
    assert.deepEqual(await open(actual), await open(reference));
    assert.equal(actual.id, prompt.id);
    assert.equal(actual.pendingMessage.id, prompt.pendingMessage.id);
    assert.equal(actual.idempotencyKey, prompt.idempotencyKey);
    return actual;
  };
  const open = (prompt) =>
    Promise.all([
      decryptQueuedPromptProtectedContent({
        ownerId,
        componentKey,
        keyRevision,
        promptId: prompt.id,
        encrypted: prompt.protectedContent,
        publicClassification: prompt.classification,
      }),
      decryptChatMessageProtectedContent({
        ownerId,
        componentKey,
        keyRevision,
        messageId: prompt.pendingMessage.id,
        encrypted: prompt.pendingMessage.protectedContent,
        publicClassification: prompt.pendingMessage.classification,
      }),
      prompt.protectedNativeInput &&
        codec.openNativeInput({
          promptId: prompt.id,
          payload: prompt.protectedNativeInput,
        }),
    ]);
  const textInput = (text) => ({ type: "text", text, text_elements: [] });
  const image = {
    type: "image",
    url: `data:image/png;base64,${media.toString("base64")}`,
  };
  const draft = async ({
    text,
    promptId = randomUUID(),
    mode = "default",
    input = [textInput(text)],
    displayText = text,
    action = "parseSlash",
    executionMethod = "turn/start",
    attachmentMap = [],
    attachments,
    ...retention
  }) => {
    const { queuedPrompt } = await protectChatTurn({
      promptId,
      messageId: randomUUID(),
      idempotencyKey: randomUUID(),
      modelId: "gpt-5",
      mode,
      reasoningEffort: null,
      service: oracle,
      text,
      attachments,
    });
    const associatedData = {
      ownerId,
      component: "chat-content",
      table: "managed-queue",
      rowId: createHash("sha256")
        .update(JSON.stringify([oracle.serverIdentity(), chatId, promptId]))
        .digest("hex"),
      field: "native-input",
      formatVersion: 1,
      keyRevision,
    };
    const protectedNativeInput = await encryptPayload({
      key: deriveFieldKey({ componentKey, ...associatedData }),
      associatedData,
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          input,
          displayText,
          action,
          executionMethod,
          ...retention,
          attachmentMap,
        }),
      ),
    });
    return {
      ...queuedPrompt,
      nativeAction: action,
      executionMethod,
      protectedNativeInput,
    };
  };

  const original = "/plan The previous version of the project objective.";
  const edit = await draft({
    promptId: goalId,
    mode: "plan",
    text: `/goal ${goalText}`,
    input: [textInput(original), image],
    displayText: original,
  });
  const goal = await prepared(edit);
  assert.equal(goal.executionMethod, "thread/goal/set");
  assert.equal(goal.classification.mode, "goal");
  assert.equal(goal.pendingMessage.classification.mode, "goal");
  assert.equal((await open(goal))[0].text, `/goal ${goalText}`);
  assert.equal(
    (await request({ ...command(edit), chatId: randomUUID() })).ok,
    false,
  );
  const tampered = structuredClone(edit);
  tampered.pendingMessage.protectedContent.envelope.nonce =
    Buffer.alloc(12).toString("base64url");
  assert.equal((await request(command(tampered))).ok, false);

  const plain = await prepared(
    await draft({ text: "!echo fixture", mode: "plan", action: "plain" }),
  );
  assert.equal(plain.nativeAction, "runShell");
  assert.equal(plain.executionMethod, "thread/shellCommand");
  assert.equal(plain.classification.mode, "default");

  const split = await prepared(
    await draft({
      text: "/plan\nimplement",
      input: [textInput("/plan"), image, textInput("implement")],
    }),
  );
  assert.equal(split.executionMethod, "turn/start");
  assert.equal(split.classification.mode, "plan");
  assert.deepEqual((await open(split))[2].input, [
    textInput("/plan"),
    image,
    textInput("implement"),
  ]);

  const keptAttachment = {
    id: randomUUID(),
    chatId,
    fileName: "kept.png",
    mimeType: "image/png",
    sizeBytes: media.length,
    kind: "image",
    source: "file",
    status: "ready",
    previewText: null,
    createdAt: new Date().toISOString(),
  };
  const changedAttachments = await prepared(
    await draft({
      text: "/plan",
      displayText: "",
      input: [image, image],
      attachmentMap: [
        { id: randomUUID(), index: 0 },
        { id: keptAttachment.id, index: 1 },
      ],
      attachments: [keptAttachment],
    }),
  );
  assert.equal(changedAttachments.executionMethod, "thread/settings/update");
  const [display, pending, native] = await open(changedAttachments);
  assert.deepEqual(native.attachmentMap, [{ id: keptAttachment.id, index: 1 }]);
  assert.deepEqual(native.input, [textInput("/plan"), image]);
  assert.deepEqual(display.classification.attachmentIds, [keptAttachment.id]);
  assert.deepEqual(
    pending.content.find((item) => item.type === "attachment"),
    {
      type: "attachment",
      attachment: keptAttachment,
    },
  );

  const badSpans = await draft({
    text: "bad native range",
    action: "literal",
    input: [
      {
        type: "text",
        text: "bad native range",
        text_elements: [{ byteRange: { start: -1, end: 0 } }],
      },
    ],
  });
  assert.equal((await request(command(badSpans))).ok, false);

  const exact = [textInput("retained native text and metadata"), image];
  const retainedGui = await draft({
    text: "original user text",
    input: exact,
    retainedGui: true,
    representedAttachmentIds: [],
    action: "literal",
  });
  assert.deepEqual((await open(await prepared(retainedGui)))[2].input, exact);
  const editedGui = await prepared(
    await draft({
      text: "edited user text",
      displayText: "original user text",
      input: exact,
      retainedGui: true,
      representedAttachmentIds: [],
      action: "literal",
    }),
  );
  const editedNative = (await open(editedGui))[2];
  assert.equal(editedNative.retainedGui, false);
  assert.deepEqual(editedNative.input, [textInput("edited user text")]);

  const terminal = await prepared(
    await draft({
      text: "/goal clear",
      mode: "goal",
      retainedTurnStart: true,
      action: "literal",
    }),
  );
  assert.equal(terminal.executionMethod, "turn/start");
  const clear = await prepared(await draft({ text: "/goal clear" }));
  assert.equal(clear.executionMethod, "thread/goal/clear");

  const unsupported = await draft({ text: "/unknown" });
  assert.equal((await request(command(unsupported))).ok, false);
  const interactive = await draft({ text: "/goal edit" });
  assert.equal((await request(command(interactive))).ok, false);

  const legacy = await draft({ text: "Legacy objective", mode: "goal" });
  delete legacy.nativeAction;
  delete legacy.executionMethod;
  delete legacy.protectedNativeInput;
  const legacyReady = await prepared(legacy);
  assert.equal(legacyReady.nativeAction, "literal");
  assert.equal(legacyReady.executionMethod, "thread/goal/set");
  assert.deepEqual(legacyReady.protectedContent, legacy.protectedContent);
  assert.deepEqual(legacyReady.pendingMessage, legacy.pendingMessage);
  console.log(
    "Queue preparation matches the Node codec for edited rich inputs, slash classification, retained GUI and terminal text, and legacy prompts.",
  );
  return goal;
}
