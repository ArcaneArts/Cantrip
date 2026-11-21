import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requestManagedHistoryTransfer } from "../src/codex/managed-history-transfer.js";

describe("managed native history transport", () => {
  const input = () => ({
    threadId: "thread",
    transferId: randomUUID(),
    expectedLastTurnId: null,
  });
  it("validates requests before dispatch and rejects mismatched native receipts", async () => {
    const request = vi.fn(async () => ({
      threadId: "wrong",
      path: "/private/transfer",
    }));
    await expect(
      requestManagedHistoryTransfer(
        request,
        () => "runtime",
        "thread/managedHistory/export",
        input(),
      ),
    ).rejects.toThrow("another conversation");
    request.mockClear();
    await expect(
      requestManagedHistoryTransfer(
        request,
        () => "runtime",
        "thread/managedHistory/import",
        {
          threadId: "thread",
          transferId: randomUUID(),
          path: "relative",
        },
      ),
    ).rejects.toThrow("absolute artifact path");
    expect(request).not.toHaveBeenCalled();
  });
  it("surfaces actual native errors without capability or readiness guesses", async () => {
    const nativeError = new Error("actual native active turn");
    const request = vi.fn().mockRejectedValue(nativeError);
    await expect(
      requestManagedHistoryTransfer(
        request,
        () => null,
        "thread/managedHistory/export",
        input(),
      ),
    ).rejects.toBe(nativeError);
    expect(request).toHaveBeenCalledOnce();
  });
  it("keeps an operation uncertain after a transport change or cancellation during dispatch", async () => {
    let generation = "one";
    const request = vi.fn(async () => {
      generation = "two";
      return { threadId: "thread", path: "/private/transfer" };
    });
    await expect(
      requestManagedHistoryTransfer(
        request,
        () => generation,
        "thread/managedHistory/export",
        input(),
      ),
    ).rejects.toThrow("reconcile the same transfer ID");
    const abort = new AbortController();
    await expect(
      requestManagedHistoryTransfer(
        async () => {
          abort.abort(new Error("cancelled during export"));
          return { threadId: "thread", path: "/private/transfer" };
        },
        () => generation,
        "thread/managedHistory/export",
        input(),
        abort.signal,
      ),
    ).rejects.toThrow("cancelled during export");
  });
});
