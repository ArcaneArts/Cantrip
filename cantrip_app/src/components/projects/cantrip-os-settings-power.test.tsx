// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectSummary } from "@cantrip/protocol";
const mocks = vi.hoisted(() => ({
  instances: vi.fn(),
  workspaces: vi.fn(),
  bindings: vi.fn(),
  status: vi.fn(),
  history: vi.fn(),
}));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    connectionId: "connection",
    serverUrl: "http://server",
    serverId: "server",
    userId: "owner",
  }),
  onClientSessionIdentityChanged: () => () => {},
}));
vi.mock("@/lib/api/cantrip-os", () => ({
  getCantripOsInstances: mocks.instances,
  getCantripOsWorkspaces: mocks.workspaces,
  getCantripOsBindings: mocks.bindings,
  recoverCantripOsInstance: vi.fn(),
  refreshCantripOs: vi.fn(),
  createCantripOsWorkspace: vi.fn(),
  recoverCantripOsBinding: vi.fn(),
  verifyCantripOsBinding: vi.fn(),
}));
vi.mock("@/lib/api/cantrip-os-power", () => ({
  getCantripOsPower: mocks.status,
  getCantripOsPowerOperations: mocks.history,
  submitCantripOsPower: vi.fn(),
  observeCantripOsPowerDraft: vi.fn(),
  observeCantripOsPowerOperation: vi.fn(),
}));
vi.mock("./cantrip-os-backup-controls", () => ({
  CantripOsBackupControls: () => (
    <section aria-label="Backup controls">Backups</section>
  ),
}));
import { CantripOsSettings } from "./cantrip-os-settings";
let root: Root, host: HTMLDivElement, client: QueryClient;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  client?.clear();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
it("keeps one power and backup panel while instance observations repeatedly refresh", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const instance = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "QA Linux",
    status: "connected",
    workerId: "worker",
    attachmentGeneration: "00000000-0000-4000-8000-000000000002",
  };
  mocks.instances.mockResolvedValue([instance]);
  mocks.workspaces.mockResolvedValue([]);
  mocks.bindings.mockResolvedValue([]);
  mocks.status.mockResolvedValue({
    target: null,
    observation: null,
    error: null,
  });
  mocks.history.mockResolvedValue({ items: [], nextCursor: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CantripOsSettings
          project={{ id: "project" } as ProjectSummary}
          workers={[]}
          worktrees={[]}
          onOpenAgent={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  for (let iteration = 0; iteration < 8; iteration++) {
    await act(async () => {
      client.setQueryData(
        ["cantrip-os"],
        [
          {
            ...instance,
            lastObservedAt: `2026-11-06T00:00:0${iteration}.000Z`,
          },
        ],
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(
      host.querySelectorAll('section[aria-label="Instance power"]'),
    ).toHaveLength(1);
    expect(
      host.querySelectorAll('section[aria-label="Backup controls"]'),
    ).toHaveLength(1);
  }
  expect(
    errors.mock.calls.some((call) => String(call[0]).includes("same key")),
  ).toBe(false);
});
