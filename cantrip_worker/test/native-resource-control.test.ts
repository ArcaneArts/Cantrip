import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { CodexAppServer } from "../src/codex/app-server.js";
import { handleNativeResourceProtection } from "../src/codex/native-resource-control.js";
import { resourceProtectionFixture } from "./native-resource-protection-fixture.js";

const directories: string[] = [];
const binding = {
  threadId: "original-thread",
  turnId: "original-turn",
  checkpointId: "confirmed-capture",
};
const request = {
  ...binding,
  requestId: randomUUID(),
  runnerGeneration: "fresh-runner",
  seal: true,
  value: { private: "RESOURCE_PRIVATE_VALUE" },
};
const owner = {
  transport: "current-transport",
  runner: request.runnerGeneration,
};

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-resource-control-"),
  );
  directories.push(directory);
  return resourceProtectionFixture(directory);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native private resource control", () => {
  it("uses actual grants and returns protected data only to the exact request", async () => {
    const { protection } = await fixture();
    const resolve = vi.fn(async (_params: unknown) => ({}));
    await handleNativeResourceProtection(request, {
      owner: () => owner,
      protection,
      resolve,
    });
    const result = resolve.mock.calls[0]![0] as typeof request;
    expect(result).toMatchObject({
      ...binding,
      requestId: request.requestId,
      runnerGeneration: owner.runner,
    });
    expect(JSON.stringify(result)).not.toContain("RESOURCE_PRIVATE_VALUE");
    expect(await protection.open(binding, result.value)).toEqual(request.value);
  });

  it("explicitly denies when the actual component grant is absent", async () => {
    const encryption = await fixture();
    await encryption.authorize(false);
    const resolve = vi.fn(async (_params: unknown) => ({}));
    await handleNativeResourceProtection(request, {
      owner: () => owner,
      protection: encryption.protection,
      resolve,
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ value: null }),
    );
  });

  it("rejects foreign generations before exposing private state to the protector", async () => {
    const encryption = await fixture();
    const seal = vi.spyOn(encryption.protection, "seal");
    const resolve = vi.fn(async () => ({}));
    await handleNativeResourceProtection(
      { ...request, runnerGeneration: "stale" },
      { owner: () => owner, protection: encryption.protection, resolve },
    );
    expect(seal).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not send an old result after the transport changes during real encryption", async () => {
    const encryption = await fixture();
    let current = owner;
    const seal = encryption.protection.seal.bind(encryption.protection);
    encryption.protection.seal = async (...args) => {
      const value = await seal(...args);
      current = { ...owner, transport: "replacement-transport" };
      return value;
    };
    const resolve = vi.fn(async () => ({}));
    await handleNativeResourceProtection(request, {
      owner: () => current,
      protection: encryption.protection,
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not protect a foreign thread using another thread's runner", async () => {
    const encryption = await fixture();
    const owners = new Map([[binding.threadId, owner]]);
    const seal = vi.spyOn(encryption.protection, "seal");
    const resolve = vi.fn(async () => ({}));
    await handleNativeResourceProtection(
      { ...request, threadId: "foreign-thread" },
      {
        owner: ({ threadId }) => owners.get(threadId) ?? null,
        protection: encryption.protection,
        resolve,
      },
    );
    expect(seal).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not return data after the same thread acquires a replacement runner", async () => {
    const encryption = await fixture();
    const owners = new Map([[binding.threadId, owner]]);
    const seal = encryption.protection.seal.bind(encryption.protection);
    encryption.protection.seal = async (...args) => {
      const value = await seal(...args);
      owners.set(binding.threadId, { ...owner, runner: "replacement-runner" });
      return value;
    };
    const resolve = vi.fn(async () => ({}));
    await handleNativeResourceProtection(request, {
      owner: ({ threadId }) => owners.get(threadId) ?? null,
      protection: encryption.protection,
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("intercepts resource notifications before App Server diagnostics and observers", async () => {
    const runtime = new CodexAppServer(
      "/unused/codex",
      "/unused/data",
      "/unused/home",
      unprobedCodexRuntimeReport,
    );
    const native = runtime as unknown as {
      handleMessage(data: Buffer): void;
      recordDiagnostic(...args: unknown[]): string;
    };
    const diagnostics = vi.spyOn(native, "recordDiagnostic");
    native.handleMessage(
      Buffer.from(
        JSON.stringify({
          method: "thread/nativeResources/requested",
          params: request,
        }),
      ),
    );
    await Promise.resolve();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(runtime.diagnostics()).toEqual([]);
  });
});
