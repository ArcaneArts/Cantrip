import { EventEmitter } from "node:events";
import type { EncryptedAgentInteractionRequest } from "@cantrip/protocol";
import type { CuaApprovalRequestEvent } from "@cantrip/protocol/computer-use-preview";
import { describe, expect, it, vi } from "vitest";
import { applyComputerUseAgentEvent } from "../src/app/runtime/computer-use-agent-events.js";
import { WorkerBridge } from "../src/workers/bridge.js";

const requestKey = "00000000-0000-4000-8000-000000000001";
function approval(): CuaApprovalRequestEvent {
  return {
    type: "computer-use.approval.request",
    operationId: requestKey,
    request: {
      requestKey,
      projectId: "project",
      provenance: {
        owner: "computer-use",
        chatId: "chat",
        workerId: "worker",
        executionLaneId: "lane",
        threadId: "child",
        turnId: "child-turn",
        itemId: null,
      },
      classification: { kind: "permissions" },
      protectedPayload: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12).toString("base64url"),
          ciphertext: Buffer.alloc(16).toString("base64url"),
        },
      },
      expiresAt: "2030-09-01T00:00:00.000Z",
    },
  };
}
const terminal = {
  type: "computer-use.approval.terminal" as const,
  chatId: "chat",
  requestKey,
  status: "interrupted" as const,
};
function fixture() {
  const record = vi.fn(
    async (request: CuaApprovalRequestEvent["request"]) =>
      ({ ...request, id: requestKey }) as EncryptedAgentInteractionRequest,
  );
  const terminalize = vi.fn(async () => null);
  const lookup = vi.fn(
    async () =>
      ({
        ...approval().request,
        id: requestKey,
      }) as EncryptedAgentInteractionRequest,
  );
  return {
    ownerId: "owner",
    workerId: "worker",
    chatId: "chat",
    projectId: "project",
    executionLaneId: "lane",
    record,
    terminalize,
    lookup,
  };
}

describe("managed CUA durable events", () => {
  it("persists the exact protected computer-use request including child attribution", async () => {
    const f = fixture();
    const event = approval();
    expect(await applyComputerUseAgentEvent({ ...f, event })).toBe(true);
    expect(f.record).toHaveBeenCalledExactlyOnceWith(event.request);
    expect(f.record.mock.calls[0]?.[0].provenance).toEqual(
      event.request.provenance,
    );
  });

  it.each([
    "owner",
    "chatId",
    "workerId",
    "executionLaneId",
    "threadId",
    "turnId",
  ] as const)("rejects invalid %s without persisting", async (field) => {
    const f = fixture();
    const event = approval();
    Object.assign(event.request.provenance, {
      [field]: field === "threadId" || field === "turnId" ? null : "other",
    });
    await expect(applyComputerUseAgentEvent({ ...f, event })).rejects.toThrow();
    expect(f.record).not.toHaveBeenCalled();
  });

  it("cannot terminalize a Codex-owned request through the CUA stream", async () => {
    const f = fixture();
    f.lookup.mockResolvedValue({
      ...approval().request,
      id: requestKey,
      provenance: { ...approval().request.provenance, owner: "codex" },
    } as EncryptedAgentInteractionRequest);
    await expect(
      applyComputerUseAgentEvent({ ...f, event: terminal }),
    ).rejects.toThrow("terminal");
    expect(f.terminalize).not.toHaveBeenCalled();
  });

  it("real WorkerBridge serializes a terminal and final response behind a delayed durable insert", async () => {
    const f = fixture();
    let finishInsert!: () => void;
    let enteredInsert!: () => void;
    const inserting = new Promise<void>((resolve) => {
      enteredInsert = resolve;
    });
    const insert = new Promise<void>((resolve) => {
      finishInsert = resolve;
    });
    let saved = false;
    f.record.mockImplementation(async (request) => {
      enteredInsert();
      await insert;
      saved = true;
      return { ...request, id: requestKey } as EncryptedAgentInteractionRequest;
    });
    f.lookup.mockImplementation(async () =>
      saved
        ? ({
            ...approval().request,
            id: requestKey,
          } as EncryptedAgentInteractionRequest)
        : null!,
    );
    const bridge = new WorkerBridge();
    const socket = Object.assign(new EventEmitter(), {
      bufferedAmount: 0,
      readyState: 1,
      close() {},
      send(data: string | Uint8Array) {
        const { requestId } = JSON.parse(String(data));
        for (const event of [approval(), terminal])
          socket.emit(
            "message",
            JSON.stringify({ kind: "event", requestId, event }),
          );
        socket.emit(
          "message",
          JSON.stringify({ kind: "response", requestId, ok: true, result: {} }),
        );
      },
    });
    bridge.attach("worker", socket);
    try {
      // The command payload is irrelevant to the response/event queue exercised
      // here; use a valid bounded built-in command through the real transport.
      let complete = false;
      const pending = bridge
        .request(
          "worker",
          { type: "worker.version" },
          {
            onEvent: async (event) => {
              await applyComputerUseAgentEvent({ ...f, event });
            },
          },
        )
        .then(() => {
          complete = true;
        });
      await inserting;
      expect(f.terminalize).not.toHaveBeenCalled();
      expect(complete).toBe(false);
      finishInsert();
      await pending;
      expect(f.terminalize).toHaveBeenCalledExactlyOnceWith(
        requestKey,
        "chat",
        "worker",
        "interrupted",
      );
    } finally {
      await bridge.close();
    }
  });
});
