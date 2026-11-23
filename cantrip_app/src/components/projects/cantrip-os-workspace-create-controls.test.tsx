// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  submit: vi.fn(),
  observe: vi.fn(),
  history: vi.fn(),
  changed: vi.fn(),
  identity: {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
  },
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => mocks.identity,
  onClientSessionIdentityChanged: (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock("@/lib/api/cantrip-os-workspace-operations", () => ({
  getCantripOsWorkspaceOperations: mocks.list,
  submitCantripOsWorkspaceCreate: mocks.submit,
  observeCantripOsWorkspaceCreateDraft: mocks.observe,
  observeCantripOsWorkspaceOperation: mocks.history,
}));
import { CantripOsWorkspaceCreateControls } from "./cantrip-os-workspace-create-controls";
import {
  prepareCantripOsWorkspaceCreateDraft,
  saveCantripOsWorkspaceCreateDraft,
  readCantripOsWorkspaceCreateDraft,
} from "@/lib/cantrip-os-workspace-create-draft";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instance = {
  id: id(1),
  workerId: "worker",
  name: "QA Linux",
  attachmentGeneration: id(2),
  runtimeGeneration: id(3),
  status: "connected",
} as CantripOsInstanceSummary;
const at = "2026-11-06T00:00:00.000Z";
function summary(
  draft: ReturnType<typeof prepareCantripOsWorkspaceCreateDraft>,
) {
  return {
    ...draft.target,
    operationId: draft.request.operationId,
    guestWorkspaceId: draft.request.guestWorkspaceId,
    state: "ready" as const,
    result: null,
    createdAt: at,
    updatedAt: at,
  };
}
let tree: TestRenderer.ReactTestRenderer | undefined, client: QueryClient;
const button = (label: string) =>
  tree!.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label)!;
const text = () => JSON.stringify(tree!.toJSON());
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
  await settle();
}
async function submit() {
  await act(async () =>
    tree!.root.findByType("form").props.onSubmit({ preventDefault() {} }),
  );
  await settle();
}
async function mount(target = instance) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CantripOsWorkspaceCreateControls
          instance={target}
          onChanged={mocks.changed}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
}
async function unmount() {
  await act(async () => tree?.unmount());
  tree = undefined;
  client?.clear();
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.listeners.clear();
  mocks.identity = {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
  };
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.submit.mockImplementation(async (draft) => summary(draft));
  mocks.observe.mockImplementation(async (draft) => summary(draft));
});
afterEach(unmount);

it("saves submitted intent before HTTP and observes the same request after reply loss and reload", async () => {
  mocks.submit.mockImplementationOnce(async (draft) => {
    expect(readCantripOsWorkspaceCreateDraft(instance.id)).toEqual({
      ...draft,
      submitted: true,
    });
    throw new Error("Creation reply lost");
  });
  await mount();
  expect(mocks.submit).not.toHaveBeenCalled();
  await submit();
  const draft = readCantripOsWorkspaceCreateDraft(instance.id)!;
  expect(draft.submitted).toBe(true);
  expect(text()).toContain("Creation reply lost");
  await unmount();
  await mount();
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.observe).not.toHaveBeenCalled();
  await click("Observe saved request");
  expect(mocks.observe).toHaveBeenCalledWith(draft);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toBeNull();
  expect(text()).toContain("Completed");
});
it("observes original intent after the instance attachment changes", async () => {
  const draft = {
    ...prepareCantripOsWorkspaceCreateDraft(instance, "original"),
    submitted: true,
  };
  saveCantripOsWorkspaceCreateDraft(draft);
  await mount({
    ...instance,
    attachmentGeneration: id(8),
    runtimeGeneration: id(9),
  });
  await click("Observe saved request");
  expect(mocks.observe).toHaveBeenCalledWith(draft);
  expect(mocks.submit).not.toHaveBeenCalled();
});
it("does not turn missing receipts into another create", async () => {
  const draft = {
    ...prepareCantripOsWorkspaceCreateDraft(instance, "original"),
    submitted: true,
  };
  saveCantripOsWorkspaceCreateDraft(draft);
  mocks.observe.mockResolvedValue({ ...summary(draft), state: "unknown" });
  await mount();
  await click("Observe saved request");
  await click("Observe saved request");
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toEqual(draft);
  expect(button("Create workspace").props.disabled).toBe(true);
  expect(text()).toContain("Outcome unknown");
});
it("submits a retained unsent request once and dismisses only the local record", async () => {
  const draft = prepareCantripOsWorkspaceCreateDraft(instance, "prepared");
  saveCantripOsWorkspaceCreateDraft(draft);
  await mount();
  await click("Submit saved request");
  expect(mocks.submit).toHaveBeenCalledWith({ ...draft, submitted: true });
  const other = {
    ...prepareCantripOsWorkspaceCreateDraft(instance, "another"),
    submitted: true,
  };
  saveCantripOsWorkspaceCreateDraft(other);
  await unmount();
  await mount();
  await click("Dismiss saved request");
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.observe).not.toHaveBeenCalled();
  expect(mocks.history).not.toHaveBeenCalled();
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toBeNull();
});
it("ignores completion after an account switch and preserves the original saved request", async () => {
  let finish!: (value: unknown) => void;
  mocks.submit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await submit();
  const original = readCantripOsWorkspaceCreateDraft(instance.id)!;
  await act(async () => {
    mocks.identity.userId = "other";
    for (const listener of mocks.listeners) listener();
  });
  await settle();
  await act(async () => finish(summary(original)));
  await settle();
  expect(mocks.changed).not.toHaveBeenCalled();
  expect(text()).not.toContain("Completed");
  mocks.identity.userId = "owner";
  expect(readCantripOsWorkspaceCreateDraft(instance.id)).toEqual(original);
});
it("does not dispatch twice while creation is pending", async () => {
  let finish!: (value: unknown) => void;
  mocks.submit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await submit();
  await submit();
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  const draft = readCantripOsWorkspaceCreateDraft(instance.id)!;
  await act(async () => finish(summary(draft)));
  await settle();
});
it("paginates history and observes the original history item", async () => {
  const draft = prepareCantripOsWorkspaceCreateDraft(instance, "older"),
    entry = summary(draft);
  mocks.list.mockImplementation(async (_id, cursor) => ({
    items: cursor ? [] : [entry],
    nextCursor: cursor ? null : id(8),
  }));
  mocks.history.mockResolvedValue(entry);
  await mount();
  await click("Observe creation");
  expect(mocks.history).toHaveBeenCalledWith(entry, draft.accountKey);
  await click("Load older creations");
  expect(mocks.list.mock.calls.some((call) => call[1] === id(8))).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
});
