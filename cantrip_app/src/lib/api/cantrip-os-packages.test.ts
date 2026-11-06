// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
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
  clientSessionIdentityMatches: (value: unknown) => value === mocks.identity,
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
  prepareCantripOsPackageDraft,
  saveCantripOsPackageDraft,
  readCantripOsPackageDraft,
  clearCantripOsPackageDraft,
  cantripOsPackageAccountKey,
} from "../cantrip-os-package-draft";
import {
  getCantripOsPackages,
  getCantripOsPackageOperations,
  submitCantripOsPackage,
  observeCantripOsPackageDraft,
  controlCantripOsPackageOperation,
} from "./cantrip-os-packages";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  generation: id(2),
  instanceId: id(1),
  workerId: "worker",
  attachmentGeneration: id(3),
  architecture: "amd64",
  verifiedAt: "2026-11-06T00:00:00.000Z",
};
const instance = {
  id: target.instanceId,
  workerId: target.workerId,
  attachmentGeneration: target.attachmentGeneration,
} as CantripOsInstanceSummary;
const artifact = {
  name: "cantrip-os-recovery" as const,
  version: "0.5.0",
  architecture: "all",
  sha256: "a".repeat(64),
  bytes: 21484,
};
const draft = () => ({
  ...prepareCantripOsPackageDraft(target, {
    action: "repair",
    configuration: "preserve",
    packages: [artifact],
  }),
  submitted: true,
});
function summary(value = draft()) {
  return {
    ...value.request,
    instanceId: target.instanceId,
    workerId: target.workerId,
    state: "unknown" as const,
    phase: "ready-to-install",
    createdAt: target.verifiedAt,
    updatedAt: target.verifiedAt,
    protectedResult: null,
    error: null,
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
});
it("retains immutable artifact selection after a lost reply and observes the original admission after reload", async () => {
  const saved = draft();
  saveCantripOsPackageDraft(saved);
  mocks.request.mockRejectedValueOnce(new Error("Lost reply"));
  await expect(submitCantripOsPackage(saved)).rejects.toThrow("Lost reply");
  const restored = readCantripOsPackageDraft(instance.id)!;
  expect(restored).toEqual(saved);
  mocks.request.mockResolvedValueOnce(summary(saved));
  await observeCantripOsPackageDraft(restored);
  expect(mocks.request.mock.calls.map((call) => call[0])).toEqual([
    `/api/cantrip-os/${instance.id}/package-operations`,
    `/api/cantrip-os/${instance.id}/package-operations/${saved.request.operationId}/observe`,
  ]);
  expect(mocks.request.mock.calls[0]![1]).toEqual({
    method: "POST",
    body: JSON.stringify(saved.request),
  });
  expect(
    mocks.request.mock.calls.every(
      (call) => call[2].allowCsrfRecovery === false,
    ),
  ).toBe(true);
  expect(JSON.stringify(restored)).not.toMatch(
    /identityPath|runtimeGeneration|transport/,
  );
});
it("keeps saved drafts within their account and rejects tampered artifact acknowledgements", async () => {
  const saved = draft();
  saveCantripOsPackageDraft(saved);
  const original = mocks.identity;
  mocks.identity = { ...original, userId: "other", generation: 2 };
  expect(readCantripOsPackageDraft(instance.id)).toBeNull();
  await expect(observeCantripOsPackageDraft(saved)).rejects.toThrow(
    "not redirected",
  );
  expect(() =>
    clearCantripOsPackageDraft(instance.id, saved.accountKey),
  ).toThrow("preserved");
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.identity = original;
  expect(readCantripOsPackageDraft(instance.id)).toEqual(saved);
  mocks.request.mockResolvedValueOnce({
    ...summary(saved),
    packages: [{ ...artifact, sha256: "b".repeat(64) }],
  });
  await expect(observeCantripOsPackageDraft(saved)).rejects.toThrow(
    "artifact selection",
  );
});
it("checks inventory/history routing and sends explicit controls to their original target", async () => {
  mocks.request.mockResolvedValueOnce({
    target: { ...target, workerId: "other" },
    installed: [],
    available: [artifact],
    unavailable: 0,
    error: null,
  });
  await expect(getCantripOsPackages(instance)).rejects.toThrow(
    "attachment changed",
  );
  mocks.request.mockResolvedValueOnce({
    items: [{ ...summary(), instanceId: id(8) }],
    nextCursor: null,
  });
  await expect(getCantripOsPackageOperations(instance.id)).rejects.toThrow(
    "misrouted",
  );
  const saved = draft(),
    original = summary(saved);
  mocks.request.mockResolvedValueOnce(original);
  await controlCantripOsPackageOperation(
    original,
    "continue",
    cantripOsPackageAccountKey(),
  );
  expect(mocks.grant).toHaveBeenCalledWith(
    expect.objectContaining({
      workerId: target.workerId,
      components: ["repository-content"],
    }),
  );
  expect(mocks.refresh).toHaveBeenCalledWith(target.workerId, {
    component: "repository-content",
    keyRevision: 1,
  });
  expect(mocks.request.mock.calls.at(-1)!.slice(0, 2)).toEqual([
    `/api/cantrip-os/${instance.id}/package-operations/${original.operationId}/continue`,
    {
      method: "POST",
      body: JSON.stringify({
        attachmentGeneration: original.attachmentGeneration,
        targetGeneration: original.targetGeneration,
      }),
    },
  ]);
});
it("does not dispatch a control if the account changes during real key authorization", async () => {
  const value = summary(),
    account = cantripOsPackageAccountKey();
  mocks.grant.mockImplementationOnce(async () => {
    mocks.identity = { ...mocks.identity, userId: "other", generation: 2 };
  });
  await expect(
    controlCantripOsPackageOperation(value, "abandon", account),
  ).rejects.toThrow("changed during package authorization");
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
});
