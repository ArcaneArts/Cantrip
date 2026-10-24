import { generateAccountMasterKey } from "@cantrip/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEncryptionService } from "./client-encryption";
import { createWorkspaceTransferChannel } from "./workspace-transfer-channel";
import { encryptWorkspaceTransfer } from "./workspace-transfer-encryption";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});
function pair(restore = vi.fn(async (_bytes: Uint8Array) => {})) {
  const key = generateAccountMasterKey();
  const binding = {
    serverId: "server",
    ownerId: "owner",
    projectId: "project",
    workspaceId: "workspace",
    transferId: crypto.randomUUID(),
    sourceWindowId: "main",
    sourceGeneration: 1,
    destinationWindowId: "destination",
    destinationGeneration: 0,
  };
  const services = [
    new ClientEncryptionService(),
    new ClientEncryptionService(),
  ] as const;
  for (const service of services)
    service.setAccountMasterKey({
      accountMasterKey: key,
      identity: binding,
      masterKeyRevision: 1,
    });
  const name = `test-${binding.transferId}`;
  const sourcePort = new BroadcastChannel(name);
  const destinationPort = new BroadcastChannel(name);
  const sourceMessages = vi.spyOn(sourcePort, "postMessage");
  const destinationMessages = vi.spyOn(destinationPort, "postMessage");
  const ready = vi.fn();
  const restored = vi.fn();
  const sourceError = vi.fn();
  const destinationError = vi.fn();
  const source = createWorkspaceTransferChannel({
    binding,
    service: services[0],
    port: sourcePort,
    side: "source",
    onReady: ready,
    onRestored: restored,
    onError: sourceError,
  });
  const destination = createWorkspaceTransferChannel({
    binding,
    service: services[1],
    port: destinationPort,
    side: "destination",
    restore,
    onError: destinationError,
  });
  cleanup.push(source.dispose, destination.dispose);
  return {
    source,
    destination,
    ready,
    restored,
    sourceError,
    destinationError,
    restore,
    sourceMessages,
    destinationMessages,
    services,
    binding,
    destinationPort,
  };
}

describe("encrypted workspace transfer channel", () => {
  it("requires explicit application readiness and acknowledges only after restore completes", async () => {
    let finish!: () => void;
    let retained: Uint8Array | undefined;
    let captured: Uint8Array | undefined;
    const restore = vi.fn(async (bytes: Uint8Array) => {
      retained = bytes;
      captured = new Uint8Array(bytes);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const p = pair(restore);
    const bytes = new TextEncoder().encode("secret dirty draft");
    await expect(p.source.sendSnapshot(bytes)).rejects.toThrow(/readiness/);
    expect(p.ready).not.toHaveBeenCalled();
    await p.destination.announceReady();
    await vi.waitFor(() => expect(p.ready).toHaveBeenCalledTimes(1));
    await p.source.sendSnapshot(bytes);
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(p.restored).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(p.restored).toHaveBeenCalledTimes(1));
    expect(captured).toEqual(bytes);
    expect(retained).toEqual(new Uint8Array(bytes.length));
    expect(JSON.stringify(p.sourceMessages.mock.calls)).not.toContain(
      "secret dirty draft",
    );
    expect(p.sourceError).not.toHaveBeenCalled();
    expect(p.destinationError).not.toHaveBeenCalled();
  });

  it("re-acknowledges the same snapshot without restoring twice or duplicating callbacks", async () => {
    const p = pair();
    await p.destination.announceReady();
    await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
    await p.source.sendSnapshot(new Uint8Array([2, 3]));
    await vi.waitFor(() => expect(p.restored).toHaveBeenCalledOnce());
    p.source.resendSnapshot();
    await p.destination.announceReady();
    await vi.waitFor(() =>
      expect(
        p.destinationMessages.mock.calls.filter(
          ([packet]) => packet.kind === "restored",
        ),
      ).toHaveLength(2),
    );
    expect(p.restore).toHaveBeenCalledOnce();
    expect(p.restored).toHaveBeenCalledOnce();
    expect(p.ready).toHaveBeenCalledOnce();
    await expect(p.source.sendSnapshot(new Uint8Array([4]))).rejects.toThrow(
      /already prepared/,
    );
  });

  it("rejects a failed restore at the source and never reinstalls that failed snapshot", async () => {
    const p = pair(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("private document restore failed"))
        .mockResolvedValue(undefined),
    );
    await p.destination.announceReady();
    await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
    await p.source.sendSnapshot(new Uint8Array([2]));
    await vi.waitFor(() => expect(p.destinationError).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(p.sourceError).toHaveBeenCalledOnce());
    expect(p.sourceError.mock.calls[0]?.[0].message).toMatch(
      /could not restore/,
    );
    expect(p.restored).not.toHaveBeenCalled();
    p.source.resendSnapshot();
    await vi.waitFor(() =>
      expect(
        p.destinationMessages.mock.calls.filter(
          ([packet]) => packet.kind === "rejected",
        ),
      ).toHaveLength(2),
    );
    expect(p.restore).toHaveBeenCalledOnce();
    expect(p.restored).not.toHaveBeenCalled();
    expect(p.sourceError).toHaveBeenCalledOnce();
    expect(JSON.stringify(p.destinationMessages.mock.calls)).not.toContain(
      "private document",
    );
  });

  it("ignores an authenticated rejection for a different snapshot nonce", async () => {
    let finish!: () => void;
    const p = pair(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await p.destination.announceReady();
    await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
    await p.source.sendSnapshot(new Uint8Array([2]));
    await vi.waitFor(() => expect(p.restore).toHaveBeenCalledOnce());
    p.destinationPort.postMessage({
      kind: "rejected",
      envelope: await encryptWorkspaceTransfer(
        { ...p.binding, purpose: "rejected" },
        new TextEncoder().encode("not-the-current-snapshot"),
        p.services[1],
      ),
    });
    finish();
    await vi.waitFor(() => expect(p.restored).toHaveBeenCalledOnce());
    expect(p.sourceError).not.toHaveBeenCalled();
  });

  it("closes on account lock and suppresses an acknowledgement from an in-flight restore", async () => {
    let finish!: () => void;
    const p = pair(
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await p.destination.announceReady();
    await vi.waitFor(() => expect(p.ready).toHaveBeenCalledOnce());
    await p.source.sendSnapshot(new Uint8Array([1]));
    await vi.waitFor(() => expect(p.restore).toHaveBeenCalledOnce());
    p.services[1].lock();
    finish();
    await expect(p.destination.announceReady()).rejects.toThrow(/closed/);
    expect(p.destinationError).toHaveBeenCalledOnce();
    expect(
      p.destinationMessages.mock.calls.some(
        ([packet]) => packet.kind === "restored",
      ),
    ).toBe(false);
    expect(p.restored).not.toHaveBeenCalled();
    p.source.dispose();
    expect(() => p.source.resendSnapshot()).toThrow(/closed/);
  });
});
