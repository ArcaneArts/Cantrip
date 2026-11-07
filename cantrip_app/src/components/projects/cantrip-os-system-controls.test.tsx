// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CantripOsInstanceSummary } from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  history: vi.fn(),
  authorize: vi.fn(),
  submit: vi.fn(),
  observeDraft: vi.fn(),
  observe: vi.fn(),
  control: vi.fn(),
  recover: vi.fn(),
  open: vi.fn(),
  sessions: new Set<() => void>(),
  encryptionListeners: new Set<() => void>(),
  identity: {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  },
  encryption: {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  },
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => mocks.identity,
  onClientSessionIdentityChanged: (listener: () => void) => {
    mocks.sessions.add(listener);
    return () => mocks.sessions.delete(listener);
  },
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    getSnapshot: () => mocks.encryption,
    subscribe: (listener: () => void) => {
      mocks.encryptionListeners.add(listener);
      return () => mocks.encryptionListeners.delete(listener);
    },
  },
}));
vi.mock("@/lib/cantrip-os-system-encryption", () => ({
  openCantripOsSystemResult: mocks.open,
}));
vi.mock("@/lib/api/cantrip-os-systems", () => ({
  getCantripOsSystem: mocks.status,
  getCantripOsSystemOperations: mocks.history,
  authorizeCantripOsSystemWorker: mocks.authorize,
  submitCantripOsSystem: mocks.submit,
  observeCantripOsSystemDraft: mocks.observeDraft,
  observeCantripOsSystemOperation: mocks.observe,
  controlCantripOsSystemOperation: mocks.control,
  recoverCantripOsSystemOperation: mocks.recover,
}));
import { CantripOsSystemControls } from "./cantrip-os-system-controls";
import {
  cantripOsSystemTestFixture,
  systemTestId as id,
} from "@/lib/cantrip-os-system-test-fixture";
import {
  readCantripOsSystemDraft,
  prepareCantripOsSystemDraft,
  saveCantripOsSystemDraft,
  type CantripOsSystemDraft,
} from "@/lib/cantrip-os-system-draft";
const f = cantripOsSystemTestFixture();
let root: Root | undefined, host: HTMLDivElement, client: QueryClient;
const text = () => host.textContent ?? "";
function button(label: string, within: ParentNode = host) {
  const value = [...within.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!value) throw new Error(`Missing button ${label}: ${text()}`);
  return value;
}
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10);
    else await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
