import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { DatabaseEngine } from "@cantrip/protocol";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { ServerConfig } from "../config.js";
import { ServerRepository } from "./repository.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export interface DatabaseConnection {
  close(): Promise<void>;
  engine: DatabaseEngine;
  ping(): Promise<void>;
  repository: ServerRepository;
}

async function connectPglite(
  config: ServerConfig,
): Promise<DatabaseConnection> {
  await mkdir(config.dataDirectory, { recursive: true });

  const client = new PGlite(path.join(config.dataDirectory, "server-db"));
  const database = drizzlePglite(client, { schema });
  await migratePglite(database, { migrationsFolder });
  const repository = new ServerRepository(database);
  await repository.ensureLocalIdentity();

  return {
    engine: "pglite",
    repository,
    async ping() {
      await database.execute(sql`select 1`);
    },
    async close() {
      await client.close();
    },
  };
}

async function connectPostgres(
  databaseUrl: string,
  attempts = 30,
): Promise<DatabaseConnection> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = postgres(databaseUrl, {
      connect_timeout: 2,
      max: 5,
    });
    const database = drizzlePostgres(client, { schema });

    try {
      await database.execute(sql`select 1`);
      await migratePostgres(database, { migrationsFolder });
      const repository = new ServerRepository(database);
      await repository.ensureLocalIdentity();

      return {
        engine: "postgres",
        repository,
        async ping() {
          await database.execute(sql`select 1`);
        },
        async close() {
          await client.end({ timeout: 5 });
        },
      };
    } catch (error) {
      lastError = error;
      await client.end({ timeout: 0 });

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  throw new Error("Could not connect to PostgreSQL.", { cause: lastError });
}

export async function connectDatabase(
  config: ServerConfig,
): Promise<DatabaseConnection> {
  if (config.databaseUrl) {
    return connectPostgres(config.databaseUrl);
  }

  return connectPglite(config);
}
