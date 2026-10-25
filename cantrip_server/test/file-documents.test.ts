import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  installFileDocumentRoutes,
  installFileDocumentOperationRoute,
} from "../src/app/routes/file-documents.js";
import {
  fileDocumentCreateSchema,
  unprobedCodexRuntimeReport,
  type WorkspaceAction,
  type WorkspaceOwnership,
} from "@cantrip/protocol";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  protectedExplorerFields,
  protectedDisplayLabelFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

let db: DatabaseConnection;
let directory: string;
let projectId: string;
let worktreeId: string;
const owner = LOCAL_USER_ID;
const app = Fastify();
let requestOwner = owner;
const workerRequest = vi.fn();
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-file-documents-"));
  db = await connectDatabase({
    agentModel: "gemma4:26b",
    agentModelProvider: "ollama",
    appOrigins: [],
    authMode: "none",
    bootstrapMode: "pnpm-dev",
    dataDirectory: directory,
    deploymentMode: "local",
    host: "127.0.0.1",
    port: 4310,
    ollamaBaseUrl: "http://127.0.0.1:11434/v1",
    workerToken: "test",
  });
  await db.repository.recordWorker(owner, {
    workerId: "document-worker",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.163.0",
    codexRuntime: unprobedCodexRuntimeReport,
    startedAt: new Date().toISOString(),
  });
  const project = await db.repository.createGithubProject(owner, {
    workerId: "document-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "D".repeat(43),
    repositoryId: "documents",
    nameWithOwner: "test/documents",
    url: "https://github.com/test/documents",
  });
  projectId = project.id;
  await db.repository.completeGithubProjectSetup(
    owner,
    projectId,
    "document-worker",
    {
      path: "/test/documents",
      displayPath: "test/documents",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  worktreeId = (await db.repository.listProjectWorktrees(owner, projectId))[0]!
    .id;
  installFileDocumentRoutes(app, {
    applicationOwnerId: () => requestOwner,
    repository: db.repository,
  });
  installFileDocumentOperationRoute(app, {
    applicationOwnerId: () => requestOwner,
    repository: db.repository,
    bridge: { request: workerRequest },
    serverId: "test-server",
  });
}, 30_000);
afterAll(async () => {
  await app.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function input() {
  return fileDocumentCreateSchema.parse({
    id: randomUUID(),
    worktreeId,
    stateProtection: {
      classification: { recordKind: "file-document-state" },
      protectedState: {
        formatVersion: 1,
        keyRevision: 2,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 2,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    },
  });
}

it("imports legacy native file windows once, with project authority and immutable document bindings", async () => {
  const document = (await db.repository.fileDocuments.create(
    owner,
    projectId,
    input(),
  ))!;
  const layout = (await db.repository.workspaceLayouts.seed(
    owner,
    projectId,
    randomUUID(),
    "main",
  ))!;
  const request = {
    windowId: `cantrip-editor-${randomUUID()}`,
    paneId: randomUUID(),
    expectedRevision: layout.revision,
    views: [
      { tabId: randomUUID(), documentId: document.id, mode: "edit" as const },
    ],
  };
  expect(
    await db.repository.workspaceLayouts.importLegacyFiles(
      "other-owner",
      projectId,
      layout.id,
      request,
    ),
  ).toBeNull();
  await expect(
    db.repository.workspaceLayouts.importLegacyFiles(
      owner,
      projectId,
      layout.id,
      {
        ...request,
        expectedRevision: layout.revision + 1,
      },
    ),
  ).rejects.toMatchObject({ code: "revision" });
  const explorer = (await db.repository.createExplorer(owner, projectId, {
    ...protectedExplorerFields(),
    worktreeId,
    attachToTabLayout: false,
  }))!;
  await expect(
    db.repository.workspaceLayouts.importLegacyFiles(
      owner,
      projectId,
      layout.id,
      {
        ...request,
        views: [{ ...request.views[0]!, documentId: explorer.id }],
      },
    ),
  ).rejects.toMatchObject({ code: "missing" });
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, layout.id),
  ).toEqual(layout);
  const first = (await db.repository.workspaceLayouts.importLegacyFiles(
    owner,
    projectId,
    layout.id,
    request,
  ))!;
  expect(first.replayed).toBe(false);
  expect(
    first.layout.windows.find((window) => window.id === request.windowId)
      ?.panes[0]?.tabs[0]?.resource,
  ).toEqual({
    kind: "entity",
    definitionId: "project.file",
    resourceId: document.id,
  });
  expect(
    await db.repository.workspaceLayouts.importLegacyFiles(
      owner,
      projectId,
      layout.id,
      request,
    ),
  ).toEqual({ ...first, replayed: true });
  await expect(
    db.repository.workspaceLayouts.importLegacyFiles(
      owner,
      projectId,
      layout.id,
      {
        ...request,
        paneId: randomUUID(),
      },
    ),
  ).rejects.toMatchObject({ code: "invalid" });
});

async function migrationFixture() {
  const explorer = (await db.repository.createExplorer(owner, projectId, {
    ...protectedExplorerFields(),
    worktreeId,
    attachToTabLayout: false,
  }))!;
  const document = (await db.repository.fileDocuments.create(
    owner,
    projectId,
    input(),
  ))!;
  const retained = (await db.repository.fileDocuments.create(
    owner,
    projectId,
    input(),
  ))!;
  const initial = (await db.repository.workspaceLayouts.seed(
    owner,
    projectId,
    randomUUID(),
    "main",
  ))!;
  const command = (layout: WorkspaceOwnership, action: WorkspaceAction) => ({
    operationId: randomUUID(),
    workspaceId: layout.id,
    projectId,
    windowId: "main",
    attachmentGeneration: 0,
    expectedRevision: layout.revision,
    action,
  });
  const tabId = randomUUID();
  const opened = (await db.repository.workspaceLayouts.execute(
    owner,
    command(initial, {
      type: "open",
      tab: {
        id: tabId,
        resource: {
          kind: "entity",
          definitionId: "project.explorer",
          resourceId: explorer.id,
        },
        preview: false,
        titleProtection: null,
        builtInState: null,
        dockPresentation: null,
      },
      target: {
        kind: "new-pane",
        paneId: randomUUID(),
        region: "center",
        splitId: randomUUID(),
      },
    }),
  ))!.layout;
  const action: Extract<WorkspaceAction, { type: "migrate-explorer-file" }> = {
    type: "migrate-explorer-file",
    tabId,
    explorerId: explorer.id,
    expectedWorkerId: explorer.activeWorkerId,
    expectedWorktreeId: explorer.worktreeId,
    expectedStateProtection: explorer.stateProtection,
    documentId: document.id,
    mode: "edit",
    retainedViews: [
      { tabId: randomUUID(), documentId: retained.id, mode: "edit" },
    ],
  };
  return { opened, command, action, explorer };
}

it("commits all migrated views once and replays the receipt without duplicating retained files", async () => {
  const f = await migrationFixture();
  const request = f.command(f.opened, f.action);
  const first = (await db.repository.workspaceLayouts.execute(owner, request))!;
  const replay = (await db.repository.workspaceLayouts.execute(
    owner,
    request,
  ))!;
  expect(replay.replayed).toBe(true);
  expect(replay.layout).toEqual(first.layout);
  const tabs = first.layout.windows.flatMap((w) =>
    w.panes.flatMap((p) => p.tabs),
  );
  expect(tabs.find((tab) => tab.id === f.action.tabId)?.resource).toEqual({
    kind: "entity",
    definitionId: "project.file",
    resourceId: f.action.documentId,
  });
  expect(
    tabs.filter((tab) => tab.id === f.action.retainedViews[0]!.tabId),
  ).toHaveLength(1);
  expect(
    await db.repository.workspaceLayouts.execute("foreign-owner", request),
  ).toBeNull();
});

async function codeMigrationFixture() {
  const f = await migrationFixture();
  const code = (await db.repository.createCodeTab(owner, projectId, {
    ...protectedDisplayLabelFields("code-tab"),
    worktreeId,
    attachToTabLayout: false,
  }))!;
  const tabId = randomUUID();
  const opened = (await db.repository.workspaceLayouts.execute(
    owner,
    f.command(f.opened, {
      type: "open",
      tab: {
        id: tabId,
        resource: {
          kind: "entity",
          definitionId: "project.code",
          resourceId: code.id,
        },
        preview: false,
        titleProtection: null,
        builtInState: null,
        dockPresentation: null,
      },
      target: {
        kind: "new-pane",
        paneId: randomUUID(),
        splitId: randomUUID(),
        region: "center",
      },
    }),
  ))!.layout;
  const action: Extract<WorkspaceAction, { type: "migrate-code-files" }> = {
    type: "migrate-code-files",
    tabId,
    codeId: code.id,
    expectedWorkerId: code.activeWorkerId,
    expectedWorktreeId: code.worktreeId,
    views: [
      { tabId: randomUUID(), documentId: f.action.documentId, mode: "edit" },
      ...f.action.retainedViews,
    ],
  };
  return { ...f, opened, action };
}
it("authorizes and commits Code conversion with an idempotent operation receipt", async () => {
  const f = await codeMigrationFixture();
  const request = f.command(f.opened, f.action);
  const first = (await db.repository.workspaceLayouts.execute(owner, request))!;
  expect(first.layout.legacyCodeImports).toEqual([
    { tabId: f.action.tabId, codeId: f.action.codeId, views: f.action.views },
  ]);
  const replay = (await db.repository.workspaceLayouts.execute(
    owner,
    request,
  ))!;
  expect(replay.replayed).toBe(true);
  expect(replay.layout).toEqual(first.layout);
  expect(
    await db.repository.workspaceLayouts.execute("foreign-owner", request),
  ).toBeNull();
});
it.each(["source", "worker", "worktree", "document"] as const)(
  "rejects unauthorized Code conversion %s without changing ownership",
  async (field) => {
    const f = await codeMigrationFixture();
    if (field === "source") f.action.codeId = "missing-code";
    if (field === "worker") f.action.expectedWorkerId = "other-worker";
    if (field === "worktree") f.action.expectedWorktreeId = "other-tree";
    if (field === "document")
      f.action.views[1]!.documentId = "unavailable-document";
    await expect(
      db.repository.workspaceLayouts.execute(
        owner,
        f.command(f.opened, f.action),
      ),
    ).rejects.toThrow();
    expect(
      await db.repository.workspaceLayouts.get(owner, projectId, f.opened.id),
    ).toEqual(f.opened);
  },
);

it.each(["state", "worker", "worktree", "document", "retained"] as const)(
  "rejects stale or unauthorized migration %s without partial placement",
  async (field) => {
    const f = await migrationFixture();
    if (field === "state")
      f.action.expectedStateProtection =
        protectedExplorerFields().stateProtection;
    if (field === "worker") f.action.expectedWorkerId = "other-worker";
    if (field === "worktree") f.action.expectedWorktreeId = "other-worktree";
    if (field === "document") f.action.documentId = "unavailable-document";
    if (field === "retained")
      f.action.retainedViews[0]!.documentId = "unavailable-document";
    await expect(
      db.repository.workspaceLayouts.execute(
        owner,
        f.command(f.opened, f.action),
      ),
    ).rejects.toThrow(
      field === "document" || field === "retained"
        ? /unavailable/
        : /binding changed/,
    );
    expect(
      await db.repository.workspaceLayouts.get(owner, projectId, f.opened.id),
    ).toEqual(f.opened);
  },
);

it("retains immutable documents after checkout rollback without granting execution", async () => {
  const checkoutId = randomUUID();
  const checkoutPath = `/test/worktrees/${checkoutId}`;
  const primaryPath = "/test/documents";
  const worktrees = [primaryPath, checkoutPath].map((path, index) => ({
    path,
    head: "a".repeat(40),
    branch: index === 0 ? "main" : "document-checkout",
    detached: false,
    isPrimary: index === 0,
    managed: index !== 0,
    locked: false,
    lockReason: null,
    prunable: false,
    pruneReason: null,
    missing: false,
  }));
  await db.repository.reconcileProjectWorktrees(
    owner,
    projectId,
    "document-worker",
    {
      sourcePath: primaryPath,
      primaryPath,
      gitCommonDir: `${primaryPath}/.git`,
      managedRoot: "/test/worktrees",
      repositoryFingerprint: "a".repeat(64),
      worktrees,
    },
    {
      id: checkoutId,
      origin: "cantrip",
      name: "Document checkout",
      path: checkoutPath,
    },
  );
  const created = await db.repository.fileDocuments.create(owner, projectId, {
    ...input(),
    worktreeId: checkoutId,
  });
  expect(created).not.toBeNull();
  expect(
    await db.repository.fileDocuments.executionContext(owner, created!.id),
  ).toMatchObject({ root: checkoutPath });
  expect(
    await db.repository.rollbackProjectWorktreeCreation(
      owner,
      projectId,
      "document-worker",
      { id: checkoutId, origin: "cantrip", path: checkoutPath },
    ),
  ).toBe(true);
  expect(await db.repository.fileDocuments.get(owner, created!.id)).toEqual(
    created,
  );
  expect(
    await db.repository.fileDocuments.executionContext(owner, created!.id),
  ).toBeNull();
  expect(
    await db.repository.fileDocuments.get("other-owner", created!.id),
  ).toBeNull();
  expect(
    await db.repository.fileDocuments.create(owner, projectId, {
      ...input(),
      worktreeId: checkoutId,
    }),
  ).toBeNull();
});

it("persists file modes per device view without changing the protected document", async () => {
  const document = (await db.repository.fileDocuments.create(
    owner,
    projectId,
    input(),
  ))!;
  const command = (layout: WorkspaceOwnership, action: WorkspaceAction) => ({
    operationId: randomUUID(),
    workspaceId: layout.id,
    projectId,
    windowId: "main",
    attachmentGeneration: 0,
    expectedRevision: layout.revision,
    action,
  });
  const openOnDevice = async () => {
    const layout = (await db.repository.workspaceLayouts.seed(
      owner,
      projectId,
      randomUUID(),
      "main",
    ))!;
    return (await db.repository.workspaceLayouts.execute(
      owner,
      command(layout, {
        type: "open",
        tab: {
          id: randomUUID(),
          resource: {
            kind: "entity",
            definitionId: "project.file",
            resourceId: document.id,
          },
          preview: false,
          titleProtection: null,
          builtInState: null,
          dockPresentation: null,
        },
        target: {
          kind: "new-pane",
          paneId: randomUUID(),
          region: "center",
          splitId: randomUUID(),
        },
      }),
    ))!.layout;
  };
  const desktop = await openOnDevice();
  const mobile = await openOnDevice();
  const fileTab = (layout: WorkspaceOwnership) =>
    layout.windows
      .flatMap((w) => w.panes)
      .flatMap((p) => p.tabs)
      .find(
        (t) =>
          t.resource.kind === "entity" && t.resource.resourceId === document.id,
      )!;
  const firstCommand = command(desktop, {
    type: "file-mode",
    tabId: fileTab(desktop).id,
    mode: "preview",
  });
  const first = (await db.repository.workspaceLayouts.execute(
    owner,
    firstCommand,
  ))!;
  expect(
    fileTab(
      (await db.repository.workspaceLayouts.get(owner, projectId, desktop.id))!,
    ).fileMode,
  ).toBe("preview");
  const second = (await db.repository.workspaceLayouts.execute(
    owner,
    command(first.layout, {
      type: "file-mode",
      tabId: fileTab(desktop).id,
      mode: "visual",
    }),
  ))!;
  const replay = (await db.repository.workspaceLayouts.execute(
    owner,
    firstCommand,
  ))!;
  expect(replay.replayed).toBe(true);
  expect(replay.layout).toEqual(second.layout);
  expect(
    fileTab(
      (await db.repository.workspaceLayouts.get(owner, projectId, desktop.id))!,
    ).fileMode,
  ).toBe("visual");
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, mobile.id),
  ).toEqual(mobile);
  expect(await db.repository.fileDocuments.get(owner, document.id)).toEqual(
    document,
  );
  expect(
    await db.repository.workspaceLayouts.execute(
      "other-owner",
      command(second.layout, {
        type: "file-mode",
        tabId: fileTab(desktop).id,
        mode: "edit",
      }),
    ),
  ).toBeNull();
  expect(
    await db.repository.workspaceLayouts.get(owner, projectId, desktop.id),
  ).toEqual(second.layout);
});

