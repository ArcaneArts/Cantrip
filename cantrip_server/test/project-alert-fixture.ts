import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as liteDrizzle } from "drizzle-orm/pglite";
import { migrate as liteMigrate } from "drizzle-orm/pglite/migrator";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import { migrate as pgMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { ServerRepository } from "../src/db/repository.js";
import { SecretVault } from "../src/security/secret-vault.js";
import * as schema from "../src/db/schema.js";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  protectedProjectFields,
  protectedDisplayLabelFields,
} from "./private-label-fixture.js";

export async function projectAlertFixture() {
  const owner = LOCAL_USER_ID;
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-alerts-"));
  const migrationsFolder = fileURLToPath(
    new URL("../drizzle", import.meta.url),
  );
  const url = process.env.CANTRIP_ALERT_TEST_DATABASE_URL;
  const pg = url ? postgres(url) : null;
  const lite = pg ? null : new PGlite();
  const database = pg
    ? pgDrizzle(pg, { schema })
    : liteDrizzle(lite!, { schema });
  if (pg) await pgMigrate(pgDrizzle(pg, { schema }), { migrationsFolder });
  else await liteMigrate(liteDrizzle(lite!, { schema }), { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  const receive = (payload: string) => repository.alerts.receive(payload);
  const unlisten = pg
    ? (await pg.listen("cantrip_project_alerts", receive)).unlisten
    : await lite!.listen("cantrip_project_alerts", receive);
  const db = {
    repository,
    database,
    async close() {
      await unlisten();
      if (pg) await pg.end();
      else await lite!.close();
    },
  };
  await repository.ensureLocalIdentity();
  await repository.policies.ensureOwnerState(owner);
  await db.repository.recordWorker(owner, {
    workerId: "alert-worker",
    name: "Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.166.0",
    codexRuntime: unprobedCodexRuntimeReport,
    startedAt: new Date().toISOString(),
  });
  const create = async (name: string) => {
    const result = await db.repository.createGithubProject(owner, {
      workerId: "alert-worker",
      ...protectedProjectFields(),
      repositoryBlindIndex: randomBytes(32).toString("base64url"),
      repositoryId: name + randomUUID(),
      nameWithOwner: `qa/${name}`,
      url: `https://github.com/qa/${name}`,
    });
    await db.repository.completeGithubProjectSetup(
      owner,
      result.id,
      "alert-worker",
      {
        path: `/test/${result.id}`,
        displayPath: `/test/${result.id}`,
        reused: false,
        updated: false,
        warning: null,
      },
    );
    return result.id;
  };
  const project = await create("alerts");
  const other = await create("other");
  await db.repository.ensureAccountConfiguration(owner);
  const chat = (await db.repository.createChat(owner, project, {
    ...protectedDisplayLabelFields("chat"),
    modelId: null,
  }))!.id;
  return {
    db,
    owner,
    project,
    other,
    chat,
    async close() {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
