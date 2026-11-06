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
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
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
vi.mock("./cantrip-os-backup-entry", () => ({
  CantripOsBackupEntry: ({
    entry,
    onRestore,
  }: {
    entry: unknown;
    onRestore(entry: unknown): void;
  }) => <button onClick={() => onRestore(entry)}>Restore backup</button>,
}));
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
    expect(client.getQueryState(["cantrip-os-backup-operations"])?.status).toBe(
      "success",
    );
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
  sessionStorage.clear();
  api.list.mockResolvedValue({ items: [], nextCursor: null });
  api.refresh.mockResolvedValue({
    instance,
    workspaces: [workspace, restored],
  });
  api.prepare.mockResolvedValue(admission);
  api.submit.mockResolvedValue({ operationId: id(6), state: "ready" });
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
    tree!.root.findByType("form").props.onSubmit({ preventDefault() {} });
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
    tree!.root
      .findAllByType("form")[1]!
      .props.onSubmit({ preventDefault() {} });
  });
  await act(async () => {
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.submit).not.toHaveBeenCalled();
  const saved = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
  expect(saved.stage).toBe("workspace");
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
    tree!.root
      .findByProps({ type: "checkbox" })
      .props.onChange({ target: { checked: true } });
  });
  await act(async () => {
    const submit = tree!.root.findAllByType("form")[1]!.props.onSubmit;
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
