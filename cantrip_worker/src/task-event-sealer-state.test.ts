import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptedTaskEventSealer } from "./task-operation.js";
import { taskEventSealerStateSchema } from "./task-event-sealer-state.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

function service() {
  const key = randomBytes(32);
  return {
    ownerId: () => "owner",
    componentKey: (role: string) => {
      expect(role).toBe("task-content");
      return { key: new Uint8Array(key), keyRevision: 1 };
    },
  } as unknown as WorkerEncryptionService;
}
const message = {
  id: "native-item",
  text: "Task progress",
  phase: "commentary" as const,
  correlation: {
    sourceMethod: "item/completed",
    diagnosticId: null,
    threadId: "thread",
    turnId: "turn",
    itemId: "native-item",
  },
};

describe("Task event continuation", () => {
  it("preserves published message identities in a new sealer after serialization", async () => {
    const first = new EncryptedTaskEventSealer(service(), "default");
    const published = await first.message(message);
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    const restored = new EncryptedTaskEventSealer(service(), "default", saved);
    const continued = await restored.message({
      ...message,
      text: "Task progress updated",
    });
    expect(continued.message.id).toBe(published.message.id);
    expect(continued.message.idempotencyKey).toBe(
      published.message.idempotencyKey,
    );
    const another = await restored.message({
      ...message,
      id: "another-native-item",
    });
    expect(another.message.id).not.toBe(published.message.id);
    expect(first.snapshot()).toEqual(saved);
  });

  it("reuses the exact published final ciphertext without serializing key material", async () => {
    const first = new EncryptedTaskEventSealer(service(), "default");
    const completed = await first.message({
      ...message,
      phase: "final_answer",
    });
    const saved = JSON.parse(JSON.stringify(first.snapshot()));
    expect(Object.keys(saved).sort()).toEqual([
      "completedRootMessage",
      "ids",
      "mode",
      "version",
    ]);
    const restored = new EncryptedTaskEventSealer(
      {
        componentKey: () => {
          throw new Error("No old execution grant");
        },
      } as unknown as WorkerEncryptionService,
      "default",
      saved,
    );
    const result = {
      threadId: "thread",
      turnId: "turn",
      text: message.text,
      status: "completed" as const,
    };
    expect(restored.finalMessageForResult(result)).toEqual(completed.message);
    expect(
      restored.finalMessageForResult({ ...result, turnId: "another-turn" }),
    ).toBeNull();
    expect(
      restored.finalMessageForResult({ ...result, text: "another answer" }),
    ).toBeNull();
  });

  it("rejects a changed mode, duplicate identity and detached completion", async () => {
    const first = new EncryptedTaskEventSealer(service(), "default");
    await first.message({ ...message, phase: "final_answer" });
    const saved = first.snapshot();
    expect(
      () => new EncryptedTaskEventSealer(service(), "goal", saved),
    ).toThrow("another execution mode");
    expect(
      taskEventSealerStateSchema.safeParse({
        ...saved,
        ids: [...saved.ids, saved.ids[0]],
      }).success,
    ).toBe(false);
    expect(
      taskEventSealerStateSchema.safeParse({ ...saved, ids: [] }).success,
    ).toBe(false);
    expect(
      taskEventSealerStateSchema.safeParse({
        ...saved,
        credential: "not continuation data",
      }).success,
    ).toBe(false);
  });
});
