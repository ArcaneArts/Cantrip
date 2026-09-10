import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type {
  NativeRuntimeHandoffInventory,
  NativeRuntimeHandoffRequest,
  NativeRuntimeHandoffState,
} from "@cantrip/protocol";

const api = vi.hoisted(() => ({
  read: vi.fn(),
  start: vi.fn(),
  control: vi.fn(),
  matches: vi.fn(() => true),
  snapshot: { status: "ready" },
}));
vi.mock("@/lib/native-runtime-handoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/native-runtime-handoff")>()),
  readRuntimeHandoffs: api.read,
  startRuntimeHandoff: api.start,
  controlRuntimeHandoff: api.control,
}));
vi.mock("@/lib/client-session", () => ({
  clientSessionIdentityMatches: api.matches,
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: { getSnapshot: () => api.snapshot },
}));
vi.mock("@/lib/protected-secrets", () => ({
  openModelProviderAccountWireSummary: async (wire: { id: string }) => ({
    id: wire.id,
    label: "Demo account",
  }),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) =>
    createElement("button", props, children as never),
}));
import { useRuntimeHandoff } from "./use-runtime-handoff";
import { NativeRuntimeHandoffEditor } from "./native-runtime-handoff-editor";
import { CantripApiError } from "@/lib/api-client";

