import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkerInferenceJournal } from "../src/inference-journal.js";
import { LocalNativeInferenceOwnership } from "../src/native-inference-ownership.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY?.trim();

describe.skipIf(!binary)("actual native Task journal identity", () => {
  it.each([undefined, 0, 2])(
    "preserves queue epoch %s without changing the canonical receipt",
    async (queueOrderEpoch) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-task-journal-epoch-"),
      );
      const scope = {
        serverId: randomUUID(),
        ownerId: randomUUID(),
        workerId: randomUUID(),
        workerGeneration: randomUUID(),
      };
      const errors: unknown[] = [];
      const owner = new LocalNativeInferenceOwnership(
        binary!,
        directory,
        scope,
        (error) => errors.push(error),
      );
      const journal = new WorkerInferenceJournal(
        scope.workerGeneration,
        (command) => owner.journal(command),
      );
      const runtimeGeneration = randomUUID();
      try {
        await owner.prepare(runtimeGeneration);
        const operationId = randomUUID();
        const taskInput = {
          operationId,
          ...(queueOrderEpoch === undefined ? {} : { queueOrderEpoch }),
          chatId: randomUUID(),
          clientMessageId: randomUUID(),
          workerId: scope.workerId,
          worktreeId: randomUUID(),
          executionLaneId: randomUUID(),
          executionLaneActivatedAt: "2026-11-06T00:00:00.000Z",
          providerId: "fixture-provider",
          modelRouteId: randomUUID(),
          providerAccountId: null,
          dispatch: {
            cycleId: randomUUID(),
            operationId,
            leaseOwner: randomUUID(),
            fencingToken: 1,
          },
        };
        const key = journal.key(runtimeGeneration, operationId);
        const record = await journal.enqueue(key, {
          operationId,
          runtimeGeneration,
          providerId: taskInput.providerId,
          recoveryKey: taskInput.clientMessageId,
          recovery: {
            messageId: taskInput.clientMessageId,
            taskInput,
          },
          chatId: taskInput.chatId,
          projectId: randomUUID(),
        });
        expect(record.identity.recovery?.taskInput).toEqual(taskInput);
        await journal.grant(key);
        await journal.release(key, "never-started");
        expect(
          (await journal.snapshot()).find((item) => item.key === key)?.identity
            .recovery?.taskInput,
        ).toEqual(taskInput);
        expect(errors).toEqual([]);
      } finally {
        await owner.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