it("routes document operations using stored authority, never a client root", async () => {
  const document = input();
  await db.repository.fileDocuments.create(owner, projectId, document);
  const envelope = document.stateProtection.protectedState;
  const protectedRequest = {
    formatVersion: envelope.formatVersion,
    keyRevision: envelope.keyRevision,
    envelope: envelope.envelope,
  };
  const operation = {
    operationId: randomUUID(),
    sequence: 0,
    protectedRequest,
  };
  workerRequest.mockResolvedValue({
    operationId: operation.operationId,
    sequence: 0,
    protectedResponse: protectedRequest,
  });
  const url = `/api/file-documents/${document.id}/operation`;
  const response = await app.inject({
    method: "POST",
    url,
    payload: operation,
  });
  expect(response.statusCode).toBe(200);
  expect(workerRequest).toHaveBeenLastCalledWith("document-worker", {
    type: "file-document.operation",
    documentId: document.id,
    serverId: "test-server",
    projectId,
    workerId: "document-worker",
    worktreeId,
    root: "/test/documents",
    stateProtection: document.stateProtection,
    ...operation,
  });
  workerRequest.mockClear();
  const forged = await app.inject({
    method: "POST",
    url,
    payload: { ...operation, root: "/other" },
  });
  expect(forged.statusCode).toBe(400);
  expect(workerRequest).not.toHaveBeenCalled();
  requestOwner = "other-owner";
  try {
    const denied = await app.inject({
      method: "POST",
      url,
      payload: operation,
    });
    expect(denied.statusCode).toBe(404);
    expect(workerRequest).not.toHaveBeenCalled();
  } finally {
    requestOwner = owner;
  }
});

