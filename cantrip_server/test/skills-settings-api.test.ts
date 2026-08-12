import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  skillSettingsDocumentSchema,
  skillSettingsInventorySchema,
  skillSettingsMutationResultSchema,
  unprobedCodexRuntimeReport,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const dataDirectory = await mkdtemp(path.join(tmpdir(), "cantrip-skills-api-"));
const projectPath = path.join(dataDirectory, "project");
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};

const projectSkill = {
  id: "project:cHJvamVjdC1yZXZpZXc",
  name: "project-review",
  description: "Review this repository.",
  displayName: null,
  scope: "repo" as const,
  location: "project" as const,
  path: `${projectPath}/.agents/skills/project-review/SKILL.md`,
  editable: true,
  deletable: true,
};
const inventory = skillSettingsInventorySchema.parse({
  project: [projectSkill],
  global: [],
  errors: [],
});
const document = skillSettingsDocumentSchema.parse({
  skill: projectSkill,
  file: { path: "SKILL.md", sizeBytes: 80 },
  files: [{ path: "SKILL.md", sizeBytes: 80 }],
  content:
    "---\nname: project-review\ndescription: Review this repository.\n---\n",
});
const changed = skillSettingsMutationResultSchema.parse({
  changed: true,
  recoveryPath: null,
});
const commands: WorkerCommand[] = [];
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "test-worker";
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    commands.push(command);
    if (command.type === "skills.settings.list") return inventory;
    if (command.type === "skills.settings.read") return document;
    if (command.type === "skills.settings.write") return changed;
    if (command.type === "skills.settings.delete") {
      return { ...changed, recoveryPath: "/worker/recovery/project-review" };
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;
let providerId: string;

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "test-worker",
    name: "Test Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.146.1",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "test-worker",
    repositoryId: "skills-settings-api",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    project.id,
    "test-worker",
    {
      path: projectPath,
      displayPath: projectPath,
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  providerId = (await database.repository.getSettings(LOCAL_USER_ID))
    .providers[0]!.id;
});

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("skills settings API", () => {
  it("lists project and global skills through the owning worker", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/skills?workerId=test-worker&providerId=${providerId}&projectId=${projectId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(skillSettingsInventorySchema.parse(response.json())).toEqual(
      inventory,
    );
    expect(commands.at(-1)).toMatchObject({
      type: "skills.settings.list",
      cwd: projectPath,
      providerId,
    });
  });

  it("reads and updates a selected skill file", async () => {
    const requestContext = {
      workerId: "test-worker",
      providerId,
      projectId,
      skillId: projectSkill.id,
      file: "SKILL.md",
    };
    const readResponse = await app.inject({
      method: "POST",
      url: "/api/skills/read",
      payload: requestContext,
    });
    expect(readResponse.statusCode).toBe(200);
    expect(skillSettingsDocumentSchema.parse(readResponse.json())).toEqual(
      document,
    );

    const writeResponse = await app.inject({
      method: "PUT",
      url: "/api/skills/file",
      payload: {
        ...requestContext,
        content: `${document.content}\nUpdated.\n`,
      },
    });
    expect(writeResponse.statusCode).toBe(200);
    expect(commands.at(-1)).toMatchObject({
      type: "skills.settings.write",
      cwd: projectPath,
      skillId: projectSkill.id,
    });
  });

  it("deletes through the recovery-aware worker command", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/skills",
      payload: {
        workerId: "test-worker",
        providerId,
        projectId,
        skillId: projectSkill.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(skillSettingsMutationResultSchema.parse(response.json())).toEqual({
      changed: true,
      recoveryPath: "/worker/recovery/project-review",
    });
  });

  it("rejects a worker that does not own the project", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/skills?workerId=other-worker&providerId=${providerId}&projectId=${projectId}`,
    });
    expect(response.statusCode).toBe(409);
  });
});
