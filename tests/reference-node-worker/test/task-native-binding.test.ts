import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { taskInferenceInputReceiptSchema } from "@cantrip/protocol";
import { WorkerInferenceAdmission } from "../src/inference-admission.js";
import { NativeCommandClient } from "../src/native-command-client.js";

const receipt = taskInferenceInputReceiptSchema.parse({
  operationId: randomUUID(),
  chatId: "chat",
  clientMessageId: "message",
  workerId: "worker",
  worktreeId: "tree",
  executionLaneId: randomUUID(),
  executionLaneActivatedAt: new Date().toISOString(),
  providerId: "provider",
  modelRouteId: "route",
  providerAccountId: null,
  dispatch: {
    cycleId: randomUUID(),
    operationId: randomUUID(),
    leaseOwner: "server",
    fencingToken: 1,
  },
});
const execution = { threadId: "thread", turnId: "turn", scopeId: "scope" };

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const ack = deferred(),
    entered = deferred();
  const bind = vi.fn(async () => {
    entered.resolve();
    await ack.promise;
  });
  const admission = new WorkerInferenceAdmission(
    {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      workerGeneration: randomUUID(),
    },
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    bind,
  );
  admission.configure({ providerId: "provider", maxConcurrentInference: 1 });
  const runtime = admission.createRuntime();
  const ticket = runtime.request({
    operationId: receipt.operationId,
    lifetime: runtime.createOperationLifetime(receipt.operationId),
    providerId: "provider",
    chatId: receipt.chatId,
    recovery: { messageId: receipt.clientMessageId, taskInput: receipt },
  });
  return { admission, runtime, ticket, ack, entered, bind };
}

describe("Task native binding permission barrier", () => {
  it("waits for the exact server acknowledgement and binds once", async () => {
    const f = fixture();
    try {
      const lease = await f.ticket.ready;
      let allowed = false;
      const pending = lease.bindNative(execution).then(() => {
        allowed = true;
      });
      await f.entered.promise;
      expect(allowed).toBe(false);
      expect(f.bind.mock.calls[0]).toEqual([
        receipt,
        execution,
        f.runtime.generation,
        lease.signal,
      ]);
      f.ack.resolve();
      await pending;
      await lease.bindNative(execution);
      expect(f.bind).toHaveBeenCalledTimes(1);
      expect(allowed).toBe(true);
      lease.settle("completed");
    } finally {
      f.ack.resolve();
      await f.admission.close();
    }
  });
  it("propagates an actual server write failure without model permission", async () => {
    const f = fixture();
    try {
      const lease = await f.ticket.ready;
      const pending = lease.bindNative(execution);
      const rejected = expect(pending).rejects.toThrow("binding write failed");
      await f.entered.promise;
      f.ack.reject(new Error("binding write failed"));
      await rejected;
      lease.settle("failed");
    } finally {
      f.ack.resolve();
      await f.admission.close();
    }
  });
  it("rejects a late acknowledgement after cancellation", async () => {
    const f = fixture();
    try {
      const lease = await f.ticket.ready;
      const pending = lease.bindNative(execution);
      const rejected = expect(pending).rejects.toThrow("lost its owning grant");
      await f.entered.promise;
      f.ticket.cancel();
      f.ack.resolve();
      await rejected;
      expect(lease.signal.aborted).toBe(true);
    } finally {
      f.ack.resolve();
      await f.admission.close();
    }
  });
});

describe("Task native binding HTTP acknowledgement", () => {
  it("rejects another native tuple/runtime and requires the binding in a success response", async () => {
    const input = {
      serverId: "server",
      workerGeneration: randomUUID(),
      receipt,
      phase: "native" as const,
      nativeExecution: execution,
      nativeRuntimeGeneration: randomUUID(),
    };
    const response = {
      receipt,
      nativeExecution: execution,
      nativeRuntimeGeneration: input.nativeRuntimeGeneration,
    };
    const fetcher = vi.fn<typeof fetch>();
    const client = new NativeCommandClient({
      serverUrl: "https://fixture.example",
      workerId: "worker",
      token: () => "credential",
      fetch: fetcher,
    });
    for (const body of [
      { receipt },
      { ...response, nativeRuntimeGeneration: randomUUID() },
      ...["threadId", "turnId", "scopeId"].map((key) => ({
        ...response,
        nativeExecution: { ...execution, [key]: "different" },
      })),
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(body));
      await expect(client.dispatchTaskInput(input)).rejects.toThrow(
        "another execution",
      );
    }
    fetcher.mockResolvedValueOnce(Response.json(response));
    expect(await client.dispatchTaskInput(input)).toEqual(response);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))).toEqual({
      ...input,
      workerId: "worker",
    });
  });
});
