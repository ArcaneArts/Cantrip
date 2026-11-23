import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";

import { ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

function secretVault(): SecretVault {
  return new SecretVault({
    activeKeyId: "test",
    keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
  });
}

describe("authoritative server identity", () => {
  it("converges concurrent repository instances on the inserted UUID", async () => {
    const client = new PGlite();
    try {
      await client.exec(`
        CREATE TABLE system_state (
          key text PRIMARY KEY,
          value jsonb NOT NULL DEFAULT '{}'::jsonb,
          updated_at timestamp with time zone NOT NULL DEFAULT now()
        )
      `);
      const database = drizzle(client, { schema });
      const first = new ServerRepository(database, secretVault());
      const second = new ServerRepository(database, secretVault());

      const resolved = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          (index % 2 === 0 ? first : second).getOrCreateServerId(),
        ),
      );
      expect(new Set(resolved)).toEqual(new Set([resolved[0]]));
      expect(resolved[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      );

      const stored = await client.query<{ value: { id: string } }>(
        "SELECT value FROM system_state WHERE key = 'server-id'",
      );
      expect(stored.rows).toEqual([{ value: { id: resolved[0] } }]);
      await expect(first.getOrCreateServerId()).resolves.toBe(resolved[0]);
      await expect(second.getOrCreateServerId()).resolves.toBe(resolved[0]);
    } finally {
      await client.close();
    }
  });
});
