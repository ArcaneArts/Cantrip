import { expect, it } from "vitest";
import { WorkerInferenceAdmission } from "../src/inference-admission.js";

it("shares capacity across endpoint runtimes while keeping instances and authoritative limits independent", async () => {
  const errors: unknown[] = [];
  const admission = new WorkerInferenceAdmission(
    {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      workerGeneration: "generation",
    },
    (error) => errors.push(error),
  );
  try {
    admission.configure({
      providerId: "ollama-mac",
      maxConcurrentInference: 1,
      inferenceConfigRevision: 4,
    });
    admission.configure({
      providerId: "ollama-lan",
      maxConcurrentInference: 2,
      inferenceConfigRevision: 2,
    });
    const original = admission.createRuntime();
    const replacement = admission.createRuntime();
    const first = original.request({
      operationId: "first",
      lifetime: original.createOperationLifetime("first"),
      providerId: "ollama-mac",
      purpose: "turn",
      projectId: "one",
    });
    const firstLease = await first.ready;
    firstLease.start();
    const waiting = replacement.request({
      operationId: "replacement",
      lifetime: replacement.createOperationLifetime("replacement"),
      providerId: "ollama-mac",
      purpose: "helper",
      projectId: "two",
    });
    const independent = replacement.request({
      operationId: "lan",
      lifetime: replacement.createOperationLifetime("lan"),
      providerId: "ollama-lan",
      purpose: "turn",
      projectId: "two",
    });
    const independentLease = await independent.ready;
    independentLease.start();
    expect(waiting.status().state).toBe("waiting");
    expect(admission.snapshot().pools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "ollama-mac",
          activeCount: 1,
          queuedCount: 1,
          maxConcurrentInference: 1,
        }),
        expect.objectContaining({
          providerId: "ollama-lan",
          activeCount: 1,
          queuedCount: 0,
          maxConcurrentInference: 2,
        }),
      ]),
    );
    // Key/URL runtime replacement and a legacy command cannot create more slots.
    expect(admission.configure({ providerId: "ollama-mac" })).toBe(true);
    expect(
      admission.configure({
        providerId: "ollama-mac",
        maxConcurrentInference: 8,
        inferenceConfigRevision: 3,
      }),
    ).toBe(false);
    first.cancel();
    expect(firstLease.signal.aborted).toBe(true);
    expect(first.status().state).toBe("cancelling");
    expect(waiting.status().state).toBe("waiting");
    firstLease.settle("interrupted");
    const nextLease = await waiting.ready;
    nextLease.start();
    const third = original.request({
      operationId: "third",
      lifetime: original.createOperationLifetime("third"),
      providerId: "ollama-mac",
    });
    expect(third.status().state).toBe("waiting");
    expect(
      admission.configure({
        providerId: "ollama-mac",
        maxConcurrentInference: 2,
        inferenceConfigRevision: 5,
      }),
    ).toBe(true);
    const thirdLease = await third.ready;
    thirdLease.start();
    expect(
      admission.configure({
        providerId: "ollama-mac",
        maxConcurrentInference: 1,
        inferenceConfigRevision: 6,
      }),
    ).toBe(true);
    const fourth = replacement.request({
      operationId: "fourth",
      lifetime: replacement.createOperationLifetime("fourth"),
      providerId: "ollama-mac",
    });
    nextLease.settle("completed");
    expect(fourth.status().state).toBe("waiting");
    thirdLease.settle("completed");
    const finalLease = await fourth.ready;
    finalLease.start();
    finalLease.settle("completed");
    independentLease.settle("completed");
    expect(
      admission
        .snapshot()
        .pools.every(
          (pool) => pool.activeCount === 0 && pool.queuedCount === 0,
        ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await admission.close();
  }
});
