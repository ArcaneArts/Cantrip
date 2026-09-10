import { beforeEach, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({ request: transport }));
import {
  readRuntimeHandoffs,
  startRuntimeHandoff,
  controlRuntimeHandoff,
} from "./native-runtime-handoff";
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: null,
};
const scope = { chatId: "chat", identity };
const binding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "core",
  contextKind: "project",
  projectId: "project",
  placementId: "placement",
  modelRouteId: "source",
  providerAccountId: null,
};
const input = {
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  bindingId: "binding",
  targetModelRouteId: "target",
  targetProviderAccountId: "account-b",
};
const state = {
  operationId: input.operationId,
  targetModelRouteId: input.targetModelRouteId,
  targetProviderAccountId: input.targetProviderAccountId,
  chatId: "chat",
  workerId: "worker",
  source: binding,
  binding,
  phase: "preparing",
  prepared: null,
  errorCode: null,
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
};
beforeEach(() => transport.mockReset());
it("sends the exact operation and destination under the captured authenticated identity", async () => {
  transport.mockResolvedValue(state);
  await startRuntimeHandoff(scope, input);
  expect(transport.mock.calls[0]).toEqual([
    "/api/chats/chat/runtime-handoffs",
    { method: "POST", body: JSON.stringify(input) },
    { expectedIdentity: identity },
  ]);
  await controlRuntimeHandoff(scope, input.operationId, "retry");
  expect(transport.mock.calls[1]![0]).toBe(
    `/api/chats/chat/runtime-handoffs/${input.operationId}/retry`,
  );
});
it.each([
  { chatId: "another-chat" },
  { operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  { source: { ...binding, bindingId: "another-binding" } },
  { targetProviderAccountId: "another-account" },
  { targetModelRouteId: "another-route" },
])("rejects a mismatched start receipt %j", async (patch) => {
  transport.mockResolvedValue({ ...state, ...patch });
  await expect(startRuntimeHandoff(scope, input)).rejects.toThrow(
    "does not match",
  );
});
it("rejects inventory from another chat even when its outer chat ID matches", async () => {
  transport.mockResolvedValue({
    chatId: "chat",
    binding,
    latest: { ...state, chatId: "another-chat" },
    providers: [],
  });
  await expect(readRuntimeHandoffs(scope)).rejects.toThrow("another chat");
});
it("rejects a cancellation response for another operation", async () => {
  transport.mockResolvedValue({
    ...state,
    operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  await expect(
    controlRuntimeHandoff(scope, input.operationId, "cancel"),
  ).rejects.toThrow("another operation");
});
