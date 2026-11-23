// @vitest-environment jsdom
import type { WorkerSummary } from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useAlertWorkerEncryption } from "./alert-worker-encryption";
import { authorizeWorkerEncryption } from "./worker-encryption-grants";
import { refreshWorkerEncryption } from "./api/worker-wire";
const state = vi.hoisted(() => ({
  current: true,
  snapshot: {
    status: "ready",
    masterKeyRevision: 1,
    identity: { serverId: "server", ownerId: "owner" },
  },
}));
vi.mock("./client-encryption", () => ({
  clientEncryption: {
    subscribe: () => () => {},
    getSnapshot: () => state.snapshot,
  },
}));
vi.mock("./client-session", () => ({
  getClientSessionIdentitySnapshot: () => ({
    serverId: "server",
    userId: "owner",
  }),
  clientSessionIdentityMatches: () => state.current,
}));
vi.mock("./worker-encryption-grants", () => ({
  authorizeWorkerEncryption: vi.fn(),
}));
vi.mock("./api/worker-wire", () => ({ refreshWorkerEncryption: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let ui: ReactTestRenderer | undefined, client: QueryClient | undefined;
const worker = {
  workerId: "worker",
  online: true,
  encryption: {
    state: "ready",
    principalId: "principal",
    grants: [{ component: "chat-content", keyRevision: 1 }],
  },
} as WorkerSummary;
function Capabilities({ workers }: { workers: WorkerSummary[] }) {
  useAlertWorkerEncryption(workers);
  return null;
}
async function render(workers: WorkerSummary[], copies = 1) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    ui = create(
      <QueryClientProvider client={client!}>
        {Array.from({ length: copies }, (_, i) => (
          <Capabilities key={i} workers={workers} />
        ))}
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 15));
  });
}
afterEach(async () => {
  if (ui) await act(async () => ui!.unmount());
  ui = undefined;
  client?.clear();
  vi.clearAllMocks();
  state.current = true;
});
it("shares one upgrade grant across consumers without mounting a Chat or granting a pending/offline worker", async () => {
  vi.mocked(authorizeWorkerEncryption).mockResolvedValue([]);
  vi.mocked(refreshWorkerEncryption).mockResolvedValue({} as any);
  await render(
    [
      worker,
      { ...worker, workerId: "offline", online: false },
      {
        ...worker,
        workerId: "pending",
        encryption: { ...worker.encryption, state: "pending-approval" },
      },
    ],
    2,
  );
  expect(authorizeWorkerEncryption).toHaveBeenCalledTimes(1);
  expect(authorizeWorkerEncryption).toHaveBeenCalledWith(
    expect.objectContaining({
      workerId: "worker",
      approvePending: false,
      components: ["alert-content"],
    }),
  );
  expect(refreshWorkerEncryption).toHaveBeenCalledWith("worker", {
    component: "alert-content",
    keyRevision: 1,
  });
});
it("does not authorize workers that already have the current Alert capability", async () => {
  await render([
    {
      ...worker,
      encryption: {
        ...worker.encryption,
        grants: [
          ...worker.encryption.grants,
          { component: "alert-content", keyRevision: 1 },
        ],
      },
    },
  ]);
  expect(authorizeWorkerEncryption).not.toHaveBeenCalled();
});
it("drops delayed refresh after an account change", async () => {
  let release!: () => void;
  vi.mocked(authorizeWorkerEncryption).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  );
  await render([worker]);
  state.current = false;
  await act(async () => {
    release();
    await new Promise((r) => setTimeout(r, 15));
  });
  expect(refreshWorkerEncryption).not.toHaveBeenCalled();
});
