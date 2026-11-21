import { describe, expect, it, vi } from "vitest";
import type { CuaApprovalRequestEvent } from "@cantrip/protocol/computer-use-preview";
import {
  CuaAgentApprovalEvents,
  type CuaAgentApprovalEvent,
} from "./agent-approval-events.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { resolve, promise };
}
function request(requestKey = "one", chatId = "chat"): CuaApprovalRequestEvent {
  return {
    type: "computer-use.approval.request",
    operationId: "operation",
    request: {
      requestKey,
      provenance: {
        owner: "computer-use",
        chatId,
        workerId: "worker",
        executionLaneId: "lane",
        threadId: "child",
        turnId: "child-turn",
        itemId: null,
      },
    },
  } as CuaApprovalRequestEvent;
}
const terminal = {
  requestKey: "one",
  chatId: "chat",
  status: "interrupted" as const,
};

describe("agent approval command event routing", () => {
  it("orders Stop after the in-flight publication and drains before command completion", async () => {
    const events = new CuaAgentApprovalEvents();
    const gate = deferred();
    const received: string[] = [];
    const emit = vi.fn(async (event: CuaAgentApprovalEvent) => {
      received.push(event.type);
      if (event.type === "computer-use.approval.request") await gate.promise;
    });
    const publish = events.publish(request(), emit);
    await Promise.resolve();
    expect(events.terminal(terminal)).toBe(true);
    expect(events.terminal(terminal)).toBe(true);
    events.finish("one");
    let drained = false;
    const drain = events.drain(emit).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(received).toEqual(["computer-use.approval.request"]);
    gate.resolve();
    await publish;
    await drain;
    expect(received).toEqual([
      "computer-use.approval.request",
      "computer-use.approval.terminal",
    ]);
  });

  it("retains routing when a cancelled caller finishes before its publication", async () => {
    const events = new CuaAgentApprovalEvents();
    const gate = deferred();
    const emit = vi.fn(async (event: CuaAgentApprovalEvent) => {
      if (event.type === "computer-use.approval.request") await gate.promise;
    });
    const pending = events.publish(request(), emit);
    events.finish("one");
    expect(events.terminal(terminal)).toBe(true);
    gate.resolve();
    await pending;
    await events.drain(emit);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith({
      type: "computer-use.approval.terminal",
      ...terminal,
    });
  });

  it("keeps exact child provenance and routes concurrent root/child requests independently", async () => {
    const events = new CuaAgentApprovalEvents();
    const child = vi.fn(async (_event: CuaAgentApprovalEvent) => {});
    const root = vi.fn(async (_event: CuaAgentApprovalEvent) => {});
    const event = request();
    await events.publish(event, child);
    await events.publish(request("two"), root);
    expect(child).toHaveBeenCalledWith(event);
    expect(events.terminal({ ...terminal, chatId: "other" })).toBe(false);
    events.terminal(terminal);
    await events.drain(child);
    expect(root).toHaveBeenCalledTimes(1);
    expect(child).toHaveBeenCalledTimes(2);
    events.finish("one");
    events.finish("two");
  });

  it("reports publication failures and still orders a terminal event for uncertain delivery", async () => {
    const events = new CuaAgentApprovalEvents();
    const emit = vi.fn(async (event: CuaAgentApprovalEvent) => {
      if (event.type === "computer-use.approval.request")
        throw new Error("delivery");
    });
    await expect(events.publish(request(), emit)).rejects.toThrow("delivery");
    expect(events.terminal(terminal)).toBe(true);
    events.finish("one");
    await events.drain(emit);
    expect(emit).toHaveBeenLastCalledWith({
      type: "computer-use.approval.terminal",
      ...terminal,
    });
  });

  it("bounds retained publications without evicting cancelled in-flight sends", async () => {
    const events = new CuaAgentApprovalEvents();
    const gate = deferred();
    const emit = async () => gate.promise;
    const pending = Array.from({ length: 32 }, (_, index) =>
      events.publish(request(String(index)), emit),
    );
    events.finish("0");
    await expect(events.publish(request("overflow"), emit)).rejects.toThrow(
      "unavailable",
    );
    gate.resolve();
    await Promise.all(pending);
    await events.drain(emit);
    await events.publish(request("new"), async () => {});
  });
});