async function click(label: string, within?: ParentNode) {
  await act(async () => button(label, within).click());
  await settle();
}
async function render(instance = f.instance) {
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <CantripOsSystemControls instance={instance} onChanged={() => {}} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
async function mount(instance = f.instance) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render(instance);
}
async function unmount() {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  client?.clear();
}
function outcome(
  draft: CantripOsSystemDraft,
  state: typeof f.summary.state = "unknown",
) {
  return {
    ...f.summary,
    request: draft.request,
    operationId: draft.request.operationId,
    state,
    context: { ...f.context, operationId: draft.request.operationId },
  };
}
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  for (const key of [
    "status",
    "history",
    "authorize",
    "submit",
    "observeDraft",
    "observe",
    "control",
    "recover",
    "open",
  ] as const)
    mocks[key].mockReset();
  mocks.identity = {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  };
  mocks.encryption = {
    status: "ready",
    identity: { ownerId: "owner", serverId: "server" },
    masterKeyRevision: 1,
  };
  mocks.status.mockImplementation(
    async (instance: CantripOsInstanceSummary) => ({
      supported: true,
      target: {
        ...f.target,
        instanceId: instance.id,
        workerId: instance.workerId,
        attachmentGeneration: instance.attachmentGeneration,
      },
      bases: [
        {
          imageId: f.physical.imageId,
          architecture: "amd64",
          tags: ["cantrip-os:test"],
        },
      ],
      error: null,
    }),
  );
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  mocks.sessions.clear();
  mocks.encryptionListeners.clear();
});
it("saves before grants and first send, then recovers the same admission after reload without another create", async () => {
  mocks.authorize.mockImplementation(async () =>
    expect(readCantripOsSystemDraft(f.instance.id)?.submitted).toBe(false),
  );
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) => {
    expect(readCantripOsSystemDraft(f.instance.id)).toEqual(draft);
    throw new Error("Lost reply");
  });
  await mount();
  await click("Create system checkpoint");
  expect(text()).toContain("Mounted files are excluded");
  await click("Confirm system action");
  const saved = readCantripOsSystemDraft(f.instance.id)!;
  expect(saved.submitted).toBe(true);
  expect(mocks.submit).toHaveBeenCalledOnce();
  await unmount();
  mocks.observeDraft.mockResolvedValue(outcome(saved, "ready"));
  await mount({ ...f.instance, attachmentGeneration: id(9) });
  await click("Observe saved system request");
  expect(mocks.observeDraft).toHaveBeenCalledWith(saved);
  expect(mocks.submit).toHaveBeenCalledOnce();
  expect(readCantripOsSystemDraft(f.instance.id)).toBeNull();
  expect(text()).toContain(
    "Latest recorded action: System checkpoint · Completed",
  );
});
it("clears an obsolete review when attachment changes and does not create anything", async () => {
  await mount();
  await click("Create system checkpoint");
  expect(
    host.querySelector('[aria-label="Review system action"]'),
  ).not.toBeNull();
  await render({ ...f.instance, attachmentGeneration: id(20) });
  expect(host.querySelector('[aria-label="Review system action"]')).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.authorize).not.toHaveBeenCalled();
});
it("distinguishes a base reset from checkpoint preservation and retains the exact selected base", async () => {
  const observed = await mocks.status(f.instance);
  observed.bases[0].tags = ["<none>:<none>"];
  mocks.status.mockResolvedValue(observed);
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) =>
    outcome(draft, "ready"),
  );
  await mount();
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="System base image"]',
  )!;
  expect(select.textContent).toContain(f.physical.imageId.slice(7, 19));
  expect(select.textContent).not.toContain("<none>:<none>");
  await act(async () => {
    select.value = f.physical.imageId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Reset system to base image");
  expect(text()).toContain("Root customization does not merge");
  await click("Confirm system action");
  expect(mocks.submit.mock.calls[0]![0].request).toMatchObject({
    action: "replace",
    source: { kind: "base", imageId: f.physical.imageId },
  });
});
it("prepares rollback against the original replacement target even without a current helper observation", async () => {
  const replacement = {
    ...f.summary,
    request: {
      operationId: f.context.operationId,
      attachmentGeneration: f.context.attachmentGeneration,
      targetGeneration: f.context.targetGeneration,
      action: "replace" as const,
      source: { kind: "base" as const, imageId: f.physical.imageId },
      startTarget: true,
    },
  };
  mocks.status.mockResolvedValue({
    supported: true,
    target: null,
    bases: [],
    error: "Guest helper unavailable",
  });
  mocks.history.mockResolvedValue({ items: [replacement], nextCursor: null });
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) =>
    outcome(draft),
  );
  await mount({ ...f.instance, attachmentGeneration: id(21) });
  await click("Roll back replacement");
  expect(text()).toContain("exact original container");
  await click("Confirm system action");
  expect(mocks.submit.mock.calls[0]![0].request).toMatchObject({
    action: "rollback",
    replacementOperationId: replacement.operationId,
    attachmentGeneration: id(21),
    targetGeneration: replacement.targetGeneration,
  });
});
it("automatically observes uncertainty once without continuing or repeating execution", async () => {
  vi.useFakeTimers();
  mocks.history.mockResolvedValue({ items: [f.summary], nextCursor: null });
  mocks.observe.mockResolvedValue(f.summary);
  await mount({
    ...f.instance,
    attachmentGeneration: f.summary.attachmentGeneration,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2600);
  });
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  await settle();
  expect(mocks.observe).toHaveBeenCalledOnce();
  expect(mocks.control).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});
