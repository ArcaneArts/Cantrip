import {
  managedQueueTurnInput,
  managedQueueNativeCommand,
} from "../src/codex/managed-queue-command.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptChatMessageProtectedContent,
  encryptQueuedPromptProtectedContent,
} from "@cantrip/crypto";
import type { EncryptedQueuedPrompt } from "@cantrip/protocol";
import type { QueuedPromptOpaqueContent } from "@cantrip/protocol/communication-content";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AttachmentStore } from "../src/attachment-store.js";
import { openWorkerAttachments } from "../src/attachment-encryption.js";
import {
  createManagedQueueInputCodec,
  type NativeQueueUserInput,
} from "../src/managed-queue-input.js";
import type { ManagedNativeQueueRequest } from "../src/codex/managed-native-queue.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const id = "11111111-1111-4111-8111-111111111111";
const identity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project" as const,
  placementId: "placement",
  threadId: "thread",
  runtimeGeneration: "runtime",
  modelRouteId: "route",
  providerAccountId: null,
};
const key = new Uint8Array(32).fill(27);
const storeDirectory = mkdtempSync(join(tmpdir(), "cantrip-queue-media-test-"));
const attachmentStore = new AttachmentStore(storeDirectory);
afterAll(() => rm(storeDirectory, { recursive: true, force: true }));
function encryption(owner = "owner", server = "server") {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = 3) => {
      if (revision !== 3) throw new Error("Missing key revision");
      return { key: key.slice(), keyRevision: revision };
    },
  } as unknown as WorkerEncryptionService;
}
function codec(
  options: { owner?: string; server?: string; chatId?: string } = {},
) {
  return createManagedQueueInputCodec({
    encryption: encryption(options.owner, options.server),
    chatId: options.chatId ?? "chat",
    attachmentStore,
    defaults: () => ({
      mode: "default",
      modelId: "model",
      reasoningEffort: "high",
      customSubagentModel: true,
      subagentModelId: "child",
      subagentReasoningEffort: "medium",
      worktreeId: "placement",
    }),
  });
}
function request(
  input: unknown[],
  action = "plain",
): ManagedNativeQueueRequest {
  return {
    method: "thread/queue/add",
    params: {
      threadId: "thread",
      input,
      clientUserMessageId: "native-message",
      managed: { action },
    },
    identity,
    connectionId: "view",
    signal: new AbortController().signal,
    assertCurrent() {},
  };
}
function stored(prompt: QueuedPromptOpaqueContent): EncryptedQueuedPrompt {
  return {
    ...prompt,
    chatId: "chat",
    attachments: [],
    revision: 2,
    position: 0,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}
async function editDisplay(prompt: QueuedPromptOpaqueContent, text: string) {
  return {
    ...prompt,
    protectedContent: await encryptQueuedPromptProtectedContent({
      ownerId: "owner",
      promptId: id,
      componentKey: key,
      keyRevision: 3,
      content: { version: 1, classification: prompt.classification, text },
    }),
  };
}

describe("canonical managed queue input protection", () => {
  it("round trips the full native vector, spans and identities without plaintext storage", async () => {
    const nativeInput: NativeQueueUserInput[] = [
      {
        type: "text",
        text: "  private π $skill  ",
        text_elements: [
          { byteRange: { start: 13, end: 19 }, placeholder: "$skill" },
        ],
      },
      {
        type: "image",
        url: "data:image/png;base64,cHJpdmF0ZQ==",
        detail: "original",
      },
      { type: "audio", url: "data:audio/wav;base64,YXVkaW8=" },
      { type: "skill", name: "skill", path: "/private/skill/SKILL.md" },
      { type: "mention", name: "source", path: "/private/source.ts" },
    ];
    const subject = codec();
    const prepared = await subject.preparePrompt({
      id,
      request: request(nativeInput),
    });
    expect(JSON.stringify(prepared)).not.toContain("private");
    const opened = await subject.openPrompt(stored(prepared.prompt));
    expect(opened.input).toEqual(nativeInput);
    expect(opened.clientUserMessageId).toBe("native-message");
    expect(prepared.prompt).toMatchObject({
      modelId: "model",
      customSubagentModel: true,
      subagentModelId: "child",
      subagentReasoningEffort: "medium",
      worktreeId: "placement",
    });
    expect(key).toEqual(new Uint8Array(32).fill(27));
  });

  it("snapshots local media before acceptance and still opens after its source is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cantrip-queue-input-"));
    try {
      const image = join(directory, "input.png");
      const audio = join(directory, "input.wav");
      await writeFile(image, Buffer.from([137, 80, 78, 71]));
      await writeFile(audio, Buffer.from("audio bytes"));
      const subject = codec();
      const prepared = await subject.preparePrompt({
        id,
        request: request([
          { type: "localImage", path: image, detail: "high" },
          { type: "localAudio", path: audio },
        ]),
      });
      await rm(directory, { recursive: true });
      const summaries = await openWorkerAttachments(
        prepared.attachments,
        encryption(),
      );
      expect(summaries.map((item) => item.kind)).toEqual(["image", "audio"]);
      expect(summaries.map((item) => item.fileName)).toEqual([
        "input.png",
        "input.wav",
      ]);
      const content = await attachmentStore.read(
        "chat",
        summaries[0]!.id,
        summaries[0]!.fileName,
        0,
        20,
      );
      expect(Array.from(content.bytes)).toEqual([137, 80, 78, 71]);
      expect((await subject.openPrompt(stored(prepared.prompt))).input).toEqual(
        [
          {
            type: "image",
            url: "data:image/png;base64,iVBORw==",
            detail: "high",
          },
          { type: "audio", url: "data:audio/wav;base64,YXVkaW8gYnl0ZXM=" },
        ],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors GUI removal of mapped native media and never appends its surviving attachment twice", async () => {
    const subject = codec();
    const prepared = await subject.preparePrompt({
      id,
      request: request([
        { type: "text", text: "inspect" },
        { type: "image", url: "data:image/png;base64,cG5n" },
        { type: "audio", url: "data:audio/wav;base64,d2F2" },
      ]),
    });
    const item = {
      ...stored(prepared.prompt),
      attachments: prepared.attachments,
    };
    expect((await subject.openPrompt(item)).input).toHaveLength(3);
    const opened = await subject.openNativeInput({
      promptId: id,
      payload: prepared.prompt.protectedNativeInput!,
      attachmentIds: [prepared.attachments[1]!.id],
      text: "revised",
    });
    expect(opened.input).toEqual([
      { type: "text", text: "revised", text_elements: [] },
      { type: "audio", url: "data:audio/wav;base64,d2F2" },
    ]);
    expect(opened.attachmentMap).toEqual([
      { id: prepared.attachments[1]!.id, index: 1 },
    ]);
  });

  it("retains attachment IDs through a native text edit and drops only media actually removed from its vector", async () => {
    const subject = codec();
    const prepared = await subject.preparePrompt({
      id,
      request: request([
        { type: "text", text: "inspect" },
        { type: "image", url: "data:image/png;base64,cG5n" },
        { type: "audio", url: "data:audio/wav;base64,d2F2" },
      ]),
    });
    const original = {
      ...stored(prepared.prompt),
      attachments: prepared.attachments,
    };
    const edited = await subject.preparePrompt({
      id,
      existing: original,
      request: request([
        { type: "text", text: "revised" },
        { type: "audio", url: "data:audio/wav;base64,d2F2" },
      ]),
    });
    expect(edited.attachments.map((item) => item.id)).toEqual([
      prepared.attachments[1]!.id,
    ]);
    expect(edited.prompt.pendingMessage.id).toBe(original.pendingMessage.id);
    expect(
      (
        await subject.openPrompt({
          ...stored(edited.prompt),
          attachments: edited.attachments,
        })
      ).input,
    ).toEqual([
      { type: "text", text: "revised" },
      { type: "audio", url: "data:audio/wav;base64,d2F2" },
    ]);
  });

  it("does not overwrite accepted attachment bytes when a caller reuses an operation ID with different content", async () => {
    const subject = codec();
    const first = await subject.preparePrompt({
      id,
      request: request([
        { type: "image", url: "data:image/png;base64,Zmlyc3Q=" },
      ]),
    });
    const second = await subject.preparePrompt({
      id,
      request: request([
        { type: "image", url: "data:image/png;base64,c2Vjb25k" },
      ]),
    });
    expect(first.attachments[0]!.id).not.toBe(second.attachments[0]!.id);
    const [summary] = await openWorkerAttachments(
      first.attachments,
      encryption(),
    );
    const read = await attachmentStore.read(
      "chat",
      summary!.id,
      summary!.fileName,
      0,
      100,
    );
    expect(new TextDecoder().decode(read.bytes)).toBe("first");
  });

  it("recovers a failed media upload without a worker restart and preserves an already committed copy", async () => {
    const subject = codec();
    const native = [{ type: "image", url: "data:image/png;base64,c3RhYmxl" }];
    const first = await subject.preparePrompt({ id, request: request(native) });
    const failure = vi
      .spyOn(attachmentStore, "append")
      .mockRejectedValueOnce(new Error("temporary disk failure"));
    try {
      await expect(
        subject.preparePrompt({ id, request: request(native) }),
      ).rejects.toThrow("temporary disk failure");
    } finally {
      failure.mockRestore();
    }
    const [summary] = await openWorkerAttachments(
      first.attachments,
      encryption(),
    );
    expect(
      new TextDecoder().decode(
        (
          await attachmentStore.read(
            "chat",
            summary!.id,
            summary!.fileName,
            0,
            100,
          )
        ).bytes,
      ),
    ).toBe("stable");
    const retried = await subject.preparePrompt({
      id,
      request: request(native),
    });
    expect(retried.attachments[0]!.id).toBe(first.attachments[0]!.id);
  });

  it("binds native input to server, owner, chat, item and recorded key revision", async () => {
    const prepared = await codec().preparePrompt({
      id,
      request: request([{ type: "text", text: "secret" }]),
    });
    const payload = prepared.prompt.protectedNativeInput!;
    for (const subject of [
      codec({ owner: "other" }),
      codec({ server: "other" }),
      codec({ chatId: "other" }),
    ]) {
      await expect(
        subject.openNativeInput({ promptId: id, payload }),
      ).rejects.toThrow();
    }
    await expect(
      codec().openNativeInput({ promptId: "other", payload }),
    ).rejects.toThrow();
    await expect(
      codec().openNativeInput({
        promptId: id,
        payload: { ...payload, keyRevision: 4 },
      }),
    ).rejects.toThrow("Missing key revision");
  });

  it("preserves exact input for metadata-only edits and replaces spans only when GUI text changes", async () => {
    const subject = codec();
    const input = [
      {
        type: "text",
        text: "old",
        text_elements: [
          { byteRange: { start: 0, end: 3 }, placeholder: "old" },
        ],
      },
      { type: "mention", name: "file", path: "/file" },
      { type: "text", text: "tail" },
    ];
    const prepared = await subject.preparePrompt({
      id,
      request: request(input),
    });
    expect(
      (await subject.openPrompt(stored({ ...prepared.prompt, frozen: true })))
        .input,
    ).toEqual(input);
    const edited = await editDisplay(prepared.prompt, "new text");
    expect((await subject.openPrompt(stored(edited))).input).toEqual([
      { type: "text", text: "new text", text_elements: [] },
      { type: "mention", name: "file", path: "/file" },
    ]);
  });

  it.each([
    ["!echo ok", "plain", "default", "thread/shellCommand"],
    ["!echo ok", "literal", "default", "turn/start"],
    ["/plan do work", "parseSlash", "plan", "turn/start"],
    ["/plan", "parseSlash", "plan", "thread/settings/update"],
    ["/goal improve coverage", "parseSlash", "goal", "thread/goal/set"],
    ["/goal CLEAR", "parseSlash", "goal", "thread/goal/clear"],
  ])(
    "retains typed semantics for %s (%s)",
    async (text, action, mode, method) => {
      const prepared = await codec().preparePrompt({
        id,
        request: request([{ type: "text", text }], action),
      });
      expect(prepared.prompt.classification.mode).toBe(mode);
      expect(prepared.prompt.executionMethod).toBe(method);
      expect((await codec().openPrompt(stored(prepared.prompt))).input).toEqual(
        [{ type: "text", text }],
      );
    },
  );

  it("classifies and dispatches a split /plan vector consistently while preserving rich inputs and native byte spans", async () => {
    const subject = codec();
    const input: NativeQueueUserInput[] = [
      {
        type: "text",
        text: "/plan",
        text_elements: [
          { byteRange: { start: 0, end: 5 }, placeholder: "/plan" },
        ],
      },
      { type: "mention", name: "reviewer", path: "agent://reviewer" },
      { type: "text", text: " \u2003" },
      { type: "image", url: "data:image/png;base64,cG5n", detail: "original" },
      {
        type: "text",
        text: "\t😀 inspect",
        text_elements: [
          { byteRange: { start: 6, end: 13 }, placeholder: "inspect" },
        ],
      },
      {
        type: "text",
        text: "tail",
        text_elements: [
          { byteRange: { start: 0, end: 4 }, placeholder: "tail" },
        ],
      },
    ];
    const prepared = await subject.preparePrompt({
      id,
      request: request(input, "parseSlash"),
    });
    expect(prepared.prompt).toMatchObject({
      classification: { mode: "plan" },
      executionMethod: "turn/start",
    });
    const native = await subject.openNativeInput({
      promptId: id,
      payload: prepared.prompt.protectedNativeInput!,
    });
    expect(native.input).toEqual(input);
    expect(managedQueueTurnInput(native)).toEqual([
      input[1],
      input[3],
      {
        type: "text",
        text: "😀 inspect",
        text_elements: [
          { byteRange: { start: 5, end: 12 }, placeholder: "inspect" },
        ],
      },
      input[5],
    ]);
    expect(native.input).toEqual(input);
  });

  it("treats split bare /plan whitespace as settings without fabricating model input", async () => {
    const subject = codec();
    const prepared = await subject.preparePrompt({
      id,
      request: request(
        [
          { type: "text", text: "/plan" },
          { type: "text", text: " \t" },
        ],
        "parseSlash",
      ),
    });
    expect(prepared.prompt.executionMethod).toBe("thread/settings/update");
    const native = await subject.openNativeInput({
      promptId: id,
      payload: prepared.prompt.protectedNativeInput!,
    });
    expect(
      await managedQueueNativeCommand({
        opened: native,
        threadId: "thread",
        promptId: id,
        codexHome: "/tmp/unused-split-plan",
      }),
    ).toEqual({
      method: "thread/settings/update",
      params: { threadId: "thread" },
      planMode: "plan",
    });
    expect(() =>
      managedQueueTurnInput({ ...native, executionMethod: "turn/start" }),
    ).toThrow("no native model input");
  });

  it("normalizes a GUI slash edit and reencrypts both classifications before admission", async () => {
    const subject = codec();
    const prepared = await subject.preparePrompt({
      id,
      request: request(
        [{ type: "text", text: "/plan implement" }],
        "parseSlash",
      ),
    });
    const normalized = await subject.normalizePrompt(
      await editDisplay(prepared.prompt, "/goal implement"),
    );
    expect(normalized.executionMethod).toBe("thread/goal/set");
    expect(normalized.classification.mode).toBe("goal");
    expect(normalized.pendingMessage.classification.mode).toBe("goal");
    await expect(
      decryptChatMessageProtectedContent({
        ownerId: "owner",
        messageId: normalized.pendingMessage.id,
        componentKey: key,
        keyRevision: 3,
        encrypted: normalized.pendingMessage.protectedContent,
        publicClassification: normalized.pendingMessage.classification,
      }),
    ).resolves.toMatchObject({ classification: { mode: "goal" } });
    expect(
      (
        await subject.openNativeInput({
          promptId: id,
          payload: normalized.protectedNativeInput!,
        })
      ).input,
    ).toEqual([{ type: "text", text: "/goal implement", text_elements: [] }]);
  });

  it("rejects unavailable local content and unsupported slash calls without poisoning later input", async () => {
    const subject = codec();
    await expect(
      subject.preparePrompt({
        id,
        request: request([
          { type: "localImage", path: "/nonexistent/cantrip-input.png" },
        ]),
      }),
    ).rejects.toThrow();
    for (const text of ["/unknown secret", "/goal", "/goal edit"])
      await expect(
        subject.preparePrompt({
          id,
          request: request([{ type: "text", text }], "parseSlash"),
        }),
      ).rejects.toThrow();
    const prepared = await subject.preparePrompt({
      id,
      request: request([{ type: "text", text: "still works" }]),
    });
    expect((await subject.openPrompt(stored(prepared.prompt))).input).toEqual([
      { type: "text", text: "still works" },
    ]);
  });
});
describe("deferred GUI input retention", () => {
  it("authenticates the original message, retains exact native input and IDs, and seals queue fields separately", async () => {
    const subject = codec();
    const original = await subject.preparePrompt({
      id,
      request: request([
        { type: "text", text: "original private user prompt" },
      ]),
    });
    const nativeInput = [
      {
        type: "text" as const,
        text: "transformed retry context plus original private user prompt",
        text_elements: [],
      },
    ];
    const retained = await subject.retainGuiPrompt({
      pendingMessage: original.prompt.pendingMessage,
      attachments: [],
      input: nativeInput,
    });
    const again = await subject.retainGuiPrompt({
      pendingMessage: original.prompt.pendingMessage,
      attachments: [],
      input: nativeInput,
      clientUserMessageId: `cantrip:${original.prompt.pendingMessage.id}`,
    });
    expect(retained.prompt.id).toBe(again.prompt.id);
    expect(retained.prompt.pendingMessage).toEqual(
      original.prompt.pendingMessage,
    );
    expect(retained.prompt.nativeClientUserMessageId).toBe(
      `cantrip:${original.prompt.pendingMessage.id}`,
    );
    expect(retained.prompt.protectedContent).not.toEqual(
      original.prompt.pendingMessage.protectedContent,
    );
    expect(JSON.stringify(retained)).not.toContain("private");
    expect((await subject.openPrompt(stored(retained.prompt))).input).toEqual(
      nativeInput,
    );
    await expect(
      subject.openNativeInput({
        promptId: retained.prompt.id,
        payload: retained.prompt.pendingMessage.protectedContent.envelope,
      }),
    ).rejects.toThrow();
    await expect(
      subject.retainGuiPrompt({
        pendingMessage: {
          ...original.prompt.pendingMessage,
          classification: {
            ...original.prompt.pendingMessage.classification,
            mode: "plan",
          },
        },
        attachments: [],
        input: nativeInput,
      }),
    ).rejects.toThrow();
    await expect(
      subject.retainGuiPrompt({
        pendingMessage: original.prompt.pendingMessage,
        attachments: [],
        input: nativeInput,
        clientUserMessageId: "another-message",
      }),
    ).rejects.toThrow();
  });
  it("does not duplicate embedded attachments, but rebuilds edited text and removed selections", async () => {
    const original = await codec().preparePrompt({
      id,
      request: request([
        { type: "text", text: "user text" },
        { type: "image", url: "data:image/png;base64,cGljdHVyZQ==" },
      ]),
    });
    const projection = vi.fn(async () => [
      { type: "text" as const, text: "current attachment projection" },
    ]);
    const subject = createManagedQueueInputCodec({
      encryption: encryption(),
      chatId: "chat",
      attachmentStore,
      defaults: () => ({
        mode: "default",
        modelId: "model",
        reasoningEffort: "high",
      }),
      openAttachments: projection,
    });
    const exact = [
      {
        type: "text" as const,
        text: "user text with embedded attachment metadata",
      },
      { type: "image" as const, url: "data:image/png;base64,cGljdHVyZQ==" },
    ];
    const retained = await subject.retainGuiPrompt({
      pendingMessage: original.prompt.pendingMessage,
      attachments: original.attachments,
      input: exact,
    });
    const queued = {
      ...stored(retained.prompt),
      attachments: original.attachments,
    };
    expect((await subject.openPrompt(queued)).input).toEqual(exact);
    expect(projection).not.toHaveBeenCalled();
    const editedContent = await encryptQueuedPromptProtectedContent({
      ownerId: "owner",
      promptId: retained.prompt.id,
      componentKey: key,
      keyRevision: 3,
      content: {
        version: 1,
        classification: queued.classification,
        text: "edited user text",
      },
    });
    expect(
      (await subject.openPrompt({ ...queued, protectedContent: editedContent }))
        .input,
    ).toEqual([
      { type: "text", text: "edited user text", text_elements: [] },
      { type: "text", text: "current attachment projection" },
    ]);
    expect(projection).toHaveBeenCalledTimes(1);
    const classification = { ...queued.classification, attachmentIds: [] };
    const removedContent = await encryptQueuedPromptProtectedContent({
      ownerId: "owner",
      promptId: retained.prompt.id,
      componentKey: key,
      keyRevision: 3,
      content: { version: 1, classification, text: "user text" },
    });
    expect(
      (
        await subject.openPrompt({
          ...queued,
          classification,
          attachments: [],
          protectedContent: removedContent,
        })
      ).input,
    ).toEqual([{ type: "text", text: "user text", text_elements: [] }]);
    expect(projection).toHaveBeenCalledTimes(1);
  });
});
describe("direct terminal no-input retention", () => {
  it("keeps slash-looking turn input literal with stable operation/message identities", async () => {
    const subject = codec();
    const operation = {
      operationId: "terminal-operation",
      origin: "terminal" as const,
      identity,
      connectionId: "view",
      kind: "start" as const,
      method: "turn/start",
      frame: {
        params: {
          threadId: identity.threadId,
          clientUserMessageId: "terminal-original-message",
          input: [{ type: "text", text: "/goal this is literal native input" }],
        },
      },
    };
    const first = await subject.retainTerminalPrompt(operation);
    const second = await subject.retainTerminalPrompt(operation);
    expect(first.retainedPrompt.id).toBe(second.retainedPrompt.id);
    expect(first.retainedPrompt.pendingMessage.id).toBe(
      second.retainedPrompt.pendingMessage.id,
    );
    expect(first.retainedPrompt).toMatchObject({
      nativeClientUserMessageId: "terminal-original-message",
      nativeAction: "literal",
      executionMethod: "turn/start",
    });
    const normalized = await subject.normalizePrompt(first.retainedPrompt);
    expect(normalized.executionMethod).toBe("turn/start");
    expect(
      (
        await subject.openPrompt({
          ...stored(normalized),
          attachments: first.attachments,
        })
      ).input,
    ).toEqual(operation.frame.params.input);
    expect(
      (
        await subject.retainTerminalPrompt({
          ...operation,
          operationId: "different-operation",
        })
      ).retainedPrompt.id,
    ).not.toBe(first.retainedPrompt.id);
    await expect(
      subject.retainTerminalPrompt({
        ...operation,
        identity: { ...identity, chatId: "other-chat" },
      }),
    ).rejects.toThrow("another source");
    await expect(
      subject.retainTerminalPrompt({
        ...operation,
        queueClaim: { id: "existing-claim", promptRevision: 1 },
      }),
    ).rejects.toThrow("direct native");
  });
});
