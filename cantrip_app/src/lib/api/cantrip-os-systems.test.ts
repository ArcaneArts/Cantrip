// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { cantripOsSystemSummarySchema } from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  grant: vi.fn(),
  refresh: vi.fn(),
  identity: {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  },
  encryption: {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => mocks.identity,
  clientSessionIdentityMatches: (identity: unknown) =>
    identity === mocks.identity,
}));
vi.mock("@/lib/api-client", () => ({
  request: mocks.request,
  CantripApiError: class extends Error {},
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: { getSnapshot: () => mocks.encryption },
}));
vi.mock("@/lib/worker-encryption-grants", () => ({
  authorizeWorkerEncryption: mocks.grant,
}));
vi.mock("./worker-wire", () => ({ refreshWorkerEncryption: mocks.refresh }));
import {
  prepareCantripOsSystemDraft,
  saveCantripOsSystemDraft,
  readCantripOsSystemDraft,
  clearCantripOsSystemDraft,
  cantripOsSystemAccountKey,
  type CantripOsSystemDraft,
} from "../cantrip-os-system-draft";
import {
  getCantripOsSystem,
  getCantripOsSystemOperations,
  submitCantripOsSystem,
  observeCantripOsSystemDraft,
  observeCantripOsSystemOperation,
  controlCantripOsSystemOperation,
  recoverCantripOsSystemOperation,
} from "./cantrip-os-systems";
import {
  cantripOsSystemTestFixture,
  systemTestId as id,
} from "../cantrip-os-system-test-fixture";
const f = cantripOsSystemTestFixture();
function draft() {
  return {
    ...prepareCantripOsSystemDraft(f.destination, {
      action: "capture",
      resumeOriginal: true,
    }),
    submitted: true,
  };
}
function outcome(d: CantripOsSystemDraft) {
  return {
    ...f.summary,
    operationId: d.request.operationId,
    request: d.request,
    context: { ...f.context, operationId: d.request.operationId },
  };
}
beforeEach(() => {
  sessionStorage.clear();
  mocks.request.mockReset();
  mocks.grant.mockReset();
  mocks.refresh.mockReset();
  mocks.identity = {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  };
  mocks.encryption = {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  };
});
it("retains the request after a lost send, observes its original scope after reload and explicitly resubmits the same UUID", async () => {
  const d = draft();
  saveCantripOsSystemDraft(d);
  mocks.request.mockRejectedValueOnce(new Error("Lost reply"));
  await expect(submitCantripOsSystem(d)).rejects.toThrow("Lost reply");
  const restored = readCantripOsSystemDraft(f.instance.id)!;
  expect(restored).toEqual(d);
  mocks.request.mockResolvedValue(outcome(d));
  const observed = await observeCantripOsSystemDraft(restored);
  expect(observed.attachmentGeneration).toBe(id(9));
  expect(observed.context.attachmentGeneration).toBe(id(2));
  await submitCantripOsSystem(restored);
  const calls = mocks.request.mock.calls;
  expect(calls[1]![0]).toContain(`/${d.request.operationId}/observe`);
  expect(calls[0]![1].body).toBe(calls[2]![1].body);
  for (const call of calls) expect(call[2].allowCsrfRecovery).toBe(false);
  expect(mocks.grant).not.toHaveBeenCalled();
});
it("uses the current operation fence for continuation while preserving the original encryption context", async () => {
  const account = cantripOsSystemAccountKey();
  mocks.request.mockResolvedValue(f.summary);
  await controlCantripOsSystemOperation(f.summary, "continue", account);
  expect(mocks.grant).toHaveBeenCalledOnce();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({
    attachmentGeneration: id(9),
    targetGeneration: id(3),
  });
  mocks.request.mockResolvedValue({
    ...f.summary,
    context: { ...f.context, guestInstanceId: id(21) },
  });
  await expect(
    observeCantripOsSystemOperation(f.summary, account),
  ).rejects.toThrow("context changed");
});
it("abandons only its original prepared request without a crypto grant when encryption is locked", async () => {
  mocks.encryption = { ...mocks.encryption, status: "locked" };
  const prepared = {
    ...f.summary,
    dispatchStage: "preparing" as const,
    phase: "prepared",
  };
  mocks.request.mockResolvedValue({
    ...prepared,
    state: "rejected",
    phase: "not-dispatched",
  });
  expect(
    (
      await controlCantripOsSystemOperation(
        prepared,
        "abandon",
        cantripOsSystemAccountKey(),
      )
    ).state,
  ).toBe("rejected");
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
});
it("preserves saved requests across account/server switches and never sends them to another identity", async () => {
  const d = draft();
  saveCantripOsSystemDraft(d);
  const original = { ...mocks.identity };
  mocks.identity = { ...mocks.identity, serverId: "other" };
  expect(readCantripOsSystemDraft(f.instance.id)).toBeNull();
  await expect(submitCantripOsSystem(d)).rejects.toThrow("not redirected");
  expect(() => clearCantripOsSystemDraft(f.instance.id, d.accountKey)).toThrow(
    "preserved",
  );
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.identity = original;
  expect(readCantripOsSystemDraft(f.instance.id)).toEqual(d);
});
it("rejects misrouted observations and history without treating old history as the current target", async () => {
  const account = cantripOsSystemAccountKey();
  mocks.request.mockResolvedValue({
    supported: true,
    target: { ...f.target, attachmentGeneration: id(9) },
    bases: [],
    error: null,
  });
  await expect(getCantripOsSystem(f.instance, account)).rejects.toThrow(
    "attachment changed",
  );
  mocks.request.mockResolvedValue({ items: [f.summary], nextCursor: id(22) });
  expect(
    (await getCantripOsSystemOperations(f.instance.id, id(23), account))
      .items[0],
  ).toEqual(f.summary);
  expect(mocks.request.mock.calls.at(-1)![0]).toContain(`cursor=${id(23)}`);
  mocks.request.mockResolvedValue({
    items: [{ ...f.summary, workerId: "foreign" }],
    nextCursor: null,
  });
  await expect(
    getCantripOsSystemOperations(f.instance.id, undefined, account),
  ).rejects.toThrow("misrouted");
});
it("recovers only the same logical instance and accepts a fresh guest identity and fence", async () => {
  const original = cantripOsSystemSummarySchema.parse({
    ...f.summary,
    state: "ready",
    phase: "complete",
    request: {
      operationId: f.context.operationId,
      attachmentGeneration: f.scope.attachmentGeneration,
      targetGeneration: f.context.targetGeneration,
      action: "replace",
      source: { kind: "base", imageId: f.physical.imageId },
      startTarget: true,
    },
  });
  const recovered = {
    ...f.instance,
    guestInstanceId: id(25),
    attachmentGeneration: id(26),
    runtimeGeneration: null,
    status: "unknown",
  };
  mocks.request.mockResolvedValue(recovered);
  expect(
    await recoverCantripOsSystemOperation(
      original,
      cantripOsSystemAccountKey(),
    ),
  ).toEqual(recovered);
  expect(mocks.grant).not.toHaveBeenCalled();
  mocks.request.mockResolvedValue({ ...recovered, ownerId: "foreign" });
  await expect(
    recoverCantripOsSystemOperation(original, cantripOsSystemAccountKey()),
  ).rejects.toThrow("misrouted");
  mocks.request.mockResolvedValue({
    ...recovered,
    attachmentGeneration: original.attachmentGeneration,
  });
  await expect(
    recoverCantripOsSystemOperation(original, cantripOsSystemAccountKey()),
  ).rejects.toThrow("misrouted");
});
