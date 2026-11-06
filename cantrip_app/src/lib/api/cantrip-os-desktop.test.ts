// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type {
  CantripOsInstanceSummary,
  CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
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
  prepareCantripOsDesktopDraft,
  saveCantripOsDesktopDraft,
  readCantripOsDesktopDraft,
  clearCantripOsDesktopDraft,
  cantripOsDesktopAccountKey,
} from "@/lib/cantrip-os-desktop-draft";
import {
  submitCantripOsDesktop,
  observeCantripOsDesktopDraft,
  getCantripOsDesktop,
  getCantripOsDesktopOperations,
  observeCantripOsDesktopOperation,
} from "./cantrip-os-desktop";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  workspaceId: id(4),
  runtimeGeneration: id(5),
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
  runtimeGeneration: target.runtimeGeneration,
} as CantripOsInstanceSummary;
const workspace = {
  id: target.workspaceId,
  instanceId: instance.id,
  workerId: instance.workerId,
  guestWorkspaceId: "work",
} as CantripOsWorkspaceSummary;
function summary(draft = prepareCantripOsDesktopDraft(target, "restart")) {
  return {
    ...draft.request,
    instanceId: target.instanceId,
    workspaceId: target.workspaceId,
    workerId: target.workerId,
    state: "ready" as const,
    createdAt: target.verifiedAt,
    updatedAt: target.verifiedAt,
    error: null,
    completionEvidence: "acknowledged-and-observed" as const,
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
    ...prepareCantripOsDesktopDraft(target, "restart"),
    submitted: true,
  };
  saveCantripOsDesktopDraft(draft);
  mocks.request.mockRejectedValueOnce(new Error("Lost reply"));
  await expect(submitCantripOsDesktop(draft)).rejects.toThrow("Lost reply");
  const restored = readCantripOsDesktopDraft(instance.id, workspace.id)!;
  expect(restored).toEqual(draft);
  mocks.request.mockResolvedValueOnce(summary(draft));
  await observeCantripOsDesktopDraft(restored);
  expect(mocks.request.mock.calls).toEqual([
    [
      `/api/cantrip-os/${instance.id}/workspaces/${workspace.id}/desktop-operations`,
      { method: "POST", body: JSON.stringify(draft.request) },
      { expectedIdentity: mocks.identity, allowCsrfRecovery: false },
    ],
    [
      `/api/cantrip-os/${instance.id}/workspaces/${workspace.id}/desktop-operations/${draft.request.operationId}/observe`,
      { method: "POST" },
      { expectedIdentity: mocks.identity, allowCsrfRecovery: false },
    ],
  ]);
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toEqual(draft);
});

it.each([
  ["operationId", id(8)],
  ["action", "stop"],
  ["instanceId", id(9)],
  ["workerId", "other"],
  ["workspaceId", id(30)],
  ["runtimeGeneration", id(31)],
  ["attachmentGeneration", id(10)],
  ["targetGeneration", id(11)],
])(
  "rejects a changed %s in an otherwise valid desktop response",
  async (field, changed) => {
    const draft = prepareCantripOsDesktopDraft(target, "restart");
    mocks.request.mockResolvedValue({ ...summary(draft), [field]: changed });
    await expect(submitCantripOsDesktop(draft)).rejects.toThrow("misrouted");
    await expect(observeCantripOsDesktopDraft(draft)).rejects.toThrow(
      "misrouted",
    );
  },
);

it("never redirects saved or historical operations to another account or server", async () => {
  const draft = prepareCantripOsDesktopDraft(target, "stop"),
    account = cantripOsDesktopAccountKey();
  saveCantripOsDesktopDraft(draft);
  const previous = { ...mocks.identity };
  mocks.identity = { ...previous, serverUrl: "http://other-server" };
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toBeNull();
  await expect(submitCantripOsDesktop(draft)).rejects.toThrow("not redirected");
  await expect(observeCantripOsDesktopDraft(draft)).rejects.toThrow(
    "not redirected",
  );
  await expect(
    observeCantripOsDesktopOperation(summary(draft), account),
  ).rejects.toThrow("not redirected");
  await expect(
    getCantripOsDesktop(instance, workspace, account),
  ).rejects.toThrow("not redirected");
  await expect(
    getCantripOsDesktopOperations(
      instance.id,
      workspace.id,
      undefined,
      account,
    ),
  ).rejects.toThrow("not redirected");
  expect(() =>
    clearCantripOsDesktopDraft(instance.id, workspace.id, account),
  ).toThrow("preserved");
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.identity = { ...previous, generation: 2 };
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toEqual(draft);
});

it("rejects a changed attachment status and foreign instance history", async () => {
  mocks.request.mockResolvedValue({
    target: { ...target, attachmentGeneration: id(12) },
    observation: null,
    error: null,
  });
  await expect(getCantripOsDesktop(instance, workspace)).rejects.toThrow(
    "attachment changed",
  );
  mocks.request.mockResolvedValue({
    items: [{ ...summary(), instanceId: id(13) }],
    nextCursor: null,
  });
  await expect(
    getCantripOsDesktopOperations(instance.id, workspace.id),
  ).rejects.toThrow("misrouted");
});

it("keeps distinct workspace drafts and rejects copied, corrupt or retargeted requests", () => {
  const first = prepareCantripOsDesktopDraft(target, "start");
  saveCantripOsDesktopDraft(first);
  const original = sessionStorage.getItem(sessionStorage.key(0)!)!;
  const second = prepareCantripOsDesktopDraft(
    { ...target, workspaceId: id(20) },
    "stop",
  );
  saveCantripOsDesktopDraft(second);
  const secondKey = sessionStorage.key(1)!;
  sessionStorage.setItem(secondKey, original);
  expect(() => readCantripOsDesktopDraft(instance.id, id(20))).toThrow(
    "another workspace",
  );
  sessionStorage.setItem(secondKey, "{corrupt");
  expect(() => readCantripOsDesktopDraft(instance.id, id(20))).toThrow();
  expect(() =>
    saveCantripOsDesktopDraft({
      ...first,
      request: { ...first.request, targetGeneration: id(99) },
    }),
  ).toThrow("differs");
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toEqual(first);
});
