// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CantripOsInstanceSummary,
  CantripOsWorkspaceSummary,
} from "@cantrip/protocol";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  recover: vi.fn(),
  create: vi.fn(),
  refresh: vi.fn(),
  legacyObserve: vi.fn(),
}));
const identity = vi.hoisted(() => ({
  owner: "owner",
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/client-session", () => ({
  onClientSessionIdentityChanged: (listener: () => void) => {
    identity.listeners.add(listener);
    return () => identity.listeners.delete(listener);
  },
  getClientSessionIdentitySnapshot: () => ({
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: identity.owner,
  }),
}));
vi.mock("@/lib/api/cantrip-os-backups", () => ({
  getCantripOsBackupOperations: api.list,
  prepareCantripOsBackup: api.prepare,
  submitCantripOsBackup: api.submit,
  recoverCantripOsBackup: api.recover,
}));
vi.mock("@/lib/api/cantrip-os", () => ({
  createCantripOsWorkspace: api.create,
  refreshCantripOs: api.refresh,
}));
vi.mock("@/lib/api/cantrip-os-workspace-operations", () => ({
  observeLegacyCantripOsRestoreWorkspace: api.legacyObserve,
}));
vi.mock("./cantrip-os-backup-entry", () => ({
  CantripOsBackupEntry: ({
    entry,
    onRestore,
    onRecover,
  }: {
    entry: unknown;
    onRestore(entry: unknown): void;
    onRecover(entry: unknown, mode: "recover"): void;
  }) => (
    <>
      <button onClick={() => onRestore(entry)}>Restore backup</button>
      <button onClick={() => onRecover(entry, "recover")}>
        Recover interrupted operation
      </button>
    </>
  ),
}));
import {
  cantripOsBackupAccountKey,
  saveCantripOsBackupDraft,
} from "@/lib/cantrip-os-backup-draft";
import { CantripOsBackupControls } from "./cantrip-os-backup-controls";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const instance = {
  id: id(1),
  name: "QA Linux",
  workerId: "worker",
  attachmentGeneration: id(2),
  runtimeGeneration: id(3),
} as CantripOsInstanceSummary;
const workspace = {
  id: id(4),
  instanceId: id(1),
  guestWorkspaceId: "work",
  uid: 2000,
  gid: 2000,
  homeGuestPath: "/home/work",
} as CantripOsWorkspaceSummary;
const restored = { ...workspace, id: id(5), guestWorkspaceId: "restored" };
const frame = {
  kind: "metadata",
  sequence: 1,
  envelope: {
    version: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
const admission = {
  action: "capture",
  operationId: id(6),
  workspaceId: workspace.id,
  attachmentGeneration: id(2),
  runtimeGeneration: id(3),
  protectedRequest: frame,
};
let tree: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;
function button(text: string) {
  return tree!.root
    .findAllByType("button")
    .find((item) => item.children.join("") === text)!;
}
function formFor(text: string) {
  return tree!.root
    .findAllByType("form")
    .find((form) =>
      form
        .findAllByType("button")
        .some((item) => item.children.join("") === text),
    )!;
}
function resetReview() {
  return formFor("Review reset");
}
function labelInput(text: string) {
  return tree!.root
    .findAllByType("label")
    .find((item) => item.children[0] === text)!
    .findByType("input");
}
async function mount() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CantripOsBackupControls
          instance={instance}
          workspace={workspace}
          workspaces={[workspace, restored]}
          onChanged={() => {}}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(
      client.getQueryState([
        "cantrip-os-backup-operations",
        cantripOsBackupAccountKey(),
      ])?.status,
    ).toBe("success");
    const page = await api.list.mock.results.at(-1)!.value;
    if (page.items.length) expect(button("Restore backup")).toBeDefined();
  });
}
async function unmount() {
  await act(async () => tree?.unmount());
  tree = undefined;
  client?.clear();
}
beforeEach(() => {
  vi.resetAllMocks();
  identity.owner = "owner";
  identity.listeners.clear();
  sessionStorage.clear();
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.refresh.mockResolvedValue({
    instance,
    workspaces: [workspace, restored],
  });
  api.prepare.mockResolvedValue(admission);
  api.submit.mockResolvedValue({
    operationId: id(6),
    result: { state: "ready" },
  });
});
afterEach(unmount);

