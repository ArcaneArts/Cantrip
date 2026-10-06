import { randomUUID } from "node:crypto";
import {
  decryptPrivateDisplayLabel,
  encryptChatMessageProtectedContent,
  encryptTaskProtectedContent,
  randomBytes,
} from "@cantrip/crypto";
import {
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { taskProtectedClassificationSchema } from "@cantrip/protocol/tasks";
import { describe, expect, it, vi } from "vitest";
import { generatePrivateLabel } from "../src/automatic-labeling.js";
import { CodexAppServer } from "../src/codex/app-server.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

type LabelCommand = Extract<WorkerCommand, { type: "label.generate" }>;
const ownerId = "fixture-owner";

function encryptionFixture() {
  const key = randomBytes(32);
  const service = {
    ownerId: () => ownerId,
    status: () => ({}),
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
  return { key, service };
}

describe("private automatic labels", () => {
  it("opens only the first request, bounds its text, and returns a row-bound encrypted three-word title", async () => {
    const { key, service } = encryptionFixture();
    const chatId = randomUUID();
    const id = randomUUID();
    const classification = {
      role: "user" as const,
      mode: "default" as const,
      attachmentIds: [],
    };
    const protectedContent = await encryptChatMessageProtectedContent({
      ownerId,
      messageId: id,
      keyRevision: 1,
      componentKey: key,
      content: {
        version: 1,
        classification,
        content: [{ type: "text", text: "x".repeat(5_000) }],
      },
    });
    const input = {
      kind: "message" as const,
      message: {
        id,
        classification,
        protectedContent,
        reasoningEffort: null,
        idempotencyKey: id,
      },
    };
    const command = {
      type: "label.generate",
      labelKind: "chat",
      chatId,
      input,
    } as LabelCommand;
    const infer = vi
      .fn()
      .mockResolvedValue("Improve login form validation and styling");
    const result = await generatePrivateLabel(command, service, infer);
    expect(infer).toHaveBeenCalledTimes(1);
    expect(infer.mock.calls[0]?.[0]).toContain(
      "THREE WORDS IS THE ABSOLUTE MAXIMUM",
    );
    expect(JSON.parse(infer.mock.calls[0]?.[1]).initialRequest).toHaveLength(
      4_000,
    );
    expect(JSON.stringify(result)).not.toContain("Improve login form");
    expect(result.emptyInput).toBe(false);
    expect(
      await decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: chatId,
        keyRevision: 1,
        componentKey: key,
        opaque: result.titleProtection!,
      }),
    ).toBe("Improve login form");
    await expect(
      decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: randomUUID(),
        keyRevision: 1,
        componentKey: key,
        opaque: result.titleProtection!,
      }),
    ).rejects.toThrow();
    await expect(
      generatePrivateLabel(
        {
          ...command,
          input: {
            ...input,
            message: {
              ...input.message,
              classification: { ...classification, role: "assistant" },
            },
          },
        },
        service,
        infer,
      ),
    ).rejects.toThrow("user request");
    infer.mockResolvedValue("---");
    await expect(generatePrivateLabel(command, service, infer)).rejects.toThrow(
      "no usable title",
    );
  });

  async function taskInput(briefMarkdown: string) {
    const fixture = encryptionFixture();
    const chatId = randomUUID();
    const classification = taskProtectedClassificationSchema.parse({
      state: "draft",
      stableStateBeforeFailure: null,
      activeOperationKind: null,
      planAuthorship: "agent",
      planningRound: 0,
      hasPlan: false,
      hasQuestions: false,
      hasFinalPlan: false,
      hasGoalPrompt: false,
      lastError: null,
    });
    const protectedContent = await encryptTaskProtectedContent({
      ownerId,
      chatId,
      keyRevision: 1,
      componentKey: fixture.key,
      content: {
        version: 1,
        classification,
        briefMarkdown,
        planMarkdown: null,
        currentQuestions: [],
        currentAnswers: [],
        additionalDirection: "EXTRA_CONTEXT_NOT_FOR_LABELING",
        finalPlanMarkdown: null,
        goalPrompt: null,
        lastError: null,
      },
    });
    const command = {
      type: "label.generate",
      chatId,
      labelKind: "task",
      input: {
        kind: "task",
        task: { ...classification, chatId, protectedContent },
      },
    } as LabelCommand;
    return { ...fixture, chatId, command };
  }
  it("names tasks only from their brief and enforces six words", async () => {
    const f = await taskInput("Fix the profile page");
    const infer = vi
      .fn()
      .mockResolvedValue(
        "Fix profile page and improve its styling significantly",
      );
    const result = await generatePrivateLabel(f.command, f.service, infer);
    expect(JSON.parse(infer.mock.calls[0]?.[1])).toEqual({
      initialRequest: "Fix the profile page",
    });
    expect(infer.mock.calls[0]?.[0]).toContain(
      "SIX WORDS IS THE ABSOLUTE MAXIMUM",
    );
    expect(
      await decryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: f.chatId,
        keyRevision: 1,
        componentKey: f.key,
        opaque: result.titleProtection!,
      }),
    ).toBe("Fix profile page and improve its");
    await expect(
      generatePrivateLabel(
        { ...f.command, chatId: randomUUID() },
        f.service,
        infer,
      ),
    ).rejects.toThrow("another Task");
  });
  it("does not boot inference for an empty task brief", async () => {
    const f = await taskInput("  ");
    const infer = vi.fn();
    expect(await generatePrivateLabel(f.command, f.service, infer)).toEqual({
      titleProtection: null,
      emptyInput: true,
    });
    expect(infer).not.toHaveBeenCalled();
  });
});

describe("lightweight native request privacy", () => {
  it.each([false, true])(
    "redacts both normal and late labeling responses (late=%s)",
    async (late) => {
      vi.useFakeTimers();
      try {
        const runtime = new CodexAppServer(
          "/unused/codex",
          "/unused/data",
          "/unused/home",
          unprobedCodexRuntimeReport,
        );
        const native = runtime as unknown as {
          request(
            method: string,
            params: unknown,
            timeout: number,
          ): Promise<unknown>;
          send(message: { id: number }): void;
          handleMessage(data: Buffer): void;
        };
        let id = 0;
        native.send = (message) => {
          id = message.id;
        };
        const result = native.request(
          "cantrip/inference",
          { input: "private prompt" },
          5,
        );
        const observed = result.catch(() => null);
        if (late) await vi.advanceTimersByTimeAsync(6);
        native.handleMessage(
          Buffer.from(
            JSON.stringify({ id, result: { text: "Secret generated title" } }),
          ),
        );
        if (!late)
          expect(await observed).toEqual({ text: "Secret generated title" });
        else expect(await observed).toBeNull();
        expect(JSON.stringify(runtime.diagnostics())).not.toMatch(
          /Secret generated title|private prompt/,
        );
        expect(JSON.stringify(runtime.diagnostics())).toContain(
          "privateInference",
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
