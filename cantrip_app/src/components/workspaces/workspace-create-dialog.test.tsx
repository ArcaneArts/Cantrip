import type { ProjectWorkspaceSummary, WorkerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  WorkspaceCreateDialog,
  workspaceCreationCanSubmit,
} from "./workspace-create-dialog";

const listDesktopWorkers = vi.fn();

vi.mock("@/lib/desktop-worker", () => ({
  listDesktopWorkers: () => listDesktopWorkers(),
}));

vi.mock("@/lib/desktop-folder-picker", () => ({
  pickLocalFolder: vi.fn(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: PropsWithChildren) => (
    <section>{children}</section>
  ),
  DialogDescription: ({ children }: PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: PropsWithChildren) => (
    <footer>{children}</footer>
  ),
  DialogHeader: ({ children }: PropsWithChildren) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: PropsWithChildren) => <h1>{children}</h1>,
}));

vi.mock("@/components/settings/workspace-repository-discovery-review", () => ({
  WorkspaceRepositoryDiscoveryReview: ({
    open,
    workspace,
  }: {
    open: boolean;
    workspace: ProjectWorkspaceSummary | null;
  }) => (
    <output
      data-testid="repository-review"
      data-open={String(open)}
      data-workspace-id={workspace?.id ?? ""}
    />
  ),
}));

const worker = {
  workerId: "worker-one",
  name: "This machine",
  online: true,
  managedFolders: {
    attachWorkspaceRoot: true,
  },
} as WorkerSummary;

const remoteWorker = {
  ...worker,
  workerId: "worker-two",
  name: "Remote machine",
} as WorkerSummary;

const attachedWorkspace = {
  id: "workspace-attached",
  name: "Existing repositories",
  position: 1,
  isDefault: false,
  projectIds: [],
  revision: 1,
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:00:00.000Z",
  storage: {
    kind: "attached",
    workerId: worker.workerId,
    rootPathHandle: `ctrr_${"a".repeat(43)}`,
    displayHandle: `ctrr_${"b".repeat(43)}`,
  },
} as ProjectWorkspaceSummary;

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : nodeText(child)))
    .join("");
}

describe("workspace create dialog", () => {
  it("requires the storage-specific fields", () => {
    expect(
      workspaceCreationCanSubmit({
        name: "Managed",
        rootPath: "",
        selectedWorker: undefined,
        storageKind: "managed",
        submitting: false,
      }),
    ).toBe(true);
    expect(
      workspaceCreationCanSubmit({
        name: "Attached",
        rootPath: "",
        selectedWorker: worker,
        storageKind: "attached",
        submitting: false,
      }),
    ).toBe(false);
    expect(
      workspaceCreationCanSubmit({
        name: "Attached",
        rootPath: "/srv/repositories",
        selectedWorker: worker,
        storageKind: "attached",
        submitting: false,
      }),
    ).toBe(true);
  });

  it("creates an attached workspace and opens its repository review", async () => {
    listDesktopWorkers.mockResolvedValue([
      {
        workerId: worker.workerId,
        name: worker.name,
        running: true,
        serverUrl: "http://127.0.0.1:4310",
      },
    ]);
    const onCreate = vi.fn().mockResolvedValue(attachedWorkspace);
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <WorkspaceCreateDialog
            onCreate={onCreate}
            onOpenChange={onOpenChange}
            open
            workers={[worker]}
            workspaces={[]}
          />
        </QueryClientProvider>,
      );
    });

    const buttons = () => renderer.root.findAllByType("button");
    expect(
      buttons().some((button) =>
        nodeText(button).includes("Managed by Cantrip"),
      ),
    ).toBe(true);
    const attachedChoice = buttons().find((button) =>
      nodeText(button).includes("Use an existing folder"),
    );
    await act(async () => attachedChoice!.props.onClick());
    await act(async () => undefined);
    expect(
      buttons().some((button) => nodeText(button).includes("Browse")),
    ).toBe(true);

    const nameInput = renderer.root.findByProps({
      placeholder: "Personal Projects",
    });
    const pathInput = renderer.root.findByProps({
      placeholder: "/path/on/the/selected/worker",
    });
    await act(async () => {
      nameInput.props.onChange({ target: { value: attachedWorkspace.name } });
      pathInput.props.onChange({ target: { value: "/srv/repositories" } });
    });
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({
        preventDefault: vi.fn(),
      });
    });

    expect(onCreate).toHaveBeenCalledWith({
      name: attachedWorkspace.name,
      storage: {
        kind: "attached",
        workerId: worker.workerId,
        rootPath: "/srv/repositories",
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(
      renderer.root.findByProps({ "data-testid": "repository-review" }).props,
    ).toMatchObject({
      "data-open": "true",
      "data-workspace-id": attachedWorkspace.id,
    });

    await act(async () => renderer.unmount());
    queryClient.clear();
  });

  it("hides the native picker for a remote worker and accepts its absolute path", async () => {
    listDesktopWorkers.mockResolvedValue([
      {
        workerId: worker.workerId,
        name: worker.name,
        running: true,
        serverUrl: "http://127.0.0.1:4310",
      },
    ]);
    const remoteWorkspace = {
      ...attachedWorkspace,
      storage: {
        ...attachedWorkspace.storage,
        workerId: remoteWorker.workerId,
      },
    } as ProjectWorkspaceSummary;
    const onCreate = vi.fn().mockResolvedValue(remoteWorkspace);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <WorkspaceCreateDialog
            onCreate={onCreate}
            onOpenChange={vi.fn()}
            open
            workers={[worker, remoteWorker]}
            workspaces={[]}
          />
        </QueryClientProvider>,
      );
    });

    const buttons = () => renderer.root.findAllByType("button");
    await act(async () => {
      buttons()
        .find((button) => nodeText(button).includes("Use an existing folder"))!
        .props.onClick();
    });
    await act(async () => undefined);
    expect(
      buttons().some((button) => nodeText(button).includes("Browse")),
    ).toBe(true);

    await act(async () => {
      renderer.root.findByType("select").props.onChange({
        target: { value: remoteWorker.workerId },
      });
    });
    expect(
      buttons().some((button) => nodeText(button).includes("Browse")),
    ).toBe(false);

    await act(async () => {
      renderer.root
        .findByProps({ placeholder: "Personal Projects" })
        .props.onChange({ target: { value: "Remote repositories" } });
      renderer.root
        .findByProps({ placeholder: "/path/on/the/selected/worker" })
        .props.onChange({ target: { value: "/srv/remote-repositories" } });
    });
    await act(async () => {
      await renderer.root.findByType("form").props.onSubmit({
        preventDefault: vi.fn(),
      });
    });

    expect(onCreate).toHaveBeenCalledWith({
      name: "Remote repositories",
      storage: {
        kind: "attached",
        workerId: remoteWorker.workerId,
        rootPath: "/srv/remote-repositories",
      },
    });

    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
