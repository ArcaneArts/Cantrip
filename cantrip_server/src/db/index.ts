import { mkdir, rename } from "node:fs/promises";
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
import {
  resolveSecretVault,
  type SecretVault,
} from "../security/secret-vault.js";
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
  secretVault: SecretVault,
): Promise<DatabaseConnection> {
  await mkdir(config.dataDirectory, { recursive: true });

  const databaseDirectory = path.join(config.dataDirectory, "server-db");

  try {
    return await openPglite(databaseDirectory, secretVault);
  } catch (error) {
    if (config.bootstrapMode !== "pnpm-dev" || !isPgliteAbort(error)) {
      throw error;
    }

    const backupDirectory = path.join(
      config.dataDirectory,
      `server-db-corrupt-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
    );
    await rename(databaseDirectory, backupDirectory);
    console.warn(
      `[cantrip_server] PGlite data was unreadable. Preserved it at ${backupDirectory} and created a fresh development database.`,
    );
    return openPglite(databaseDirectory, secretVault);
  }
}

function isPgliteAbort(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    if (
      current instanceof Error &&
      current.name === "RuntimeError" &&
      current.message.includes("Aborted()")
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }

  return false;
}

async function openPglite(
  databaseDirectory: string,
  secretVault: SecretVault,
): Promise<DatabaseConnection> {
  const client = new PGlite(databaseDirectory);
  const database = drizzlePglite(client, { schema });

  try {
    await migratePglite(database, { migrationsFolder });
    const repository = new ServerRepository(database, secretVault);
    await repository.ensureLocalIdentity();
    await repository.migrateProviderSecrets();

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
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectPostgres(
  databaseUrl: string,
  secretVault: SecretVault,
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
      const repository = new ServerRepository(database, secretVault);
      await repository.ensureLocalIdentity();
      await repository.migrateProviderSecrets();

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
  const secretVault = await resolveSecretVault(config);
  if (config.databaseUrl) {
    return connectPostgres(config.databaseUrl, secretVault);
  }

  return connectPglite(config, secretVault);
}
