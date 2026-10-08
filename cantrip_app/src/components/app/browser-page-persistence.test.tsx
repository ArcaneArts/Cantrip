import type { BrowserSummary, BrowserUpdate } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserPageStateUpdate } from "@/lib/browser-page-state";
import { CantripApiError } from "@/lib/api-client";

const api = vi.hoisted(() => ({
  updateBrowser: vi.fn(),
  getBrowsers: vi.fn(),
  deleteBrowser: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/run-configuration-api", () => ({
  operateRunConfigurationRuntime: vi.fn(),
}));

import { useBrowserSurfaceOperations } from "./surface-crud-operations";
import type { ProjectSurfaceCloseCoordinator } from "./project-surface-close";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const browser: BrowserSummary = {
  id: "browser-1",
  projectId: "project-1",
  title: "WQA worker page",
  position: 0,
  stateRevision: 1,
  url: "http://127.0.0.1:4371/",
  createdAt: "2026-10-08T12:00:00Z",
  updatedAt: "2026-10-08T12:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const renderers: TestRenderer.ReactTestRenderer[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0))
    await act(async () => renderer.unmount());
  vi.resetAllMocks();
});
async function setup(initial = browser) {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  client.setQueryData(["browsers", browser.projectId], [initial]);
  let mutation!: ReturnType<
    typeof useBrowserSurfaceOperations
  >["updateBrowserMutation"];
  function Harness() {
    mutation = useBrowserSurfaceOperations({
      queryClient: client,
      selectedProjectId: browser.projectId,
      surfaceClose: {} as ProjectSurfaceCloseCoordinator,
    }).updateBrowserMutation;
    return null;
  }
  await act(async () => {
    renderers.push(
      TestRenderer.create(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      ),
    );
  });
  const current = () =>
    client.getQueryData<BrowserSummary[]>(["browsers", browser.projectId])![0]!;
  api.updateBrowser.mockImplementation(
    async (_id: string, input: BrowserUpdate) => ({
      ...current(),
      ...input,
      stateRevision: current().stateRevision + (input.url ? 1 : 0),
    }),
  );
  const page = (pageState: BrowserPageStateUpdate) =>
    mutation.mutateAsync({
      browserId: browser.id,
      projectId: browser.projectId,
      pageState,
    });
  return {
    client,
    current,
    page,
    rename: (title: string) =>
      mutation.mutateAsync({ browserId: browser.id, input: { title } }),
  };
}
const errorPage = {
  previousTitle: "WQA worker page",
  title: "127.0.0.1",
  url: browser.url,
};
const restored = {
  previousTitle: "127.0.0.1",
  title: "WQA worker page",
  url: browser.url,
};
const article = {
  previousTitle: "WQA worker page",
  title: "WQA article",
  url: `${browser.url}article`,
};

describe("Browser automatic page title persistence", () => {
  it("converges after a delayed error-page update, restoration, article, redirect and history", async () => {
    const h = await setup();
    const pending = deferred<BrowserSummary>();
    api.updateBrowser.mockImplementationOnce(() => pending.promise);
    let failedPage!: Promise<BrowserSummary>;
    let recovered!: Promise<BrowserSummary>;
    await act(async () => {
      failedPage = h.page(errorPage);
      recovered = h.page(restored);
    });
    await act(async () => {
      pending.resolve({ ...browser, title: errorPage.title });
      await Promise.all([failedPage, recovered]);
    });
    expect(h.current().title).toBe(restored.title);
    for (const state of [
      article,
      { ...article, previousTitle: article.title },
      { ...restored, previousTitle: article.title },
      article,
    ]) {
      await act(async () => {
        await h.page(state);
      });
      expect(h.current()).toMatchObject({ title: state.title, url: state.url });
    }
  });

  it("retains the acknowledged title after failed persistence so the next navigation repairs it", async () => {
    const h = await setup({ ...browser, title: errorPage.title });
    api.updateBrowser.mockRejectedValueOnce(
      new CantripApiError("Temporary failure", 503),
    );
    await act(async () => {
      await expect(h.page(restored)).rejects.toThrow("Temporary failure");
    });
    await act(async () => {
      await h.page(article);
    });
    expect(h.current()).toMatchObject({
      title: article.title,
      url: article.url,
    });
  });

  it("refreshes an actual revision conflict and retries with the fresh revision", async () => {
    const h = await setup({ ...browser, title: errorPage.title });
    api.updateBrowser.mockRejectedValueOnce(
      new CantripApiError("Browser private state changed", 409, "stale-state"),
    );
    api.getBrowsers.mockResolvedValue([
      { ...browser, title: errorPage.title, stateRevision: 7 },
    ]);
    await act(async () => {
      await h.page({ ...restored, url: `${browser.url}restored` });
    });
    expect(api.getBrowsers).toHaveBeenCalledWith(browser.projectId);
    expect(api.updateBrowser.mock.calls[1]?.[1]).toMatchObject({
      title: restored.title,
      stateRevision: 7,
    });
    expect(h.current().title).toBe(restored.title);
  });

  it("preserves an explicit rename queued between automatic page events", async () => {
    const h = await setup();
    const pending = deferred<BrowserSummary>();
    api.updateBrowser.mockImplementationOnce(() => pending.promise);
    let operations!: Promise<unknown>[];
    await act(async () => {
      operations = [h.page(errorPage), h.rename("Research"), h.page(restored)];
    });
    await act(async () => {
      pending.resolve({ ...browser, title: errorPage.title });
      await Promise.all(operations);
    });
    await act(async () => {
      await h.page(article);
    });
    expect(h.current()).toMatchObject({ title: "Research", url: article.url });
  });

  it("preserves a remote explicit rename discovered while refreshing a conflict", async () => {
    const h = await setup();
    api.updateBrowser.mockRejectedValueOnce(
      new CantripApiError("Browser private state changed", 409, "stale-state"),
    );
    api.getBrowsers.mockResolvedValue([
      { ...browser, title: "Research", stateRevision: 9 },
    ]);
    await act(async () => {
      await h.page(article);
    });
    expect(api.updateBrowser.mock.calls[1]?.[1]).toEqual({
      url: article.url,
      stateRevision: 9,
    });
    expect(h.current().title).toBe("Research");
  });

  it("bounds conflict recovery and surfaces a repeated failure", async () => {
    const h = await setup();
    api.updateBrowser.mockRejectedValue(
      new CantripApiError("Browser private state changed", 409, "stale-state"),
    );
    api.getBrowsers.mockResolvedValue([{ ...browser, stateRevision: 9 }]);
    await act(async () => {
      await expect(h.page(article)).rejects.toThrow(
        "Browser private state changed",
      );
    });
    expect(api.updateBrowser).toHaveBeenCalledTimes(2);
    expect(api.getBrowsers).toHaveBeenCalledTimes(1);
  });
  it("does not replay an unrelated conflict such as a changed authenticated lifetime", async () => {
    const h = await setup();
    api.updateBrowser.mockRejectedValueOnce(
      new CantripApiError("The account or server changed", 409),
    );
    await act(async () => {
      await expect(h.page(article)).rejects.toThrow(
        "The account or server changed",
      );
    });
    expect(api.updateBrowser).toHaveBeenCalledTimes(1);
    expect(api.getBrowsers).not.toHaveBeenCalled();
  });
});
