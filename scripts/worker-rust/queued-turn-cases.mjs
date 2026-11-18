import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AttachmentStore } from "../../cantrip_worker/src/attachment-store.ts";
import { protectWorkerAttachmentMetadata } from "../../cantrip_worker/src/attachment-encryption.ts";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.ts";
import { managedQueueTurnInput } from "../../cantrip_worker/src/codex/managed-queue-command.ts";
import { admit, GuiReceiptPeer, logical } from "./gui-receipt-cases.mjs";
import { GuiHistoryPeer } from "./gui-history-cases.mjs";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgaPgPQhAKACX2Bf2gcp/LAAAAAElFTkSuQmCC";

export async function verifyQueuedTurns({
  start,
  stop,
  request,
  expectThread,
  expectSuccess,
  untilProvider,
  modelCalls,
  attach,
  workerId,
  generation,
  provider,
  directory,
  oracle,
  stamp,
}) {
  await start();
  const attachmentStore = new AttachmentStore(directory);
  const issue = async (rich) => {
    const session = {
      contextKind: "project",
      chatId: randomUUID(),
      computerUseEnabled: false,
      projectId: randomUUID(),
      worktreeId: randomUUID(),
      rootKind: "folder-root",
      scratchRootId: null,
    };
    const planMode = rich ? "plan" : "default";
    const { threadId } = await expectThread({ session, provider, planMode });
    const text = rich
      ? "Review the retained queue preview."
      : "Review the queued file reference.";
    const client = rich ? "terminal-input:" + randomUUID() : undefined;
    const promptId = randomUUID();
    let prompt, attachments, file;
    if (rich) {
      const codec = createManagedQueueInputCodec({
        encryption: oracle,
        chatId: session.chatId,
        attachmentStore,
        defaults: () => ({
          mode: "default",
          modelId: "gpt-5",
          reasoningEffort: null,
        }),
      });
      ({ prompt, attachments } = await codec.preparePrompt({
        id: promptId,
        request: {
          method: "thread/queue/add",
          params: {
            threadId,
            clientUserMessageId: client,
            managed: { action: "parseSlash", operationId: randomUUID() },
            input: [
              { type: "text", text: "/plan", text_elements: [] },
              { type: "image", url: image },
              { type: "text", text: "\u3000" + text, text_elements: [] },
            ],
          },
        },
      }));
      const retained = await codec.openNativeInput({
        promptId,
        payload: prompt.protectedNativeInput,
      });
      assert.deepEqual(managedQueueTurnInput(retained), [
        { type: "image", url: image },
        { type: "text", text, text_elements: [] },
      ]);
    } else {
      const fileName = "queued-note.txt";
      const bytes = Buffer.from("Authorized queue attachment fixture.");
      const summary = {
        id: randomUUID(),
        chatId: session.chatId,
        fileName,
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        kind: "text",
        source: "file",
        status: "ready",
        previewText: null,
        createdAt: stamp,
      };
      file = attachmentStore.resolve(summary.chatId, summary.id, fileName);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { mode: 0o600 });
      const protectedMetadata = await protectWorkerAttachmentMetadata({
        chatId: summary.chatId,
        attachmentId: summary.id,
        service: oracle,
        content: {
          version: 1,
          fileName,
          mimeType: summary.mimeType,
          kind: summary.kind,
          source: summary.source,
          previewText: null,
          error: null,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      attachments = [
        {
          id: summary.id,
          chatId: summary.chatId,
          sizeBytes: summary.sizeBytes,
          status: summary.status,
          createdAt: summary.createdAt,
          protectedMetadata,
        },
      ];
      ({ queuedPrompt: prompt } = await protectChatTurn({
        promptId,
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        modelId: "gpt-5",
        mode: "default",
        reasoningEffort: null,
        service: oracle,
        text,
        attachments: [summary],
      }));
    }
    const fields = {
      type: "chat.turn",
      executionProfile: "ide",
      contextKind: "project",
      chatId: session.chatId,
      clientMessageId: prompt.pendingMessage.id,
      executionLaneId: randomUUID(),
      threadId,
      worktreeId: session.worktreeId,
      policyProjectId: session.projectId,
      rootKind: session.rootKind,
      isPrimary: true,
      worktreeMode: "agent-managed",
      worktreePolicy: "direct",
      planMode,
      provider,
      queuedPromptId: prompt.id,
      protectedPrompt: prompt.pendingMessage,
      attachments,
      resultMode: {
        kind: "chat-message-encrypted",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
      ...(rich
        ? {
            protectedNativeInput: prompt.protectedNativeInput,
            nativeClientUserMessageId: client,
          }
        : {}),
    };
    const receipt = admit(fields, stamp);
    const peer = new GuiReceiptPeer(fields, receipt, {
      oracle,
      workerId,
      workerGeneration: generation(),
    });
    const history = new GuiHistoryPeer({
      fields,
      receipt,
      oracle,
      workerId,
      stamp,
    });
    attach(peer, history);
    const before = modelCalls();
    if (rich) {
      assert.equal((await request(fields)).ok, false);
      const rejected = admit(fields, stamp);
      const invalid = await request({
        ...fields,
        queuedPromptId: randomUUID(),
        nativeCommandReceipt: rejected,
      });
      assert.equal(invalid.ok, false);
      await expectSuccess(logical(rejected));
      assert.equal(modelCalls(), before);
      assert.deepEqual(peer.steps, []);
    }
    const upstream = untilProvider();
    const received = request({ ...fields, nativeCommandReceipt: receipt });
    const actual = await Promise.race([
      upstream,
      received.then((frame) => assert.fail(JSON.stringify(frame))),
    ]);
    assert.deepEqual(peer.steps.slice(0, 2), ["bind-preparation", "dispatch"]);
    const content = actual.body.input.flatMap((item) =>
      item.role === "user" && Array.isArray(item.content) ? item.content : [],
    );
    const nativeText = content.flatMap((item) => item.text ?? []).join("\n");
    assert.ok(nativeText.includes(text));
    assert.ok(!nativeText.includes("/plan"));
    const images = content.filter((item) => item.type === "input_image");
    assert.equal(images.length, rich ? 1 : 0);
    if (!rich) assert.ok(nativeText.includes(file));
    actual.finish();
    const response = await received;
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(modelCalls(), before + 1);
    assert.equal(
      peer.result.reconciliation.nativeTurnId,
      response.result.turnId,
    );
    assert.equal(peer.terminal.terminalStatus, "completed");
    assert.deepEqual(peer.steps, [
      "bind-preparation",
      "dispatch",
      "receipt",
      "receipt",
      "receipt",
    ]);
    await expectSuccess(logical(receipt));
    const signal = AbortSignal.timeout(5000);
    for (;;) {
      try {
        await history.verifyLocalSource(directory, response.result.turnId);
        assert.ok(
          [...history.identities.values()].some(
            (entry) => entry.preservedInput?.id === prompt.pendingMessage.id,
          ),
        );
        break;
      } catch (error) {
        if (error.code !== "ERR_ASSERTION" || signal.aborted) throw error;
        await delay(20, undefined, { signal });
      }
    }
  };
  try {
    await issue(true);
    await issue(false);
    await stop();
  } finally {
    attach();
  }
  console.log(
    "Core-admitted rich and legacy queued model prompts ran through native dispatch, exact receipts, and canonical History.",
  );
}
