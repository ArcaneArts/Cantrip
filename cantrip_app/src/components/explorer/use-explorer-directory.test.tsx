import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getExplorerDirectory } from "@/lib/api";

import { useExplorerDirectory } from "./use-explorer-directory";

vi.mock("@/lib/api", () => ({
  getExplorerDirectory: vi.fn(),
  getExplorerDirectoryCommits: vi.fn(),
}));

function DirectoryQuery({
  explorerId = "explorer-one",
  preservePreviousDataKey,
  worktreeId = "worktree-one",
}: {
  explorerId?: string;
  preservePreviousDataKey?: string;
  worktreeId?: string;
}) {
  const { entries } = useExplorerDirectory({
    enabled: true,
    explorerId,
    gitStatus: undefined,
    path: "src",
    projectId: "project-one",
    preservePreviousDataKey,
    queryScope: `binding-${explorerId}`,
    worktreeId,
  });
  return <span>{entries.map((entry) => entry.name).join(",")}</span>;
}

afterEach(() => vi.clearAllMocks());

describe("Explorer directory queries", () => {
  it("reuses a directory listing when a collapsed folder is expanded again", async () => {
    vi.mocked(getExplorerDirectory).mockResolvedValue({
      entries: [],
      path: "src",
      truncated: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <DirectoryQuery />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(getExplorerDirectory).toHaveBeenCalledOnce());

    await act(async () => {
      renderer.update(
        <QueryClientProvider client={queryClient}>{null}</QueryClientProvider>,
      );
    });
    await act(async () => {
      renderer.update(
        <QueryClientProvider client={queryClient}>
          <DirectoryQuery />
        </QueryClientProvider>,
      );
    });

    expect(getExplorerDirectory).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
    queryClient.clear();
  });

  it("keeps the prior listing visible while a same-worktree Explorer handoff loads", async () => {
    let resolveReplacement!: (
      value: Awaited<ReturnType<typeof getExplorerDirectory>>,
    ) => void;
    vi.mocked(getExplorerDirectory).mockImplementation((explorerId) => {
      if (explorerId === "explorer-one") {
        return Promise.resolve({
          entries: [
            {
              kind: "file",
              markdown: false,
              modifiedAt: "2026-08-23T12:00:00.000Z",
              name: "existing.ts",
              path: "src/existing.ts",
              size: 10,
              symbolicLink: false,
              viewable: true,
            },
          ],
          path: "src",
          truncated: false,
        });
      }
      return new Promise((resolve) => {
        resolveReplacement = resolve;
      });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <DirectoryQuery preservePreviousDataKey="worker-authorization" />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() =>
      expect(renderer.toJSON()).toMatchObject({ children: ["existing.ts"] }),
    );

    await act(async () => {
      renderer.update(
        <QueryClientProvider client={queryClient}>
          <DirectoryQuery
            explorerId="explorer-two"
            preservePreviousDataKey="worker-authorization"
          />
        </QueryClientProvider>,
      );
    });

    expect(renderer.toJSON()).toMatchObject({ children: ["existing.ts"] });

    await act(async () => {
      resolveReplacement({
        entries: [],
        path: "src",
        truncated: false,
      });
    });
    await vi.waitFor(() =>
      expect(renderer.toJSON()).toMatchObject({ children: null }),
    );

    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});
