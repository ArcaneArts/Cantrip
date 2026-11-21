import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeCommandSettlement } from "@cantrip/protocol";
import { NativeDeferredSettlementDelivery } from "../src/native-deferred-settlement-delivery.js";
import { protectNativeCommandContent } from "../src/native-command-content.js";

type Input = Omit<NativeCommandSettlement, "workerId">;
const roots: string[] = [];
const pumps: NativeDeferredSettlementDelivery[] = [];
const owner = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
};
afterEach(async () => {
  await Promise.all(pumps.splice(0).map((p) => p.stop()));
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "native-deferred-settlement-"),
  );
  roots.push(directory);
  const encrypted = await protectNativeCommandContent({
    service: owner,
    context: { chatId: "chat", operationId: "op", direction: "result" },
    content: {
      privateInput: "never plaintext",
      error: {
        code: -32001,
        data: { reason: "pendingSettings", inputConsumed: false },
      },
    },
  });
  const input: Input = {
    operationId: "op",
    operationGeneration: "generation",
    status: "rejected",
    rejectionCode: "native-settings-pending",
    resultDigest: encrypted.digest,
    protectedResult: encrypted.envelope,
    executionComplete: true,
    executionStatus: "idle",
    deferred: {
      reason: "pendingSettings",
      inputConsumed: false,
      threadId: "thread",
      runtimeGeneration: "runtime",
    },
  };
  return { directory, input };
}
function result(input: Input) {
  return {
    receipt: {
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      activationGeneration: "activation",
      chatId: "chat",
      startsExecution: true,
      executionLaneId: "lane",
      status: "rejected" as const,
      method: "turn/start",
      payloadDigest: "a".repeat(64),
      rejectionCode: "native-settings-pending",
      threadId: "thread",
      createdAt: "now",
      updatedAt: "now",
      resumeQueue: true,
    },
  };
}
function pump(
  directory: string,
  settle = vi.fn(async (input: Input, _signal?: AbortSignal) => result(input)),
  service = owner,
  published = vi.fn(async (_result: ReturnType<typeof result>) => {}),
) {
  const instance = new NativeDeferredSettlementDelivery({
    directory,
    workerId: "worker",
    service,
    client: { settle },
    onPublished: published,
    onError: vi.fn(),
    retryDelayMs: 20,
  });
  pumps.push(instance);
  return { instance, settle, published };
}
async function files(directory: string) {
  const names = await readdir(directory, { recursive: true });
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
}

describe("durable deferred native settlement", () => {
  it("recovers a failed first write after restart without replaying native input", async () => {
    const { directory, input } = await fixture();
    const first = pump(
      directory,
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(first.instance.settle(input)).rejects.toThrow("offline");
    await first.instance.stop();
    const retained = await files(directory);
    expect(retained).toHaveLength(1);
    expect(await readFile(retained[0]!, "utf8")).not.toContain(
      "never plaintext",
    );
    const replacement = pump(directory);
    replacement.instance.wake();
    await expect.poll(() => replacement.published.mock.calls.length).toBe(1);
    expect(replacement.settle.mock.calls[0]![0]).toEqual({
      ...input,
      workerId: "worker",
    });
    await expect
      .poll(
        async () =>
          (await files(directory)).filter((p) => p.endsWith(".pending.json"))
            .length,
      )
      .toBe(0);
  });

  it("retries the exact encrypted body after a committed acknowledgment is lost", async () => {
    const { directory, input } = await fixture();
    const bodies: string[] = [];
    const send = vi.fn(async (body: Input) => {
      bodies.push(JSON.stringify(body));
      if (bodies.length === 1) throw new Error("lost ack");
      return result(body);
    });
    const p = pump(directory, send);
    await expect(p.instance.settle(input)).rejects.toThrow("lost ack");
    await expect.poll(() => p.published.mock.calls.length).toBe(1);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies).toHaveLength(2);
  });

  it("rejects conflicting captures both pending and acknowledged", async () => {
    const { directory, input } = await fixture();
    let offline = true;
    const p = pump(
      directory,
      vi.fn(async (body) => {
        if (offline) throw new Error("offline");
        return result(body);
      }),
    );
    await expect(p.instance.settle(input)).rejects.toThrow("offline");
    const conflicting = { ...input, resultDigest: "b".repeat(64) };
    await expect(p.instance.settle(conflicting)).rejects.toThrow(
      "different content",
    );
    offline = false;
    await p.instance.settle(input);
    const count = p.settle.mock.calls.length;
    await expect(p.instance.settle(conflicting)).rejects.toThrow(
      "different content",
    );
    await p.instance.settle(input);
    expect(p.settle).toHaveBeenCalledTimes(count);
  });

  it("does not publish or discard an old owner's response after identity changes", async () => {
    const { directory, input } = await fixture();
    let ownerId = "owner";
    let finish!: (value: ReturnType<typeof result>) => void;
    const p = pump(
      directory,
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      { ...owner, ownerId: () => ownerId },
    );
    const settling = p.instance.settle(input);
    await expect.poll(() => p.settle.mock.calls.length).toBe(1);
    ownerId = "other";
    finish(result(input));
    await expect(settling).rejects.toThrow("ownership changed");
    expect(p.published).not.toHaveBeenCalled();
    await p.instance.stop();
    const replacement = pump(directory, undefined, {
      ...owner,
      ownerId: () => ownerId,
    });
    replacement.instance.wake();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(replacement.settle).not.toHaveBeenCalled();
    expect(
      (await files(directory)).filter((p) => p.endsWith(".pending.json")),
    ).toHaveLength(1);
  });

  it("keeps the durable record until publication succeeds and rejects uncorrelated ACKs", async () => {
    const { directory, input } = await fixture();
    let fail = true;
    const published = vi.fn(async () => {
      expect(
        (await files(directory)).some((p) => p.endsWith(".pending.json")),
      ).toBe(true);
      if (fail) throw new Error("publication unavailable");
    });
    const p = pump(directory, undefined, owner, published);
    await expect(p.instance.settle(input)).rejects.toThrow(
      "publication unavailable",
    );
    expect(
      (await files(directory)).some((p) => p.endsWith(".pending.json")),
    ).toBe(true);
    fail = false;
    await p.instance.settle(input);
    expect(
      (await files(directory)).some((p) => p.endsWith(".pending.json")),
    ).toBe(false);
    const other = await fixture();
    const bad = pump(
      other.directory,
      vi.fn(async (body) => ({
        receipt: { ...result(body).receipt, operationGeneration: "wrong" },
      })),
    );
    await expect(bad.instance.settle(other.input)).rejects.toThrow(
      "identity mismatch",
    );
    expect(bad.published).not.toHaveBeenCalled();
  });

  it("stop aborts an unresponsive client and retains the record for another pump", async () => {
    const { directory, input } = await fixture();
    const p = pump(
      directory,
      vi.fn(() => new Promise(() => {})),
    );
    const settling = p.instance.settle(input);
    const rejection = expect(settling).rejects.toThrow("interrupted");
    await expect.poll(() => p.settle.mock.calls.length).toBe(1);
    await p.instance.stop();
    await rejection;
    expect(
      (await files(directory)).some((p) => p.endsWith(".pending.json")),
    ).toBe(true);
  });
});
