import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDirectWorkerProbe: vi.fn(),
  deleteDirectAttachment: vi.fn(),
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));
vi.mock("@/lib/api", () => ({
  createDirectWorkerProbe: mocks.createDirectWorkerProbe,
  deleteDirectAttachment: mocks.deleteDirectAttachment,
}));

import { probeDirectWorker } from "./desktop-direct";

const instanceId = "8d0a19a8-26f9-4f20-bff0-87242d1b280c";
const capabilityId = "1c4066d8-5798-4330-82e2-f5634c6176b7";

function ticket() {
  const expiresAt = new Date(Date.now() + 10_000).toISOString();
  return {
    broker: {
      available: true as const,
      protocol: "ws-v1" as const,
      loopbackHost: "127.0.0.1" as const,
      loopbackPort: 43123,
      instanceId,
      publicKey: "a".repeat(43),
      fingerprint: "b".repeat(64),
    },
    binding: {
      capabilityId,
      ownerId: "owner-1",
      authSessionId: "session-1",
      workerId: "worker-1",
      resourceKind: "probe" as const,
      resourceId: "worker-1",
      attachmentId: "attachment-1",
      channels: ["probe"],
      expiresAt,
      leaseExpiresAt: expiresAt,
    },
    secret: "c".repeat(43),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteDirectAttachment.mockResolvedValue(undefined);
});

describe("probeDirectWorker", () => {
  it("falls back without asking the server outside Tauri", async () => {
    mocks.isTauri.mockReturnValue(false);
    await expect(probeDirectWorker("worker-1")).resolves.toMatchObject({
      state: "relayed",
      workerId: "worker-1",
    });
    expect(mocks.createDirectWorkerProbe).not.toHaveBeenCalled();
  });

  it("hands the one-use secret to native code and revokes it afterward", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.createDirectWorkerProbe.mockResolvedValue(ticket());
    mocks.invoke.mockResolvedValue({
      state: "local-direct",
      reason: null,
      latencyMs: 2,
      workerId: "worker-1",
      brokerInstanceId: instanceId,
    });
    const states: string[] = [];
    await expect(
      probeDirectWorker("worker-1", { onState: (state) => states.push(state) }),
    ).resolves.toMatchObject({ state: "local-direct" });
    expect(states).toEqual(["probing", "local-direct"]);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "probe_direct_worker",
      expect.objectContaining({ request: expect.any(Object) }),
    );
    expect(mocks.deleteDirectAttachment).toHaveBeenCalledWith(capabilityId);
  });
});
