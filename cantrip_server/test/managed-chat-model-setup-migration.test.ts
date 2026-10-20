import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("upgrades the preparation phase constraint without changing existing receipts", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE managed_chat_preparations (
      chat_id text PRIMARY KEY,
      phase text NOT NULL CONSTRAINT managed_chat_preparations_phase_check
        CHECK (phase IN ('pending','thread','console','ready','failed')),
      failed_phase text
    );
    INSERT INTO managed_chat_preparations VALUES ('failed', 'failed', 'thread'), ('ready', 'ready', NULL);`);
    await db.exec(
      await readFile(
        new URL(
          "../drizzle/0227_managed_chat_model_setup.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      (
        await db.query(
          "SELECT * FROM managed_chat_preparations ORDER BY chat_id",
        )
      ).rows,
    ).toEqual([
      { chat_id: "failed", phase: "failed", failed_phase: "thread" },
      { chat_id: "ready", phase: "ready", failed_phase: null },
    ]);
    await db.exec(
      "INSERT INTO managed_chat_preparations VALUES ('setup', 'needs-model', NULL)",
    );
    await expect(
      db.exec(
        "INSERT INTO managed_chat_preparations VALUES ('invalid', 'unknown', NULL)",
      ),
    ).rejects.toThrow("managed_chat_preparations_phase_check");
  } finally {
    await db.close();
  }
});
