import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("advances the durable effect revision only for rendering or opt-in changes", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE TABLE user_settings (user_id text PRIMARY KEY, computer_use_enabled boolean NOT NULL DEFAULT false, theme text); INSERT INTO user_settings(user_id) VALUES ('owner');`,
    );
    await db.exec(
      await readFile(
        new URL("../drizzle/0202_computer_use_effects.sql", import.meta.url),
        "utf8",
      ),
    );
    const revision = async () =>
      (
        await db.query<{ revision: number }>(
          `SELECT computer_use_effects_revision AS revision FROM user_settings`,
        )
      ).rows[0]!.revision;
    expect(await revision()).toBe(1);
    await db.exec(`UPDATE user_settings SET theme='dark';`);
    expect(await revision()).toBe(1);
    await db.exec(
      `UPDATE user_settings SET computer_use_effects='{"effect":"debug-gradient","parameters":{}}';`,
    );
    expect(await revision()).toBe(2);
    await db.exec(
      `UPDATE user_settings SET computer_use_effects='{"effect":"debug-gradient","parameters":{}}';`,
    );
    expect(await revision()).toBe(2);
    await db.exec(`UPDATE user_settings SET computer_use_enabled=true;`);
    expect(await revision()).toBe(3);
    await db.exec(`UPDATE user_settings SET computer_use_enabled=false;`);
    expect(await revision()).toBe(4);
  } finally {
    await db.close();
  }
});
