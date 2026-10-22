import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ deleteChat: vi.fn(), interruptChat: vi.fn() }));
vi.mock("@/lib/api", () => api);

import { CantripApiError } from "./api-client";
import { removeAgentChat } from "./remove-agent-chat";

const stillRunning = () =>
  new CantripApiError("Stop the running chat first.", 409);

describe("agent tab removal", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it("removes idle agents without interrupting", async () => {
    await removeAgentChat("idle", false);
    expect(api.interruptChat).not.toHaveBeenCalled();
    expect(api.deleteChat).toHaveBeenCalledExactlyOnceWith("idle");
  });

  it("waits for interruption before attempting removal", async () => {
    let finish!: () => void;
    api.interruptChat.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const removal = removeAgentChat("running", true);
    expect(api.interruptChat).toHaveBeenCalledExactlyOnceWith("running");
    expect(api.deleteChat).not.toHaveBeenCalled();
    finish();
    await removal;
    expect(api.deleteChat).toHaveBeenCalledExactlyOnceWith("running");
  });

  it("retries removal while the stopped turn is still settling", async () => {
    vi.useFakeTimers();
    api.deleteChat
      .mockRejectedValueOnce(stillRunning())
      .mockResolvedValue(undefined);
    const removal = removeAgentChat("running", true);
    await vi.runAllTimersAsync();
    await removal;
    expect(api.deleteChat).toHaveBeenCalledTimes(2);
    expect(api.interruptChat).toHaveBeenCalledOnce();
  });

  it("does not remove the tab when interruption fails", async () => {
    api.interruptChat.mockRejectedValue(new Error("Worker unavailable"));
    await expect(removeAgentChat("running", true)).rejects.toThrow(
      "Worker unavailable",
    );
    expect(api.deleteChat).not.toHaveBeenCalled();
  });

  it("surfaces unrelated conflicts without retrying", async () => {
    api.deleteChat.mockRejectedValue(
      new CantripApiError("Account changed", 409),
    );
    await expect(removeAgentChat("running", true)).rejects.toThrow(
      "Account changed",
    );
    expect(api.deleteChat).toHaveBeenCalledOnce();
  });

  it("bounds retries when a turn never stops", async () => {
    vi.useFakeTimers();
    api.deleteChat.mockRejectedValue(stillRunning());
    const failure = expect(removeAgentChat("running", true)).rejects.toThrow(
      "Stop the running chat first.",
    );
    await vi.runAllTimersAsync();
    await failure;
    expect(api.deleteChat).toHaveBeenCalledTimes(51);
  });
});
