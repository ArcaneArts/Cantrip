import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeSettingsState } from "@cantrip/protocol";
import { NativeSettingsPublisher } from "../src/native-settings-publisher.js";
import { NativeHistoryObservations } from "../src/codex/native-history-observation.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";
import {
  protectNativeSettingsSnapshot,
  openNativeSettingsSnapshot,
} from "../src/native-settings-content.js";
import { CantripServerRequestError } from "../src/cli-client.js";

const scope = {
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route",
  providerAccountId: null,
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ keyRevision: 1, key: Buffer.alloc(32, 6) }),
};
const publishers: NativeSettingsPublisher[] = [];
afterEach(() => {
  for (const publisher of publishers.splice(0)) publisher.close();
});
function fixture() {
  const observations = new NativeHistoryObservations();
  observations.replace("runtime");
  let settings = nativeThreadSettings({
    settingsVersion: { epoch: "core", revision: "0" },
  });
  let current = true;
  let nextBinding = 0;
  const errors: unknown[] = [];
  const client = {
    refreshSettings: vi.fn(
      async (
        _chatId?: string,
        _signal?: AbortSignal,
      ): Promise<NativeSettingsState> => {
        const effective = await protectNativeSettingsSnapshot({
          service,
          settings,
          context: {
            chatId: scope.chatId,
            workerId: scope.workerId,
            threadId: scope.threadId,
            runtimeGeneration: "runtime",
            settingsVersion: settings.settingsVersion!,
          },
        });
        return {
          chatId: scope.chatId,
          revision: "1",
          desiredRevision: "0",
          desired: null,
          desiredStatus: null,
          pending: [],
          effective,
          binding: {
            ...scope,
            bindingId: `binding-${++nextBinding}`,
            runtimeGeneration: "runtime",
            nativeEpoch: settings.settingsVersion!.epoch,
          },
        };
      },
    ),
    observeSettings: vi.fn(
      async (
        input: Parameters<
          NativeSettingsPublisherConstructorClient["observeSettings"]
        >[0],
      ) => ({
        bindingId: input.bindingId,
        revision: "2",
        settingsVersion: input.snapshot.context.settingsVersion,
      }),
    ),
  };
  const publisher = new NativeSettingsPublisher({
    scope,
    generation: "runtime",
    service,
    client,
    runtime: {
      observeNativeHistory: (threadId, observer) =>
        observations.subscribe(threadId, observer, async () => {
          throw new Error("No history read is needed");
        }),
    },
    isCurrent: () => current,
    retryDelayMs: 5,
    onError: (error) => errors.push(error),
  });
  publishers.push(publisher);
  return {
    publisher,
    client,
    errors,
    observations,
    retire() {
      current = false;
    },
    emit(revision: string) {
      settings = nativeThreadSettings({
        settingsVersion: { epoch: "core", revision },
        privateInstructions: `private-${revision}`,
      });
      observations.notification("thread/settings/updated", {
        threadId: "thread",
        threadSettings: settings,
      });
    },
  };
}
type NativeSettingsPublisherConstructorClient = ConstructorParameters<
  typeof NativeSettingsPublisher
>[0]["client"];

