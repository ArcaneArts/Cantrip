import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import {
  userSettingsSchema,
  userSettingsUpdateSchema,
} from "@cantrip/protocol";

it("defaults off without adding opt-in to unrelated settings patches", () => {
  expect(userSettingsSchema.shape.computerUseEnabled.parse(undefined)).toBe(
    false,
  );
  expect(userSettingsUpdateSchema.parse({ theme: "dark" })).toEqual({
    theme: "dark",
  });
  expect(userSettingsUpdateSchema.parse({ computerUseEnabled: true })).toEqual({
    computerUseEnabled: true,
  });
});

it("migrates existing accounts off and advances only the changed owner's CUA lifetimes", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE user_settings (user_id text PRIMARY KEY);
      CREATE TABLE chats (id text PRIMARY KEY, owner_id text NOT NULL, computer_use_authority_generation integer NOT NULL DEFAULT 1);
      INSERT INTO user_settings VALUES ('a'), ('b');
      INSERT INTO chats (id,owner_id) VALUES ('a1','a'),('a2','a'),('b1','b');`);
    await db.exec(
      await readFile(
        new URL("../drizzle/0201_computer_use_opt_in.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (await db.query("SELECT computer_use_enabled FROM user_settings")).rows,
    ).toEqual([
      { computer_use_enabled: false },
      { computer_use_enabled: false },
    ]);
    await db.exec(
      "UPDATE user_settings SET computer_use_enabled=true WHERE user_id='a'",
    );
    await db.exec(
      "UPDATE user_settings SET computer_use_enabled=true WHERE user_id='a'",
    );
    expect(
      (
        await db.query(
          "SELECT computer_use_authority_generation AS generation FROM chats ORDER BY id",
        )
      ).rows,
    ).toEqual([{ generation: 2 }, { generation: 2 }, { generation: 1 }]);
    await db.exec(
      "UPDATE user_settings SET computer_use_enabled=false WHERE user_id='a'",
    );
    expect(
      (
        await db.query(
          "SELECT computer_use_authority_generation AS generation FROM chats ORDER BY id",
        )
      ).rows,
    ).toEqual([{ generation: 3 }, { generation: 3 }, { generation: 1 }]);
  } finally {
    await db.close();
  }
});
