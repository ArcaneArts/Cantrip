// Actual Drizzle migration bytes/journal from a historical prefix, not a
// current schema with a forged older migration marker.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectLabel } from "./security-fixtures.mjs";

const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pglite");
const { migrate } = require("drizzle-orm/pglite/migrator");
const migrations = new URL("../../cantrip_server/drizzle/", import.meta.url);

export async function prepareHistoricalPglite(pg, root, count) {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", migrations), "utf8"),
  );
  assert.ok(
    Number.isInteger(count) && count > 0 && count < journal.entries.length,
  );
  const folder = path.join(root, "historical-migrations");
  await mkdir(path.join(folder, "meta"), { recursive: true });
  const entries = journal.entries.slice(0, count);
  await writeFile(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries)
    await copyFile(
      new URL(entry.tag + ".sql", migrations),
      path.join(folder, entry.tag + ".sql"),
    );
  await migrate(drizzle(pg), { migrationsFolder: folder });
  const owner = "00000000-0000-0000-0000-000000000001";
  await pg.query(
    "INSERT INTO users(id,kind,role,status,display_name,created_at,updated_at) VALUES($1,'anonymous','owner','active','Local User','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z')",
    [owner],
  );
  await pg.transaction(async (transaction) => {
    const worker = "historical-worker";
    const chat = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const scratch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await transaction.query(
      "INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES($1,$2,'Historical worker','darwin','arm64','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z')",
      [worker, owner],
    );
    await transaction.query(
      "INSERT INTO chats(id,owner_id,context_kind,protected_label,active_worker_id,active_scratch_root_id,worktree_mode,created_at,updated_at) VALUES($1,$2,'standalone',$3::jsonb,$4,$5,NULL,'2020-01-03T01:02:03.123Z','2020-01-04T04:05:06.789Z')",
      [
        chat,
        owner,
        JSON.stringify(projectLabel.protectedLabel),
        worker,
        scratch,
      ],
    );
    await transaction.query(
      "INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle) VALUES($1,$2,$3,$4,$5)",
      [
        scratch,
        chat,
        owner,
        worker,
        "ctrr_" + Buffer.alloc(32, 90).toString("base64url"),
      ],
    );
  });
  return {
    count,
    latest: entries.at(-1).tag,
    currentCount: journal.entries.length,
  };
}

export async function upgradeHistoricalReference(pg) {
  await migrate(drizzle(pg), { migrationsFolder: fileURLToPath(migrations) });
}
