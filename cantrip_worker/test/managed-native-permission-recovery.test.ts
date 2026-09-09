import { CodexNativeRpcError } from "../src/codex/app-server.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  nativeThreadSettingsSchema,
  type NativeSettingsEvidence,
  type NativeSettingsBinding,
} from "@cantrip/protocol";
import { NativeSettingsDelivery } from "../src/native-settings-delivery.js";
import { ManagedNativeSettings } from "../src/codex/managed-native-settings.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { openNativeCommandContent } from "../src/native-command-content.js";
const directories: string[] = [];
const deliveries: NativeSettingsDelivery[] = [];
afterEach(async () => {
  await Promise.all(deliveries.splice(0).map((item) => item.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((item) => rm(item, { recursive: true, force: true })),
  );
});
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
};
const scope = {
  chatId: "chat",
  operationId: "operation",
  operationGeneration: "grant",
  threadId: "thread",
  runtimeGeneration: "old-runtime",
  nativeOperationId: "native-operation",
};
const source = {
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "old-runtime",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: "account",
};
const binding: NativeSettingsBinding = {
  ...source,
  runtimeGeneration: "new-runtime",
  bindingId: "new-binding",
  nativeEpoch: "new-epoch",
};
const transition = {
  selectedId: null,
  resolvedSelectedId: ":workspace",
  effectiveId: ":workspace",
  expectedRevision: "0",
};
const security = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: ["/private/root"],
    networkAccess: false,
  },
  permissionProfile: { type: "workspace", root: "/private/root" },
  activePermissionProfile: { id: ":workspace", extends: null },
};
const historical = nativeThreadSettingsSchema.parse({
  ...security,
  settingsVersion: { epoch: "old-epoch", revision: "1" },
  cwd: "/private/root",
  model: "old-model",
  modelProvider: "provider",
  effort: "high",
  serviceTier: null,
  summary: null,
  collaborationMode: { mode: "default", settings: {} },
  personality: null,
});
const current = nativeThreadSettingsSchema.parse({
  ...historical,
  model: "new-model",
  settingsVersion: { epoch: "new-epoch", revision: "2" },
});
const journal = {
  threadId: scope.threadId,
  operationId: scope.nativeOperationId,
  submissionId: "submission",
  phase: "applied",
  resolvedSecurity: security,
  threadSettings: historical,
  rejection: null,
};
function delivery(directory: string) {
  const send = vi.fn(
    async (event: Omit<NativeSettingsEvidence, "workerId">) => ({
      operationId: event.operationId,
      operationGeneration: event.operationGeneration,
      eventId: event.eventId,
      permissionPolicyPublished: Boolean(event.recoveryBindingId),
      application: {
        nativeOperationId: event.nativeOperationId,
        submissionId: event.submissionId,
        status:
          event.kind === "rejected"
            ? ("rejected" as const)
            : event.kind === "queued"
              ? ("pending" as const)
              : ("applied" as const),
        evidenceCount: 1,
      },
    }),
  );
  const onError = vi.fn();
  const instance = new NativeSettingsDelivery({
    directory,
    workerId: "worker",
    service,
    client: { settingsEvidence: send },
    onError,
    retryDelayMs: 5,
  });
  deliveries.push(instance);
  return { instance, send, onError };
}
async function fixture(register = true) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-permission-recovery-"),
  );
  directories.push(directory);
  const first = delivery(directory);
  if (register) await first.instance.track(scope, { transition, source });
  await first.instance.stop();
  const second = delivery(directory);
  const observations = new NativeHistoryObservations();
  observations.replace(binding.runtimeGeneration);
  const applied = vi.fn(),
    rejected = vi.fn(),
    onError = vi.fn();
  const tracker = new ManagedNativeSettings({
    runtime: {
      observeNativeHistory: (threadId, observer) =>
        observations.subscribe(threadId, observer, async () => {
          throw new Error("Unexpected history read");
        }),
    },
    delivery: second.instance,
    onPermissionApplied: applied,
    onPermissionRejected: rejected,
    onError,
  });
  return { directory, ...second, observations, tracker, applied, rejected };
}
it("keeps durable native pending permission operations pending across reconnect without guessing transport failure", async () => {
  const f = await fixture();
  const readSettings = vi.fn(async () => current),
    readOperation = vi.fn(async () => ({
      ...journal,
      phase: "pending",
      threadSettings: null,
    }));
  await f.tracker.recoverPermissions({
    binding,
    readSettings,
    readOperation,
    assertCurrent() {},
  });
  await expect.poll(() => f.send.mock.calls.length).toBe(1);
  expect(f.send.mock.calls[0]![0].kind).toBe("queued");
  expect(readSettings).not.toHaveBeenCalled();
  f.observations.replace("later-runtime");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    f.send.mock.calls.some(([event]) => event.kind === "transport-lost"),
  ).toBe(false);
  expect(await f.instance.permissionRegistrations(binding)).toHaveLength(1);
});
it("re-proves already applied security from actual journal and current read without restoring the historical model", async () => {
  const f = await fixture();
  const readSettings = vi.fn(async () => current),
    readOperation = vi.fn(async () => journal);
  await f.tracker.recoverPermissions({
    binding,
    readSettings,
    readOperation,
    assertCurrent() {},
  });
  await expect.poll(() => f.applied.mock.calls.length).toBe(1);
  expect(readOperation).toHaveBeenCalledWith(scope.nativeOperationId);
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(f.applied.mock.calls[0]).toEqual([
    { ...scope, runtimeGeneration: binding.runtimeGeneration },
    transition,
    current,
  ]);
  const recovery = f.send.mock.calls
    .map(([event]) => event)
    .find((event) => event.recoveryBindingId)!;
  expect(recovery).toMatchObject({
    runtimeGeneration: scope.runtimeGeneration,
    recoveryBindingId: binding.bindingId,
    permissionPolicy: {
      effectiveId: transition.effectiveId,
      settingsVersion: current.settingsVersion,
    },
  });
  const plaintext = await openNativeCommandContent({
    service,
    context: {
      chatId: scope.chatId,
      operationId: scope.operationId,
      direction: "settings-evidence",
      eventId: recovery.eventId,
    },
    envelope: recovery.protectedResult,
  });
  expect(plaintext).toMatchObject({
    recoveryBindingId: binding.bindingId,
    content: { currentSettings: current, journal },
  });
  await f.instance.stop();
  const third = delivery(f.directory);
  expect(await third.instance.permissionRegistrations(binding)).toHaveLength(1);
});
it("does not read another placement or account, and does not claim historical security is currently applied", async () => {
  const f = await fixture();
  const readOperation = vi.fn(async () => journal),
    readSettings = vi.fn(async () => ({ ...current, approvalPolicy: "never" }));
  await f.tracker.recoverPermissions({
    binding: { ...binding, providerAccountId: "another" },
    readOperation,
    readSettings,
    assertCurrent() {},
  });
  expect(readOperation).not.toHaveBeenCalled();
  await f.tracker.recoverPermissions({
    binding,
    readOperation,
    readSettings,
    assertCurrent() {},
  });
  await expect.poll(() => f.send.mock.calls.length).toBe(1);
  expect(f.send.mock.calls[0]![0]).toMatchObject({
    kind: "applied",
    permissionPolicy: { settingsVersion: historical.settingsVersion },
  });
  expect(f.send.mock.calls[0]![0].recoveryBindingId).toBeUndefined();
  expect(f.applied).not.toHaveBeenCalled();
});
it("keeps native rejection and replaced read failures distinct from successful recovery", async () => {
  const f = await fixture();
  const readSettings = vi.fn(async () => current);
  await f.tracker.recoverPermissions({
    binding,
    readSettings,
    readOperation: async () => ({
      ...journal,
      phase: "rejected",
      rejection: "invalid profile",
      threadSettings: null,
    }),
    assertCurrent() {},
  });
  await expect.poll(() => f.rejected.mock.calls.length).toBe(1);
  expect(readSettings).not.toHaveBeenCalled();
  let checks = 0;
  await expect(
    f.tracker.recoverPermissions({
      binding: { ...binding, bindingId: "newer-binding" },
      readSettings,
      readOperation: async () => journal,
      assertCurrent() {
        if (++checks === 3) throw new Error("source replaced");
      },
    }),
  ).rejects.toThrow("source replaced");
  expect(f.applied).not.toHaveBeenCalled();
});