const binding = {
  bindingId: "bound",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "core",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route-a",
  providerAccountId: null,
};
const identity = {
  userId: "owner",
  serverId: "server",
  accountId: "account",
  connectionId: "connection",
  generation: 1,
  incarnationId: "incarnation",
  serverUrl: null,
};
let inventory: NativeRuntimeHandoffInventory;
function receipt(
  input: NativeRuntimeHandoffRequest,
): NativeRuntimeHandoffState {
  return {
    operationId: input.operationId,
    chatId: "chat",
    workerId: "worker",
    phase: "preparing",
    cancelRequested: false,
    source: binding,
    binding,
    retiredRuntimeGenerations: [],
    retiredNativeEpochs: [],
    targetModelRouteId: input.targetModelRouteId,
    targetProviderAccountId: input.targetProviderAccountId,
    prepared: null,
    errorCode: null,
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
  };
}
const dispose: (() => void)[] = [];
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.matches.mockReturnValue(true);
  inventory = {
    chatId: "chat",
    binding,
    latest: null,
    providers: [
      {
        id: "provider-a",
        name: "Local",
        requiresAccount: false,
        accounts: [],
        models: [{ routeId: "route-a", name: "a", profileName: "A" }],
      },
      {
        id: "provider-b",
        name: "Remote",
        requiresAccount: true,
        accounts: [{ id: "target-account", position: 0 } as never],
        models: [{ routeId: "route-b", name: "b", profileName: "B" }],
      },
    ],
  };
  api.read.mockImplementation(async () => structuredClone(inventory));
  api.start.mockImplementation(async (_scope, input) => {
    inventory.latest = receipt(input);
    return inventory.latest;
  });
  api.control.mockImplementation(async (_scope, id, action) => {
    expect(id).toBe(inventory.latest!.operationId);
    if (action === "cancel")
      inventory.latest = { ...inventory.latest!, cancelRequested: true };
    return inventory.latest;
  });
});
afterEach(async () => {
  await act(async () => dispose.splice(0).forEach((close) => close()));
});
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let controller!: ReturnType<typeof useRuntimeHandoff>;
  let unlocked = true;
  function Probe() {
    controller = useRuntimeHandoff({ binding, identity, open: true, unlocked });
    return unlocked ? (
      <NativeRuntimeHandoffEditor
        controller={controller}
        binding={binding}
        identity={identity}
        disabled={false}
      />
    ) : null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  await act(async () => {
    renderer = TestRenderer.create(render());
  });
  await flush();
  const close = () => {
    renderer.unmount();
    client.clear();
  };
  dispose.push(close);
  return {
    renderer,
    controller: () => controller,
    lock: async () => {
      unlocked = false;
      await act(async () => renderer.update(render()));
    },
    select: async (name: string, value: string) =>
      act(async () =>
        renderer.root
          .findByProps({ "aria-label": name })
          .props.onChange({ target: { value } }),
      ),
    button: (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === label)!,
  };
}
it("selects an exact provider/account/route and exposes durable cancellation without duplicating a transfer", async () => {
  const ui = await mount();
  expect(ui.button("Transfer conversation").props.disabled).toBe(true);
  await ui.select("Transfer provider", "provider-b");
  await ui.select("Transfer account", "target-account");
  await ui.select("Transfer model", "route-b");
  expect(ui.button("Transfer conversation").props.disabled).toBe(false);
  await act(async () => {
    ui.button("Transfer conversation").props.onClick();
    ui.button("Transfer conversation").props.onClick();
  });
  await flush();
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(api.start.mock.calls[0]).toEqual([
    { chatId: "chat", identity },
    expect.objectContaining({
      bindingId: "bound",
      targetModelRouteId: "route-b",
      targetProviderAccountId: "target-account",
    }),
  ]);
  expect(ui.button("Transfer conversation").props.disabled).toBe(true);
  await act(async () => ui.button("Cancel transfer").props.onClick());
  await flush();
  expect(api.control.mock.calls[0]!.slice(1)).toEqual([
    inventory.latest!.operationId,
    "cancel",
  ]);
});
it("reopens an existing committed transfer and retries it without starting another or offering cancellation", async () => {
  inventory.latest = {
    ...receipt({
      operationId: crypto.randomUUID(),
      bindingId: "bound",
      targetModelRouteId: "route-b",
      targetProviderAccountId: "target-account",
    }),
    phase: "committed",
    errorCode: "handoff-worker-unavailable",
  };
  const ui = await mount();
  expect(ui.controller().active).toBe(true);
  expect(ui.button("Cancel transfer")).toBeUndefined();
  await act(async () => ui.button("Retry transfer").props.onClick());
  expect(api.control.mock.calls[0]!.slice(1)).toEqual([
    inventory.latest.operationId,
    "retry",
  ]);
  expect(api.start).not.toHaveBeenCalled();
});
it("retains an uncertain begin identity and retries the identical destination", async () => {
  api.start.mockRejectedValueOnce(new Error("Connection lost"));
  const ui = await mount();
  await act(async () => {
    await ui
      .controller()
      .run("start", { routeId: "route-b", accountId: "target-account" });
  });
  expect(ui.controller().unconfirmed).not.toBeNull();
  const request = api.start.mock.calls[0]![1];
  await act(async () => {
    await ui.controller().run("retry");
  });
  await flush();
  expect(api.start.mock.calls[1]![1]).toEqual(request);
  expect(ui.controller().unconfirmed).toBeNull();
  expect(ui.controller().active).toBe(true);
});
it("lets the user correct a rejected destination instead of retaining an uncertain request", async () => {
  api.start.mockRejectedValueOnce(
    new CantripApiError(
      "The agent is still working.",
      409,
      "handoff-native-operation-pending",
    ),
  );
  const ui = await mount();
  await act(async () => {
    await ui
      .controller()
      .run("start", { routeId: "route-b", accountId: "target-account" });
  });
  expect(ui.controller().unconfirmed).toBeNull();
  expect(ui.controller().busy).toBe(false);
  expect(ui.controller().error).toBe("The agent is still working.");
});
it("recovers a lost begin response from the durable inventory without replay", async () => {
  api.start.mockImplementationOnce(async (_scope, input) => {
    inventory.latest = receipt(input);
    throw new Error("Connection lost after acceptance");
  });
  const ui = await mount();
  await act(async () => {
    await ui
      .controller()
      .run("start", { routeId: "route-b", accountId: "target-account" });
  });
  await flush();
  expect(ui.controller().unconfirmed).toBeNull();
  expect(ui.controller().active).toBe(true);
  expect(api.start).toHaveBeenCalledTimes(1);
});
it("clears private labels and ignores an in-flight result after encryption is locked", async () => {
  const ui = await mount();
  let release!: (result: NativeRuntimeHandoffState) => void;
  api.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = ui
      .controller()
      .run("start", { routeId: "route-b", accountId: "target-account" });
  });
  await ui.lock();
  await act(async () => {
    release(receipt(api.start.mock.calls[0]![1]));
    await pending;
  });
  expect(ui.renderer.toJSON()).toBeNull();
  expect(ui.controller().unconfirmed).toBeNull();
  expect(ui.controller().busy).toBe(false);
});
