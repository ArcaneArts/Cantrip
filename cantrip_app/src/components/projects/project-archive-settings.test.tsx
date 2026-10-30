// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  getArchivedChats: api.list,
  restoreArchivedChat: api.restore,
  permanentlyDeleteArchivedChat: api.remove,
}));
import { ProjectArchiveSettings } from "./project-archive-settings";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("keeps Task recovery in Settings and sends Agent archive navigation to Conversations", async () => {
  const task = {
    id: "task",
    title: "Archived task",
    experience: "task",
    contextKind: "project",
    archivedAt: "2026-10-29T00:00:00Z",
    expiresAt: "2027-01-27T00:00:00Z",
    messageCount: 3,
  };
  api.list.mockResolvedValue([
    task,
    { ...task, id: "agent", title: "Archived agent", experience: "agent" },
  ]);
  api.restore.mockResolvedValue(task);
  const navigate = vi.fn();
  const restored = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProjectArchiveSettings
            projectId="project"
            onOpenConversations={navigate}
            onRestoreChat={restored}
          />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.textContent).toContain("Archived task");
    expect(host.textContent).not.toContain("Archived agent");
    const buttons = [...host.querySelectorAll("button")];
    await act(async () =>
      buttons
        .find((button) => button.textContent === "Open archived conversations")!
        .click(),
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(api.restore).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
    await act(async () =>
      buttons
        .find((button) => button.textContent?.trim() === "Restore")!
        .click(),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(api.restore.mock.calls[0]?.[0]).toBe("task");
    expect(restored).toHaveBeenCalledWith(task);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