it("settles only exact actual missing-journal proof after replacement, never generic RPC or timeout errors", async () => {
  const f = await fixture();
  const absent = new CodexNativeRpcError(
    "Operation absent",
    {
      code: -32004,
      message: "Operation absent",
      data: {
        reason: "settingsOperationNotFound",
        threadId: scope.threadId,
        operationId: scope.nativeOperationId,
      },
    },
    "thread/settings/operation/read",
  );
  const readSettings = vi.fn(async () => current);
  await expect(
    f.tracker.recoverPermissions({
      binding,
      readSettings,
      readOperation: async () => {
        throw new Error("timeout");
      },
      assertCurrent() {},
    }),
  ).rejects.toThrow("timeout");
  await expect(
    f.tracker.recoverPermissions({
      binding,
      readSettings,
      readOperation: async () => {
        throw new CodexNativeRpcError(
          "bad load",
          { code: -32004, message: "bad load" },
          "thread/settings/operation/read",
        );
      },
      assertCurrent() {},
    }),
  ).rejects.toThrow("bad load");
  expect(f.send).not.toHaveBeenCalled();
  await f.tracker.recoverPermissions({
    binding,
    readSettings,
    readOperation: async () => {
      throw absent;
    },
    assertCurrent() {},
  });
  await expect.poll(() => f.rejected.mock.calls.length).toBe(1);
  expect(f.send.mock.calls[0]![0]).toMatchObject({
    kind: "rejected",
    submissionId: null,
  });
  expect(readSettings).not.toHaveBeenCalled();
});
it("serializes duplicate recovery and observes a recovered pending operation applying in the current runtime", async () => {
  const f = await fixture();
  const readOperation = vi.fn(async () => ({
    ...journal,
    phase: "pending",
    threadSettings: null,
  }));
  const recover = {
    binding,
    readOperation,
    readSettings: vi.fn(async () => current),
    assertCurrent() {},
  };
  await Promise.all([
    f.tracker.recoverPermissions(recover),
    f.tracker.recoverPermissions(recover),
  ]);
  expect(readOperation).toHaveBeenCalledTimes(1);
  f.observations.notification("thread/settings/updated", {
    threadId: scope.threadId,
    operationId: scope.nativeOperationId,
    submissionId: "submission",
    threadSettings: current,
    resolvedSecurity: security,
  });
  await expect.poll(() => f.applied.mock.calls.length).toBe(1);
  expect(f.applied.mock.calls[0]).toEqual([
    { ...scope, runtimeGeneration: binding.runtimeGeneration },
    transition,
    current,
  ]);
  expect(
    f.send.mock.calls
      .map(([event]) => event)
      .find((event) => event.kind === "applied"),
  ).toMatchObject({
    recoveryBindingId: binding.bindingId,
    runtimeGeneration: scope.runtimeGeneration,
  });
  expect(recover.readSettings).not.toHaveBeenCalled();
});

