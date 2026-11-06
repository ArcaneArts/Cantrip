// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CantripOsInstanceSummary,
  CantripOsWorkspaceSummary,
} from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  submit: vi.fn(),
  observe: vi.fn(),
  history: vi.fn(),
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
vi.mock("@/lib/api/cantrip-os-desktop", () => ({
  getCantripOsDesktop: mocks.status,
  getCantripOsDesktopOperations: mocks.list,
  submitCantripOsDesktop: mocks.submit,
  observeCantripOsDesktopDraft: mocks.observe,
  observeCantripOsDesktopOperation: mocks.history,
}));
import { CantripOsDesktopControls } from "./cantrip-os-desktop-controls";
import {
  prepareCantripOsDesktopDraft,
  saveCantripOsDesktopDraft,
  readCantripOsDesktopDraft,
} from "@/lib/cantrip-os-desktop-draft";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  workspaceId: id(4),
  runtimeGeneration: id(5),
  generation: id(2),
  instanceId: id(1),
  workerId: "worker",
  attachmentGeneration: id(3),
  verifiedAt: "2026-11-06T00:00:00.000Z",
};
const instance = {
  id: target.instanceId,
  workerId: target.workerId,
  name: "QA Linux",
  attachmentGeneration: target.attachmentGeneration,
  status: "connected",
  runtimeGeneration: target.runtimeGeneration,
} as CantripOsInstanceSummary;
const workspace = {
  id: target.workspaceId,
  instanceId: instance.id,
  workerId: instance.workerId,
  guestWorkspaceId: "work",
} as CantripOsWorkspaceSummary;
const desktop = {
  target,
  observation: {
    status: "running",
  },
  error: null,
};
function result(draft: ReturnType<typeof prepareCantripOsDesktopDraft>) {
  return {
    ...draft.request,
    instanceId: draft.target.instanceId,
    workspaceId: draft.target.workspaceId,
    workerId: draft.target.workerId,
    state: "ready" as const,
    createdAt: target.verifiedAt,
    updatedAt: target.verifiedAt,
    error: null,
    completionEvidence: "acknowledged-and-observed" as const,
  };
}
let tree: TestRenderer.ReactTestRenderer | undefined, client: QueryClient;
const buttons = () => tree!.root.findAllByType("button");
const button = (label: string) =>
  buttons().find((item) => item.children.join("") === label)!;
const text = () => JSON.stringify(tree!.toJSON());
async function click(label: string) {
  await act(async () => button(label).props.onClick());
  await settle();
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CantripOsDesktopControls
          instance={instance}
          workspace={workspace}
          onChanged={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  await settle();
  await vi.waitFor(() => expect(mocks.status).toHaveBeenCalled());
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
  mocks.status.mockResolvedValue(desktop);
  mocks.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.submit.mockImplementation(async (draft) => result(draft));
  mocks.observe.mockImplementation(async (draft) => result(draft));
});
afterEach(unmount);

it("requires a deliberate action, saves before dispatch and observes the same request after reply loss/reload", async () => {
  mocks.submit.mockImplementationOnce(async (draft) => {
    expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toEqual({
      ...draft,
      submitted: true,
    });
    throw new Error("Desktop reply lost");
  });
  await mount();
  expect(mocks.submit).not.toHaveBeenCalled();
  await click("Restart desktop");
  expect(mocks.submit).not.toHaveBeenCalled();
  await click("Confirm restart");
  const saved = readCantripOsDesktopDraft(instance.id, workspace.id)!;
  expect(saved.submitted).toBe(true);
  expect(text()).toContain("Desktop reply lost");
  await unmount();
  await mount();
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.observe).not.toHaveBeenCalled();
  await click("Observe saved request");
  expect(mocks.observe).toHaveBeenCalledWith(saved);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toBeNull();
  expect(text()).toContain("Completed");
});

it("keeps a prepared request pinned when the current target changes before submission", async () => {
  const saved = prepareCantripOsDesktopDraft(target, "start");
  saveCantripOsDesktopDraft(saved);
  mocks.status.mockResolvedValue({
    ...desktop,
    target: { ...target, generation: id(10) },
  });
  await mount();
  expect(mocks.submit).not.toHaveBeenCalled();
  await click("Submit saved request");
  expect(mocks.submit).toHaveBeenCalledWith({ ...saved, submitted: true });
});

it("retains the target selected at confirmation rather than substituting a refreshed one", async () => {
  await mount();
  await click("Stop desktop");
  mocks.status.mockResolvedValue({
    ...desktop,
    target: { ...target, generation: id(10) },
  });
  await click("Refresh desktop");
  await click("Confirm stop");
  expect(mocks.submit.mock.calls[0]![0].target).toEqual(target);
});

it("keeps a captured target usable with unknown observation and offers no action without a target", async () => {
  mocks.status.mockResolvedValue({
    ...desktop,
    observation: null,
    error: "Captured desktop cannot be observed",
  });
  await mount();
  expect(button("Start desktop").props.disabled).toBeFalsy();
  await unmount();
  mocks.status.mockResolvedValue({
    target: null,
    observation: null,
    error: "Captured desktop unavailable",
  });
  await mount();
  expect(button("Start desktop")).toBeUndefined();
  expect(text()).toContain("Captured desktop unavailable");
});

it("does not present a cached running state as current after observation fails", async () => {
  await mount();
  mocks.status.mockRejectedValue(new Error("Observation unavailable"));
  await click("Refresh desktop");
  expect(text()).toContain("Unverified");
  expect(text()).toContain("Observation unavailable");
  expect(text()).not.toContain("Running");
  expect(button("Stop desktop").props.disabled).toBeFalsy();
});

it("rejects a stale confirmation across a server change even if instance IDs coincide", async () => {
  await mount();
  await click("Restart desktop");
  const oldConfirm = button("Confirm restart").props.onClick;
  await act(async () => {
    mocks.identity = { ...mocks.identity, serverUrl: "http://another-server" };
    for (const changed of mocks.listeners) changed();
  });
  await act(async () => oldConfirm());
  await settle();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toBeNull();
});

it("does not clear a new account's draft or publish the old operation after an in-flight account switch", async () => {
  let resolve!: (value: ReturnType<typeof result>) => void;
  mocks.submit.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await click("Stop desktop");
  await click("Confirm stop");
  const old = readCantripOsDesktopDraft(instance.id, workspace.id)!;
  mocks.identity = { ...mocks.identity, userId: "another-owner" };
  const current = prepareCantripOsDesktopDraft(target, "start");
  saveCantripOsDesktopDraft(current);
  await act(async () => {
    for (const changed of mocks.listeners) changed();
  });
  await act(async () => resolve(result(old)));
  await settle();
  expect(readCantripOsDesktopDraft(instance.id, workspace.id)).toEqual(current);
  expect(text()).not.toContain("Completed");
  expect(mocks.submit).toHaveBeenCalledTimes(1);
});

it("observes historical identities and pages history without issuing a fresh mutation", async () => {
  const recorded = result(
    prepareCantripOsDesktopDraft({ ...target, generation: id(20) }, "stop"),
  );
  mocks.list.mockImplementation(async (_id, _workspace, cursor) =>
    cursor
      ? { items: [], nextCursor: null }
      : { items: [recorded], nextCursor: recorded.operationId },
  );
  mocks.history.mockResolvedValue(recorded);
  await mount();
  await click("Observe operation");
  expect(mocks.history.mock.calls[0]![0]).toEqual(recorded);
  await click("Older desktop operations");
  expect(
    mocks.list.mock.calls.some((call) => call[2] === recorded.operationId),
  ).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
});