it("withholds late results when the account changes and preserves the old account's saved request", async () => {
  let complete!: (value: unknown) => void;
  mocks.submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await mount();
  await click("Create system checkpoint");
  await click("Confirm system action");
  const saved = readCantripOsSystemDraft(f.instance.id)!;
  await act(async () => {
    mocks.identity = { ...mocks.identity, userId: "other" };
    for (const listener of mocks.sessions) listener();
  });
  await act(async () => complete(outcome(saved, "ready")));
  await settle();
  expect(text()).not.toContain(saved.request.operationId);
  expect(mocks.submit).toHaveBeenCalledOnce();
  mocks.identity = { ...mocks.identity, userId: "owner" };
  expect(readCantripOsSystemDraft(f.instance.id)).toEqual(saved);
});
it("hides decrypted outcomes immediately when encryption locks", async () => {
  const entry = {
    ...f.summary,
    state: "ready",
    protectedResult: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "A".repeat(16),
      ciphertext: "A".repeat(22),
    },
  };
  mocks.history.mockResolvedValue({ items: [entry], nextCursor: null });
  mocks.open.mockResolvedValue({ diagnostic: "PRIVATE_ROOT_雪" });
  await mount();
  await click("Inspect private outcome");
  expect(text()).toContain("PRIVATE_ROOT_雪");
  await act(async () => {
    mocks.encryption = { ...mocks.encryption, status: "locked" };
    for (const listener of mocks.encryptionListeners) listener();
  });
  expect(text()).not.toContain("PRIVATE_ROOT_雪");
  expect(text()).toContain("Unlock encryption");
});
it("offers abandonment only before execution on the current fence", async () => {
  const prepared = {
    ...f.summary,
    dispatchStage: "preparing" as const,
    phase: "prepared",
  };
  mocks.history.mockResolvedValue({ items: [prepared], nextCursor: null });
  mocks.control.mockResolvedValue({
    ...prepared,
    state: "rejected",
    phase: "not-dispatched",
  });
  await mount();
  expect(text()).not.toContain("Abandon before execution");
  await render({
    ...f.instance,
    attachmentGeneration: prepared.attachmentGeneration,
  });
  await click("Abandon before execution");
  expect(mocks.control.mock.calls[0]!.slice(0, 2)).toEqual([
    prepared,
    "abandon",
  ]);
  expect(text()).toContain("Not dispatched");
});
it("requires an explicit completed-target recovery and keeps runtime/source recovery separate", async () => {
  const replacement = {
    ...f.summary,
    state: "ready",
    phase: "complete",
    request: {
      operationId: f.context.operationId,
      attachmentGeneration: f.context.attachmentGeneration,
      targetGeneration: f.context.targetGeneration,
      action: "replace" as const,
      source: { kind: "base" as const, imageId: f.physical.imageId },
      startTarget: true,
    },
    root: {
      requestSha256: "c".repeat(64),
      originalContainerId: f.context.containerId,
      targetContainerId: "d".repeat(64),
      retainedContainerId: f.context.containerId,
      runtimeHandlesRestored: false,
      guestInstanceId: id(30),
      guestAttachment: "unattached",
    },
  };
  mocks.history.mockResolvedValue({ items: [replacement], nextCursor: null });
  mocks.recover.mockResolvedValue({
    ...f.instance,
    attachmentGeneration: id(31),
    guestInstanceId: id(30),
    runtimeGeneration: null,
  });
  await mount({
    ...f.instance,
    attachmentGeneration: replacement.attachmentGeneration,
  });
  expect(host.querySelector("details")?.open).toBe(true);
  expect(mocks.recover).not.toHaveBeenCalled();
  await click("Recover resulting system");
  expect(mocks.recover).toHaveBeenCalledOnce();
  expect(text()).toContain("Use Check recovery and verify the intended source");
  expect(mocks.submit).not.toHaveBeenCalled();
  await render({ ...f.instance, attachmentGeneration: id(31) });
  expect(host.querySelector("details")?.open).toBe(false);
});
it("can select an older completed checkpoint after loading history", async () => {
  const older = {
    ...f.summary,
    operationId: id(40),
    context: { ...f.context, operationId: id(40) },
    request: { ...f.request, operationId: id(40) },
    state: "ready",
    phase: "complete",
  };
  mocks.history.mockImplementation(async (_instance, cursor) =>
    cursor
      ? { items: [older], nextCursor: null }
      : { items: [], nextCursor: id(41) },
  );
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) =>
    outcome(draft, "ready"),
  );
  await mount();
  await click("Load older system operations");
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="System checkpoint"]',
  )!;
  await act(async () => {
    select.value = older.operationId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Restore system checkpoint");
  await click("Confirm system action");
  expect(mocks.submit.mock.calls[0]![0].request).toMatchObject({
    action: "replace",
    source: { kind: "checkpoint", operationId: older.operationId },
  });
});
it("keeps Docker history readable on an SSH-only attachment without offering image replacement", async () => {
  mocks.status.mockResolvedValue({
    supported: false,
    target: null,
    bases: [],
    error: null,
  });
  const replacement = {
    ...f.summary,
    request: {
      operationId: f.context.operationId,
      attachmentGeneration: f.context.attachmentGeneration,
      targetGeneration: f.context.targetGeneration,
      action: "replace" as const,
      source: { kind: "base" as const, imageId: f.physical.imageId },
      startTarget: true,
    },
  };
  mocks.history.mockResolvedValue({ items: [replacement], nextCursor: null });
  await mount({
    ...f.instance,
    attachmentGeneration: replacement.attachmentGeneration,
  });
  expect(text()).toContain("SSH alone cannot replace");
  expect(text()).not.toContain("Roll back replacement");
  expect(text()).not.toContain("Create system checkpoint");
  expect(button("Check original operation")).toBeDefined();
});
it("can roll back its saved uncertain replacement without discarding the recovery reference first", async () => {
  const saved = {
    ...prepareCantripOsSystemDraft(f.destination, {
      action: "replace",
      source: { kind: "base", imageId: f.physical.imageId },
      startTarget: true,
    }),
    submitted: true,
  };
  saveCantripOsSystemDraft(saved);
  const original = outcome(saved);
  mocks.history.mockResolvedValue({ items: [original], nextCursor: null });
  mocks.observeDraft.mockResolvedValue(original);
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) => {
    expect(readCantripOsSystemDraft(f.instance.id)).toEqual(draft);
    const rolledBack = outcome(draft, "ready");
    mocks.history.mockResolvedValue({
      items: [
        { ...original, retiredBy: draft.request.operationId },
        rolledBack,
      ],
      nextCursor: null,
    });
    return rolledBack;
  });
  await mount({
    ...f.instance,
    attachmentGeneration: original.attachmentGeneration,
  });
  await click("Observe saved system request");
  await click("Roll back replacement");
  expect(button("Confirm system action").disabled).toBe(false);
  await click("Confirm system action");
  expect(mocks.submit.mock.calls[0]![0].request).toMatchObject({
    action: "rollback",
    replacementOperationId: original.operationId,
  });
  expect(mocks.submit.mock.calls[0]![0].request.operationId).not.toBe(
    original.operationId,
  );
  const article = host.querySelector(
    `[aria-label="System operation ${original.operationId}"]`,
  )!;
  expect(article.textContent).toContain("rollback retired this replacement");
  expect(article.textContent).not.toContain("Continue original operation");
});
it("resumes the same unsent request after encryption authorization fails", async () => {
  mocks.authorize.mockRejectedValueOnce(
    new Error("Unlock encryption for this account"),
  );
  mocks.submit.mockImplementation(async (draft: CantripOsSystemDraft) =>
    outcome(draft, "ready"),
  );
  await mount();
  await click("Create system checkpoint");
  await click("Confirm system action");
  const saved = readCantripOsSystemDraft(f.instance.id)!;
  expect(saved.submitted).toBe(false);
  expect(mocks.submit).not.toHaveBeenCalled();
  mocks.authorize.mockResolvedValue(undefined);
  await click("Send saved system request");
  expect(mocks.submit).toHaveBeenCalledOnce();
  expect(mocks.submit.mock.calls[0]![0].request.operationId).toBe(
    saved.request.operationId,
  );
});