describe("automatic native settings publication", () => {
  it("abandons an old read-only request on reconnect and immediately establishes a fresh baseline", async () => {
    const f = fixture();
    let oldSignal: AbortSignal | undefined;
    f.client.refreshSettings.mockImplementationOnce(
      (_chatId, signal) =>
        new Promise((_resolve, reject) => {
          oldSignal = signal;
          signal!.addEventListener(
            "abort",
            () => reject(new Error("Read cancelled for reconnect")),
            { once: true },
          );
        }),
    );
    f.publisher.start();
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    f.publisher.wake();
    await vi.waitFor(() =>
      expect(f.client.refreshSettings).toHaveBeenCalledTimes(2),
    );
    expect(oldSignal!.aborted).toBe(true);
    expect(f.errors).toEqual([]);
    f.emit("1");
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledOnce(),
    );
  });

  it("establishes a native read baseline then publishes complete encrypted updates", async () => {
    const f = fixture();
    f.publisher.start();
    await vi.waitFor(() =>
      expect(f.client.refreshSettings).toHaveBeenCalledOnce(),
    );
    f.emit("1");
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledOnce(),
    );
    const input = f.client.observeSettings.mock.calls[0]![0];
    expect(JSON.stringify(input)).not.toContain("private-");
    expect(
      (
        await openNativeSettingsSnapshot({
          service,
          context: input.snapshot.context,
          snapshot: input.snapshot,
        })
      ).privateInstructions,
    ).toBe("private-1");
    expect(f.client.refreshSettings).toHaveBeenCalledOnce();
    expect(f.errors).toEqual([]);
  });

  it("retries the same ciphertext after a lost publication acknowledgment", async () => {
    const f = fixture();
    f.client.observeSettings.mockRejectedValueOnce(
      new Error("Lost response after commit"),
    );
    f.publisher.start();
    f.emit("1");
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledTimes(2),
    );
    expect(f.client.observeSettings.mock.calls[0]![0]).toEqual(
      f.client.observeSettings.mock.calls[1]![0],
    );
    expect(f.client.refreshSettings).toHaveBeenCalledOnce();
    expect(f.errors).toHaveLength(1);
  });

  it("recovers a failed initial read without restarting the runtime or waiting for another event", async () => {
    const f = fixture();
    f.client.refreshSettings.mockRejectedValueOnce(
      new Error("Server unavailable"),
    );
    f.publisher.start();
    await vi.waitFor(() =>
      expect(f.client.refreshSettings).toHaveBeenCalledTimes(2),
    );
    f.emit("2");
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledOnce(),
    );
    expect(f.errors).toHaveLength(1);
  });

  it("coalesces updates arriving while delivery is pending and eventually publishes the newest version", async () => {
    const f = fixture();
    let release!: (
      receipt: Awaited<
        ReturnType<NativeSettingsPublisherConstructorClient["observeSettings"]>
      >,
    ) => void;
    f.client.observeSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.publisher.start();
    f.emit("1");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    for (const version of ["2", "3", "2", "4"]) f.emit(version);
    const first = f.client.observeSettings.mock.calls[0]![0];
    release({
      bindingId: first.bindingId,
      revision: "2",
      settingsVersion: first.snapshot.context.settingsVersion,
    });
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledTimes(2),
    );
    expect(
      f.client.observeSettings.mock.calls[1]![0].snapshot.context
        .settingsVersion.revision,
    ).toBe("4");
  });

  it("gets a fresh binding after server replacement and keeps queued state isolated", async () => {
    const f = fixture();
    f.client.observeSettings.mockRejectedValueOnce(
      new CantripServerRequestError(
        "Replaced",
        409,
        "settings-binding-replaced",
      ),
    );
    f.publisher.start();
    f.emit("1");
    await vi.waitFor(() =>
      expect(f.client.observeSettings).toHaveBeenCalledTimes(2),
    );
    expect(f.client.refreshSettings).toHaveBeenCalledTimes(2);
    expect(
      f.client.observeSettings.mock.calls.map(([input]) => input.bindingId),
    ).toEqual(["binding-1", "binding-2"]);
    f.publisher.wake();
    await vi.waitFor(() =>
      expect(f.client.refreshSettings).toHaveBeenCalledTimes(3),
    );
  });

  it("retires only its observation when the native transport is replaced", async () => {
    const f = fixture();
    f.publisher.start();
    await vi.waitFor(() =>
      expect(f.client.refreshSettings).toHaveBeenCalledOnce(),
    );
    f.observations.replace("new-runtime");
    f.emit("3");
    f.publisher.wake();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.client.refreshSettings).toHaveBeenCalledOnce();
    expect(f.client.observeSettings).not.toHaveBeenCalled();
  });

  it("does not publish an in-flight read after its selected association is retired", async () => {
    const f = fixture();
    let release!: (state: NativeSettingsState) => void;
    const state = await f.client.refreshSettings();
    f.client.refreshSettings.mockClear();
    f.client.refreshSettings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    f.publisher.start();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.emit("1");
    f.retire();
    release(state);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.client.observeSettings).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  });
});
