import { mkdir, rename, rm } from "node:fs/promises";
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
import { serverLogger } from "../logger.js";
import {
  resolveSecretVault,
  type SecretVault,
} from "../security/secret-vault.js";
import { LOCAL_USER_ID, ServerRepository } from "./repository.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const SLOW_DATABASE_HEALTH_CHECK_MS = 250;

class PgliteMigrationError extends Error {
  constructor(cause: unknown) {
    super("Could not migrate the internal PGlite database.", { cause });
    this.name = "PgliteMigrationError";
  }
}

async function databaseHealthCheck(
  engine: DatabaseEngine,
  execute: () => Promise<unknown>,
): Promise<void> {
  const startedAtMs = Date.now();
  try {
    await execute();
    const durationMs = Date.now() - startedAtMs;
    if (durationMs >= SLOW_DATABASE_HEALTH_CHECK_MS) {
      serverLogger.warn("Database health check was slow", {
        event: "database.health.slow",
        subsystem: "database",
        operation: "health-check",
        status: "degraded",
        reasonCode: "slow-operation",
        databaseEngine: engine,
        durationMs,
      });
    }
  } catch (error) {
    serverLogger.rateLimited(
      `database-health-failed:${engine}`,
      "error",
      "Database health check failed",
      {
        event: "database.health.failed",
        subsystem: "database",
        operation: "health-check",
        status: "failed",
        reasonCode: "query-failed",
        databaseEngine: engine,
        durationMs: Date.now() - startedAtMs,
        error,
      },
      { summaryEvery: 5, windowMs: 60_000 },
    );
    throw error;
  }
}

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
  const startedAtMs = Date.now();
  await mkdir(config.dataDirectory, { recursive: true });

  const databaseDirectory = path.join(config.dataDirectory, "server-db");

  try {
    return await openPglite(databaseDirectory, secretVault);
  } catch (error) {
    if (
      config.bootstrapMode === "tauri" &&
      error instanceof PgliteMigrationError
    ) {
      serverLogger.event(
        "warn",
        "Internal desktop database migration failed; resetting the database",
        {
          event: "database.reset.started",
          subsystem: "database",
          operation: "reset-desktop-database",
          reasonCode: "migration-failed",
          status: "resetting",
        },
      );
      await rm(databaseDirectory, { recursive: true, force: true });
      const connection = await openPglite(databaseDirectory, secretVault);
      serverLogger.event("info", "Internal desktop database reset completed", {
        event: "database.reset.completed",
        subsystem: "database",
        operation: "reset-desktop-database",
        status: "ready",
        durationMs: Date.now() - startedAtMs,
      });
      return connection;
    }
    if (config.bootstrapMode !== "pnpm-dev" || !isPgliteAbort(error)) {
      throw error;
    }

    const backupDirectory = path.join(
      config.dataDirectory,
      `server-db-corrupt-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`,
    );
    await rename(databaseDirectory, backupDirectory);
    serverLogger.event(
      "warn",
      "PGlite data was unreadable; preserved it and created a fresh development database",
      {
        event: "database.recovery.started",
        subsystem: "database",
        operation: "recover-development-database",
        reasonCode: "pglite-aborted",
        status: "recovering",
      },
    );
    const connection = await openPglite(databaseDirectory, secretVault);
    serverLogger.event("info", "PGlite development database recovered", {
      event: "database.recovery.completed",
      subsystem: "database",
      operation: "recover-development-database",
      status: "ready",
      durationMs: Date.now() - startedAtMs,
    });
    return connection;
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
  const startedAtMs = Date.now();
  const client = new PGlite(databaseDirectory);
  const database = drizzlePglite(client, { schema });

  try {
    try {
      await migratePglite(database, { migrationsFolder });
    } catch (error) {
      throw new PgliteMigrationError(error);
    }
    const repository = new ServerRepository(database, secretVault);
    await repository.ensureLocalIdentity();
    await repository.policies.ensureOwnerState(LOCAL_USER_ID);
    await repository.migrateProviderSecrets();
    await repository.migrateProviderAccountCredentialSecrets();
    await repository.migrateMcpServerSecrets();

    serverLogger.event("info", "PGlite migrations completed", {
      event: "database.migrations.completed",
      subsystem: "database",
      operation: "migrate",
      status: "completed",
      durationMs: Date.now() - startedAtMs,
      databaseEngine: "pglite",
    });

    return {
      engine: "pglite",
      repository,
      async ping() {
        await databaseHealthCheck("pglite", () =>
          database.execute(sql`select 1`),
        );
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
    const attemptStartedAtMs = Date.now();

    try {
      await database.execute(sql`select 1`);
      await migratePostgres(database, { migrationsFolder });
      const repository = new ServerRepository(database, secretVault);
      await repository.ensureLocalIdentity();
      await repository.policies.ensureOwnerState(LOCAL_USER_ID);
      await repository.migrateProviderSecrets();
      await repository.migrateProviderAccountCredentialSecrets();
      await repository.migrateMcpServerSecrets();

      serverLogger.event("info", "PostgreSQL migrations completed", {
        event: "database.migrations.completed",
        subsystem: "database",
        operation: "migrate",
        status: "completed",
        durationMs: Date.now() - attemptStartedAtMs,
        databaseEngine: "postgres",
        attempt,
      });

      return {
        engine: "postgres",
        repository,
        async ping() {
          await databaseHealthCheck("postgres", () =>
            database.execute(sql`select 1`),
          );
        },
        async close() {
          await client.end({ timeout: 5 });
        },
      };
    } catch (error) {
      lastError = error;
      await client.end({ timeout: 0 });

      if (attempt < attempts) {
        serverLogger.rateLimited(
          "database-postgres-connect-retry",
          "warn",
          "PostgreSQL connection attempt failed; retrying",
          {
            event: "database.connection.retrying",
            subsystem: "database",
            operation: "connect",
            reasonCode: "connection-failed",
            status: "retrying",
            attempt,
          },
          { summaryEvery: 5, windowMs: 30_000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  throw new Error("Could not connect to PostgreSQL.", { cause: lastError });
}

export async function connectDatabase(
  config: ServerConfig,
): Promise<DatabaseConnection> {
  const startedAtMs = Date.now();
  const databaseEngine = config.databaseUrl ? "postgres" : "pglite";
  serverLogger.event("info", "Database connection began", {
    event: "database.connection.started",
    subsystem: "database",
    operation: "connect",
    status: "connecting",
    databaseEngine,
  });
  const secretVault = await resolveSecretVault(config);
  const connection = config.databaseUrl
    ? await connectPostgres(config.databaseUrl, secretVault)
    : await connectPglite(config, secretVault);
  serverLogger.event("info", "Database connection completed", {
    event: "database.connection.completed",
    subsystem: "database",
    operation: "connect",
    status: "ready",
    durationMs: Date.now() - startedAtMs,
    databaseEngine: connection.engine,
  });
  return connection;
}
