import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshProviderModelCatalog } from "@/lib/api";
import { getClientSessionIdentitySnapshot } from "@/lib/client-session";
import {
  OllamaModelPickerRefresh,
  type OllamaModelPickerScope,
} from "./ollama-model-picker-refresh";

vi.mock("@/lib/api", () => ({ refreshProviderModelCatalog: vi.fn() }));
vi.mock("@/lib/client-session", () => ({
  clientSessionIdentityMatches: () => true,
  getClientSessionIdentitySnapshot: vi.fn(),
}));

const identity = {
  accountId: null,
  connectionId: null,
  generation: 1,
  incarnationId: "incarnation",
  serverId: "server",
  serverUrl: null,
  userId: "user",
};

const providers = [
  { id: "local-ollama", kind: "ollama" },
  { id: "second-ollama", kind: "ollama" },
  { id: "openrouter", kind: "openai-compatible" },
] as const;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(getClientSessionIdentitySnapshot).mockReturnValue(identity);
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("discovers Ollama models on each opening and updates the open chat's lists", async () => {
  const queryClient = new QueryClient();
  const settingsKey = ["settings"];
  const inventoryKey = ["native-model-inventory", "chat", "binding", identity];
  const handoffKey = ["native-runtime-handoffs", "chat", identity];
  const otherChatKey = [
    "native-model-inventory",
    "other-chat",
    "binding",
    identity,
  ];
  const keys = [settingsKey, inventoryKey, handoffKey];
  for (const key of [...keys, otherChatKey]) {
    queryClient.setQueryData(key, ["existing-model"]);
  }

  let discoveredModels = ["existing-model"];
  const refresh = vi.mocked(refreshProviderModelCatalog);
  refresh.mockImplementation(async (providerId) => {
    if (providerId === "second-ollama") throw new Error("Unavailable");
    discoveredModels = ["existing-model", "newly-pulled-model"];
    return {
      providerId,
      models: [],
      availability: [],
      syncStates: [],
      servedStale: false,
    };
  });
  function List({ queryKey }: { queryKey: unknown[] }) {
    useQuery({
      queryKey,
      queryFn: async () => discoveredModels,
      staleTime: Infinity,
    });
    return null;
  }
  function view(open: boolean, entries: OllamaModelPickerScope["providers"]) {
    return (
      <QueryClientProvider client={queryClient}>
        {keys.map((key) => (
          <List key={String(key[0])} queryKey={key} />
        ))}
        {open ? (
          <OllamaModelPickerRefresh
            chatId="chat"
            providers={entries}
            workerId="selected-worker"
          />
        ) : null}
      </QueryClientProvider>
    );
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(view(false, providers));
  });
  try {
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => renderer.update(view(true, undefined)));
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => renderer.update(view(true, providers)));
    expect(refresh.mock.calls).toEqual([
      ["local-ollama", "selected-worker", identity],
      ["second-ollama", "selected-worker", identity],
    ]);
    for (const key of keys) {
      expect(queryClient.getQueryData(key)).toEqual(discoveredModels);
    }
    expect(queryClient.getQueryState(otherChatKey)?.isInvalidated).toBe(false);

    await act(async () => renderer.update(view(true, [...providers])));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => renderer.update(view(false, providers)));
    await act(async () => renderer.update(view(true, providers)));
    expect(refresh).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => renderer.unmount());
    queryClient.clear();
  }
});
