import { randomUUID } from "node:crypto";
import { taskInferenceInputReceiptSchema } from "@cantrip/protocol";
import { taskOperationRelayRequestSchema } from "@cantrip/protocol/tasks";
import { wrapComponentKeyForWorker } from "@cantrip/crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerEncryptionService } from "./worker-encryption.js";
import { captureWorkerTurn } from "./codex/worker-turn-continuation.js";
import { workerTurnState } from "./codex/worker-turn-continuation.test-fixture.js";
import { createNativeResourceProtection } from "./native-resource-protection.js";
import {
  NativeSuspensionStore,
  type NativeSuspensionSource,
} from "./native-suspension-store.js";

const scope = {
  serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerId: "owner",
  workerId: "worker",
};
const source: NativeSuspensionSource = {
  chatId: "chat",
  threadId: "thread",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
const suspension = {
  threadId: "thread",
  turnId: "original-turn",
  checkpointId: "checkpoint",
  revision: 1,
};
const key = new Uint8Array(32).fill(37);
const timestamp = "2026-11-05T12:00:00.000Z";
const dirs: string[] = [];
async function worker(
  directory?: string,
  grant = true,
  component: "chat-content" | "task-content" = "chat-content",
) {
  const dataDirectory =
    directory ??
    (await mkdtemp(path.join(tmpdir(), "cantrip-suspension-registry-")));
  if (!directory) dirs.push(dataDirectory);
  const service = await WorkerEncryptionService.open({
    dataDirectory,
    workerId: scope.workerId,
    serverUrl: "https://cantrip.test",
  });
  const registration = service.registration();
  const wrapped = await wrapComponentKeyForWorker({
    ownerId: scope.ownerId,
    workerId: scope.workerId,
    component,
    componentKey: key,
    keyRevision: 1,
    workerPublicKey: registration.publicKey,
  });
  await service.acceptBootstrap({
    serverId: scope.serverId,
    ownerId: scope.ownerId,
    principal: {
      id: registration.principalId,
      ownerId: scope.ownerId,
      kind: "worker",
      workerId: scope.workerId,
      label: "Registry test",
      publicKey: registration.publicKey,
      state: "approved",
      revision: 2,
      approvedAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    grants: grant
      ? [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            ownerId: scope.ownerId,
            principalId: registration.principalId,
            component,
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
  const store = new NativeSuspensionStore(dataDirectory, () => scope, service);
  return { store, service, dataDirectory };
}
const input = {
  source,
  home: "/private/original-native-home",
  suspension,
  runtimeVersion: "0.166.0",
  runtimeFingerprint: null,
};
async function file(directory: string, id: string) {
  const name = (await readdir(directory, { recursive: true })).find((name) =>
    name.endsWith(`${id}.json`),
  );
  expect(name).toBeDefined();
  return path.join(directory, name!);
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("native suspension source registry with actual worker encryption", () => {
  it("persists the original Task round and event identities with only a Task grant", async () => {
    const w = await worker(undefined, true, "task-content");
    const fixtures = JSON.parse(
      await readFile(
        new URL(
          "../../scripts/server-rust/worker-command-alternatives.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      cases: Array<{
        input: {
          command: { resultMode?: { kind: string; operation?: unknown } };
        };
      }>;
    };
    const original = taskOperationRelayRequestSchema.parse(
      fixtures.cases.find(
        (item) => item.input.command.resultMode?.kind === "task-encrypted",
      )!.input.command.resultMode!.operation,
    );
    const request = {
      ...original,
      chatId: source.chatId,
      operationId: randomUUID(),
    };
    const receipt = taskInferenceInputReceiptSchema.parse({
      operationId: randomUUID(),
      chatId: source.chatId,
      clientMessageId: request.userMessage.id,
      workerId: scope.workerId,
      worktreeId: source.placementId,
      executionLaneId: randomUUID(),
      executionLaneActivatedAt: timestamp,
      providerId: "provider",
      modelRouteId: source.modelRouteId,
      providerAccountId: source.providerAccountId,
      dispatch: {
        operationId: request.operationId,
        cycleId: randomUUID(),
        leaseOwner: "original-owner",
        fencingToken: 1,
      },
    });
    const taskSource = { ...source, taskInput: receipt };
    const continuation = captureWorkerTurn(
      workerTurnState(),
      suspension.turnId,
    );
    const taskContinuation = {
      version: 1 as const,
      request,
      events: {
        version: 1 as const,
        mode:
          request.classification.kind === "direct"
            ? ("default" as const)
            : ("plan" as const),
        ids: [],
        completedRootMessage: null,
      },
    };
    const evidence = await w.store.commit({
      ...input,
      source: taskSource,
      continuation,
      taskContinuation,
    });
    const bytes = await readFile(
      await file(w.dataDirectory, evidence.storageId),
      "utf8",
    );
    expect(JSON.parse(bytes)).toMatchObject({
      version: 3,
      protectedSource: { formatVersion: 2, component: "task-content" },
    });
    for (const privateValue of [
      receipt.operationId,
      request.operationId,
      request.fingerprint,
      input.home,
      "SAVED_ASSISTANT",
    ])
      expect(bytes).not.toContain(privateValue);
    const denied = await worker(w.dataDirectory, false, "task-content");
    await expect(
      denied.store.open(evidence.storageId, taskSource),
    ).rejects.toThrow("active task-content encryption grant");
    const fresh = await worker(w.dataDirectory, true, "task-content");
    const opened = await fresh.store.open(evidence.storageId, taskSource);
    expect(opened.taskContinuation).toEqual(taskContinuation);
    await expect(
      createNativeResourceProtection(fresh.service).open(
        {
          threadId: suspension.threadId,
          turnId: suspension.turnId,
          checkpointId: suspension.checkpointId,
        },
        JSON.parse(bytes).protectedSource,
        "task-content",
      ),
    ).rejects.toThrow("authenticated");
    expect(opened.continuation).toEqual(continuation);
    await expect(
      fresh.store.commit({ ...input, source: taskSource, continuation }),
    ).rejects.toThrow("original round");
    await expect(
      fresh.store.commit({
        ...input,
        source: taskSource,
        continuation,
        taskContinuation: {
          ...taskContinuation,
          request: { ...request, operationId: randomUUID() },
        },
      }),
    ).rejects.toThrow("another canonical input");
    expect(
      await readFile(await file(w.dataDirectory, evidence.storageId), "utf8"),
    ).toBe(bytes);
  });

  it("keeps legacy evidence inspectable and protects worker bookkeeping under a distinct immutable locator", async () => {
    const w = await worker();
    const legacy = await w.store.commit(input);
    const continuation = captureWorkerTurn(
      workerTurnState(),
      suspension.turnId,
    );
    const evidence = await w.store.commit({ ...input, continuation });
    expect(evidence.storageId).not.toBe(legacy.storageId);
    const filename = await file(w.dataDirectory, evidence.storageId);
    const bytes = await readFile(filename, "utf8");
    expect(JSON.parse(bytes).version).toBe(2);
    for (const value of [
      "SAVED_ASSISTANT",
      "before.txt",
      "completed-command",
      input.home,
    ])
      expect(bytes).not.toContain(value);
    const fresh = await worker(w.dataDirectory);
    expect(
      (await fresh.store.open(evidence.storageId, source)).continuation,
    ).toEqual(continuation);
    expect(
      (await fresh.store.open(legacy.storageId, source)).continuation,
    ).toBeNull();
    expect(
      await fresh.store.commit({
        ...input,
        continuation: {
          ...continuation,
          capturedAtMs: continuation.capturedAtMs + 1,
        },
      }),
    ).toEqual(evidence);
    expect(await readFile(filename, "utf8")).toBe(bytes);
    const denied = await worker(w.dataDirectory, false);
    await expect(denied.store.open(evidence.storageId, source)).rejects.toThrow(
      /chat-content encryption grant/,
    );
    expect(await readFile(filename, "utf8")).toBe(bytes);
  });
  it("does not return an old source if authenticated scope changes during decryption", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    let current = { ...scope };
    const changing = new NativeSuspensionStore(
      w.dataDirectory,
      () => current,
      w.service,
    );
    const pending = changing.open(evidence.storageId, source);
    current = { ...scope, ownerId: "replaced-owner" };
    await expect(pending).rejects.toThrow(/ownership changed/);
    expect((await w.store.open(evidence.storageId, source)).home).toBe(
      input.home,
    );
  });
  it("retains prior recovery bytes when authenticated scope changes during a new commit", async () => {
    const w = await worker();
    const first = await w.store.commit(input);
    let current = { ...scope };
    const changing = new NativeSuspensionStore(
      w.dataDirectory,
      () => current,
      w.service,
    );
    const pending = changing.commit({
      ...input,
      suspension: { ...suspension, revision: 2 },
    });
    current = { ...scope, ownerId: "replaced-owner" };
    await expect(pending).rejects.toThrow(/ownership changed/);
    expect(await w.store.list(source.chatId)).toEqual([first]);
    expect((await w.store.open(first.storageId, source)).home).toBe(input.home);
  });
  it("cannot substitute a source locator for Core resource ciphertext", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    const filename = await file(w.dataDirectory, evidence.storageId);
    const record = JSON.parse(await readFile(filename, "utf8"));
    const binding = {
      threadId: suspension.threadId,
      turnId: suspension.turnId,
      checkpointId: suspension.checkpointId,
    };
    const core = createNativeResourceProtection(w.service);
    await expect(core.open(binding, record.protectedSource)).rejects.toThrow();
    record.protectedSource = await core.seal(binding, {
      version: 1,
      source,
      home: input.home,
    });
    await writeFile(filename, JSON.stringify(record));
    await expect(w.store.open(evidence.storageId, source)).rejects.toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "retries actual directory sync before acknowledging an existing publication",
    async () => {
      const w = await worker();
      const evidence = await w.store.commit(input);
      const filename = await file(w.dataDirectory, evidence.storageId);
      const directory = path.dirname(filename);
      const bytes = await readFile(filename, "utf8");
      try {
        await chmod(directory, 0o300);
        await expect(w.store.commit(input)).rejects.toMatchObject({
          code: "EACCES",
        });
        expect(await readFile(filename, "utf8")).toBe(bytes);
      } finally {
        await chmod(directory, 0o700);
      }
      expect(await w.store.commit(input)).toEqual(evidence);
    },
  );
  it("commits an immutable descriptor and reopens its encrypted original home with fresh grants", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    const filename = await file(w.dataDirectory, evidence.storageId);
    const bytes = await readFile(filename, "utf8");
    expect(bytes).not.toContain(input.home);
    for (const value of [
      source.projectId,
      source.placementId,
      source.modelRouteId,
      source.providerAccountId,
    ])
      expect(bytes).not.toContain(`"${value}"`);
    const fresh = await worker(w.dataDirectory);
    expect(await fresh.store.open(evidence.storageId, source)).toEqual({
      evidence,
      source,
      home: input.home,
      continuation: null,
    });
    expect(await fresh.store.list(source.chatId)).toEqual([evidence]);
    expect(
      await fresh.store.commit({
        ...input,
        runtimeVersion: "new-compatible-runtime",
      }),
    ).toEqual(evidence);
    expect(await readFile(filename, "utf8")).toBe(bytes);
  });

  it("joins concurrent publications without changing or deleting the earlier checkpoint", async () => {
    const w = await worker();
    const another = new NativeSuspensionStore(
      w.dataDirectory,
      () => scope,
      w.service,
    );
    const pair = await Promise.all([
      w.store.commit(input),
      another.commit(input),
    ]);
    expect(pair[0]).toEqual(pair[1]);
    const newer = await w.store.commit({
      ...input,
      suspension: { ...suspension, revision: 2 },
    });
    expect(newer.storageId).not.toBe(pair[0]!.storageId);
    expect(
      (await w.store.list(source.chatId)).map((e) => e.storageId).sort(),
    ).toEqual([newer.storageId, pair[0]!.storageId].sort());
    expect(
      (await w.store.open(pair[0]!.storageId, source)).evidence.suspension
        .revision,
    ).toBe(1);
  });

  it("rejects changed placement/account/thread and a different home without replacing evidence", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    const filename = await file(w.dataDirectory, evidence.storageId);
    const before = await readFile(filename, "utf8");
    for (const changed of [
      { ...source, placementId: "other-placement" },
      { ...source, providerAccountId: "other-account" },
      { ...source, threadId: "other-thread" },
    ])
      await expect(w.store.open(evidence.storageId, changed)).rejects.toThrow();
    await expect(
      w.store.commit({ ...input, home: "/another-home" }),
    ).rejects.toThrow(/home changed/);
    expect(await readFile(filename, "utf8")).toBe(before);
  });

  it("requires the current component grant after restart and never persists a grant as fallback", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    const noGrant = await worker(w.dataDirectory, false);
    await expect(
      noGrant.store.open(evidence.storageId, source),
    ).rejects.toThrow();
    const fresh = await worker(w.dataDirectory);
    expect((await fresh.store.open(evidence.storageId, source)).home).toBe(
      input.home,
    );
    const record = JSON.parse(
      await readFile(await file(w.dataDirectory, evidence.storageId), "utf8"),
    );
    expect(Object.keys(record).sort()).toEqual([
      "chatId",
      "evidence",
      "protectedSource",
      "scope",
      "version",
    ]);
  });

  it("retains corrupt and unsupported bytes instead of minting replacement state", async () => {
    const w = await worker();
    const evidence = await w.store.commit(input);
    const filename = await file(w.dataDirectory, evidence.storageId);
    for (const bytes of [
      '{"version":99,"private":"retained"}',
      "{broken-json",
    ]) {
      await writeFile(filename, bytes);
      await expect(w.store.open(evidence.storageId, source)).rejects.toThrow();
      await expect(w.store.commit(input)).rejects.toThrow();
      expect(await readFile(filename, "utf8")).toBe(bytes);
    }
  });

  it("propagates real filesystem write failures and makes no success record", async () => {
    const w = await worker();
    await writeFile(
      path.join(w.dataDirectory, "native-turn-suspensions"),
      "blocked directory",
    );
    await expect(w.store.commit(input)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    expect(
      await readFile(
        path.join(w.dataDirectory, "native-turn-suspensions"),
        "utf8",
      ),
    ).toBe("blocked directory");
  });

  it("does not turn missing records, arbitrary paths, or source metadata into restoration", async () => {
    const w = await worker();
    expect(await w.store.list(source.chatId)).toEqual([]);
    await expect(w.store.open("../../outside", source)).rejects.toThrow();
    await expect(
      w.store.open("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      w.store.commit({
        ...input,
        suspension: { ...suspension, threadId: "another" },
      }),
    ).rejects.toThrow(/different native thread/);
  });
});
