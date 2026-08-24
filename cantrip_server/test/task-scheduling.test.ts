import { fileURLToPath } from "node:url";

import { taskWorkerCreateSchema } from "@cantrip/protocol/task-scheduling";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { TaskSchedulingConflictError } from "../src/db/task-scheduling.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_ROUTE_ID,
  DEFAULT_OLLAMA_PROVIDER_ID,
  LOCAL_USER_ID,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import { protectedProjectFields } from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function fixture() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    "fixture-model",
    "http://127.0.0.1:11434",
  );
  return { client, database, repository };
}

function workerInput(name: string) {
  return taskWorkerCreateSchema.parse({
    name,
    modelConfiguration: { modelId: DEFAULT_MODEL_ID },
  });
}

describe("Task scheduling persistence", () => {
  it("preserves explicit Task Worker ordering and optimistic mutations", async () => {
    const { client, repository } = await fixture();
    try {
      expect(
        await repository.taskScheduling.listTaskWorkers(LOCAL_USER_ID),
      ).toEqual([]);

      const primary = await repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Primary Tasks"),
      );
      expect(primary).toMatchObject({
        activeTaskCount: 0,
        allowsPlanGoal: false,
        continuityFamily: `model:${DEFAULT_MODEL_ID}`,
        continuityFamilyOverride: null,
        enabled: true,
        maxConcurrency: 1,
        position: 0,
        rowVersion: 1,
      });

      const updated = await repository.taskScheduling.updateTaskWorker(
        LOCAL_USER_ID,
        primary.id,
        {
          rowVersion: primary.rowVersion,
          allowsPlanGoal: true,
          continuityFamilyOverride: "gpt",
          maxConcurrency: 4,
        },
      );
      expect(updated).toMatchObject({
        allowsPlanGoal: true,
        continuityFamily: "gpt",
        continuityFamilyOverride: "gpt",
        maxConcurrency: 4,
        rowVersion: 2,
      });
      await expect(
        repository.taskScheduling.updateTaskWorker(LOCAL_USER_ID, primary.id, {
          rowVersion: primary.rowVersion,
          name: "Stale Tasks",
        }),
      ).rejects.toMatchObject<Partial<TaskSchedulingConflictError>>({
        code: "stale-version",
      });

      const secondary = await repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Secondary Tasks"),
      );
      const reordered = await repository.taskScheduling.reorderTaskWorkers(
        LOCAL_USER_ID,
        { ids: [secondary.id, primary.id] },
      );
      expect(
        reordered.map(({ id, position, rowVersion }) => ({
          id,
          position,
          rowVersion,
        })),
      ).toEqual([
        { id: secondary.id, position: 0, rowVersion: 2 },
        { id: primary.id, position: 1, rowVersion: 3 },
      ]);

      await expect(
        repository.taskScheduling.deleteTaskWorker(
          LOCAL_USER_ID,
          secondary.id,
          secondary.rowVersion,
        ),
      ).rejects.toMatchObject<Partial<TaskSchedulingConflictError>>({
        code: "stale-version",
      });
      expect(
        await repository.taskScheduling.deleteTaskWorker(
          LOCAL_USER_ID,
          secondary.id,
          reordered[0]!.rowVersion,
        ),
      ).toBe(true);
      expect(
        (await repository.taskScheduling.listTaskWorkers(LOCAL_USER_ID)).map(
          ({ id }) => id,
        ),
      ).toEqual([primary.id]);
    } finally {
      await client.close();
    }
  });

  it("updates Project Task pause state with its own revision", async () => {
    const { client, database, repository } = await fixture();
    try {
      const projectFields = protectedProjectFields();
      await database.insert(schema.projects).values({
        id: projectFields.id,
        ownerId: LOCAL_USER_ID,
        protectedLabel: projectFields.nameProtection,
        githubRepositoryBlindIndex: "A".repeat(43),
      });

      const initial = await repository.taskScheduling.getProjectTaskPauseState(
        LOCAL_USER_ID,
        projectFields.id,
      );
      expect(initial).toEqual({
        projectId: projectFields.id,
        paused: false,
        pausedAt: null,
        rowVersion: 1,
      });

      const paused = await repository.taskScheduling.setProjectTaskPauseState(
        LOCAL_USER_ID,
        projectFields.id,
        { paused: true, rowVersion: initial!.rowVersion },
      );
      expect(paused).toMatchObject({ paused: true, rowVersion: 2 });
      expect(paused?.pausedAt).not.toBeNull();
      await expect(
        repository.taskScheduling.setProjectTaskPauseState(
          LOCAL_USER_ID,
          projectFields.id,
          { paused: false, rowVersion: initial!.rowVersion },
        ),
      ).rejects.toMatchObject<Partial<TaskSchedulingConflictError>>({
        code: "stale-version",
      });
    } finally {
      await client.close();
    }
  });

  it("infers trusted continuity families and rejects incompatible subagents", async () => {
    const { client, database, repository } = await fixture();
    try {
      const catalogModelId = crypto.randomUUID();
      await database.insert(schema.providerModels).values({
        id: catalogModelId,
        providerId: DEFAULT_OLLAMA_PROVIDER_ID,
        nativeModelId: "grok-4.6",
        displayName: "Grok 4.6",
        family: "Grok",
        metadataSource: "grok",
      });
      await database
        .update(schema.modelRoutes)
        .set({ providerModelId: catalogModelId })
        .where(eq(schema.modelRoutes.id, DEFAULT_MODEL_ROUTE_ID));

      const inferred = await repository.taskScheduling.createTaskWorker(
        LOCAL_USER_ID,
        workerInput("Inferred family"),
      );
      expect(inferred).toMatchObject({
        continuityFamily: "grok",
        continuityFamilyOverride: null,
      });

      const otherProviderId = crypto.randomUUID();
      const otherModelId = crypto.randomUUID();
      await database.insert(schema.modelProviders).values({
        id: otherProviderId,
        ownerId: LOCAL_USER_ID,
        name: "Other provider",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:22468",
      });
      await database.insert(schema.modelProfiles).values({
        id: otherModelId,
        ownerId: LOCAL_USER_ID,
        name: "Other model",
      });
      await database.insert(schema.modelRoutes).values({
        id: crypto.randomUUID(),
        modelId: otherModelId,
        providerId: otherProviderId,
        modelName: "other-model",
      });

      await expect(
        repository.taskScheduling.createTaskWorker(
          LOCAL_USER_ID,
          taskWorkerCreateSchema.parse({
            name: "Incompatible subagent",
            modelConfiguration: {
              modelId: DEFAULT_MODEL_ID,
              customSubagentModel: true,
              subagentModelId: otherModelId,
            },
          }),
        ),
      ).rejects.toMatchObject<Partial<TaskSchedulingConflictError>>({
        code: "model-incompatible",
      });
    } finally {
      await client.close();
    }
  });
});
