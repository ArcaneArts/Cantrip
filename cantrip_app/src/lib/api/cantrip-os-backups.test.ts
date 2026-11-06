import { beforeEach, expect, it, vi } from "vitest";
import {
  cantripOsBackupRequestEnvelopeSchema,
  cantripOsBackupSummarySchema,
  type CantripOsInstanceSummary,
} from "@cantrip/protocol";
const ids = Array.from(
  { length: 6 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const identity = { userId: "owner", serverId: "server", generation: 1 };
const snapshot = {
  status: "ready",
  identity: { ownerId: "owner", serverId: "server" },
  masterKeyRevision: 3,
};
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  protect: vi.fn(),
  openRequest: vi.fn(),
  openResult: vi.fn(),
  authorize: vi.fn(),
  refresh: vi.fn(),
  matches: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  request: mocks.request,
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => identity,
  clientSessionIdentityMatches: mocks.matches,
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: { getSnapshot: mocks.snapshot },
}));
vi.mock("@/lib/worker-encryption-grants", () => ({
  authorizeWorkerEncryption: mocks.authorize,
}));
vi.mock("@/lib/cantrip-os-backup-encryption", () => ({
  protectCantripOsBackupRequest: mocks.protect,
  openCantripOsBackupRequest: mocks.openRequest,
  openCantripOsBackupResult: mocks.openResult,
}));
vi.mock("./worker-wire", () => ({ refreshWorkerEncryption: mocks.refresh }));
import {
  prepareCantripOsBackup,
  submitCantripOsBackup,
  getCantripOsBackupOperation,
  getCantripOsBackupOperations,
  recoverCantripOsBackup,
  openCantripOsBackupDetails,
} from "./cantrip-os-backups";
const frame = cantripOsBackupRequestEnvelopeSchema.parse({
  kind: "metadata",
  sequence: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 3,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
});
const instance = {
  id: ids[0],
  workerId: "worker",
  attachmentGeneration: ids[2],
  runtimeGeneration: ids[3],
} as CantripOsInstanceSummary;
const intent = {
  action: "capture" as const,
  workspaceId: ids[1]!,
  label: "private",
  exclusions: ["cache"],
};
function summary(operationId = ids[4]!) {
  return cantripOsBackupSummarySchema.parse({
    operationId,
    action: "capture",
    instanceId: ids[0],
    workspaceId: ids[1],
    workerId: "worker",
    backupId: null,
    restoreOperationId: null,
    protectedRequest: frame,
    result: null,
    workerConnected: false,
    archiveAvailability: "worker-offline",
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.matches.mockReturnValue(true);
  mocks.snapshot.mockReturnValue(snapshot);
  mocks.protect.mockResolvedValue(frame);
  mocks.openRequest.mockResolvedValue(intent);
});
it("seals once, refreshes actual Worker grants and reuses the exact admission after a lost reply", async () => {
  const admission = await prepareCantripOsBackup(instance, intent, ids[4]);
  expect(mocks.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      workerId: "worker",
      keyRevision: 3,
      components: ["repository-content"],
    }),
  );
  expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("worker", {
    component: "repository-content",
    keyRevision: 3,
  });
  mocks.request
    .mockRejectedValueOnce(new TypeError("reply lost"))
    .mockResolvedValueOnce(summary());
  await expect(submitCantripOsBackup(instance.id, admission)).rejects.toThrow(
    "reply lost",
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
  await expect(submitCantripOsBackup(instance.id, admission)).resolves.toEqual(
    summary(),
  );
  expect(mocks.request.mock.calls[0]).toEqual(mocks.request.mock.calls[1]);
  expect(mocks.request.mock.calls[0]![2]).toEqual({
    expectedIdentity: identity,
    allowCsrfRecovery: false,
  });
  expect(mocks.request.mock.calls[0]![1].body).not.toContain("private");
  expect(mocks.protect).toHaveBeenCalledOnce();
});
it("blocks changed client authority before admitting an operation and reports real refresh errors", async () => {
  mocks.refresh.mockRejectedValueOnce(new Error("actual Worker disconnected"));
  await expect(prepareCantripOsBackup(instance, intent)).rejects.toThrow(
    "actual Worker disconnected",
  );
  expect(mocks.protect).not.toHaveBeenCalled();
  mocks.refresh.mockImplementation(async () => {
    mocks.matches.mockReturnValue(false);
  });
  await expect(prepareCantripOsBackup(instance, intent)).rejects.toThrow(
    "account or server changed",
  );
  expect(mocks.request).not.toHaveBeenCalled();
});
it("loads history without contacting the offline Worker and rejects misrouted observations", async () => {
  mocks.request.mockResolvedValueOnce({
    items: [summary()],
    nextCursor: ids[4],
  });
  expect(
    (await getCantripOsBackupOperations(ids[5])).items[0]?.archiveAvailability,
  ).toBe("worker-offline");
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.request.mock.calls[0]![0]).toContain(`cursor=${ids[5]}`);
  mocks.request.mockResolvedValueOnce(summary(ids[5]));
  await expect(getCantripOsBackupOperation(ids[4]!)).rejects.toThrow(
    "misrouted",
  );
});
it("requires both fresh generation pins for continuation and never substitutes another operation", async () => {
  await expect(
    recoverCantripOsBackup(summary(), { mode: "continue" } as never),
  ).rejects.toThrow();
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request.mockResolvedValueOnce(summary(ids[5]));
  await expect(
    recoverCantripOsBackup(summary(), {
      mode: "continue",
      attachmentGeneration: ids[2]!,
      runtimeGeneration: ids[3]!,
    }),
  ).rejects.toThrow("misrouted");
});
it("does not turn protected errors or mismatched private intents into successful backups", async () => {
  const entry = summary();
  mocks.openRequest.mockResolvedValueOnce({ ...intent, workspaceId: ids[5] });
  await expect(openCantripOsBackupDetails(entry)).rejects.toThrow("differs");
  const ready = {
    ...entry,
    result: {
      state: "ready",
      action: "capture",
      operationId: ids[4],
      protectedResult: { ...frame, sequence: 2 },
    },
  } as never;
  mocks.openResult.mockResolvedValueOnce({
    action: "error",
    operationAction: "capture",
    message: "private failure",
  });
  await expect(openCantripOsBackupDetails(ready)).rejects.toThrow(
    "no authenticated successful outcome",
  );
});
