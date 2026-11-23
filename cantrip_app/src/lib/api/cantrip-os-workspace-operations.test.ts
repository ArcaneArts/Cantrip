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
  prepareCantripOsWorkspaceCreateDraft,
  saveCantripOsWorkspaceCreateDraft,
  readCantripOsWorkspaceCreateDraft,
  clearCantripOsWorkspaceCreateDraft,
  cantripOsWorkspaceCreateAccountKey,
} from "@/lib/cantrip-os-workspace-create-draft";
import {
  observeLegacyCantripOsRestoreWorkspace,
  submitCantripOsWorkspaceCreate,
  observeCantripOsWorkspaceCreateDraft,
  getCantripOsWorkspaceOperations,
  observeCantripOsWorkspaceOperation,
} from "./cantrip-os-workspace-operations";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instance = {
  id: id(1),
  workerId: "worker",
  attachmentGeneration: id(2),
  runtimeGeneration: id(3),
} as CantripOsInstanceSummary;
const at = "2026-11-06T00:00:00.000Z";
function fixture() {
  const draft = {
    ...prepareCantripOsWorkspaceCreateDraft(instance, "work"),
    submitted: true,
  };
  const result = {
    operationId: draft.request.operationId,
    state: "ready" as const,
    error: null,
    startedAt: at,
    updatedAt: at,
    receipt: {
      kind: "workspace" as const,
      workspace: {
        guestWorkspaceId: "work",
        uid: 20000,
        gid: 20000,
        homeGuestPath: "/homes/work",
      },
    },
  };
  const summary = {
    ...draft.target,
    guestWorkspaceId: "work",
    operationId: draft.request.operationId,
    state: "ready" as const,
    result,
    createdAt: at,
    updatedAt: at,
  };
  return { draft, result, summary };
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

it("retains exact intent before creation and recovers after reload using observation only", async () => {
  const { draft, result, summary } = fixture();
  saveCantripOsWorkspaceCreateDraft(draft);
  mocks.request.mockRejectedValueOnce(new Error("Lost reply"));
  await expect(submitCantripOsWorkspaceCreate(draft)).rejects.toThrow(
    "Lost reply",
  );
  expect(JSON.parse(mocks.request.mock.calls[0]![1].body)).toEqual(
    draft.request,
  );
  expect(mocks.request.mock.calls[0]![2]).toMatchObject({
    allowCsrfRecovery: false,
    expectedIdentity: mocks.identity,
  });
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toEqual(draft);
  mocks.request
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(summary);
  expect(
    await observeCantripOsWorkspaceCreateDraft(
      readCantripOsWorkspaceCreateDraft(instance.id)!,
    ),
  ).toEqual(summary);
  const routes = mocks.request.mock.calls.slice(1).map((call) => call[0]);
  expect(routes).toEqual([
    `/api/cantrip-os/${instance.id}/workspace-operations/${draft.request.operationId}`,
    `/api/cantrip-os/${instance.id}/workspace-operations/${draft.request.operationId}/observe`,
    `/api/cantrip-os/${instance.id}/workspace-operations/${draft.request.operationId}`,
  ]);
  expect(
    mocks.request.mock.calls.filter((call) => call[0].endsWith("/workspaces")),
  ).toHaveLength(1);
});
it("requires retained submission and verifies the Server's exact frozen destination", async () => {
  const { draft, result, summary } = fixture();
  await expect(
    submitCantripOsWorkspaceCreate({ ...draft, submitted: false }),
  ).rejects.toThrow("Retain");
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({ ...summary, runtimeGeneration: id(9) });
  await expect(submitCantripOsWorkspaceCreate(draft)).rejects.toThrow(
    "misrouted",
  );
});
it("rejects misrouted original summaries before sending any observation", async () => {
  const { draft, summary } = fixture();
  for (const key of [
    "instanceId",
    "workerId",
    "attachmentGeneration",
    "runtimeGeneration",
    "guestWorkspaceId",
    "operationId",
  ] as const) {
    mocks.request.mockReset();
    mocks.request.mockResolvedValueOnce({
      ...summary,
      [key]:
        key === "guestWorkspaceId"
          ? "wrong"
          : key === "workerId"
            ? "other"
            : id(9),
    });
    await expect(observeCantripOsWorkspaceCreateDraft(draft)).rejects.toThrow(
      "misrouted",
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
  }
});
it("rejects wrong operation and account receipts", async () => {
  const { draft, result } = fixture();
  mocks.request.mockResolvedValueOnce({ ...result, operationId: id(9) });
  await expect(submitCantripOsWorkspaceCreate(draft)).rejects.toThrow(
    "receipt",
  );
  mocks.request.mockResolvedValueOnce({
    ...result,
    receipt: {
      ...result.receipt,
      workspace: { ...result.receipt.workspace, guestWorkspaceId: "wrong" },
    },
  });
  await expect(submitCantripOsWorkspaceCreate(draft)).rejects.toThrow(
    "receipt",
  );
});
it("isolates saved requests by Server, account and instance and preserves them after identity change", async () => {
  const { draft } = fixture();
  saveCantripOsWorkspaceCreateDraft(draft);
  expect(readCantripOsWorkspaceCreateDraft(id(9))).toBeNull();
  for (const key of [
    "userId",
    "serverId",
    "serverUrl",
    "connectionId",
  ] as const) {
    const previous = mocks.identity[key];
    mocks.identity[key] = "other";
    expect(readCantripOsWorkspaceCreateDraft(instance.id)).toBeNull();
    await expect(submitCantripOsWorkspaceCreate(draft)).rejects.toThrow(
      "changed",
    );
    expect(() =>
      clearCantripOsWorkspaceCreateDraft(instance.id, draft.accountKey),
    ).toThrow("changed");
    mocks.identity[key] = previous;
    expect(readCantripOsWorkspaceCreateDraft(instance.id)).toEqual(draft);
  }
  expect(mocks.request).not.toHaveBeenCalled();
});
it("does not follow an account switch between reading admission and observing it", async () => {
  const { draft, summary } = fixture();
  mocks.request.mockImplementationOnce(async () => {
    mocks.identity.userId = "other";
    return summary;
  });
  await expect(observeCantripOsWorkspaceCreateDraft(draft)).rejects.toThrow(
    "changed",
  );
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
it("paginates owned history and observes its captured operation", async () => {
  const { result, summary } = fixture(),
    account = cantripOsWorkspaceCreateAccountKey();
  mocks.request.mockResolvedValueOnce({ items: [summary], nextCursor: id(9) });
  expect(
    (await getCantripOsWorkspaceOperations(instance.id, id(8), account))
      .nextCursor,
  ).toBe(id(9));
  expect(mocks.request.mock.calls[0]![0]).toContain(`cursor=${id(8)}`);
  mocks.request
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(summary);
  expect(await observeCantripOsWorkspaceOperation(summary, account)).toEqual(
    summary,
  );
  mocks.request.mockResolvedValueOnce({
    items: [{ ...summary, instanceId: id(9) }],
    nextCursor: null,
  });
  await expect(
    getCantripOsWorkspaceOperations(instance.id, undefined, account),
  ).rejects.toThrow("misrouted");
});
it("rejects corrupted or mismatched retained intent and clears only the local request", () => {
  const { draft } = fixture();
  expect(() =>
    saveCantripOsWorkspaceCreateDraft({
      ...draft,
      request: { ...draft.request, runtimeGeneration: id(9) },
    }),
  ).toThrow("differs");
  saveCantripOsWorkspaceCreateDraft(draft);
  clearCantripOsWorkspaceCreateDraft(instance.id, draft.accountKey);
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toBeNull();
  expect(mocks.request).not.toHaveBeenCalled();
});

it("requires a verified terminal outcome before accepting history completion", async () => {
  const { summary } = fixture();
  mocks.request.mockResolvedValueOnce({
    items: [{ ...summary, result: null }],
    nextCursor: null,
  });
  await expect(
    getCantripOsWorkspaceOperations(
      instance.id,
      undefined,
      cantripOsWorkspaceCreateAccountKey(),
    ),
  ).rejects.toThrow("verified receipt");
});

it("observes a legacy restore creation through its original owned admission without a create POST", async () => {
  const { summary, result } = fixture();
  mocks.request
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(summary)
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce(summary);
  expect(
    await observeLegacyCantripOsRestoreWorkspace({
      instanceId: summary.instanceId,
      operationId: summary.operationId,
      guestWorkspaceId: summary.guestWorkspaceId,
      attachmentGeneration: summary.attachmentGeneration,
    }),
  ).toEqual(summary);
  const posts = mocks.request.mock.calls.filter(
    (call) => call[1]?.method === "POST",
  );
  expect(posts).toHaveLength(1);
  expect(posts[0]![0]).toMatch(/\/observe$/);
  expect(posts[0]![1].body).toBeUndefined();
});
it("keeps unavailable or changed legacy restore creation uncertain without a replacement mutation", async () => {
  const { summary } = fixture();
  const plan = {
    instanceId: summary.instanceId,
    operationId: summary.operationId,
    guestWorkspaceId: summary.guestWorkspaceId,
    attachmentGeneration: summary.attachmentGeneration,
  };
  mocks.request.mockRejectedValueOnce(
    new Error("Original admission unavailable"),
  );
  await expect(observeLegacyCantripOsRestoreWorkspace(plan)).rejects.toThrow(
    "unavailable",
  );
  mocks.request.mockResolvedValueOnce({
    ...summary,
    attachmentGeneration: id(30),
  });
  await expect(observeLegacyCantripOsRestoreWorkspace(plan)).rejects.toThrow(
    "saved destination",
  );
  expect(
    mocks.request.mock.calls.some((call) => call[1]?.method === "POST"),
  ).toBe(false);
});
