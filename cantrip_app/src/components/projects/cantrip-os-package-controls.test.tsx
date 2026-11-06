// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CantripOsInstanceSummary,
  CantripOsPackageSummary,
} from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  history: vi.fn(),
  authorize: vi.fn(),
  submit: vi.fn(),
  observeDraft: vi.fn(),
  observe: vi.fn(),
  control: vi.fn(),
  open: vi.fn(),
  identity: {
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
    generation: 1,
  },
  sessions: new Set<() => void>(),
  encryptionListeners: new Set<() => void>(),
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
    return () => {
      mocks.sessions.delete(listener);
    };
  },
}));
vi.mock("@/lib/client-encryption", () => ({
  clientEncryption: {
    getSnapshot: () => mocks.encryption,
    subscribe: (listener: () => void) => {
      mocks.encryptionListeners.add(listener);
      return () => {
        mocks.encryptionListeners.delete(listener);
      };
    },
  },
}));
vi.mock("@/lib/api/cantrip-os-packages", () => ({
  getCantripOsPackages: mocks.inventory,
  getCantripOsPackageOperations: mocks.history,
  authorizeCantripOsPackageWorker: mocks.authorize,
  submitCantripOsPackage: mocks.submit,
  observeCantripOsPackageDraft: mocks.observeDraft,
  observeCantripOsPackageOperation: mocks.observe,
  controlCantripOsPackageOperation: mocks.control,
}));
vi.mock("@/lib/cantrip-os-package-encryption", () => ({
  openCantripOsPackageResult: mocks.open,
}));
import { CantripOsPackageControls } from "./cantrip-os-package-controls";
import { CantripOsPackageEntry } from "./cantrip-os-package-entry";
import {
  readCantripOsPackageDraft,
  cantripOsPackageAccountKey,
} from "@/lib/cantrip-os-package-draft";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = {
  instanceId: id(1),
  generation: id(2),
  workerId: "worker",
  attachmentGeneration: id(3),
  architecture: "amd64",
  verifiedAt: "2026-11-06T00:00:00.000Z",
};
const artifact = {
  name: "cantrip-os-recovery" as const,
  version: "0.5.0",
  architecture: "all",
  sha256: "a".repeat(64),
  bytes: 21484,
};
const instance = {
  id: target.instanceId,
  name: "CantripOS",
  workerId: target.workerId,
  attachmentGeneration: target.attachmentGeneration,
  runtimeGeneration: null,
  status: "disconnected",
} as CantripOsInstanceSummary;
const envelope = {
  version: 1 as const,
  algorithm: "AES-256-GCM" as const,
  keyRevision: 1,
  nonce: "A".repeat(16),
  ciphertext: "A".repeat(22),
};
function summary(operationId = id(4)): CantripOsPackageSummary {
  return {
    operationId,
    instanceId: target.instanceId,
    workerId: target.workerId,
    attachmentGeneration: target.attachmentGeneration,
    targetGeneration: target.generation,
    action: "upgrade",
    configuration: "preserve",
    packages: [artifact],
    state: "unknown",
    phase: "ready-to-install",
    createdAt: target.verifiedAt,
    updatedAt: target.verifiedAt,
    protectedResult: null,
    error: null,
  };
}
let tree: TestRenderer.ReactTestRenderer | undefined,
  client: QueryClient | undefined;
const text = () => JSON.stringify(tree!.toJSON());
const button = (label: string) =>
  tree!.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label)!;
const hasState = (label: string) =>
  tree!.root
    .findAllByType("strong")
    .some((node) => node.children.join("") === label);
