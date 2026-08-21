import { fileURLToPath } from "node:url";

import type { AttachmentProtectedMetadata } from "@cantrip/protocol/attachment-content";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("opaque attachment persistence", () => {
  it("stores only protected metadata and public control-plane fields", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const protectedMetadata: AttachmentProtectedMetadata = {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: Buffer.alloc(12, 3).toString("base64url"),
          ciphertext: Buffer.from(
            "opaque attachment metadata ciphertext",
          ).toString("base64url"),
        },
      };

      await client.exec("SET session_replication_role = replica");
      await database.insert(schema.chatAttachments).values({
        id: "22222222-2222-4222-8222-222222222222",
        chatId: "11111111-1111-4111-8111-111111111111",
        workerId: "worker-attachment",
        protectedMetadata,
        sizeBytes: 42,
        status: "ready",
      });
      const stored = await client.query<{
        protected_metadata: unknown;
        size_bytes: number;
        status: string;
      }>(`
        SELECT protected_metadata, size_bytes, status
        FROM chat_attachments
      `);
      expect(stored.rows).toEqual([
        {
          protected_metadata: protectedMetadata,
          size_bytes: 42,
          status: "ready",
        },
      ]);
      expect(JSON.stringify(stored.rows)).not.toContain("private-file-name");
      expect(JSON.stringify(stored.rows)).not.toContain("private-preview");
      expect(JSON.stringify(stored.rows)).not.toContain("private-digest");

      const columns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_attachments'
        ORDER BY column_name
      `);
      const columnNames = columns.rows.map(({ column_name }) => column_name);
      expect(columnNames).toContain("protected_metadata");
      expect(
        columnNames.filter((columnName) =>
          [
            "file_name",
            "mime_type",
            "kind",
            "source",
            "preview_text",
            "sha256",
            "error",
          ].includes(columnName),
        ),
      ).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20_000);
});
