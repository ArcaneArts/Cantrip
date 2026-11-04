import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { cantripOsSourceBindingSummarySchema } from "@cantrip/protocol";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/api/cantrip-os", () => ({
  createCantripOsBinding: api.create,
  prepareCantripOsProvision: api.prepare,
  refreshCantripOs: api.refresh,
  verifyCantripOsBinding: api.verify,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: import("react").ComponentProps<"button"> & { variant?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/input", () => ({
  Input: (props: import("react").ComponentProps<"input">) => (
    <input {...props} />
  ),
}));
import { CantripOsWorktreeForm } from "./cantrip-os-worktree-form";

it("keeps an uncertain worktree admission captured and observes it without preparing another mutation", async () => {
  const id = "12345678-1234-4234-8234-123456789abc";
  const source = cantripOsSourceBindingSummarySchema.parse({
    id,
    ownerId: id,
    projectId: id,
    workerId: id,
    projectSourceId: id,
    worktreeId: id,
    instanceId: id,
    workspaceId: id,
    mode: "linux-owned",
    linkedWorkerPath: null,
    guestPath: "/linux/source",
    bindingGeneration: id,
    provisionedAttachmentGeneration: id,
    provisionedRuntimeGeneration: id,
    state: "ready",
    lastError: null,
    dependencyOverlays: [],
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
  });
  const worktree = {
    ...source,
    id: "22345678-1234-4234-8234-123456789abc",
    worktreeId: "32345678-1234-4234-8234-123456789abc",
    guestPath: "/linux/worktree",
    state: "provisioning",
  };
  const provision = vi
    .fn()
    .mockRejectedValueOnce(new Error("Delivery is uncertain"))
    .mockResolvedValue({ state: "ready" });
  api.refresh.mockResolvedValue({ instance: { runtimeGeneration: id } });
  api.verify.mockResolvedValue(source);
  api.create.mockResolvedValue(worktree);
  api.prepare.mockResolvedValue(provision);
  const onCreated = vi.fn(),
    onChanged = vi.fn();
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  let tree: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => {
      tree = TestRenderer.create(
        <QueryClientProvider client={client}>
          <CantripOsWorktreeForm
            source={source}
            onCreated={onCreated}
            onChanged={onChanged}
            onCancel={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      tree!.root
        .findByProps({ "aria-label": "Worktree commit SHA" })
        .props.onChange({ target: { value: "a".repeat(40) } });
      tree!.root
        .findByProps({ "aria-label": "Worktree new branch" })
        .props.onChange({ target: { value: "work/日本" } });
    });
    await act(async () => {
      tree!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1));
    });
    expect(
      tree!.root.findByProps({ role: "alert" }).children.join(""),
    ).toContain("Delivery is uncertain");
    expect(
      tree!.root.findAllByType("input").every((input) => input.props.disabled),
    ).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
    await act(async () => {
      tree!.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
      await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    });
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(api.prepare).toHaveBeenCalledWith(worktree, {
      mode: "linux-owned",
      source: {
        kind: "git-worktree",
        revision: "a".repeat(40),
        branch: "work/日本",
      },
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => tree?.unmount());
    client.clear();
  }
});
