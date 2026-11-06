import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerInferenceJournal } from "../src/inference-journal.js";
import { LocalNativeInferenceOwnership } from "../src/native-inference-ownership.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)("actual native unused-grant requeue", () => {
  it("rearms only an unused grant of the same worker and clears its old no-start outcome", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-prestart-journal-"),
    );
    const scope = {
      serverId: randomUUID(),
      ownerId: randomUUID(),
      workerId: randomUUID(),
      workerGeneration: randomUUID(),
    };
    const errors: unknown[] = [];
    let owner = new LocalNativeInferenceOwnership(
      binary!,
      directory,
      scope,
      (error) => errors.push(error),
    );
    let journal = new WorkerInferenceJournal(
      scope.workerGeneration,
      (command) => owner.journal(command),
    );
    const runtimeGeneration = randomUUID();
    async function enqueue() {
      const operationId = randomUUID();
      const key = journal.key(runtimeGeneration, operationId);
      await journal.enqueue(key, {
        operationId,
        runtimeGeneration,
        providerId: "fixture",
        recoveryKey: null,
        recovery: null,
        chatId: null,
        projectId: null,
      });
      await journal.grant(key);
      return key;
    }
    try {
      await owner.prepare(runtimeGeneration);
      const key = await enqueue();
      await journal.release(key, "never-started");
      await expect(journal.grant(key)).rejects.toThrow();
      expect(await journal.requeue(key)).toMatchObject({
        state: "waiting",
        everGranted: true,
        outcome: null,
      });
      expect(await journal.grant(key)).toMatchObject({
        state: "granted",
        outcome: null,
      });
      await journal.release(key, "never-started");

      for (const outcome of [
        "completed",
        "failed",
        "interrupted",
        "runtime-exited",
        "cancelled",
      ] as const) {
        const terminal = await enqueue();
        await journal.release(terminal, outcome);
        await expect(journal.requeue(terminal)).rejects.toThrow();
      }
      const consumed = await enqueue();
      await journal.bindNative(consumed, {
        threadId: randomUUID(),
        turnId: randomUUID(),
        scopeId: randomUUID(),
      });
      await journal.release(consumed, "never-started");
      await expect(journal.requeue(consumed)).rejects.toThrow();

      const sealedId = randomUUID();
      const sealed = journal.key(runtimeGeneration, sealedId);
      await journal.sealUnstarted(sealed, {
        operationId: sealedId,
        runtimeGeneration,
        providerId: "fixture",
        recoveryKey: null,
        recovery: null,
        chatId: null,
        projectId: null,
      });
      await expect(journal.requeue(sealed)).rejects.toThrow();

      await owner.close();
      scope.workerGeneration = randomUUID();
      owner = new LocalNativeInferenceOwnership(
        binary!,
        directory,
        scope,
        (error) => errors.push(error),
      );
      journal = new WorkerInferenceJournal(scope.workerGeneration, (command) =>
        owner.journal(command),
      );
      await owner.prepare(randomUUID());
      expect(
        (await journal.snapshot()).find((record) => record.key === key),
      ).toMatchObject({
        state: "released",
        outcome: "never-started",
      });
      await expect(journal.requeue(key)).rejects.toThrow();
      expect(errors).toEqual([]);
    } finally {
      await owner.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
