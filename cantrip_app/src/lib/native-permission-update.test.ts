import { describe, expect, it, vi } from "vitest";
const call = vi.hoisted(() => vi.fn());
vi.mock("./api-client", () => ({
  request: call,
  CantripApiError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
import { CantripApiError } from "./api-client";
import {
  sendNativePermissionUpdate,
  nativePermissionUpdateRejected,
} from "./native-permission-update";
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: null,
};
const request = {
  id: null,
  bindingId: "binding",
  operationId: "stable-op",
  expectedRevision: "7",
};
describe("bound permission transport", () => {
  it("preserves nullable preference, binding and operation identity and queued outcome", async () => {
    call.mockResolvedValue({
      operationId: "stable-op",
      submissionId: "submission",
      status: "queued",
    });
    expect(
      (await sendNativePermissionUpdate({ chatId: "chat", identity, request }))
        .status,
    ).toBe("queued");
    expect(JSON.parse(call.mock.calls.at(-1)![1].body)).toEqual(request);
    expect(call.mock.calls.at(-1)).toEqual([
      "/api/chats/chat/permission-profile",
      { method: "PATCH", body: expect.any(String), signal: undefined },
      { expectedIdentity: identity },
    ]);
  });
  it("does not accept another operation or a bootstrap preference response as application evidence", async () => {
    call.mockResolvedValue({
      operationId: "another-op",
      submissionId: null,
      status: "applied",
    });
    await expect(
      sendNativePermissionUpdate({ chatId: "chat", identity, request }),
    ).rejects.toThrow("another operation");
    call.mockResolvedValue({ selectedId: ":yolo", effectiveId: ":yolo" });
    await expect(
      sendNativePermissionUpdate({ chatId: "chat", identity, request }),
    ).rejects.toThrow();
  });
  it("classifies only known deterministic native admission rejections", () => {
    expect(
      nativePermissionUpdateRejected(
        new CantripApiError("pending", 409, "permission-transition-pending"),
      ),
    ).toBe(true);
    expect(
      nativePermissionUpdateRejected(
        new CantripApiError("lost", 504, "worker-timeout"),
      ),
    ).toBe(false);
    expect(nativePermissionUpdateRejected(new Error("fetch failed"))).toBe(
      false,
    );
  });
});
