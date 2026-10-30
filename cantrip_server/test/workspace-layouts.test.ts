import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  unprobedCodexRuntimeReport,
  type WorkspaceAction,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { ServerConfig } from "../src/config.js";
import { installWorkspaceLayoutRoutes } from "../src/app/routes/workspace-layouts.js";
import {
  protectedProjectFields,
  protectedChatFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

let db: DatabaseConnection;
let config: ServerConfig;
let projectId: string;
let directory: string;
const owner = LOCAL_USER_ID;
const app = Fastify();

beforeAll(async () => {
  directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-workspace-persistence-"),
  );
  config = {
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    appOrigins: [],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory: directory,
    deploymentMode: "local",
    host: "127.0.0.1",
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    port: 4310,
    workerToken: "test-worker-token",
  };
  db = await connectDatabase(config);
  await db.repository.recordWorker(owner, {
    workerId: "workspace-worker",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.163.0",
    codexRuntime: unprobedCodexRuntimeReport,
    startedAt: new Date().toISOString(),
  });
  const project = await db.repository.createGithubProject(owner, {
    workerId: "workspace-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "R".repeat(43),
    repositoryId: "workspace-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  installWorkspaceLayoutRoutes(app, {
    applicationOwnerId: () => owner,
    repository: db.repository,
  });
}, 30_000);
afterAll(async () => {
  await app.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function seed(id = randomUUID()) {
  return (await db.repository.workspaceLayouts.seed(
    owner,
    projectId,
    id,
    "main",
  ))!;
}
function command(
  layout: WorkspaceOwnership,
  action: WorkspaceAction = { type: "home" },
  operationId = randomUUID(),
) {
  return {
    operationId,
    workspaceId: layout.id,
    projectId,
    windowId: "main",
    attachmentGeneration: 0,
    expectedRevision: layout.revision,
    action,
  };
}
const open = (id = "tab"): WorkspaceAction => ({
  type: "open",
  tab: {
    id,
    resource: { kind: "builtin", definitionId: "project.tasks" },
    preview: false,
    titleProtection: null,
    dockPresentation: null,
    builtInState: { definitionId: "project.tasks", worktreeId: null },
  },
  target: {
    kind: "new-pane",
    paneId: `pane-${id}`,
    region: "center",
    splitId: `split-${id}`,
  },
});

it("uses canonical protected resource labels while preserving retry command identity", async () => {
  const project = await db.repository.createGithubProject(owner, {
    workerId: "workspace-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "L".repeat(43),
    repositoryId: "workspace-label-resource",
    nameWithOwner: "ArcaneArts/LabelTest",
    url: "https://github.com/ArcaneArts/LabelTest",
  });
  await db.repository.completeGithubProjectSetup(
    owner,
    project.id,
    "workspace-worker",
    {
      path: path.join(directory, "label-repository"),
      displayPath: "ArcaneArts/LabelTest",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  const layout = (await db.repository.workspaceLayouts.seed(
    owner,
    project.id,
    randomUUID(),
    "main",
  ))!;
  const fields = protectedTerminalFields();
  const terminal = await db.repository.createTerminal(
    owner,
    project.id,
    fields,
  );
  expect(terminal).not.toBeNull();
  const action = open("label-tab");
  if (action.type !== "open") throw new Error("fixture");
  action.tab.resource = {
    kind: "entity",
    definitionId: "project.terminal",
    resourceId: terminal!.id,
  };
  action.tab.builtInState = null;
  // Client does not need a legacy placement or a copy of the private label.
  const input = { ...command(layout, action), projectId: project.id };
  const first = (await db.repository.workspaceLayouts.execute(owner, input))!;
  const opened = first.layout.windows
    .flatMap((w) => w.panes)
    .flatMap((p) => p.tabs)
    .find((t) => t.id === "label-tab")!;
  expect(opened.titleProtection).toEqual(fields.titleProtection);
  expect(action.tab.titleProtection).toBeNull();
  const replay = (await db.repository.workspaceLayouts.execute(owner, input))!;
  expect(replay.replayed).toBe(true);
  expect(replay.layout).toEqual(first.layout);

  // Resource deletion is shared availability, unlike device-local view closure.
  const mobile = (await db.repository.workspaceLayouts.seed(
    owner,
    project.id,
    randomUUID(),
    "main",
  ))!;
  const mobileBefore = (await db.repository.workspaceLayouts.execute(owner, {
    ...command(mobile, open("survivor")),
    projectId: project.id,
  }))!.layout;
  expect(
    await db.repository.deleteTerminal("unrelated-owner", terminal!.id),
  ).toBeNull();
  expect(
    await db.repository.workspaceLayouts.get(owner, project.id, mobile.id),
  ).toEqual(mobileBefore);
  expect(
    await db.repository.deleteTerminal(owner, terminal!.id),
  ).not.toBeNull();
  for (const workspace of [first.layout, mobileBefore]) {
    const after = (await db.repository.workspaceLayouts.get(
      owner,
      project.id,
      workspace.id,
    ))!;
    expect(after.revision).toBeGreaterThan(workspace.revision);
    expect(
      after.windows
        .flatMap((w) => w.panes)
        .flatMap((p) => p.tabs)
        .some(
          (t) =>
            t.resource.kind === "entity" &&
            t.resource.resourceId === terminal!.id,
        ),
    ).toBe(false);
    if (workspace.id === mobile.id)
      expect(
        after.windows[0]!.panes.flatMap((p) => p.tabs).map((t) => t.id),
      ).toContain("survivor");
  }
  const afterDelete = (await db.repository.workspaceLayouts.get(
    owner,
    project.id,
    first.layout.id,
  ))!;
  const oldReplay = (await db.repository.workspaceLayouts.execute(
    owner,
    input,
  ))!;
  expect(oldReplay.layout).toEqual(afterDelete);
  await expect(
    db.repository.workspaceLayouts.execute(owner, {
      ...input,
      operationId: randomUUID(),
      expectedRevision: afterDelete.revision,
    }),
  ).rejects.toThrow("resource is unavailable");
});

it("seeds once and never restores legacy state over newer workspace state", async () => {
  const initial = await seed();
  const next = await db.repository.workspaceLayouts.execute(
    owner,
    command(initial, open()),
  );
  expect(await seed(initial.id)).toEqual(next!.layout);
  await expect(
    db.repository.workspaceLayouts.seed(
      owner,
      projectId,
      initial.id,
      "different-main",
    ),
  ).rejects.toThrow("different main window");
});
it("isolates device placements while sharing resource availability", async () => {
  const desktop = await seed();
  const mobile = await seed();
  await db.repository.workspaceLayouts.execute(owner, command(mobile, open()));
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, desktop.id),
  ).toEqual(desktop);
  expect(
    (await db.repository.workspaceLayouts.get(owner, projectId, mobile.id))!
      .revision,
  ).toBe(1);
});
it("authorizes reads, seeds, and commands against project owner", async () => {
  const layout = await seed();
  expect(
    await db.repository.workspaceLayouts.get(
      "other-owner",
      projectId,
      layout.id,
    ),
  ).toBeNull();
  expect(
    await db.repository.workspaceLayouts.seed(
      "other-owner",
      projectId,
      layout.id,
      "main",
    ),
  ).toBeNull();
  expect(
    await db.repository.workspaceLayouts.execute(
      "other-owner",
      command(layout),
    ),
  ).toBeNull();
  expect(
    await db.repository.workspaceLayouts.get(owner, "other-project", layout.id),
  ).toBeNull();
});
it("replays receipts without reapplying operations or returning stale snapshots", async () => {
  const layout = await seed();
  const first = command(layout, open());
  const applied = (await db.repository.workspaceLayouts.execute(owner, first))!;
  const newer = (await db.repository.workspaceLayouts.execute(
    owner,
    command(applied.layout),
  ))!;
  const replay = (await db.repository.workspaceLayouts.execute(owner, first))!;
  expect(replay.replayed).toBe(true);
  expect(replay.appliedRevision).toBe(1);
  expect(replay.layout).toEqual(newer.layout);
  expect(replay.emptyWindowIds).toEqual([]);
  expect(replay.focusWindowId).toBeNull();
  await expect(
    db.repository.workspaceLayouts.execute(owner, {
      ...first,
      action: { type: "home" },
    }),
  ).rejects.toThrow("already used");
});
it("serializes concurrent duplicate commands into one durable application", async () => {
  const layout = await seed();
  const input = command(layout);
  const results = await Promise.all([
    db.repository.workspaceLayouts.execute(owner, input),
    db.repository.workspaceLayouts.execute(owner, input),
  ]);
  expect(results.map((r) => r!.replayed).sort()).toEqual([false, true]);
  expect(
    (await db.repository.workspaceLayouts.get(owner, projectId, layout.id))!
      .revision,
  ).toBe(1);
});
it("rejects stale revisions and does not consume their operation identity", async () => {
  const layout = await seed();
  const stale = command(layout);
  const next = (await db.repository.workspaceLayouts.execute(
    owner,
    command(layout),
  ))!;
  await expect(
    db.repository.workspaceLayouts.execute(owner, stale),
  ).rejects.toThrow();
  expect(
    (await db.repository.workspaceLayouts.execute(owner, {
      ...stale,
      expectedRevision: next.layout.revision,
    }))!.replayed,
  ).toBe(false);
});
it("fences stale renderer commands including receipt replays", async () => {
  const layout = await seed();
  const input = command(layout);
  await db.repository.workspaceLayouts.execute(owner, input);
  await expect(
    db.repository.workspaceLayouts.execute(owner, {
      ...input,
      attachmentGeneration: 1,
    }),
  ).rejects.toThrow("attachment");
  await expect(
    db.repository.workspaceLayouts.execute(owner, {
      ...input,
      windowId: "foreign-window",
    }),
  ).rejects.toThrow("attachment");
});
it("rejects unavailable entity resources without committing layout or receipts", async () => {
  const layout = await seed();
  const action = open();
  if (action.type !== "open") throw new Error("fixture");
  action.tab.resource = {
    kind: "entity",
    definitionId: "project.agent",
    resourceId: "foreign-chat",
  };
  action.tab.builtInState = null;
  const input = command(layout, action);
  await expect(
    db.repository.workspaceLayouts.execute(owner, input),
  ).rejects.toThrow("unavailable");
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, layout.id),
  ).toEqual(layout);
  expect(
    (await db.repository.workspaceLayouts.execute(owner, {
      ...input,
      action: { type: "home" },
    }))!.replayed,
  ).toBe(false);
});
it("rejects foreign worktree state", async () => {
  const layout = await seed();
  const action = open();
  if (action.type !== "open") throw new Error("fixture");
  action.tab.builtInState!.worktreeId = "foreign-worktree";
  await expect(
    db.repository.workspaceLayouts.execute(owner, command(layout, action)),
  ).rejects.toThrow("worktree");
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, layout.id),
  ).toEqual(layout);
});
it("converges concurrent seeds and isolates subsequent legacy writes", async () => {
  const id = randomUUID();
  const [first, second] = await Promise.all([seed(id), seed(id)]);
  expect(first).toEqual(second);
  const legacy = (await db.repository.tabLayouts.get(owner, projectId))!;
  await db.repository.tabLayouts.openSurfaceView(owner, projectId, {
    revision: legacy.revision,
    surfaceRef: { kind: "builtin", definitionId: "project.tasks" },
  });
  expect(await seed(id)).toEqual(first);
  const nextDevice = await seed();
  expect(
    nextDevice.windows
      .flatMap((w) => w.panes)
      .flatMap((p) => p.tabs)
      .some((t) => t.resource.definitionId === "project.tasks"),
  ).toBe(true);
});
it("validates endpoint body and route scope and exposes durable command results", async () => {
  const layout = await seed();
  const base = `/api/projects/${projectId}/workspace-layouts/${layout.id}`;
  expect((await app.inject({ method: "GET", url: base })).json()).toEqual(
    layout,
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/seed`,
        payload: { mainWindowId: "main", layout },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/commands`,
        payload: { ...command(layout), workspaceId: "different" },
      })
    ).statusCode,
  ).toBe(400);
  const input = command(layout);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/commands`,
        payload: input,
      })
    ).json().appliedRevision,
  ).toBe(1);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/commands`,
        payload: command(layout),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/commands`,
        payload: input,
      })
    ).json().replayed,
  ).toBe(true);
});
it("rejects an unknown detached pane without persisting a partial seed", async () => {
  const workspaceId = randomUUID();
  const url = `/api/projects/${projectId}/workspace-layouts/${workspaceId}`;
  const response = await app.inject({
    method: "POST",
    url: `${url}/seed`,
    payload: {
      mainWindowId: "main",
      detachedPanes: [{ paneId: "missing", windowId: "popout" }],
    },
  });
  expect(response.statusCode).toBe(400);
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, workspaceId),
  ).toBeNull();
});

it("owns direct Agent views, fences old clients, and archives an in-flight transfer atomically", async () => {
  await db.repository.completeGithubProjectSetup(
    owner,
    projectId,
    "workspace-worker",
    {
      path: path.join(directory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  await db.repository.settings.ensureAccountConfiguration(owner);
  const fields = protectedChatFields();
  const chat = await db.repository.createChat(owner, projectId, {
    ...fields,
    attachToTabLayout: false,
  });
  expect(chat).not.toBeNull();
  let layout = await seed();
  const open: WorkspaceAction = {
    type: "open-conversation",
    newPaneId: randomUUID(),
    splitId: randomUUID(),
    view: {
      id: randomUUID(),
      resource: {
        kind: "entity",
        definitionId: "project.agent",
        resourceId: fields.id,
      },
      preview: false,
      titleProtection: null,
      builtInState: null,
      dockPresentation: null,
    },
  };
  const url = `/api/projects/${projectId}/workspace-layouts/${layout.id}`;
  const old = await app.inject({
    method: "POST",
    url: `${url}/commands`,
    payload: command(layout, open),
  });
  expect(old.statusCode, old.body).toBe(409);
  expect(old.json()).toMatchObject({ code: "version", requiredVersion: 2 });
  const created = await app.inject({
    method: "POST",
    url: `${url}/commands`,
    headers: { "x-cantrip-workspace-version": "2" },
    payload: command(layout, open),
  });
  expect(created.statusCode, created.body).toBe(200);
  layout = created.json().layout;
  expect(layout.version).toBe(2);
  const pane = layout.windows[0]!.panes.find(
    (p) =>
      p.conversationView?.resource.kind === "entity" &&
      p.conversationView.resource.resourceId === fields.id,
  )!;
  expect(pane.conversationView?.titleProtection).toEqual(
    fields.titleProtection,
  );
  expect(
    pane.tabs.some(
      (t) =>
        t.resource.kind === "entity" && t.resource.resourceId === fields.id,
    ),
  ).toBe(false);
  expect((await app.inject({ method: "GET", url })).statusCode).toBe(409);
  expect(
    (
      await app.inject({
        method: "GET",
        url,
        headers: { "x-cantrip-workspace-version": "2" },
      })
    ).statusCode,
  ).toBe(200);
  const stale = await app.inject({
    method: "POST",
    url: `${url}/commands`,
    payload: command(layout, { type: "home" }),
  });
  expect(stale.statusCode).toBe(409);
  expect(
    (await db.repository.workspaceLayouts.get(owner, projectId, layout.id))
      ?.revision,
  ).toBe(layout.revision);
  const transfer = await db.repository.workspaceLayouts.execute(
    owner,
    command(layout, {
      type: "prepare-detach",
      transferId: randomUUID(),
      paneId: pane.id,
      tabId: pane.conversationView!.id,
      destinationWindowId: "direct-popout",
      destinationPaneId: randomUUID(),
    }),
  );
  expect(transfer?.layout.pendingTransfers).toHaveLength(1);
  expect(await db.repository.archiveAgentConversation(owner, fields.id)).toBe(
    "archived",
  );
  const archived = (await db.repository.workspaceLayouts.get(
    owner,
    projectId,
    layout.id,
  ))!;
  expect(archived.pendingTransfers).toEqual([]);
  expect(archived.windows.some((w) => w.id === "direct-popout")).toBe(false);
  expect(
    archived.windows
      .flatMap((w) => w.panes)
      .some((p) => p.conversationView?.id === pane.conversationView!.id),
  ).toBe(false);
});

it("retains workspace and idempotency receipts across a database restart", async () => {
  const layout = await seed();
  const input = command(layout, open());
  const applied = (await db.repository.workspaceLayouts.execute(owner, input))!;
  await db.close();
  db = await connectDatabase(config);
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, layout.id),
  ).toEqual(applied.layout);
  expect(
    (await db.repository.workspaceLayouts.execute(owner, input))!.replayed,
  ).toBe(true);
}, 30_000);

it("returns a client error and rolls back identity collisions", async () => {
  const layout = await seed();
  const first = (await db.repository.workspaceLayouts.execute(
    owner,
    command(layout, open()),
  ))!;
  const action = open();
  if (action.type !== "open") throw new Error("fixture");
  action.tab.resource = { kind: "builtin", definitionId: "git.history" };
  action.tab.id = first.layout.windows[0]!.panes[0]!.tabs[0]!.id;
  action.tab.builtInState = { definitionId: "git.history", worktreeId: null };
  const input = command(first.layout, action);
  // The app fixture retains the pre-restart repository, so use a new route host.
  const host = Fastify();
  installWorkspaceLayoutRoutes(host, {
    applicationOwnerId: () => owner,
    repository: db.repository,
  });
  try {
    const response = await host.inject({
      method: "POST",
      url: `/api/projects/${projectId}/workspace-layouts/${layout.id}/commands`,
      payload: input,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid");
    expect(
      await db.repository.workspaceLayouts.get(owner, projectId, layout.id),
    ).toEqual(first.layout);
  } finally {
    await host.close();
  }
});
