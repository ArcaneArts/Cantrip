import { beforeEach, expect, it, vi } from "vitest";
import type { CantripOsSourceBindingSummary } from "@cantrip/protocol";
const identity = {
  accountId: "owner",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverId: "server",
  serverUrl: null,
  userId: "owner",
};
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  protect: vi.fn(),
  grant: vi.fn(),
  workers: vi.fn(),
  matches: vi.fn(),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  request: mocks.request,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => identity,
  clientSessionIdentityMatches: mocks.matches,
}));
vi.mock("@/lib/repository-worker-encryption", () => ({
  ensureRepositoryWorkerEncryption: mocks.grant,
}));
vi.mock("@/lib/repository-operation-encryption", () => ({
  protectRepositoryOperationContent: mocks.protect,
}));
vi.mock("./worker-wire", () => ({
  getWorkers: mocks.workers,
  refreshWorkerEncryption: vi.fn(),
}));
import {
  prepareCantripOsProvision,
  recoverCantripOsBinding,
  createCantripOsWorkspace,
  getCantripOsInstances,
} from "./cantrip-os";
const operation = {
  operationId: "00000000-0000-4000-8000-000000000005",
  state: "unknown",
  error: "Response lost",
  receipt: null,
  startedAt: "2026-11-04T00:00:00.000Z",
  updatedAt: "2026-11-04T00:00:00.000Z",
};
const binding = {
  id: "binding",
  projectId: "project/id",
  worktreeId: "tree",
  workerId: "worker",
  instanceId: "instance",
  workspaceId: "workspace",
  bindingGeneration: "generation",
} as CantripOsSourceBindingSummary;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.matches.mockReturnValue(true);
  mocks.workers.mockResolvedValue([{ workerId: "worker" }]);
  mocks.protect.mockResolvedValue({ ciphertext: "opaque" });
});
it("seals provisioning once and retains the identical admission after response loss", async () => {
  const intent = {
    mode: "linux-owned" as const,
    source: { kind: "folder" as const },
  };
  const provision = await prepareCantripOsProvision(binding, intent);
  mocks.request.mockRejectedValueOnce(new TypeError("response lost"));
  await expect(provision()).rejects.toThrow("response lost");
  mocks.request.mockResolvedValue(operation);
  await expect(provision()).resolves.toEqual(operation);
  expect(mocks.request.mock.calls[0]).toEqual(mocks.request.mock.calls[1]);
  expect(mocks.request.mock.calls[0]![0]).toBe(
    "/api/projects/project%2Fid/cantrip-os/bindings/binding/provision",
  );
  expect(mocks.request.mock.calls[0]![2]).toEqual({
    expectedIdentity: identity,
    allowCsrfRecovery: false,
  });
  const body = JSON.parse(mocks.request.mock.calls[0]![1].body);
  expect(body).toEqual({
    operationId: expect.any(String),
    bindingGeneration: "generation",
    protectedRequest: { ciphertext: "opaque" },
  });
  expect(mocks.protect).toHaveBeenCalledExactlyOnceWith({
    context: {
      projectId: "project/id",
      worktreeId: "tree",
      operationId: body.operationId,
      direction: "request",
    },
    schema: expect.anything(),
    content: {
      type: "cantrip-os.source.provision",
      instanceId: "instance",
      workspaceId: "workspace",
      bindingId: "binding",
      bindingGeneration: "generation",
      intent,
    },
  });
  expect(mocks.grant).toHaveBeenCalledTimes(1);
});
it("rejects an account change during preparation before dispatching any mutation", async () => {
  mocks.protect.mockImplementation(async () => {
    mocks.matches.mockReturnValue(false);
    return { ciphertext: "opaque" };
  });
  await expect(
    prepareCantripOsProvision(binding, {
      mode: "linux-owned",
      source: { kind: "folder" },
    }),
  ).rejects.toThrow("account or server changed");
  expect(mocks.request).not.toHaveBeenCalled();
});
it("observes existing admissions without creating another operation", async () => {
  mocks.request.mockResolvedValue(operation);
  await expect(
    recoverCantripOsBinding("project/id", "binding/id"),
  ).resolves.toEqual(operation);
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
    "/api/projects/project%2Fid/cantrip-os/bindings/binding%2Fid/recover",
    { method: "POST", body: "{}" },
    { expectedIdentity: identity, allowCsrfRecovery: false },
  );
  expect(mocks.protect).not.toHaveBeenCalled();
});
it("preserves an explicit workspace operation identity", async () => {
  mocks.request.mockResolvedValue(operation);
  await createCantripOsWorkspace("instance/id", {
    guestWorkspaceId: "work",
    operationId: operation.operationId,
  });
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual({
    guestWorkspaceId: "work",
    operationId: operation.operationId,
  });
});
it("validates actual server data rather than accepting a partial instance", async () => {
  mocks.request.mockResolvedValue([{ id: "incomplete" }]);
  await expect(getCantripOsInstances()).rejects.toThrow();
});