async function settle(ms = 10) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
  await settle();
}
async function mount(element?: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client!}>
        {element ?? (
          <CantripOsPackageControls instance={instance} onChanged={() => {}} />
        )}
      </QueryClientProvider>,
    );
  });
  await settle();
}
async function unmount() {
  await act(async () => tree?.unmount());
  tree = undefined;
  client?.clear();
  client = undefined;
}
beforeEach(() => {
  sessionStorage.clear();
  for (const fn of [
    mocks.inventory,
    mocks.history,
    mocks.authorize,
    mocks.submit,
    mocks.observeDraft,
    mocks.observe,
    mocks.control,
    mocks.open,
  ])
    fn.mockReset();
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
  mocks.inventory.mockResolvedValue({
    target,
    installed: [],
    available: [artifact],
    unavailable: 0,
    error: null,
  });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  mocks.authorize.mockResolvedValue(undefined);
});
afterEach(async () => {
  await unmount();
  mocks.sessions.clear();
  mocks.encryptionListeners.clear();
});
async function chooseAndReview() {
  const checkbox = tree!.root
    .findAllByType("input")
    .find((node) => node.props["aria-label"] === "Select cantrip-os-recovery")!;
  await act(async () => checkbox.props.onChange({ target: { checked: true } }));
  await click("Review update");
  expect(text()).toContain("Keep administrator configuration");
  await click("Confirm update");
}
it("allows inventory without an executor and retains exact builds before its first send", async () => {
  mocks.submit.mockImplementation(async (draft) => {
    expect(readCantripOsPackageDraft(instance.id)).toEqual(draft);
    expect(draft.submitted).toBe(true);
    return summary(draft.request.operationId);
  });
  await mount();
  await chooseAndReview();
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(mocks.submit.mock.calls[0]![0].request).toMatchObject({
    action: "upgrade",
    configuration: "preserve",
    packages: [artifact],
  });
  expect(mocks.submit.mock.calls[0]![0].request).not.toHaveProperty(
    "runtimeGeneration",
  );
  expect(mocks.authorize).toHaveBeenCalledWith(
    target.workerId,
    cantripOsPackageAccountKey(),
  );
  expect(
    tree!.root
      .findAllByType("select")
      .some(
        (node) => node.props["aria-label"] === "Build for cantrip-os-recovery",
      ),
  ).toBe(false);
});
it("recovers a lost request after remount by observing the original admission", async () => {
  mocks.submit.mockRejectedValueOnce(new Error("Lost package reply"));
  await mount();
  await chooseAndReview();
  expect(text()).toContain("Lost package reply");
  const saved = readCantripOsPackageDraft(instance.id)!;
  expect(saved.submitted).toBe(true);
  await unmount();
  mocks.observeDraft.mockResolvedValueOnce({
    ...summary(saved.request.operationId),
    state: "ready",
    phase: "complete",
    protectedResult: envelope,
  });
  await mount();
  await click("Check saved package request");
  expect(readCantripOsPackageDraft(instance.id)).toBeNull();
  expect(mocks.observeDraft).toHaveBeenCalledWith(saved);
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  expect(hasState("Update · Completed")).toBe(true);
});
it("polls admitted work only through observation and preserves newer terminal history", async () => {
  const running = {
    ...summary(),
    state: "running" as const,
    phase: "installing",
  };
  const ready = {
    ...running,
    state: "ready" as const,
    phase: "complete",
    protectedResult: envelope,
  };
  mocks.history
    .mockResolvedValueOnce({ items: [running], nextCursor: null })
    .mockResolvedValue({ items: [ready], nextCursor: null });
  mocks.observe.mockResolvedValueOnce(running);
  await mount();
  expect(hasState("Update · In progress")).toBe(true);
  await settle(2600);
  await settle();
  expect(hasState("Update · Completed")).toBe(true);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.control).not.toHaveBeenCalled();
});
it("observes a detached start reservation once without retrying an uncertain installation", async () => {
  const original = { ...summary(), phase: "start-requested" };
  mocks.history.mockResolvedValue({ items: [original], nextCursor: null });
  mocks.observe.mockResolvedValue(original);
  await mount();
  expect(hasState("Update · Outcome unknown")).toBe(true);
  await settle(2700);
  await settle();
  expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(
    original,
    cantripOsPackageAccountKey(),
  );
  await settle(2700);
  expect(mocks.observe).toHaveBeenCalledTimes(1);
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.control).not.toHaveBeenCalled();
}, 10000);
it("withholds opened plaintext immediately when encryption locks", async () => {
  const entry = { ...summary(), protectedResult: envelope };
  mocks.open.mockResolvedValueOnce({
    diagnostic: "Private /root/profile secret",
    record: null,
  });
  await mount(
    <CantripOsPackageEntry
      entry={entry}
      accountKey={cantripOsPackageAccountKey()}
      pending={false}
      canControl={true}
      onRun={() => {}}
    />,
  );
  await click("Inspect private outcome");
  expect(text()).toContain("Private /root/profile secret");
  await act(async () => {
    mocks.encryption = { ...mocks.encryption, status: "locked" };
    for (const listener of mocks.encryptionListeners) listener();
  });
  expect(text()).not.toContain("Private /root/profile secret");
});
it("requires staging-control confirmation and drops replies from a previous account", async () => {
  const entry = summary(),
    run = vi.fn((action: () => Promise<CantripOsPackageSummary>) => {
      void action();
    });
  mocks.control.mockResolvedValue(entry);
  await mount(
    <CantripOsPackageEntry
      entry={entry}
      accountKey={cantripOsPackageAccountKey()}
      pending={false}
      canControl={true}
      onRun={run}
    />,
  );
  await click("Continue staging");
  expect(mocks.control).not.toHaveBeenCalled();
  await click("Confirm continuation");
  expect(mocks.control).toHaveBeenCalledWith(
    entry,
    "continue",
    cantripOsPackageAccountKey(),
  );
  await unmount();
  let finish!: (value: unknown) => void;
  mocks.submit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await chooseAndReview();
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  const saved = readCantripOsPackageDraft(instance.id)!,
    originalIdentity = mocks.identity;
  await act(async () => {
    mocks.identity = { ...mocks.identity, userId: "other", generation: 2 };
    for (const listener of mocks.sessions) listener();
  });
  await act(async () => {
    finish({
      ...summary(saved.request.operationId),
      state: "ready",
      protectedResult: envelope,
    });
  });
  await settle();
  expect(hasState("Update · Completed")).toBe(false);
  expect(readCantripOsPackageDraft(instance.id)).toBeNull();
  mocks.identity = originalIdentity;
  expect(readCantripOsPackageDraft(instance.id)).toEqual(saved);
});
