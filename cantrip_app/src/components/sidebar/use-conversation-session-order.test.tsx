// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ identity: {} as Record<string, string> }));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => mocks.identity,
}));
import { useConversationSessionOrder } from "./use-conversation-session-order";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
type Row = { id: string; title?: string };
function List({ rows, projectId }: { rows: Row[]; projectId: string }) {
  const ordered = useConversationSessionOrder(projectId, rows);
  return (
    <>
      {ordered.map((row) => (
        <span key={row.id} data-id={row.id}>
          {row.title ?? row.id}
        </span>
      ))}
    </>
  );
}
async function render(rows: Row[], projectId = "project") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <List rows={rows} projectId={projectId} />
      </QueryClientProvider>,
    ),
  );
}
const ids = () =>
  [...host.querySelectorAll<HTMLElement>("[data-id]")].map(
    (row) => row.dataset.id,
  );
const main = { id: "main" };
const fixer = { id: "fixer" };
beforeEach(() => {
  mocks.identity = {
    userId: "owner",
    serverId: "server",
    serverUrl: "https://server.test",
    connectionId: "connection",
    accountId: "account",
  };
  client = new QueryClient();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});
it("captures the first populated recency order and keeps fresh row content without moving it", async () => {
  await render([]);
  await render([main, fixer]);
  await render([
    { ...fixer, title: "Fixer running" },
    { ...main, title: "Renamed main" },
  ]);
  expect(ids()).toEqual(["main", "fixer"]);
  expect(host.textContent).toBe("Renamed mainFixer running");
});
it("appends new chats and older pages while retaining existing relative order", async () => {
  await render([main, fixer]);
  await render([{ id: "new" }, fixer, main, { id: "older" }]);
  expect(ids()).toEqual(["main", "fixer", "new", "older"]);
  await render([{ id: "older" }, { id: "new" }, main, fixer, { id: "oldest" }]);
  expect(ids()).toEqual(["main", "fixer", "new", "older", "oldest"]);
});
it("removes archived rows immediately and restores their prior place", async () => {
  await render([main, fixer, { id: "older" }]);
  await render([{ id: "older" }, main]);
  expect(ids()).toEqual(["main", "older"]);
  await render([fixer, { id: "older" }, main]);
  expect(ids()).toEqual(["main", "fixer", "older"]);
});
it("remembers the order across project switches and sidebar remounts", async () => {
  await render([main, fixer]);
  await render([fixer, main], "other-project");
  expect(ids()).toEqual(["fixer", "main"]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render([fixer, main]);
  expect(ids()).toEqual(["main", "fixer"]);
});
it("takes the new recency order when a fresh app query client launches", async () => {
  await render([main, fixer]);
  await act(async () => root.unmount());
  client.clear();
  client = new QueryClient();
  root = createRoot(host);
  await render([fixer, main]);
  expect(ids()).toEqual(["fixer", "main"]);
});
it.each(["userId", "serverId", "serverUrl", "connectionId", "accountId"])(
  "keeps %s scopes independent within the same client",
  async (field) => {
    await render([main, fixer]);
    const identity = mocks.identity;
    mocks.identity = { ...identity, [field]: "other" };
    await render([fixer, main]);
    expect(ids()).toEqual(["fixer", "main"]);
    mocks.identity = identity;
    await render([fixer, main]);
    expect(ids()).toEqual(["main", "fixer"]);
  },
);
