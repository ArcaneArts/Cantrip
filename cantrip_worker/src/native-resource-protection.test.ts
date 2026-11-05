import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wrapComponentKeyForWorker } from "@cantrip/crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeResourceProtection } from "./native-resource-protection.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "native-resource-owner";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-11-05T00:00:00.000Z";
const componentKey = new Uint8Array(32).fill(37);
const binding = {
  threadId: "original-thread",
  turnId: "original-turn",
  checkpointId: "confirmed-capture",
};
const secret = "RESOURCE_STATE_SECRET_NOT_FOR_METADATA";
const state = {
  codeMode: { stored: secret },
  terminals: [{ id: 1099, remaining: secret }],
};
const directories: string[] = [];

async function open(directory?: string, workerId = "resource-worker") {
  const dataDirectory =
    directory ??
    (await mkdtemp(path.join(tmpdir(), "cantrip-native-resource-protection-")));
  if (!directory) directories.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    workerId,
    serverUrl: "https://cantrip.test",
  });
  return { dataDirectory, workerId, service };
}

async function authorize(
  input: Awaited<ReturnType<typeof open>>,
  key?: Uint8Array,
) {
  const registration = input.service.registration();
  const wrapped = key
    ? await wrapComponentKeyForWorker({
        ownerId,
        workerId: input.workerId,
        component: "chat-content",
        componentKey: key,
        keyRevision: 1,
        workerPublicKey: registration.publicKey,
      })
    : undefined;
  await input.service.acceptBootstrap({
    serverId,
    ownerId,
    principal: {
      id: registration.principalId,
      ownerId,
      kind: "worker",
      workerId: input.workerId,
      label: "Native resource test",
      publicKey: registration.publicKey,
      state: "approved",
      revision: 2,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    grants: wrapped
      ? [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            ownerId,
            principalId: registration.principalId,
            component: "chat-content",
            keyRevision: 1,
            wrappedKey: wrapped,
            state: "active",
            revision: 1,
            revokedAt: null,
            revokedReason: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ]
      : [],
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("native resource protection", () => {
  it("round trips private JSON without writing another key file or plaintext metadata", async () => {
    const worker = await open();
    await authorize(worker, componentKey);
    const protection = createNativeResourceProtection(worker.service);
    const opaque = await protection.seal(binding, state);
    expect(JSON.stringify(opaque)).not.toContain(secret);
    expect(await protection.open(binding, opaque)).toEqual(state);
    expect(await readdir(worker.dataDirectory)).toEqual([
      "worker-encryption-key.json",
    ]);
  });

  it.each(["threadId", "turnId", "checkpointId"] as const)(
    "authenticates the exact %s",
    async (field) => {
      const worker = await open();
      await authorize(worker, componentKey);
      const protection = createNativeResourceProtection(worker.service);
      const opaque = await protection.seal(binding, state);
      await expect(
        protection.open({ ...binding, [field]: "foreign-identity" }, opaque),
      ).rejects.toThrow("authenticated");
    },
  );

  it("needs an actual fresh component grant after reopening the existing worker identity", async () => {
    const worker = await open();
    await authorize(worker, componentKey);
    const opaque = await createNativeResourceProtection(worker.service).seal(
      binding,
      state,
    );
    const fresh = await open(worker.dataDirectory);
    expect(fresh.service.registration()).toEqual(worker.service.registration());
    await authorize(fresh);
    const protection = createNativeResourceProtection(fresh.service);
    await expect(protection.open(binding, opaque)).rejects.toThrow(
      "active chat-content encryption grant",
    );
    await authorize(fresh, componentKey);
    expect(await protection.open(binding, opaque)).toEqual(state);
  });

  it("cannot move a checkpoint to another worker principal with the same component key", async () => {
    const worker = await open();
    await authorize(worker, componentKey);
    const opaque = await createNativeResourceProtection(worker.service).seal(
      binding,
      state,
    );
    const other = await open(undefined, "other-worker");
    await authorize(other, componentKey);
    await expect(
      createNativeResourceProtection(other.service).open(binding, opaque),
    ).rejects.toThrow("authenticated");
  });

  it("performs encryption with the actual retained grant when a refresh fails", async () => {
    const worker = await open();
    await authorize(worker, componentKey);
    await expect(
      worker.service.refresh({
        credential: "fixture-only",
        fetch: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("refresh worker encryption grants");
    const protection = createNativeResourceProtection(worker.service);
    const opaque = await protection.seal(binding, state);
    expect(await protection.open(binding, opaque)).toEqual(state);
  });

  it("rejects unsupported protection data without echoing private state", async () => {
    const worker = await open();
    await authorize(worker, componentKey);
    const protection = createNativeResourceProtection(worker.service);
    await expect(
      protection.open(binding, { formatVersion: 99, secret }),
    ).rejects.toThrow("invalid or unsupported");
  });
});
