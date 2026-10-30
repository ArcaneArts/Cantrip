// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ userId: "owner", serverId: "server" }));
vi.mock("@/lib/client-session", () => ({
  getClientSessionIdentitySnapshot: () => session,
  onClientSessionIdentityChanged: () => () => {},
}));
import { useProjectSidebarPage } from "./use-project-sidebar-page";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useProjectSidebarPage>;
function Harness({
  project = "project",
  workspace = "installation-workspace",
}: {
  project?: string;
  workspace?: string | null;
}) {
  state = useProjectSidebarPage(project, workspace);
  return <div>{state.page}</div>;
}
beforeEach(() => {
  localStorage.clear();
  session.userId = "owner";
  session.serverId = "server";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("persists the page independently for account, server, project, and installation", async () => {
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("files");
  await act(async () => state.setPage("conversations"));
  await act(async () => root.render(<Harness project="other" />));
  expect(state.page).toBe("files");
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("conversations");
  await act(async () =>
    root.render(<Harness workspace="other-installation" />),
  );
  expect(state.page).toBe("files");
  session.userId = "other-owner";
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("files");
  session.userId = "owner";
  session.serverId = "other-server";
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("files");
  session.serverId = "server";
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("conversations");
});
it("retains an early selection until workspace connection resolves", async () => {
  await act(async () => root.render(<Harness workspace={null} />));
  await act(async () => state.setPage("conversations"));
  expect(state.page).toBe("conversations");
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("conversations");
  await act(async () => root.render(<Harness project="other" />));
  await act(async () => root.render(<Harness />));
  expect(state.page).toBe("conversations");
});
