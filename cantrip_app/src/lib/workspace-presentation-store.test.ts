import { expect, it } from "vitest";
import type { WorkspaceOwnership } from "@cantrip/protocol";
import { WorkspaceCommandClient } from "./workspace-command-client";
import { WorkspacePresentationStore } from "./workspace-presentation-store";
import { openWorkspaceWindowPresentation } from "./workspace-window-presentation";

function fixture() {
  const layout: WorkspaceOwnership = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        focusedPaneId: "pane",
        recentPaneIds: ["pane"],
        centerRoot: { kind: "pane", paneId: "pane" },
        panes: [
          {
            id: "pane",
            region: "center",
            titleProtection: null,
            activeTabId: "tab",
            tabs: [
              {
                id: "tab",
                resource: { kind: "builtin", definitionId: "project.tasks" },
                builtInState: {
                  definitionId: "project.tasks",
                  worktreeId: null,
                },
                preview: false,
                titleProtection: null,
                dockPresentation: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const client = new WorkspaceCommandClient(layout, "main", 0, {
    read: async () => layout,
    execute: async () => {
      throw new Error("unused");
    },
    classify: () => "rejected",
  });
  const requests: {
    layout: WorkspaceOwnership;
    resolve: (
      value: Awaited<ReturnType<typeof openWorkspaceWindowPresentation>>,
    ) => void;
    reject: (error: Error) => void;
  }[] = [];
  const store = new WorkspacePresentationStore(
    client,
    "main",
    (layout) =>
      new Promise((resolve, reject) =>
        requests.push({ layout, resolve, reject }),
      ),
  );
  return { client, store, requests, layout };
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

it("publishes membership immediately and ignores older label results", async () => {
  const f = fixture();
  expect(
    f.store.getSnapshot().presentation!.layout.panes[0]!.members[0]!.tabKey,
  ).toBe("tab");
  await tick();
  const latest = structuredClone(f.layout);
  latest.revision++;
  Object.assign(latest.windows[0]!, {
    panes: [],
    centerRoot: null,
    focusedPaneId: null,
    recentPaneIds: [],
  });
  f.client.observe(latest);
  expect(f.store.getSnapshot().presentation!.layout.panes).toEqual([]);
  await tick();
  f.requests[1]!.resolve(await openWorkspaceWindowPresentation(latest, "main"));
  await tick();
  f.requests[0]!.resolve(
    await openWorkspaceWindowPresentation(f.layout, "main"),
  );
  await tick();
  expect(f.store.getSnapshot().presentation!.layout.panes).toEqual([]);
  expect(f.store.getSnapshot().presentation!.selection.destination).toBe(
    "overview",
  );
  f.client.dispose();
});

it("retains opened labels during refresh and membership on a label error", async () => {
  const f = fixture();
  await tick();
  f.requests[0]!.resolve(
    await openWorkspaceWindowPresentation(f.layout, "main"),
  );
  await tick();
  expect(
    f.store.getSnapshot().presentation!.layout.panes[0]!.members[0]!.title,
  ).toBe("Tasks");
  f.client.observe({ ...f.layout, revision: 1 });
  expect(
    f.store.getSnapshot().presentation!.layout.panes[0]!.members[0]!.title,
  ).toBe("Tasks");
  await tick();
  const error = new Error("Key unavailable");
  f.requests[1]!.reject(error);
  await tick();
  expect(f.store.getSnapshot().error).toBe(error);
  expect(
    f.store.getSnapshot().presentation!.layout.panes[0]!.members[0]!.tabKey,
  ).toBe("tab");
  f.store.retryLabels();
  await tick();
  f.requests[2]!.resolve(
    await openWorkspaceWindowPresentation(f.requests[2]!.layout, "main"),
  );
  await tick();
  expect(f.store.getSnapshot().error).toBeNull();
  expect(f.store.getSnapshot().loadingLabels).toBe(false);
  f.client.dispose();
});

it("clears presentation on controller disposal and ignores in-flight decrypted labels", async () => {
  const f = fixture();
  await tick();
  f.client.dispose();
  expect(f.store.getSnapshot().presentation).toBeNull();
  f.requests[0]!.resolve(
    await openWorkspaceWindowPresentation(f.layout, "main"),
  );
  await tick();
  expect(f.store.getSnapshot().presentation).toBeNull();
});
