import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserSummary } from "@cantrip/protocol";
import * as api from "@/lib/api";
import { useBrowserCodeViewCreationOperations } from "./surface-creation-operations";

afterEach(() => vi.restoreAllMocks());

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
