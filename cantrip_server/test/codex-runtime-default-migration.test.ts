import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { codexRuntimeReportSchema } from "@cantrip/protocol";

describe("Codex 0.157 runtime default migration", () => {
  it("updates new-worker defaults without replacing existing compatibility reports", async () => {
    const database = new PGlite();
    try {
      await database.exec(`
        CREATE TABLE workers (id text PRIMARY KEY, codex_runtime jsonb DEFAULT '{}');
        INSERT INTO workers VALUES ('existing', '{"version":{"semantic":"0.153.4"},"testedRange":"old"}');
      `);
      const sql = await readFile(
        new URL("../drizzle/0223_codex_0_157_runtime.sql", import.meta.url),
        "utf8",
      );
      await database.exec(sql);
      await database.exec("INSERT INTO workers (id) VALUES ('new')");
      const { rows } = await database.query<{
        id: string;
        codex_runtime: unknown;
      }>("SELECT id, codex_runtime FROM workers ORDER BY id");
      expect(rows[0]?.codex_runtime).toEqual({
        version: { semantic: "0.153.4" },
        testedRange: "old",
      });
      expect(
        codexRuntimeReportSchema.parse(rows[1]?.codex_runtime),
      ).toMatchObject({
        compatibility: "missing",
        version: null,
        testedRange: ">=0.157.1 <0.158.0",
      });
    } finally {
      await database.close();
    }
  }, 30_000);
});
