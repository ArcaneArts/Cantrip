// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cantripOsSourceBindingSummarySchema,
  cantripOsProvisionSchema,
  type CantripOsWorkspaceSummary,
  type ProjectSummary,
} from "@cantrip/protocol";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  submit: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    connectionId: "qa",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
  }),
}));
vi.mock("@/lib/api/cantrip-os", () => ({
  createCantripOsBinding: api.create,
  prepareCantripOsProvisionRequest: api.prepare,
  submitCantripOsProvision: api.submit,
  refreshCantripOs: api.refresh,
}));
import { CantripOsExistingSourceForm } from "./cantrip-os-existing-source-form";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-11-05T00:00:00Z";
const workspace = {
  id: id(1),
  instanceId: id(2),
  workerId: "worker",
  guestWorkspaceId: "restored",
  uid: 20001,
  gid: 20001,
  homeGuestPath: "/home/restored",
} as CantripOsWorkspaceSummary;
const project = {
  id: "project",
  capabilities: { git: true },
} as ProjectSummary;
const binding = cantripOsSourceBindingSummarySchema.parse({
  id: id(3),
  ownerId: "owner",
  projectId: project.id,
  workerId: workspace.workerId,
  projectSourceId: id(4),
  worktreeId: id(5),
  instanceId: workspace.instanceId,
  workspaceId: workspace.id,
  mode: "linux-owned",
  linkedWorkerPath: null,
  guestPath: "/home/restored/checkouts/old-id",
  bindingGeneration: id(6),
  provisionedAttachmentGeneration: null,
  provisionedRuntimeGeneration: null,
  state: "provisioning",
  lastError: null,
  dependencyOverlays: [],
  createdAt: now,
  updatedAt: now,
});
const provision = cantripOsProvisionSchema.parse({
  operationId: id(7),
  bindingGeneration: binding.bindingGeneration,
  protectedRequest: {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
});
const ready = {
  state: "ready",
  receipt: {
    kind: "source",
    source: {
      bindingId: binding.id,
      workspaceId: workspace.id,
      guestPath: binding.guestPath,
    },
  },
};
let tree: TestRenderer.ReactTestRenderer | undefined;
let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={client}>
        <CantripOsExistingSourceForm
          project={project}
          workspace={workspace}
          onProvisioned={() => {}}
          onCancel={() => {}}
        />
      </QueryClientProvider>,
    );
  });
}
async function unmount() {
  await act(async () => tree?.unmount());
  tree = undefined;
  client?.clear();
}
async function submit() {
  await act(async () => {
    tree!.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  api.create.mockResolvedValue(binding);
  api.prepare.mockResolvedValue(provision);
  api.submit.mockResolvedValue(ready);
});
afterEach(unmount);

it("resumes the original creation after a lost response and reload before preparing any guest verification", async () => {
  api.create.mockRejectedValueOnce(new Error("Creation reply lost"));
  await mount();
  await act(async () => {
    tree!.root
      .findByType("input")
      .props.onChange({ target: { value: "checkouts/old-id" } });
  });
  await submit();
  await act(async () => {
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });
  expect(api.prepare).not.toHaveBeenCalled();
  const first = api.create.mock.calls[0];
  expect(first?.[1]).toMatchObject({
    mode: "linux-existing",
    relativePath: "checkouts/old-id",
    sourceKind: "git",
    operationId: expect.any(String),
  });
  await unmount();
  await mount();
  await submit();
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(api.create.mock.calls[1]).toEqual(first);
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith(binding, {
    mode: "linux-owned",
    source: { kind: "existing", sourceKind: "git" },
  });
  expect(sessionStorage.length).toBe(0);
});

it("saves encrypted verification before sending and resumes the identical admission after reload", async () => {
  api.submit.mockRejectedValueOnce(new Error("Verification reply lost"));
  await mount();
  await act(async () => {
    tree!.root
      .findByType("input")
      .props.onChange({ target: { value: "checkouts/old-id" } });
  });
  await submit();
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledOnce());
  });
  expect(
    JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).provision,
  ).toEqual(provision);
  await unmount();
  await mount();
  await submit();
  await act(async () => {
    await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
  });
  expect(api.submit.mock.calls[0]).toEqual(api.submit.mock.calls[1]);
  expect(api.create).toHaveBeenCalledOnce();
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});

it("does not verify a reservation returned for a different workspace or accept a misrouted receipt", async () => {
  api.create.mockResolvedValueOnce({ ...binding, workspaceId: id(99) });
  await mount();
  await act(async () => {
    tree!.root
      .findByType("input")
      .props.onChange({ target: { value: "checkouts/old-id" } });
  });
  await submit();
  await act(async () => {
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.submit).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(1);
});
