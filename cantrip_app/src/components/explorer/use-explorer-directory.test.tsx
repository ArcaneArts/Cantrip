import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getExplorerDirectory } from "@/lib/api";

import { useExplorerDirectory } from "./use-explorer-directory";

vi.mock("@/lib/api", () => ({
  getExplorerDirectory: vi.fn(),
  getExplorerDirectoryCommits: vi.fn(),
}));

function DirectoryQuery() {
  useExplorerDirectory({
    enabled: true,
    explorerId: "explorer-one",
    gitStatus: undefined,
    path: "src",
    projectId: "project-one",
    queryScope: "binding-one",
    worktreeId: "worktree-one",
  });
  return null;
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
});
