import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  projectAlertProjectionSchema,
  unprobedCodexRuntimeReport,
  type ProjectAlertProjection,
} from "@cantrip/protocol";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  protectedProjectFields,
  protectedDisplayLabelFields,
} from "./private-label-fixture.js";
import { installProjectAlertRoutes } from "../src/app/routes/project-alerts.js";

let db: DatabaseConnection,
  directory: string,
  project: string,
  other: string,
  chat: string;
let owner = LOCAL_USER_ID;
const app = Fastify();
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-alerts-"));
  db = await connectDatabase({
    databaseUrl: process.env.CANTRIP_ALERT_TEST_DATABASE_URL,
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
    workerId: "alert-worker",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.166.0",
    codexRuntime: unprobedCodexRuntimeReport,
    startedAt: new Date().toISOString(),
  });
  const create = async (name: string, blind: string) => {
    const result = await db.repository.createGithubProject(owner, {
      workerId: "alert-worker",
      ...protectedProjectFields(),
      repositoryBlindIndex: blind.repeat(43),
      repositoryId: name,
      nameWithOwner: `qa/${name}`,
      url: `https://github.com/qa/${name}`,
    });
    await db.repository.completeGithubProjectSetup(
      owner,
      result.id,
      "alert-worker",
      {
        path: `/test/${name}`,
        displayPath: `/test/${name}`,
        reused: false,
        updated: false,
        warning: null,
      },
    );
    return result.id;
  };
  project = await create("alerts", "A");
  other = await create("other", "B");
  await db.repository.ensureAccountConfiguration(owner);
  chat = (await db.repository.createChat(owner, project, {
    ...protectedDisplayLabelFields("chat"),
    modelId: null,
  }))!.id;
  installProjectAlertRoutes(app, {
    applicationOwnerId: () => owner,
    repository: db.repository,
  });
}, 30_000);
afterAll(async () => {
  await app.close();
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
function event(
  sourceId: string,
  overrides: Partial<ProjectAlertProjection> = {},
): ProjectAlertProjection {
  return projectAlertProjectionSchema.parse({
    projectId: project,
    chatId: chat,
    source: "interaction",
    sourceId,
    episodeId: "request",
    sourceRevision: 1,
    kind: "permission",
    status: "open",
    target: { kind: "interaction", chatId: chat, requestId: sourceId },
    occurredAt: "2026-11-02T12:00:00.000Z",
    ...overrides,
  });
}

it("creates one row per source episode, rejects stale events, and retains resolution tombstones", async () => {
  const initial = await db.repository.alerts.apply(owner, event("one"));
  expect(initial?.status).toBe("open");
  expect((await db.repository.alerts.apply(owner, event("one")))?.id).toBe(
    initial!.id,
  );
  const updated = await db.repository.alerts.apply(
    owner,
    event("one", { sourceRevision: 3, kind: "user-input" }),
  );
  expect(updated?.kind).toBe("user-input");
  expect(
    (
      await db.repository.alerts.apply(
        owner,
        event("one", { sourceRevision: 2 }),
      )
    )?.kind,
  ).toBe("user-input");
  const closed = await db.repository.alerts.apply(
    owner,
    event("one", { sourceRevision: 4, status: "resolved" }),
  );
  expect(closed?.resolvedAt).not.toBeNull();
  expect(
    (
      await db.repository.alerts.apply(
        owner,
        event("one", { sourceRevision: 5 }),
      )
    )?.status,
  ).toBe("resolved");
  expect(
    (
      await db.repository.alerts.apply(
        owner,
        event("one", { episodeId: "new-request" }),
      )
    )?.id,
  ).not.toBe(initial!.id);
});

it("a terminal event delivered before its opening event cannot resurrect an alert", async () => {
  await db.repository.alerts.apply(
    owner,
    event("closed-first", { sourceRevision: 2, status: "resolved" }),
  );
  expect(
    (await db.repository.alerts.apply(owner, event("closed-first")))?.status,
  ).toBe("resolved");
});

it("lists with stable priority/time/id ordering and a cursor that survives resolution", async () => {
  for (const id of ["page-c", "page-b", "page-a"])
    await db.repository.alerts.apply(owner, event(id, { priority: 0 }));
  const first = await db.repository.alerts.list(owner, project, { limit: 2 });
  expect(first!.items).toHaveLength(2);
  expect(first!.items.every((a) => a.priority === 0)).toBe(true);
  expect(first!.nextCursor).toBe(first!.items[1]!.id);
  const anchor = first!.items[1]!;
  await db.repository.alerts.apply(
    owner,
    event(anchor.sourceId, {
      priority: 0,
      sourceRevision: 2,
      status: "resolved",
    }),
  );
  const next = await db.repository.alerts.list(owner, project, {
    limit: 2,
    after: first!.nextCursor!,
  });
  expect(next!.items.some((a) => first!.items.some((b) => a.id === b.id))).toBe(
    false,
  );
  expect(next!.items[0]!.priority).toBe(0);
});

it("keeps projects and owners isolated, with accurate aggregate counts", async () => {
  const cross = event("cross-chat", { projectId: other });
  expect(await db.repository.alerts.apply(owner, cross)).toBeNull();
  expect(
    await db.repository.alerts.apply("foreign-owner", event("foreign")),
  ).toBeNull();
  expect(await db.repository.alerts.counts("foreign-owner")).toEqual([]);
  expect(await db.repository.alerts.list("foreign-owner", project)).toBeNull();
  await db.repository.alerts.apply(
    owner,
    event("other-project", {
      projectId: other,
      chatId: null,
      target: { kind: "interaction", chatId: null, requestId: "other-project" },
    }),
  );
  const page = await db.repository.alerts.list(owner, project, { limit: 100 });
  const counts = await db.repository.alerts.counts(owner);
  expect(counts.find((a) => a.projectId === project)?.count).toBe(
    page!.items.length,
  );
  expect(counts.find((a) => a.projectId === other)?.count).toBe(1);
  expect(page!.items.some((a) => a.projectId !== project)).toBe(false);
});

it("publishes scoped post-commit notifications and does not notify for replayed writes", async () => {
  const changes: unknown[] = [];
  const stop = db.repository.alerts.subscribe((value) => changes.push(value));
  try {
    await db.repository.alerts.apply(owner, event("notify"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toContainEqual({ ownerId: owner, projectId: project });
    const before = changes.length;
    await db.repository.alerts.apply(owner, event("notify"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(before);
  } finally {
    stop();
  }
});

it("exposes bounded read-only HTTP APIs and does not leak unknown owners or projects", async () => {
  const page = await app.inject(`/api/projects/${project}/alerts?limit=1`);
  expect(page.statusCode).toBe(200);
  expect(page.json().items).toHaveLength(1);
  expect(
    (await app.inject(`/api/projects/${project}/alerts?limit=101`)).statusCode,
  ).toBe(400);
  expect(
    (await app.inject(`/api/projects/${project}/alerts?after=invalid`))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject(
        `/api/projects/${project}/alerts?after=alert_${"0".repeat(64)}`,
      )
    ).statusCode,
  ).toBe(404);
  owner = "foreign-owner";
  try {
    expect(
      (await app.inject(`/api/projects/${project}/alerts`)).statusCode,
    ).toBe(404);
    expect((await app.inject("/api/project-alerts/counts")).json()).toEqual([]);
  } finally {
    owner = LOCAL_USER_ID;
  }
});