it("reconciles an applied live policy again when deferred retention settles after the first wake, waiting for publication", async () => {
  const f = await fixture(false);
  const liveScope = { ...scope, runtimeGeneration: binding.runtimeGeneration };
  const liveSource = {
    ...source,
    runtimeGeneration: binding.runtimeGeneration,
  };
  const response = f.send.getMockImplementation()!;
  let release!: () => void;
  const publication = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.send.mockImplementation(async (event) => {
    if (event.recoveryBindingId) await publication;
    return { ...(await response(event)), permissionPolicyPublished: true };
  });
  let retained = false,
    resumed = false;
  f.applied.mockImplementation(() => {
    if (retained) resumed = true;
  });
  await f.tracker.track(liveScope, transition, liveSource);
  f.observations.notification("thread/settings/updated", {
    threadId: scope.threadId,
    operationId: scope.nativeOperationId,
    submissionId: "submission",
    threadSettings: current,
    resolvedSecurity: security,
  });
  await expect.poll(() => f.applied.mock.calls.length).toBe(1);
  expect(resumed).toBe(false);
  retained = true;
  const readOperation = vi.fn(async () => ({
    ...journal,
    threadSettings: current,
  }));
  const readSettings = vi.fn(async () => current);
  await f.tracker.recoverPermissions({
    binding,
    readOperation,
    readSettings,
    assertCurrent() {},
  });
  expect(readOperation).toHaveBeenCalledTimes(1);
  expect(readSettings).toHaveBeenCalledTimes(1);
  await expect
    .poll(() =>
      f.send.mock.calls.some(([event]) => Boolean(event.recoveryBindingId)),
    )
    .toBe(true);
  expect(resumed).toBe(false);
  release();
  await expect.poll(() => resumed).toBe(true);
  expect(f.applied.mock.calls.at(-1)).toEqual([liveScope, transition, current]);
});
it("does not query a live pre-dispatch registration, but reconciles it after an uncertain native response", async () => {
  const f = await fixture(false);
  const liveScope = { ...scope, runtimeGeneration: binding.runtimeGeneration };
  await f.tracker.track(liveScope, transition, {
    ...source,
    runtimeGeneration: binding.runtimeGeneration,
  });
  const readOperation = vi.fn(async () => ({
    ...journal,
    threadSettings: current,
  }));
  const readSettings = vi.fn(async () => current);
  const recovery = { binding, readOperation, readSettings, assertCurrent() {} };
  await f.tracker.recoverPermissions(recovery);
  expect(readOperation).not.toHaveBeenCalled();
  await f.tracker.acknowledge(scope.nativeOperationId, null);
  await f.tracker.recoverPermissions(recovery);
  expect(readOperation).toHaveBeenCalledTimes(1);
  expect(readSettings).toHaveBeenCalledTimes(1);
  await expect.poll(() => f.applied.mock.calls.length).toBe(1);
});
it("reconciles when the server has committed application but its worker reply is still pending", async () => {
  const f = await fixture(false);
  const liveScope = { ...scope, runtimeGeneration: binding.runtimeGeneration };
  const response = f.send.getMockImplementation()!;
  let release!: () => void;
  const reply = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.send.mockImplementation(async (event) => {
    if (!event.recoveryBindingId && event.kind === "applied") await reply;
    return { ...(await response(event)), permissionPolicyPublished: true };
  });
  await f.tracker.track(liveScope, transition, {
    ...source,
    runtimeGeneration: binding.runtimeGeneration,
  });
  f.observations.notification("thread/settings/updated", {
    threadId: scope.threadId,
    operationId: scope.nativeOperationId,
    submissionId: "submission",
    threadSettings: current,
    resolvedSecurity: security,
  });
  await expect.poll(() => f.send.mock.calls.length).toBe(1);
  expect(f.applied).not.toHaveBeenCalled();
  const readSettings = vi.fn(async () => current);
  await f.tracker.recoverPermissions({
    binding,
    readOperation: async () => ({ ...journal, threadSettings: current }),
    readSettings,
    assertCurrent() {},
  });
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(f.applied).not.toHaveBeenCalled();
  release();
  await expect.poll(() => f.applied.mock.calls.length).toBeGreaterThan(0);
  expect(f.applied.mock.calls[0]).toEqual([liveScope, transition, current]);
});

it("reawakens late retained input from a captured native rejection without inventing a missing-journal result", async () => {
  const f = await fixture(false);
  const liveScope = { ...scope, runtimeGeneration: binding.runtimeGeneration };
  await f.tracker.track(liveScope, transition, {
    ...source,
    runtimeGeneration: binding.runtimeGeneration,
  });
  await f.tracker.acknowledge(scope.nativeOperationId, {
    error: { code: -32600, message: "Profile resolution rejected" },
  });
  await expect.poll(() => f.rejected.mock.calls.length).toBe(1);
  const readOperation = vi.fn(async () => {
    throw new Error("No journal was created");
  });
  const readSettings = vi.fn(async () => current);
  await f.tracker.recoverPermissions({
    binding,
    readOperation,
    readSettings,
    assertCurrent() {},
  });
  await expect.poll(() => f.rejected.mock.calls.length).toBe(2);
  expect(readOperation).not.toHaveBeenCalled();
  expect(readSettings).toHaveBeenCalledTimes(1);
  expect(f.applied).not.toHaveBeenCalled();
});
