import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSettingsEvidence } from "@cantrip/protocol";
import { NativeSettingsDelivery } from "../src/native-settings-delivery.js";
import { openNativeCommandContent } from "../src/native-command-content.js";

const directories: string[] = [];
const deliveries: NativeSettingsDelivery[] = [];
afterEach(async () => {
  await Promise.all(deliveries.splice(0).map((delivery) => delivery.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const scope = {
  chatId: "chat",
  operationId: "operation",
  operationGeneration: "grant",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeOperationId: "native-operation",
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
};
function receipt(event: Omit<NativeSettingsEvidence, "workerId">) {
  return {
    operationId: event.operationId,
    operationGeneration: event.operationGeneration,
    eventId: event.eventId,
    permissionPolicyPublished: true,
    application: {
      nativeOperationId: event.nativeOperationId,
      status: "applied" as const,
      submissionId: event.submissionId,
      evidenceCount: 1,
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "native-settings-delivery-"),
  );
  directories.push(directory);
  return directory;
}
function delivery(
  directory: string,
  send = vi.fn(async (event: Omit<NativeSettingsEvidence, "workerId">) =>
    receipt(event),
  ),
  owner = service,
) {
  const onError = vi.fn();
  const instance = new NativeSettingsDelivery({
    directory,
    workerId: "worker",
    service: owner,
    client: { settingsEvidence: send },
    onError,
    retryDelayMs: 10,
  });
  deliveries.push(instance);
  return { instance, send, onError };
}

describe("durable native settings delivery", () => {
  it("publishes policy locally only after the server confirms its applied evidence", async () => {
    const root = await fixture();
    let allow = false;
    const send = vi.fn(
      async (event: Omit<NativeSettingsEvidence, "workerId">) => {
        if (!allow) throw new Error("publication unavailable");
        return receipt(event);
      },
    );
    const { instance } = delivery(root, send);
    const published = vi.fn();
    instance.subscribePublished(published);
    const permissionPolicy = {
      effectiveId: ":workspace",
      settingsVersion: { epoch: "epoch", revision: "1" },
    };
    await instance.track(scope);
    await instance.record(
      scope,
      "applied",
      "submission",
      { privateSecurity: "sensitive" },
      permissionPolicy,
    );
    await expect.poll(() => send.mock.calls.length).toBeGreaterThan(0);
    expect(published).not.toHaveBeenCalled();
    const original = send.mock.calls[0]![0];
    expect(original.permissionPolicy).toEqual(permissionPolicy);
    expect(JSON.stringify(original)).not.toContain("sensitive");
    allow = true;
    await expect.poll(() => published.mock.calls.length).toBe(1);
    expect(published).toHaveBeenCalledWith(original);
    expect(
      send.mock.calls.every(([event]) => event.eventId === original.eventId),
    ).toBe(true);
  });
  it("encrypts the full native result and binds it to its exact evidence event", async () => {
    const root = await fixture();
    const { instance, send } = delivery(root);
    await instance.track(scope);
    await instance.record(scope, "applied", "submission", {
      developer_instructions: "private-settings-secret",
      serviceTier: null,
    });
    await expect.poll(() => send.mock.calls.length).toBe(1);
    const event = send.mock.calls[0]![0];
    expect(JSON.stringify(event)).not.toContain("private-settings-secret");
    const context = {
      chatId: scope.chatId,
      operationId: scope.operationId,
      direction: "settings-evidence" as const,
      eventId: event.eventId,
    };
    const plaintext = await openNativeCommandContent({
      service,
      context,
      envelope: event.protectedResult,
    });
    expect(plaintext).toMatchObject({
      scope,
      kind: "applied",
      content: {
        developer_instructions: "private-settings-secret",
        serviceTier: null,
      },
    });
    await expect(
      openNativeCommandContent({
        service,
        context: { ...context, eventId: "other" },
        envelope: event.protectedResult,
      }),
    ).rejects.toThrow();
  });

  it("retries the identical event after a response is lost and does not wait for delivery to capture", async () => {
    const root = await fixture();
    const send = vi.fn(
      async (event: Omit<NativeSettingsEvidence, "workerId">) => {
        if (send.mock.calls.length === 1)
          throw new Error("Response lost after server commit");
        return receipt(event);
      },
    );
    const { instance } = delivery(root, send);
    await instance.track(scope);
    await instance.record(scope, "applied", "submission", { model: "next" });
    expect(send).not.toHaveBeenCalled();
    await expect.poll(() => send.mock.calls.length).toBe(2);
    expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("recovers pending ciphertext on a new delivery pump without invoking native input", async () => {
    const root = await fixture();
    const first = delivery(
      root,
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await first.instance.track(scope);
    await first.instance.record(scope, "applied", "submission", {
      model: "next",
    });
    await expect.poll(() => first.send.mock.calls.length).toBeGreaterThan(0);
    const original = first.send.mock.calls[0]![0];
    await first.instance.stop();
    const second = delivery(root);
    second.instance.wake();
    await expect.poll(() => second.send.mock.calls.length).toBe(1);
    expect(second.send.mock.calls[0]![0]).toEqual(original);
  });

  it("reports an interrupted pending request as uncertain on recovery, preserving its identities", async () => {
    const root = await fixture();
    const first = delivery(root);
    await first.instance.track(scope);
    await first.instance.stop();
    const second = delivery(root);
    second.instance.wake();
    await expect.poll(() => second.send.mock.calls.length).toBe(1);
    expect(second.send.mock.calls[0]![0]).toMatchObject({
      operationId: scope.operationId,
      operationGeneration: scope.operationGeneration,
      nativeOperationId: scope.nativeOperationId,
      threadId: scope.threadId,
      runtimeGeneration: scope.runtimeGeneration,
      kind: "transport-lost",
      submissionId: null,
    });
  });

  it("does not recover another owner's records", async () => {
    const root = await fixture();
    const first = delivery(root);
    await first.instance.track(scope);
    await first.instance.stop();
    const second = delivery(root, undefined, {
      ...service,
      ownerId: () => "other-owner",
    });
    second.instance.wake();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(second.send).not.toHaveBeenCalled();
    const partitions = await readdir(
      path.join(root, "native-settings-evidence"),
    );
    const records = await Promise.all(
      partitions.map(async (partition) => {
        const directory = path.join(
          root,
          "native-settings-evidence",
          partition,
        );
        return Promise.all(
          (await readdir(directory)).map((name) =>
            readFile(path.join(directory, name), "utf8"),
          ),
        );
      }),
    );
    expect(
      records
        .flat()
        .some((record) =>
          record.includes('"nativeOperationId":"native-operation"'),
        ),
    ).toBe(true);
  });
});
