import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "../schema.js";

export type RepositoryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type RepositoryTransaction = Parameters<
  Parameters<RepositoryDatabase["transaction"]>[0]
>[0];

export function firstOrThrow<T>(rows: T[], operation: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Database returned no row after ${operation}.`);
  }
  return row;
}
