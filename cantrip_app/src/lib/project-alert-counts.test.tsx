// @vitest-environment jsdom
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectAlertCounts } from "./project-alert-counts";
import { request } from "./api-client";
vi.mock("./api-client", () => ({ request: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let ui: ReactTestRenderer | undefined;
let client: QueryClient | undefined;
function Counts() {
  const counts = useProjectAlertCounts();
  return <span>{counts.get("unopened-project") ?? 0}</span>;
}
afterEach(async () => {
  if (ui) await act(async () => ui!.unmount());
  ui = undefined;
  client?.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("shares one aggregate request across consumers without opening chats or projects", async () => {
  vi.mocked(request).mockResolvedValue([
    { projectId: "unopened-project", count: 3 },
  ]);
  client = new QueryClient();
  await act(async () => {
    ui = create(
      <QueryClientProvider client={client!}>
        <Counts />
        <Counts />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(vi.mocked(request).mock.calls).toEqual([
    ["/api/project-alerts/counts"],
  ]);
  expect(JSON.stringify(ui!.toJSON())).toContain("3");
  await act(async () => {
    client!.setQueryData(["project-alert-counts"], []);
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(JSON.stringify(ui!.toJSON())).toContain("0");
  expect(vi.mocked(request)).toHaveBeenCalledOnce();
});
it("does no interval work while hidden and reconciles on focus", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(false);
  vi.mocked(request).mockResolvedValue([
    { projectId: "unopened-project", count: 1 },
  ]);
  client = new QueryClient();
  await act(async () => {
    ui = create(
      <QueryClientProvider client={client!}>
        <Counts />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(request).toHaveBeenCalledOnce();
  vi.mocked(request).mockResolvedValue([]);
  await act(async () => {
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(ui!.toJSON())).toContain("0");
});