it("resumes the exact encrypted capture after response loss and component reload without preparing a new operation", async () => {
  api.submit.mockRejectedValueOnce(new Error("Reply lost"));
  await mount();
  await act(async () => {
    labelInput("Backup label").props.onChange({
      target: { value: "Secret label" },
    });
  });
  await act(async () => {
    formFor("Capture workspace").props.onSubmit({ preventDefault() {} });
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain(
    "Secret label",
  );
  expect(api.prepare).toHaveBeenCalledWith(
    instance,
    expect.objectContaining({ label: "Secret label" }),
  );
  await unmount();
  await mount();
  await act(async () => {
    button("Resume saved request").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
  });
  expect(api.submit.mock.calls[0]).toEqual(api.submit.mock.calls[1]);
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});

it("restores to a new workspace by default and resumes its original account creation after a lost response", async () => {
  const backup = {
    operationId: id(7),
    action: "capture",
    instanceId: instance.id,
  };
  api.list.mockResolvedValue({ items: [backup], nextCursor: null });
  api.create
    .mockRejectedValueOnce(new Error("Creation reply lost"))
    .mockResolvedValue({
      state: "ready",
      receipt: { kind: "workspace", workspace: restored },
    });
  api.prepare.mockResolvedValue({
    ...admission,
    action: "restore",
    workspaceId: restored.id,
    backupId: id(7),
    replace: false,
  });
  await mount();
  await act(async () => {
    button("Restore backup").props.onClick();
  });
  expect(tree!.root.findByType("select").props.value).toBe("");
  await act(async () => {
    labelInput("New restore workspace ID").props.onChange({
      target: { value: "restored" },
    });
  });
  await act(async () => {
    formFor("Restore workspace").props.onSubmit({ preventDefault() {} });
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.submit).not.toHaveBeenCalled();
  const saved = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
  expect(saved.stage).toBe("workspace");
  expect(saved.createRequest).toMatchObject({
    operationId: saved.operationId,
    guestWorkspaceId: "restored",
    attachmentGeneration: instance.attachmentGeneration,
    runtimeGeneration: instance.runtimeGeneration,
  });
  expect(api.create.mock.calls[0]).toEqual([instance.id, saved.createRequest]);
  await unmount();
  await mount();
  await act(async () => {
    button("Resume saved request").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1]);
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith(instance, {
    action: "restore",
    workspaceId: restored.id,
    backupId: id(7),
    replace: false,
  });
  expect(sessionStorage.length).toBe(0);
});

it("requires deliberate replacement and serializes rapid duplicate submissions", async () => {
  api.list.mockResolvedValue({
    items: [{ operationId: id(7), action: "capture" }],
    nextCursor: null,
  });
  let release!: () => void;
  api.prepare.mockImplementation(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
    return { ...admission, action: "restore", backupId: id(7), replace: true };
  });
  await mount();
  await act(async () => {
    button("Restore backup").props.onClick();
  });
  await act(async () => {
    tree!.root
      .findByType("select")
      .props.onChange({ target: { value: workspace.id } });
  });
  expect(button("Restore workspace").props.disabled).toBe(true);
  await act(async () => {
    formFor("Restore workspace")
      .findByProps({ type: "checkbox" })
      .props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    const submit = formFor("Restore workspace").props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
    release();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(api.create).not.toHaveBeenCalled();
  expect(api.prepare).toHaveBeenCalledWith(instance, {
    action: "restore",
    workspaceId: workspace.id,
    backupId: id(7),
    replace: true,
  });
});

async function reviewReset(paths = ".config/chromium") {
  await act(async () => {
    resetReview()
      .findByType("textarea")
      .props.onChange({ target: { value: paths } });
  });
  await act(async () => {
    resetReview().props.onSubmit({ preventDefault() {} });
  });
}
it("requires explicit reset review, retains unknown encrypted requests and resumes the same admission after reload", async () => {
  api.prepare.mockResolvedValue({ ...admission, action: "reset" });
  api.submit
    .mockResolvedValueOnce({ operationId: id(6), result: { state: "unknown" } })
    .mockResolvedValue({ operationId: id(6), result: { state: "ready" } });
  await mount();
  await reviewReset("../etc");
  expect(api.prepare).not.toHaveBeenCalled();
  expect(button("Confirm reset")).toBeUndefined();
  await reviewReset();
  expect(api.prepare).not.toHaveBeenCalled();
  await act(async () => {
    button("Confirm reset").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith(instance, {
    action: "reset",
    workspaceId: workspace.id,
    paths: [".config/chromium"],
  });
  expect(sessionStorage.length).toBe(1);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain(
    ".config/chromium",
  );
  await unmount();
  await mount();
  await act(async () => {
    button("Resume saved request").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(sessionStorage.length).toBe(0));
  });
  expect(api.submit.mock.calls[0]).toEqual(api.submit.mock.calls[1]);
  expect(api.prepare).toHaveBeenCalledOnce();
});
it("requires confirmation for a whole-home reset", async () => {
  api.prepare.mockResolvedValue({ ...admission, action: "reset" });
  await mount();
  await act(async () => {
    resetReview()
      .findByProps({ type: "checkbox" })
      .props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    resetReview().props.onSubmit({ preventDefault() {} });
  });
  expect(api.submit).not.toHaveBeenCalled();
  await act(async () => {
    button("Confirm reset").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(api.prepare).toHaveBeenCalledWith(instance, {
    action: "reset",
    workspaceId: workspace.id,
    paths: ["."],
  });
  expect(button("Confirm reset")).toBeUndefined();
});
it("does not reset when the actual runtime changed after confirmation", async () => {
  api.refresh.mockResolvedValue({
    instance: { ...instance, runtimeGeneration: id(30) },
    workspaces: [workspace],
  });
  await mount();
  await reviewReset();
  await act(async () => {
    button("Confirm reset").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        tree!.root
          .findAllByProps({ role: "alert" })
          .some((node) => node.children.join("").includes("runtime changed")),
      ).toBe(true),
    );
  });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.submit).not.toHaveBeenCalled();
});
it("does not publish or erase another account's draft when preparation finishes after an identity change", async () => {
  let release!: (value: unknown) => void;
  api.prepare.mockImplementation(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  await mount();
  await reviewReset();
  await act(async () => {
    button("Confirm reset").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledOnce());
  });
  await act(async () => {
    identity.owner = "other";
    for (const listener of identity.listeners) listener();
  });
  saveCantripOsBackupDraft({
    stage: "admission",
    instanceId: instance.id,
    admission: { ...admission, operationId: id(31) } as never,
  });
  await act(async () => {
    release({ ...admission, action: "reset" });
  });
  expect(api.submit).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(1);
  expect(
    JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).admission
      .operationId,
  ).toBe(id(31));
});
it.each([true, false])(
  "legacy restore plans observe their original creation only; available=%s",
  async (available) => {
    saveCantripOsBackupDraft({
      stage: "workspace",
      instanceId: instance.id,
      attachmentGeneration: instance.attachmentGeneration,
      backupId: id(7),
      guestWorkspaceId: "restored",
      operationId: id(8),
    });
    if (available)
      api.legacyObserve.mockResolvedValue({
        result: {
          state: "ready",
          receipt: { kind: "workspace", workspace: restored },
        },
      });
    else
      api.legacyObserve.mockRejectedValue(
        new Error("Original admission unavailable"),
      );
    api.prepare.mockResolvedValue({
      ...admission,
      action: "restore",
      workspaceId: restored.id,
      backupId: id(7),
      replace: false,
    });
    await mount();
    await act(async () => {
      button("Resume saved request").props.onClick();
    });
    await act(async () => {
      await vi.waitFor(() => expect(api.legacyObserve).toHaveBeenCalledOnce());
    });
    expect(api.create).not.toHaveBeenCalled();
    if (available)
      await act(async () => {
        await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
      });
    else {
      expect(api.prepare).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      expect(sessionStorage.length).toBe(1);
    }
  },
);

it("allows explicit history recovery while its exact local request is retained and clears only the recovered terminal admission", async () => {
  saveCantripOsBackupDraft({
    stage: "admission",
    instanceId: instance.id,
    admission: { ...admission, action: "reset" } as never,
  });
  api.list.mockResolvedValue({
    items: [
      {
        operationId: admission.operationId,
        action: "reset",
        instanceId: instance.id,
      },
    ],
    nextCursor: null,
  });
  api.recover.mockResolvedValue({
    operationId: admission.operationId,
    result: { state: "ready" },
  });
  await mount();
  await act(async () => {
    button("Recover interrupted operation").props.onClick();
  });
  await act(async () => {
    await vi.waitFor(() => expect(sessionStorage.length).toBe(0));
  });
  expect(api.recover).toHaveBeenCalledOnce();
  expect(api.submit).not.toHaveBeenCalled();
  expect(api.prepare).not.toHaveBeenCalled();
});
