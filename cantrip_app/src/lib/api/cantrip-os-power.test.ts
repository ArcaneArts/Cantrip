// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  identity: {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => mocks.identity,
}));
vi.mock("@/lib/api-client", () => ({
  request: mocks.request,
  CantripApiError: class extends Error {},
}));
import {
  prepareCantripOsPowerDraft,
  saveCantripOsPowerDraft,
  readCantripOsPowerDraft,
  clearCantripOsPowerDraft,
  cantripOsPowerAccountKey,
} from "@/lib/cantrip-os-power-draft";
import {
  submitCantripOsPower,
  observeCantripOsPowerDraft,
  getCantripOsPower,
  getCantripOsPowerOperations,
  observeCantripOsPowerOperation,
} from "./cantrip-os-power";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  kind: "docker" as const,
  generation: id(2),
  instanceId: id(1),
  workerId: "worker",
  attachmentGeneration: id(3),
  verifiedAt: "2026-11-06T00:00:00.000Z",
};
const instance = {
  id: target.instanceId,
  workerId: target.workerId,
  attachmentGeneration: target.attachmentGeneration,
} as CantripOsInstanceSummary;
function summary(draft = prepareCantripOsPowerDraft(target, "restart")) {
  return {
    ...draft.request,
    instanceId: target.instanceId,
    workerId: target.workerId,
    state: "ready" as const,
    createdAt: target.verifiedAt,
    updatedAt: target.verifiedAt,
    error: null,
    completionEvidence: "acknowledged-and-observed" as const,
    powerState: null,
  };
}
beforeEach(() => {
  sessionStorage.clear();
  mocks.request.mockReset();
  mocks.identity = {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  };
});

it("retains the admission after a lost reply and observes its original route after reload", async () => {
  const draft = {
    ...prepareCantripOsPowerDraft(target, "restart"),
    submitted: true,
  };
  saveCantripOsPowerDraft(draft);
  mocks.request.mockRejectedValueOnce(new Error("Lost reply"));
  await expect(submitCantripOsPower(draft)).rejects.toThrow("Lost reply");
  const restored = readCantripOsPowerDraft(instance.id)!;
  expect(restored).toEqual(draft);
  mocks.request.mockResolvedValueOnce(summary(draft));
  await observeCantripOsPowerDraft(restored);
  expect(mocks.request.mock.calls).toEqual([
    [
      `/api/cantrip-os/${instance.id}/power-operations`,
      { method: "POST", body: JSON.stringify(draft.request) },
      { expectedIdentity: mocks.identity, allowCsrfRecovery: false },
    ],
    [
      `/api/cantrip-os/${instance.id}/power-operations/${draft.request.operationId}/observe`,
      { method: "POST" },
      { expectedIdentity: mocks.identity, allowCsrfRecovery: false },
    ],
  ]);
  expect(readCantripOsPowerDraft(instance.id)).toEqual(draft);
});

it.each([
  ["operationId", id(8)],
  ["action", "stop"],
  ["instanceId", id(9)],
  ["workerId", "other"],
  ["attachmentGeneration", id(10)],
  ["targetGeneration", id(11)],
])(
  "rejects a changed %s in an otherwise valid power response",
  async (field, changed) => {
    const draft = prepareCantripOsPowerDraft(target, "restart");
    mocks.request.mockResolvedValue({ ...summary(draft), [field]: changed });
    await expect(submitCantripOsPower(draft)).rejects.toThrow("misrouted");
    await expect(observeCantripOsPowerDraft(draft)).rejects.toThrow(
      "misrouted",
    );
  },
);

it("never redirects saved or historical operations to another account or server", async () => {
  const draft = prepareCantripOsPowerDraft(target, "stop"),
    account = cantripOsPowerAccountKey();
  saveCantripOsPowerDraft(draft);
  const previous = { ...mocks.identity };
  mocks.identity = { ...previous, serverUrl: "http://other-server" };
  expect(readCantripOsPowerDraft(instance.id)).toBeNull();
  await expect(submitCantripOsPower(draft)).rejects.toThrow("not redirected");
  await expect(observeCantripOsPowerDraft(draft)).rejects.toThrow(
    "not redirected",
  );
  await expect(
    observeCantripOsPowerOperation(summary(draft), account),
  ).rejects.toThrow("not redirected");
  await expect(getCantripOsPower(instance, account)).rejects.toThrow(
    "not redirected",
  );
  await expect(
    getCantripOsPowerOperations(instance.id, undefined, account),
  ).rejects.toThrow("not redirected");
  expect(() => clearCantripOsPowerDraft(instance.id, account)).toThrow(
    "preserved",
  );
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.identity = { ...previous, generation: 2 };
  expect(readCantripOsPowerDraft(instance.id)).toEqual(draft);
});

it("rejects a changed attachment status and foreign instance history", async () => {
  mocks.request.mockResolvedValue({
    target: { ...target, attachmentGeneration: id(12) },
    observation: null,
    error: null,
  });
  await expect(getCantripOsPower(instance)).rejects.toThrow(
    "attachment changed",
  );
  mocks.request.mockResolvedValue({
    items: [{ ...summary(), instanceId: id(13) }],
    nextCursor: null,
  });
  await expect(getCantripOsPowerOperations(instance.id)).rejects.toThrow(
    "misrouted",
  );
});

it("keeps distinct instance drafts and rejects copied, corrupt or retargeted requests", () => {
  const first = prepareCantripOsPowerDraft(target, "start");
  saveCantripOsPowerDraft(first);
  const original = sessionStorage.getItem(sessionStorage.key(0)!)!;
  const second = prepareCantripOsPowerDraft(
    { ...target, instanceId: id(20) },
    "stop",
  );
  saveCantripOsPowerDraft(second);
  const secondKey = sessionStorage.key(1)!;
  sessionStorage.setItem(secondKey, original);
  expect(() => readCantripOsPowerDraft(id(20))).toThrow("another instance");
  sessionStorage.setItem(secondKey, "{corrupt");
  expect(() => readCantripOsPowerDraft(id(20))).toThrow();
  expect(() =>
    saveCantripOsPowerDraft({
      ...first,
      request: { ...first.request, targetGeneration: id(99) },
    }),
  ).toThrow("differs");
  expect(readCantripOsPowerDraft(instance.id)).toEqual(first);
});
