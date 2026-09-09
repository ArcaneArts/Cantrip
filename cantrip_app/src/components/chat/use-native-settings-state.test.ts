import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeSettingsState,
  NativeThreadSettings,
} from "@cantrip/protocol";

const runtime = vi.hoisted(() => ({
  identity: {
    userId: "owner",
    serverId: "server",
    accountId: "account",
    connectionId: "connection",
    generation: 1,
    incarnationId: "incarnation",
    serverUrl: null,
  },
  encryption: {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  },
  identityListeners: new Set<() => void>(),
  encryptionListeners: new Set<() => void>(),
  request: vi.fn(),
  open: vi.fn(),
  intents: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ request: runtime.request }));
vi.mock("@/lib/native-settings-encryption", () => ({
  openNativeSettingsState: runtime.open,
}));
vi.mock("@/lib/native-settings-intents", () => ({
  openNativeSettingsIntents: runtime.intents,
}));
vi.mock("@/lib/app-live-react", () => ({ useAppLiveScope: () => undefined }));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    subscribe: (listener: () => void) => {
      runtime.encryptionListeners.add(listener);
      return () => runtime.encryptionListeners.delete(listener);
    },
    getSnapshot: () => runtime.encryption,
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({ ...runtime.identity }),
  clientSessionIdentityMatches: (identity: typeof runtime.identity) =>
    JSON.stringify(identity) === JSON.stringify(runtime.identity),
  onClientSessionIdentityChanged: (listener: () => void) => {
    runtime.identityListeners.add(listener);
    return () => runtime.identityListeners.delete(listener);
  },
}));
import { useNativeSettingsState } from "./use-native-settings-state";
import { nativeSettingsQueryKey } from "@/lib/native-settings-api";

function state(revision = "1"): NativeSettingsState {
  return {
    chatId: "chat",
    revision,
    desiredRevision: "0",
    desired: null,
    desiredStatus: null,
    pending: [],
    binding: null,
    effective: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const selection = (model: string) => ({ model }) as NativeThreadSettings;
const cleanup: (() => void)[] = [];
async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
}
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let current!: ReturnType<typeof useNativeSettingsState>;
  function Probe() {
    current = useNativeSettingsState("chat", true);
    return null;
  }
  let view!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    view = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
  });
  cleanup.push(() => {
    view.unmount();
    client.clear();
  });
  await flush();
  return { client, current: () => current };
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.request.mockReset().mockResolvedValue(state());
  runtime.open.mockReset().mockResolvedValue(selection("private-model"));
  runtime.intents.mockReset().mockResolvedValue([]);
  runtime.identity = { ...runtime.identity, generation: 1 };
  runtime.encryption = { ...runtime.encryption, status: "ready" };
});
afterEach(async () => {
  await act(async () => {
    cleanup.splice(0).forEach((dispose) => dispose());
  });
});

describe("native settings view subscription", () => {
  it("preserves readable confirmed state when a desired request cannot be decrypted", async () => {
    runtime.intents.mockRejectedValue(new Error("Bad desired envelope"));
    const view = await mount();
    expect(view.current().confirmed?.model).toBe("private-model");
    expect(view.current().intents).toEqual([]);
    expect(view.current().decryptionError?.message).toContain(
      "requested native settings",
    );
  });

  it("keeps plaintext out of the query cache and removes it on lock", async () => {
    const view = await mount();
    expect(view.current().confirmed?.model).toBe("private-model");
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("private-model");
    await act(async () => {
      runtime.encryption = { ...runtime.encryption, status: "locked" };
      runtime.encryptionListeners.forEach((listener) => listener());
    });
    expect(view.current().confirmed).toBeNull();
  });

  it("does not expose a delayed old-account decryption in a new authenticated lifetime", async () => {
    const old = deferred<NativeThreadSettings>();
    runtime.open
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(selection("new-model"));
    const view = await mount();
    expect(view.current().confirmed).toBeNull();
    await act(async () => {
      runtime.identity = { ...runtime.identity, generation: 2 };
      runtime.identityListeners.forEach((listener) => listener());
    });
    await flush();
    expect(view.current().confirmed?.model).toBe("new-model");
    await act(async () => old.resolve(selection("old-private-model")));
    expect(view.current().confirmed?.model).toBe("new-model");
    expect(runtime.request).toHaveBeenCalledTimes(2);
  });

  it("retains newer canonical state when an older explicit native refresh completes", async () => {
    const delayed = deferred<NativeSettingsState>();
    const view = await mount();
    runtime.request.mockReturnValueOnce(delayed.promise);
    let refresh!: Promise<NativeSettingsState>;
    await act(async () => {
      refresh = view.current().refresh.mutateAsync();
    });
    await act(async () => {
      view.client.setQueryData(
        nativeSettingsQueryKey("chat", runtime.identity),
        state("9007199254740993"),
      );
    });
    await act(async () => {
      delayed.resolve(state("9007199254740992"));
      await refresh;
    });
    await flush();
    expect(view.current().state.data?.revision).toBe("9007199254740993");
    expect(runtime.request.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("refreshes canonical reads after live invalidation without launching a native read", async () => {
    const view = await mount();
    runtime.request.mockResolvedValueOnce(state("2"));
    await act(async () => {
      await view.client.invalidateQueries({
        queryKey: ["native-settings", "chat"],
      });
    });
    await flush();
    expect(view.current().state.data?.revision).toBe("2");
    expect(
      runtime.request.mock.calls.every((call) => call[1].method === "GET"),
    ).toBe(true);
  });
});
