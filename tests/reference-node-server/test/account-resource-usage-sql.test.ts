import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import { AccountResourceUsageRepository } from "../src/db/account-resource-usage.js";

describe("account resource usage SQL", () => {
  it("encodes raw history date bounds for the PostgreSQL driver", async () => {
    const dialect = new PgDialect();
    const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const database = {
      execute: vi.fn(async (statement: SQL) => {
        queries.push(dialect.sqlToQuery(statement));
        return [];
      }),
    };
    const repository = new AccountResourceUsageRepository(database as never);
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2026-08-02T00:00:00.000Z");

    await repository.listStorageHistory("owner-id", from, to, "day");
    await repository.listBandwidthHistory("owner-id", from, to, "day");

    expect(queries.map((query) => query.params)).toEqual([
      ["owner-id", from.toISOString(), to.toISOString()],
      ["owner-id", from.toISOString(), to.toISOString()],
    ]);
    expect(
      queries
        .flatMap((query) => query.params)
        .some((value) => value instanceof Date),
    ).toBe(false);
  });
});
