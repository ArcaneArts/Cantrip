import { createElement, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeSettingsState,
  NativeThreadSettings,
} from "@cantrip/protocol";
const runtime = vi.hoisted(() => ({
  observed: null as unknown,
  read: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  sendPermission: vi.fn(),
  matches: vi.fn(() => true),
}));
vi.mock("./use-runtime-handoff", () => ({
  useRuntimeHandoff: () => ({
    query: { data: null },
    latest: null,
    active: false,
    busy: false,
    error: null,
    unconfirmed: null,
  }),
}));
vi.mock("./native-runtime-handoff-editor", () => ({
  NativeRuntimeHandoffEditor: () => null,
}));
vi.mock("./use-native-settings-state", () => ({
  useNativeSettingsState: () => runtime.observed,
}));
vi.mock("@/lib/native-model-inventory", () => ({
  nativeChatModelInventoryQueryKey: (...args: unknown[]) => [
    "inventory",
    ...args,
  ],
  readNativeChatModelInventory: runtime.read,
}));
vi.mock("@/lib/native-settings-update", () => ({
  prepareNativeSettingsUpdate: runtime.prepare,
  sendNativeSettingsUpdate: runtime.send,
}));
vi.mock("@/lib/native-permission-update", () => ({
  sendNativePermissionUpdate: runtime.sendPermission,
  nativePermissionUpdateRejected: (error: unknown) =>
    error instanceof Error && error.message === "permission-transition-pending",
}));
vi.mock("@/lib/client-session", () => ({
  clientSessionIdentityMatches: runtime.matches,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) =>
    createElement("button", props, children as never),
}));
vi.mock("@/components/ui/dialog", () => {
  const part = ({ children }: { children: unknown }) =>
    createElement("div", {}, children as never);
  return {
    Dialog: part,
    DialogContent: part,
    DialogHeader: part,
    DialogTitle: part,
    DialogDescription: part,
    DialogFooter: part,
  };
});
import { useNativeModelSettings } from "./use-native-model-settings";
import { NativeModelSettingsPicker } from "./native-model-settings-picker";
const binding = {
  bindingId: "binding",
  chatId: "chat",
  workerId: "worker",
  threadId: "thread",
  runtimeGeneration: "runtime",
  nativeEpoch: "epoch",
  contextKind: "project" as const,
  projectId: "project",
  placementId: "placement",
  modelRouteId: "route-one",
  providerAccountId: "account",
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
const inventory = {
  bindingId: "binding",
  workerId: "worker",
  providerId: "provider",
  providerAccountId: "account",
  providerKind: "chatgpt",
  models: [
    {
      id: "logical",
      routeId: "route-one",
      name: "native-one",
      reasoningEffort: null,
    },
    {
      id: "logical",
      routeId: "route-two",
      name: "private-choice",
      reasoningEffort: null,
    },
  ],
};
function observed() {
  return {
    identity,
    encryption: { status: "ready" },
    confirmed: {
      model: "native-one",
      effort: "native-high",
      serviceTier: "fast",
    } as NativeThreadSettings,
    intents: [],
    state: {
      data: {
        chatId: "chat",
        revision: "1",
        permissionPolicy: null,
        desiredRevision: "0",
        desired: null,
        desiredStatus: null,
        pending: [],
        binding,
        effective: null,
      } as NativeSettingsState,
      error: null,
    },
    decryptionError: null,
  };
}
const cleanups: (() => void)[] = [];
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let controller!: ReturnType<typeof useNativeModelSettings>;
  let open!: (value: boolean) => void;
  function Probe() {
    controller = useNativeModelSettings({
      chatId: "chat",
      enabled: true,
      workerId: "worker",
      projectId: "project",
      placementId: "placement",
      contextKind: "project",
    });
    const [isOpen, setOpen] = useState(false);
    open = setOpen;
    return (
      <NativeModelSettingsPicker
        controller={controller}
        open={isOpen}
        onOpenChange={setOpen}
      />
    );
  }
  let view!: TestRenderer.ReactTestRenderer;
  const render = () => (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
  await act(async () => {
    view = TestRenderer.create(render());
  });
  await flush();
  cleanups.push(() => {
    view.unmount();
    client.clear();
  });
  return {
    view,
    client,
    controller: () => controller,
    open: () => act(async () => open(true)),
    rerender: () => act(async () => view.update(render())),
  };
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.observed = observed();
  runtime.matches.mockReset().mockReturnValue(true);
  runtime.read.mockReset().mockResolvedValue(inventory);
  runtime.prepare
    .mockReset()
    .mockImplementation(async ({ operationId, binding: source }) => ({
      operationId,
      bindingId: source.bindingId,
      protectedPatch: { ciphertext: "opaque" },
    }));
  runtime.sendPermission
    .mockReset()
    .mockImplementation(async ({ request }) => ({
      operationId: request.operationId,
      submissionId: "permission-submission",
      status: "queued",
    }));
  runtime.send.mockReset().mockImplementation(async ({ request }) => ({
    operationId: request.operationId,
    submissionId: "submission",
    status: "queued",
  }));
});
afterEach(async () => {
  await act(async () => cleanups.splice(0).forEach((cleanup) => cleanup()));
});
describe("bound GUI native model picker", () => {
  it("shares one source-owned submission lane across permissions and model/mode controls", async () => {
    const mounted = await mount();
    let release!: (value: unknown) => void;
    runtime.sendPermission.mockImplementation(
      ({ request }) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              operationId: request.operationId,
              submissionId: "permission",
              status: "queued",
            });
        }),
    );
    let submitted!: Promise<unknown>;
    await act(async () => {
      submitted = mounted
        .controller()
        .session.submitPermission(null, "7", "binding");
    });
    expect(runtime.sendPermission.mock.calls[0]![0]).toMatchObject({
      chatId: "chat",
      identity,
      request: { id: null, expectedRevision: "7", bindingId: "binding" },
    });
    await expect(mounted.controller().updateMode("plan")).rejects.toThrow(
      "already being submitted",
    );
    expect(runtime.prepare).not.toHaveBeenCalled();
    await act(async () => {
      release({});
      await submitted;
    });
    expect(mounted.controller().session.localPermission).toMatchObject({
      permissionSelection: { id: null, expectedRevision: "7" },
      status: "queued",
    });
    expect(mounted.controller().observed.confirmed?.model).toBe("native-one");
    await act(async () => {
      await mounted.controller().updateMode("plan");
    });
    expect(runtime.prepare.mock.calls[0]![0].patch).toEqual({
      collaborationModeKind: "plan",
    });
  });
  it.each([
    ["permission-transition-pending", "rejected"],
    ["connection lost", "uncertain"],
  ])(
    "retains %s as %s without repeating native permission input",
    async (message, status) => {
      const mounted = await mount();
      runtime.sendPermission.mockRejectedValue(new Error(message));
      await act(async () => {
        await expect(
          mounted
            .controller()
            .session.submitPermission(":yolo", "0", "binding"),
        ).rejects.toThrow(message);
      });
      expect(mounted.controller().session.localPermission?.status).toBe(status);
      expect(runtime.sendPermission).toHaveBeenCalledTimes(1);
      expect(mounted.controller().session.observed.confirmed?.model).toBe(
        "native-one",
      );
    },
  );

  it.each([
    ["No service tier override", { unsetServiceTier: true }, null],
    ["Standard service", { serviceTier: "default" }, "default"],
  ] as const)(
    "submits %s independently and shows actual confirmed state after reconnect",
    async (buttonLabel, patch, tier) => {
      const mounted = await mount();
      await mounted.open();
      await act(async () => {
        mounted.view.root
          .findAllByType("button")
          .find((button) => button.children.includes(buttonLabel))!
          .props.onClick();
      });
      await act(async () => {
        mounted.view.root
          .findAllByType("button")
          .find((button) => button.children.includes("Save settings"))!
          .props.onClick();
      });
      await flush();
      expect(runtime.prepare.mock.calls[0]![0].patch).toEqual(patch);
      expect(mounted.controller().selected?.serviceTier).toBe(tier);
      const current = observed();
      runtime.observed = {
        ...current,
        identity: { ...identity, generation: 2 },
        confirmed: { ...current.confirmed, serviceTier: tier },
      };
      await mounted.rerender();
      await flush();
      expect(mounted.controller().selected?.serviceTier).toBe(tier);
      expect(mounted.controller().observed.confirmed?.serviceTier).toBe(tier);
      expect(runtime.send).toHaveBeenCalledTimes(1);
    },
  );

  it("lets a replacement source submit while a retired request waits without releasing its successor", async () => {
    const mounted = await mount();
    const finishes: ((value: unknown) => void)[] = [];
    runtime.send.mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    const selection = {
      bindingId: "binding",
      draft: {
        routeId: "route-two",
        model: "private-choice",
        effort: null,
        serviceTier: null,
      },
      dirty: { model: true },
    };
    let retired!: Promise<unknown>;
    let successor!: Promise<unknown>;
    await act(async () => {
      retired = mounted.controller().update.mutateAsync(selection);
    });
    runtime.observed = {
      ...observed(),
      state: {
        ...observed().state,
        data: {
          ...observed().state.data,
          binding: { ...binding, bindingId: "replacement" },
        },
      },
    };
    runtime.read.mockResolvedValue({ ...inventory, bindingId: "replacement" });
    await mounted.rerender();
    await flush();
    await act(async () => {
      successor = mounted
        .controller()
        .update.mutateAsync({ ...selection, bindingId: "replacement" });
    });
    expect(runtime.send).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishes[0]!({
        operationId: runtime.send.mock.calls[0]![0].request.operationId,
        submissionId: "retired",
        status: "queued",
      });
      await retired;
    });
    expect(mounted.controller().update.isPending).toBe(true);
    await act(async () => {
      await expect(
        mounted
          .controller()
          .update.mutateAsync({ ...selection, bindingId: "replacement" }),
      ).rejects.toThrow("already being submitted");
    });
    expect(runtime.send).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishes[1]!({
        operationId: runtime.send.mock.calls[1]![0].request.operationId,
        submissionId: "new",
        status: "queued",
      });
      await successor;
    });
    expect(mounted.controller().localStatus).toBe("queued");
    expect(mounted.controller().update.isPending).toBe(false);
  });

  it("saves child inheritance and enabled state without touching root choices", async () => {
    const current = observed();
    runtime.observed = {
      ...current,
      confirmed: {
        ...current.confirmed,
        multiAgentEnabled: true,
        subagentModel: "private-choice",
        subagentReasoningEffort: "high",
      },
    };
    const mounted = await mount();
    await mounted.open();
    await act(async () => {
      mounted.view.root
        .findByProps({ "aria-label": "Enable subagents" })
        .props.onChange({ target: { checked: false } });
      mounted.view.root
        .findByProps({ "aria-label": "Subagent model" })
        .props.onChange({ target: { value: "" } });
      mounted.view.root
        .findByProps({ "aria-label": "Subagent reasoning effort" })
        .props.onChange({ target: { value: "" } });
    });
    await act(async () => {
      mounted.view.root
        .findAllByType("button")
        .find((button) => button.children.includes("Save settings"))!
        .props.onClick();
    });
    await flush();
    expect(runtime.prepare.mock.calls[0]![0].patch).toEqual({
      multiAgentEnabled: false,
      subagentModel: null,
      subagentReasoningEffort: null,
    });
    expect(mounted.controller().selected).toMatchObject({
      model: "native-one",
      effort: "native-high",
      multiAgentEnabled: false,
      subagentModel: null,
    });
  });
  it("does not republish a delayed submission receipt after the encryption lifetime ends", async () => {
    const mounted = await mount();
    let finish!: (value: unknown) => void;
    runtime.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let operation!: Promise<unknown>;
    await act(async () => {
      operation = mounted.controller().update.mutateAsync({
        bindingId: "binding",
        draft: {
          routeId: "route-two",
          model: "private-choice",
          effort: null,
          serviceTier: null,
        },
        dirty: { model: true },
      });
    });
    runtime.observed = {
      ...observed(),
      encryption: { status: "locked" },
      confirmed: null,
    };
    await mounted.rerender();
    await act(async () => {
      finish({
        operationId: runtime.send.mock.calls[0]![0].request.operationId,
        submissionId: "submission",
        status: "queued",
      });
      await operation;
    });
    expect(mounted.controller().localStatus).toBeNull();
    expect(mounted.controller().selected).toBeNull();
    expect(runtime.send).toHaveBeenCalledOnce();
  });

  it("submits mode-only changes after a pending model choice without losing either desired value", async () => {
    const mounted = await mount();
    await act(async () => {
      await mounted.controller().update.mutateAsync({
        bindingId: "binding",
        draft: {
          routeId: "route-two",
          model: "private-choice",
          effort: null,
          serviceTier: null,
        },
        dirty: { model: true },
      });
    });
    await act(async () => {
      await mounted.controller().updateMode("plan");
    });
    expect(runtime.prepare.mock.calls[1]![0].patch).toEqual({
      collaborationModeKind: "plan",
    });
    expect(mounted.controller().selected).toMatchObject({
      model: "private-choice",
      effort: "native-high",
      collaborationModeKind: "plan",
    });
    expect(runtime.send).toHaveBeenCalledTimes(2);
    runtime.send.mockImplementation(async ({ request }) => ({
      operationId: request.operationId,
      submissionId: "submission",
      status: "uncertain",
    }));
    await act(async () => {
      await expect(mounted.controller().updateMode("default")).rejects.toThrow(
        "not confirmed as queued",
      );
    });
    expect(runtime.send).toHaveBeenCalledTimes(3);
  });

  it("uses the shared explicit path while active, preserving untouched native effort and queued status", async () => {
    const mounted = await mount();
    await mounted.open();
    const model = mounted.view.root.findByProps({
      "aria-label": "Session model",
    });
    expect(model.props.disabled).toBe(false);
    await act(async () =>
      model.props.onChange({ target: { value: "route-two" } }),
    );
    const save = mounted.view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save settings"))!;
    await act(async () => save.props.onClick());
    await flush();
    expect(runtime.prepare).toHaveBeenCalledOnce();
    expect(runtime.prepare.mock.calls[0]![0]).toMatchObject({
      chatId: "chat",
      binding,
      patch: { model: "private-choice" },
    });
    expect(Object.keys(runtime.prepare.mock.calls[0]![0].patch)).toEqual([
      "model",
    ]);
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(mounted.controller().localStatus).toBe("queued");
    expect(mounted.controller().selected).toEqual({
      model: "private-choice",
      effort: "native-high",
      serviceTier: "fast",
    });
    expect(mounted.controller().observed.confirmed!.model).toBe("native-one");
    expect(mounted.client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("does not dispatch after source replacement or silently retry uncertain transport", async () => {
    const mounted = await mount();
    await mounted.open();
    runtime.observed = {
      ...observed(),
      state: {
        ...observed().state,
        data: {
          ...observed().state.data,
          binding: { ...binding, bindingId: "replaced" },
        },
      },
    };
    await mounted.rerender();
    await flush();
    const selection = {
      bindingId: "binding",
      draft: {
        routeId: "route-two",
        model: "private-choice",
        effort: "native-high",
        serviceTier: null,
      },
      dirty: { model: true },
    };
    await act(async () => {
      await expect(
        mounted.controller().update.mutateAsync(selection),
      ).rejects.toThrow("session changed");
    });
    expect(runtime.send).not.toHaveBeenCalled();
    runtime.observed = observed();
    await mounted.rerender();
    await flush();
    runtime.send.mockRejectedValue(new Error("Response lost"));
    await act(async () => {
      await expect(
        mounted.controller().update.mutateAsync(selection),
      ).rejects.toThrow("Response lost");
    });
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(mounted.controller().localStatus).toBe("uncertain");
  });
  it("removes mounted desired and draft plaintext on encryption lock", async () => {
    const mounted = await mount();
    await mounted.open();
    await act(async () => {
      await mounted.controller().update.mutateAsync({
        bindingId: "binding",
        draft: {
          routeId: "route-two",
          model: "private-choice",
          effort: "native-high",
          serviceTier: null,
        },
        dirty: { model: true },
      });
    });
    runtime.observed = {
      ...observed(),
      encryption: { status: "locked" },
      confirmed: null,
    };
    await mounted.rerender();
    await flush();
    expect(mounted.controller().selected).toBeNull();
    expect(mounted.controller().localStatus).toBeNull();
    expect(
      mounted.view.root.findByProps({ "aria-label": "Session model" }).props
        .value,
    ).toBe("");
  });
});
