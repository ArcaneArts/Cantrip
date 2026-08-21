import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../drizzle/0133_lame_rocket_racer.sql", import.meta.url),
);

describe("workspace plaintext closure migration", () => {
  it("drops legacy rows and the plaintext name column without translating data", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain(
      'DELETE FROM "project_workspaces" WHERE "name" IS NOT NULL',
    );
    expect(migration).toContain('DROP COLUMN "name"');
    expect(migration).toContain("workspace:default:");
    expect(migration).not.toMatch(/UPDATE[\s\S]+name_envelope/iu);
  });
});
