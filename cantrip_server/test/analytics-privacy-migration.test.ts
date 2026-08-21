import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../drizzle/0132_polite_mongoose.sql", import.meta.url),
);

describe("analytics privacy migration", () => {
  it("drops copied labels, raw diagnostics, and arbitrary audit metadata", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const column of [
      "metadata",
      "provider_account_label",
      "sanitized_raw_payload",
      "sanitized_raw_usage",
      "credential_last_refresh_error",
      "last_error",
    ]) {
      expect(migration).toContain(`DROP COLUMN \"${column}\"`);
    }
    expect(migration).toContain('ADD COLUMN "protected_label" jsonb NOT NULL');
    expect(migration).toContain('ADD COLUMN "error_code" text');
    expect(migration).not.toMatch(/UPDATE[\s\S]+protected_label/iu);
    expect(migration).not.toMatch(/UPDATE[\s\S]+error_code/iu);
  });
});
