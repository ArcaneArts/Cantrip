import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  explorerCreateSchema,
  type BrowserSummary,
  type ExplorerSummary,
  type ExplorerEntry,
} from "@cantrip/protocol";
import * as api from "@/lib/api";
import {
  useBrowserCodeViewCreationOperations,
  useExplorerCreationOperations,
  useTerminalCreationOperation,
} from "./surface-creation-operations";

afterEach(() => vi.restoreAllMocks());

it.each(
  [true, false].flatMap((ownedPlacement) =>
    ["directory", "graph"].map((kind) => ({ ownedPlacement, kind })),
  ),
)(
  "creates $kind Explorer with unambiguous execution target and owned placement=$ownedPlacement",
  async ({ ownedPlacement, kind }) => {
    const explorer = {
      id: "source",
      projectId: "project",
      worktreeId: "worktree",
      position: 0,
    } as ExplorerSummary;
    const created = { ...explorer, id: "created" };
    const create = vi
      .spyOn(api, "createExplorer")
      .mockImplementation(
        async (_project, title, worktreeId, paneId, target, options) => {
          explorerCreateSchema.parse({
            title,
            worktreeId,
            paneId,
            target,
            ...options,
          });
          return created;
        },
      );
    const openCreatedTab = vi.fn();
    const setExplorerGraphRequest = vi.fn();
    const setPopoutError = vi.fn();
    const queryClient = new QueryClient();
    let operations!: ReturnType<typeof useExplorerCreationOperations>;
    const Probe = () => {
      operations = useExplorerCreationOperations({
        queryClient,
        openCreatedTab,
        ownedPlacement,
        setExplorerGraphRequest,
        setPopoutError,
      });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe),
        ),
      );
    });
    try {
      await act(async () => {
        if (kind === "graph")
          await operations.newGraphExplorer.mutateAsync({
            explorer,
            entry: {
              name: "entry",
              path: "entry",
              kind: "directory",
            } as ExplorerEntry,
            paneId: "owned-pane",
          });
        else
          await operations.newExplorer.mutateAsync({
            projectId: "project",
            worktreeId: "worktree",
            paneId: "owned-pane",
          });
      });
      expect(create).toHaveBeenCalledExactlyOnceWith(
        "project",
        kind === "graph" ? "Graph · entry" : "Explorer",
        kind === "graph" ? undefined : "worktree",
        ownedPlacement ? undefined : "owned-pane",
        kind === "graph"
          ? { kind: "worktree", projectId: "project", worktreeId: "worktree" }
          : undefined,
        { attachToTabLayout: !ownedPlacement },
      );
      expect(openCreatedTab).toHaveBeenCalledExactlyOnceWith(
        "project",
        "explorer",
        "created",
        { paneId: "owned-pane" },
      );
      expect(setPopoutError).not.toHaveBeenCalled();
      if (kind === "graph")
        expect(setExplorerGraphRequest).toHaveBeenCalledWith({
          explorerId: "created",
          requestId: expect.any(String),
          rootPath: "entry",
        });
    } finally {
      await act(async () => renderer.unmount());
      queryClient.clear();
    }
  },
);

it.each([true, false])(
  "separates resource creation from owned pane placement (%s)",
  async (ownedPlacement) => {
    const created = {
      id: "browser",
      projectId: "project",
      position: 0,
    } as BrowserSummary;
    const create = vi.spyOn(api, "createBrowser").mockResolvedValue(created);
    const openCreatedTab = vi.fn();
    const queryClient = new QueryClient();
    let operations!: ReturnType<typeof useBrowserCodeViewCreationOperations>;
    const Probe = () => {
      operations = useBrowserCodeViewCreationOperations({
        queryClient,
        openCreatedTab,
        ownedPlacement,
      });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe),
        ),
      );
    });
    await act(async () => {
      await operations.newBrowser.mutateAsync({
        projectId: "project",
        paneId: "owned-pane",
        url: "https://example.test",
      });
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(
      "project",
      "Browser",
      ownedPlacement ? undefined : "owned-pane",
      undefined,
      "https://example.test",
    );
    expect(openCreatedTab).toHaveBeenCalledExactlyOnceWith(
      "project",
      "browser",
      "browser",
      { paneId: "owned-pane" },
    );
    await act(async () => renderer.unmount());
    queryClient.clear();
  },
);

it.each(["implicit", "explicit-host", "another-project", "explicit-os"])(
  "creates the intended terminal source for %s",
  async (kind) => {
    const queryClient = new QueryClient();
    const created = {
      id: "created",
      projectId: "project",
      position: 0,
    } as import("@cantrip/protocol").TerminalSummary;
    const create = vi.spyOn(api, "createTerminal").mockResolvedValue(created);
    let operation!: ReturnType<typeof useTerminalCreationOperation>;
    const Probe = () => {
      operation = useTerminalCreationOperation({
        queryClient,
        openCreatedTab: vi.fn(),
        setPendingTerminalInputs: vi.fn(),
        defaultPlacement: () => ({
          projectId: "project",
          worktreeId: "linux-tree",
          cantripOsBindingId: "linux",
          cantripOsRuntimeGeneration: "generation",
        }),
      });
      return null;
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe),
        ),
      );
    });
    try {
      const projectId = kind === "another-project" ? "other" : "project";
      const explicit =
        kind === "explicit-os"
          ? {
              worktreeId: "second-tree",
              cantripOsBindingId: "second",
              cantripOsRuntimeGeneration: "second-generation",
            }
          : kind === "explicit-host"
            ? {
                target: {
                  kind: "worktree" as const,
                  projectId,
                  worktreeId: "host-tree",
                },
              }
            : {};
      await act(async () => {
        await operation.mutateAsync({ projectId, ...explicit });
      });
      const args = create.mock.calls[0]!;
      expect(args[0]).toBe(projectId);
      if (kind === "implicit" || kind === "explicit-os") {
        expect(args[1]).toBe("Linux terminal");
        expect(args[2]).toBe(
          kind === "implicit" ? "linux-tree" : "second-tree",
        );
        expect(args[7]).toEqual(
          kind === "implicit"
            ? {
                cantripOsBindingId: "linux",
                cantripOsRuntimeGeneration: "generation",
              }
            : {
                cantripOsBindingId: "second",
                cantripOsRuntimeGeneration: "second-generation",
              },
        );
      } else {
        expect(args).toHaveLength(7);
        expect(args[1]).toBe("Terminal");
        expect(args[4]).toEqual(
          kind === "explicit-host" ? explicit.target : undefined,
        );
      }
    } finally {
      await act(async () => renderer.unmount());
      queryClient.clear();
    }
  },
);
