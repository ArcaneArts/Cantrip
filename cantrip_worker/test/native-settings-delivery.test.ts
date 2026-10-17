import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSettingsEvidence } from "@cantrip/protocol";
import { NativeSettingsDelivery } from "../src/native-settings-delivery.js";
import { openNativeCommandContent } from "../src/native-command-content.js";
import * as historyFiles from "../src/native-history-outbox-files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

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

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

async function fileIsMissing(filename: string): Promise<boolean> {
  try {
    await readFile(filename);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

describe("durable native settings delivery", () => {
  it("does not retry an active capture while an acknowledged event is removed", async () => {
    const root = await fixture();
    const firstWrite = barrier();
    const allowFirstWrite = barrier();
    const duplicateCompared = barrier();
    const acknowledged = barrier();
    const bodies: string[] = [];
    let eventFile = "";
    const send = vi.fn(
      async (event: Omit<NativeSettingsEvidence, "workerId">) => {
        acknowledged.release();
        return receipt(event);
      },
    );
    const { instance, onError } = delivery(root, send);
    await instance.track(scope);
    const write = historyFiles.writeImmutableHistoryFile;
    const { readdir: list } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const writing = vi
      .spyOn(historyFiles, "writeImmutableHistoryFile")
      .mockImplementation(async (filename, body) => {
        if (!filename.endsWith(".event.json")) return write(filename, body);
        const attempt = bodies.push(body);
        if (attempt === 1) {
          eventFile = filename;
          firstWrite.release();
          await allowFirstWrite.reached;
          const created = await write(filename, body);
          if (!created) {
            // A competing retry committed this exact event first. Let the
            // actual acknowledgement remove it before the EEXIST reader resumes.
            duplicateCompared.release();
            await acknowledged.reached;
            await expect.poll(() => fileIsMissing(filename)).toBe(true);
          }
          return created;
        }
        const created = await write(filename, body);
        allowFirstWrite.release();
        await duplicateCompared.reached;
        return created;
      });
    const enumerating = vi
      .spyOn(filesystem, "readdir")
      .mockImplementation(async (...args) => {
        const names = await list(...args);
        // With no in-flight retry, the pump reaches its real directory scan.
        // Release the original writer here, without a timing-based fallback.
        if (String(args[0]) === path.dirname(eventFile))
          allowFirstWrite.release();
        return names;
      });
    const recording = instance.record(scope, "applied", "submission", {
      model: "next",
    });
    void recording.catch(() => {});
    try {
      await firstWrite.reached;
      instance.wake();
      await expect(recording).resolves.toBeUndefined();
      await expect.poll(() => send.mock.calls.length).toBe(1);
      await expect.poll(() => fileIsMissing(eventFile)).toBe(true);
      await instance.stop();
      expect(bodies).toHaveLength(1);
      expect(send.mock.calls[0]![0]).toEqual(JSON.parse(bodies[0]!));
      await expect(readFile(eventFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(onError).not.toHaveBeenCalled();
    } finally {
      allowFirstWrite.release();
      duplicateCompared.release();
      acknowledged.release();
      await recording.catch(() => {});
      await instance.stop();
      writing.mockRestore();
      enumerating.mockRestore();
    }
  });
  it("retries a failed capture with its original event and ciphertext", async () => {
    const root = await fixture();
    const { instance, send, onError } = delivery(root);
    await instance.track(scope);
    const failure = Object.assign(new Error("fixture write failed"), {
      code: "EIO",
    });
    const bodies: string[] = [];
    let eventFile = "";
    const write = historyFiles.writeImmutableHistoryFile;
    const writing = vi
      .spyOn(historyFiles, "writeImmutableHistoryFile")
      .mockImplementation(async (filename, body) => {
        if (filename.endsWith(".event.json")) {
          eventFile = filename;
          bodies.push(body);
          if (bodies.length === 1) throw failure;
        }
        return write(filename, body);
      });
    try {
      await expect(
        instance.record(scope, "applied", "submission", { model: "next" }),
      ).rejects.toBe(failure);
      await expect.poll(() => send.mock.calls.length).toBe(1);
      await expect.poll(() => fileIsMissing(eventFile)).toBe(true);
      await instance.stop();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(send.mock.calls[0]![0]).toEqual(JSON.parse(bodies[0]!));
      expect(onError).not.toHaveBeenCalled();
    } finally {
      writing.mockRestore();
      await instance.stop();
    }
  });

  it.each([
    { damage: "missing", expected: { code: "ENOENT" } },
    { damage: "malformed", expected: { name: "SyntaxError" } },
    {
      damage: "changed identity",
      expected: { message: "Native settings event identity was reused." },
    },
  ])(
    "rejects genuinely $damage committed evidence without publication",
    async ({ damage, expected }) => {
      const root = await fixture();
      const { instance, send } = delivery(root);
      const published = vi.fn();
      instance.subscribePublished(published);
      const bodies: string[] = [];
      let eventFile = "";
      const write = historyFiles.writeImmutableHistoryFile;
      const writing = vi
        .spyOn(historyFiles, "writeImmutableHistoryFile")
        .mockImplementation(async (filename, body) => {
          if (!filename.endsWith(".event.json")) return write(filename, body);
          eventFile = filename;
          bodies.push(body);
          await write(filename, body);
          // Exercise the real EEXIST result before damaging committed storage.
          const created = await write(filename, body);
          expect(created).toBe(false);
          if (damage === "missing") await rm(filename);
          else
            await writeFile(
              filename,
              damage === "malformed"
                ? "{"
                : JSON.stringify({
                    ...JSON.parse(body),
                    submissionId: "changed",
                  }),
            );
          return created;
        });
      try {
        await expect(
          instance.record(scope, "applied", "submission", { model: "next" }),
        ).rejects.toMatchObject(expected);
        await expect(instance.stop()).rejects.toMatchObject(expected);
        expect(send).not.toHaveBeenCalled();
        expect(published).not.toHaveBeenCalled();
        expect(new Set(bodies).size).toBe(1);
      } finally {
        writing.mockRestore();
        // Repair only this test's damaged file so stop can flush retained evidence.
        if (eventFile) await rm(eventFile, { force: true });
        await instance.stop();
      }
      expect(JSON.parse(await readFile(eventFile, "utf8"))).toEqual(
        JSON.parse(bodies[0]!),
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["owner", "server"] as const)(
    "rejects a changed encryption %s during capture",
    async (field) => {
      const root = await fixture();
      const identity = { owner: "owner", server: "server" };
      let replace = false;
      const { instance, send } = delivery(root, undefined, {
        ownerId: () => identity.owner,
        serverIdentity: () => identity.server,
        componentKey: () => {
          if (replace) identity[field] = "replacement";
          return service.componentKey();
        },
      });
      await instance.track(scope);
      replace = true;
      await expect(
        instance.record(scope, "applied", "submission", { model: "next" }),
      ).rejects.toThrow("encryption ownership changed during capture");
      await instance.stop();
      expect(send).not.toHaveBeenCalled();
      const partitions = await readdir(
        path.join(root, "native-settings-evidence"),
      );
      const files = (
        await Promise.all(
          partitions.map((partition) =>
            readdir(path.join(root, "native-settings-evidence", partition)),
          ),
        )
      ).flat();
      expect(files.some((name) => name.endsWith(".event.json"))).toBe(false);
      expect(
        files.filter((name) => name.endsWith(".pending.json")),
      ).toHaveLength(1);
    },
  );

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
