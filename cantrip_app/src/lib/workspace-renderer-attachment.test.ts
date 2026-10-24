import {
  applyWorkspaceCommand,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { expect, it, vi } from "vitest";
import { attachWorkspaceRenderer } from "./workspace-renderer-attachment";
import type { WorkspaceTransport } from "./workspace-command-client";
import { createWorkspaceRendererConnections } from "./workspace-renderer-lifetime";

it("reconciles an abandoned transfer when returning to a disconnected project in the same page", async () => {
  const f = fixture();
  const owner = f.layout().windows[0]!;
  owner.panes.push({
    id: "pane",
    region: "center",
    titleProtection: null,
    activeTabId: "tab",
    tabs: [
      {
        id: "tab",
        preview: false,
        titleProtection: null,
        dockPresentation: null,
        resource: { kind: "builtin", definitionId: "project.tasks" },
        builtInState: { definitionId: "project.tasks", worktreeId: null },
      },
    ],
  });
  owner.centerRoot = { kind: "pane", paneId: "pane" };
  let serial = 0;
  const retain = createWorkspaceRendererConnections(
    () => `attachment-${++serial}`,
  );
  const first = retain(f.lifetime);
  const attached = await attachWorkspaceRenderer(
    f.layout(),
    "main",
    first,
    f.transport,
    () => {},
  );
  await f.transport.execute({
    operationId: "prepare",
    projectId: attached.projectId,
    workspaceId: attached.id,
    windowId: "main",
    attachmentGeneration: 1,
    expectedRevision: attached.revision,
    action: {
      type: "prepare-detach",
      transferId: "transfer",
      paneId: "pane",
      destinationWindowId: "staged",
      destinationPaneId: "pane",
    },
  });
  first.releaseConnection!();
  const returned = retain(f.lifetime);
  const recovered = await attachWorkspaceRenderer(
    f.layout(),
    "main",
    returned,
    f.transport,
    () => {},
  );
  expect(recovered.pendingTransfers).toEqual([]);
  expect(recovered.windows).toHaveLength(1);
  expect(recovered.windows[0]!.panes[0]!.tabs[0]!.id).toBe("tab");
  expect(recovered.windows[0]!.attachmentGeneration).toBe(2);
  expect(recovered.windows[0]!.rendererId).not.toBe(first.rendererId);
});

function fixture() {
  let layout: WorkspaceOwnership = {
    version: 1,
    id: "workspace",
    projectId: "project",
    revision: 0,
    mainWindowId: "main",
    windows: [
      {
        id: "main",
        attachmentGeneration: 0,
        panes: [],
        centerRoot: null,
        focusedPaneId: null,
        recentPaneIds: [],
      },
    ],
  };
  const ended = new AbortController();
  const lifetime = { rendererId: "renderer", signal: ended.signal };
  const transport: WorkspaceTransport = {
    read: vi.fn(async () => layout),
    execute: vi.fn(async (command) => {
      const result = applyWorkspaceCommand(layout, command);
      layout = result.layout;
      return { ...result, appliedRevision: layout.revision, replayed: false };
    }),
    classify: (error) =>
      (error as { code?: string })?.code === "revision"
        ? "conflict"
        : "uncertain",
  };
  return { transport, lifetime, ended, layout: () => layout };
}

it("attaches once and preserves the generation across reconnects", async () => {
  const f = fixture();
  const attached = await attachWorkspaceRenderer(
    f.layout(),
    "main",
    f.lifetime,
    f.transport,
    () => {},
  );
  expect(attached.windows[0]).toMatchObject({
    rendererId: "renderer",
    attachmentGeneration: 1,
  });
  expect(
    await attachWorkspaceRenderer(
      attached,
      "main",
      f.lifetime,
      f.transport,
      () => {},
    ),
  ).toEqual(attached);
  expect(f.transport.execute).toHaveBeenCalledOnce();
});

it("does not resend an uncertain claim and recognizes its committed identity on retry", async () => {
  const f = fixture();
  const execute = f.transport.execute;
  f.transport.execute = vi.fn(async (command) => {
    await execute(command);
    throw new Error("response lost");
  });
  await expect(
    attachWorkspaceRenderer(
      f.layout(),
      "main",
      f.lifetime,
      f.transport,
      () => {},
    ),
  ).rejects.toThrow("response lost");
  expect(f.transport.execute).toHaveBeenCalledOnce();
  const latest = await f.transport.read();
  expect(
    await attachWorkspaceRenderer(
      latest,
      "main",
      f.lifetime,
      f.transport,
      () => {},
    ),
  ).toEqual(latest);
  expect(f.transport.execute).toHaveBeenCalledOnce();
});

it("rebases only after an explicit revision rejection", async () => {
  const f = fixture();
  const initial = f.layout();
  await f.transport.execute({
    operationId: "external",
    projectId: initial.projectId,
    workspaceId: initial.id,
    windowId: "main",
    attachmentGeneration: 0,
    expectedRevision: 0,
    action: { type: "home" },
  });
  const result = await attachWorkspaceRenderer(
    initial,
    "main",
    f.lifetime,
    f.transport,
    () => {},
  );
  expect(result.revision).toBe(2);
  expect(result.windows[0]!.attachmentGeneration).toBe(1);
  expect(f.transport.read).toHaveBeenCalledOnce();
});

it("does not expose an attachment after its renderer lifetime ends", async () => {
  const f = fixture();
  const execute = f.transport.execute;
  f.transport.execute = vi.fn(async (command) => {
    const result = await execute(command);
    f.ended.abort(new Error("renderer ended"));
    return result;
  });
  await expect(
    attachWorkspaceRenderer(
      f.layout(),
      "main",
      f.lifetime,
      f.transport,
      () => {},
    ),
  ).rejects.toThrow("renderer ended");
  expect(f.transport.execute).toHaveBeenCalledOnce();
});

it("rejects a misleading receipt instead of looping attachment commands", async () => {
  const f = fixture();
  f.transport.execute = vi.fn(async (command) => ({
    operationId: command.operationId,
    appliedRevision: 1,
    replayed: false,
    layout: { ...f.layout(), revision: 1 },
    focusWindowId: null,
    emptyWindowIds: [],
  }));
  await expect(
    attachWorkspaceRenderer(
      f.layout(),
      "main",
      f.lifetime,
      f.transport,
      () => {},
    ),
  ).rejects.toThrow("superseded");
  expect(f.transport.execute).toHaveBeenCalledOnce();
});