it("serializes concurrent document identities without replacing the first envelope", async () => {
  const first = input();
  const second = structuredClone(first);
  second.stateProtection.protectedState.envelope.nonce = "BBBBBBBBBBBBBBBB";
  const results = await Promise.allSettled([
    db.repository.fileDocuments.create(owner, projectId, first),
    db.repository.fileDocuments.create(owner, projectId, second),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const accepted = results.find((result) => result.status === "fulfilled")!;
  if (accepted.status !== "fulfilled")
    throw new Error("Missing accepted creation");
  expect(await db.repository.fileDocuments.get(owner, first.id)).toEqual(
    accepted.value,
  );
  expect(
    (await db.repository.fileDocuments.list(owner, projectId)).filter(
      (document) => document.id === first.id,
    ),
  ).toHaveLength(1);
});

it("serves the protected catalog with idempotent creation and explicit conflicts", async () => {
  const request = input();
  const url = `/api/projects/${projectId}/file-documents`;
  const created = await app.inject({ method: "POST", url, payload: request });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({
    ...request,
    projectId,
    workerId: "document-worker",
  });
  const retry = await app.inject({ method: "POST", url, payload: request });
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(created.json());
  const get = await app.inject({
    method: "GET",
    url: `/api/file-documents/${request.id}`,
  });
  expect(get.statusCode).toBe(200);
  expect(get.json()).toEqual(created.json());
  const catalog = await app.inject({ method: "GET", url });
  expect(catalog.statusCode).toBe(200);
  expect(catalog.json()).toContainEqual(created.json());
  expect(created.json()).not.toHaveProperty("path");
  const changed = structuredClone(request);
  changed.stateProtection.protectedState.envelope.ciphertext = Buffer.alloc(
    16,
    2,
  ).toString("base64url");
  const conflict = await app.inject({ method: "POST", url, payload: changed });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toEqual({
    error: "File document identity already exists with a different binding.",
  });
  const invalid = await app.inject({
    method: "POST",
    url,
    payload: { ...input(), path: "/private/file" },
  });
  expect(invalid.statusCode).toBe(400);
});

it("does not expose another owner's catalog through HTTP", async () => {
  const request = input();
  await db.repository.fileDocuments.create(owner, projectId, request);
  requestOwner = "other-owner";
  try {
    const get = await app.inject({
      method: "GET",
      url: `/api/file-documents/${request.id}`,
    });
    expect(get.statusCode).toBe(404);
    const url = `/api/projects/${projectId}/file-documents`;
    const list = await app.inject({ method: "GET", url });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);
    const create = await app.inject({ method: "POST", url, payload: input() });
    expect(create.statusCode).toBe(404);
  } finally {
    requestOwner = owner;
  }
});

it("derives the worker from the authorized checkout and retries immutably", async () => {
  const request = input();
  const created = await db.repository.fileDocuments.create(
    owner,
    projectId,
    request,
  );
  expect(created).toMatchObject({
    ...request,
    projectId,
    workerId: "document-worker",
  });
  expect(
    await db.repository.fileDocuments.create(owner, projectId, request),
  ).toEqual(created);
  expect(await db.repository.fileDocuments.get(owner, request.id)).toEqual(
    created,
  );
  expect(
    (await db.repository.fileDocuments.list(owner, projectId)).filter(
      (row) => row.id === request.id,
    ),
  ).toEqual([created]);
  const changed = structuredClone(request);
  changed.stateProtection.protectedState.envelope.ciphertext = Buffer.alloc(
    16,
    1,
  ).toString("base64url");
  await expect(
    db.repository.fileDocuments.create(owner, projectId, changed),
  ).rejects.toThrow("different binding");
  expect(await db.repository.fileDocuments.get(owner, request.id)).toEqual(
    created,
  );
});

it("does not expose or create documents for another owner or project", async () => {
  const request = input();
  await db.repository.fileDocuments.create(owner, projectId, request);
  expect(
    await db.repository.fileDocuments.get("other-owner", request.id),
  ).toBeNull();
  expect(
    await db.repository.fileDocuments.list("other-owner", projectId),
  ).toEqual([]);
  expect(
    await db.repository.fileDocuments.create("other-owner", projectId, input()),
  ).toBeNull();
  expect(
    await db.repository.fileDocuments.create(owner, "other-project", input()),
  ).toBeNull();
  expect(
    await db.repository.fileDocuments.create(owner, projectId, {
      ...input(),
      worktreeId: "missing",
    }),
  ).toBeNull();
});
