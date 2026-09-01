import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const serverRequire = createRequire(
  new URL("../cantrip_server/package.json", import.meta.url),
);
const { PGlite } = serverRequire("@electric-sql/pglite");

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function backupName(now) {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function inspectRepair(database) {
  const profiles = (
    await database.query(
      `SELECT owner_id, password_wrapped_master_key IS NOT NULL AS account_mode
       FROM account_encryption_profiles
       ORDER BY owner_id`,
    )
  ).rows;
  if (profiles.some((profile) => profile.account_mode)) {
    throw new Error(
      "Development encryption repair refuses account-mode profiles; use password recovery instead.",
    );
  }

  const protectedColumns = (
    await database.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%_envelope'
       ORDER BY table_name, column_name`,
    )
  ).rows;
  const protectedValues = [];
  for (const column of protectedColumns) {
    if (
      !/^[a-z][a-z0-9_]*$/u.test(column.table_name) ||
      !/^[a-z][a-z0-9_]*$/u.test(column.column_name)
    ) {
      throw new Error(
        "The development database contains an unsafe identifier.",
      );
    }
    const result = await database.query(
      `SELECT COUNT(*)::integer AS count FROM "${column.table_name}" WHERE "${column.column_name}" IS NOT NULL`,
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > 0) {
      protectedValues.push({
        columnName: column.column_name,
        count,
        tableName: column.table_name,
      });
    }
  }

  const unexpected = protectedValues.filter(
    (value) =>
      value.tableName !== "project_workspaces" ||
      value.columnName !== "name_envelope",
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Development encryption repair found protected payloads and stopped: ${unexpected
        .map(
          (value) => `${value.tableName}.${value.columnName} (${value.count})`,
        )
        .join(", ")}.`,
    );
  }

  if (protectedValues.length > 0) {
    const unsafeWorkspaces = await database.query(
      `SELECT workspace.id
       FROM project_workspaces workspace
       WHERE workspace.name_envelope IS NOT NULL
         AND (
           workspace.id <> ('workspace:default:' || workspace.owner_id)
           OR EXISTS (
             SELECT 1 FROM project_workspace_memberships membership
             WHERE membership.workspace_id = workspace.id
           )
         )`,
    );
    if (unsafeWorkspaces.rows.length > 0) {
      throw new Error(
        "Development encryption repair found a protected nonempty or nondefault workspace and stopped.",
      );
    }
  }

  return {
    ownerIds: profiles.map((profile) => profile.owner_id),
    protectedValues,
  };
}

async function resetNativeCatalog(appLocalDataPath) {
  const catalogPath = path.join(
    appLocalDataPath,
    "installation",
    "v1",
    "catalog.sqlite3",
  );
  if (!(await pathExists(catalogPath))) return false;
  const { DatabaseSync } = await import("node:sqlite");
  const catalog = new DatabaseSync(catalogPath);
  try {
    const keyCount = catalog
      .prepare("SELECT COUNT(*) AS count FROM device_key")
      .get().count;
    if (keyCount === 0) return false;
    catalog.exec("BEGIN IMMEDIATE");
    catalog.exec("DELETE FROM account_binding");
    catalog.exec("DELETE FROM migration");
    catalog.exec("DELETE FROM device_key");
    catalog.exec(
      "UPDATE catalog_meta SET revision = revision + 1 WHERE singleton_id = 1",
    );
    catalog.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      catalog.exec("ROLLBACK");
    } catch {
      // The transaction may not have started. The original error is clearer.
    }
    throw error;
  } finally {
    catalog.close();
  }
}

export async function repairDevelopmentEncryption({
  appLocalDataPath,
  now = new Date(),
  repositoryStatePath,
}) {
  const databasePath = path.join(repositoryStatePath, "server-db");
  if (!(await pathExists(databasePath))) {
    throw new Error(
      `Development server database does not exist: ${databasePath}`,
    );
  }

  let database = new PGlite(databasePath);
  let inspection;
  try {
    inspection = await inspectRepair(database);
  } finally {
    await database.close();
  }
  database = null;
  if (inspection.ownerIds.length === 0) {
    return { backupPath: null, repairedOwners: 0, status: "not-needed" };
  }

  const backupPath = path.join(
    repositoryStatePath,
    "recovery-backups",
    `encryption-${backupName(now)}`,
  );
  await mkdir(path.dirname(backupPath), { mode: 0o700, recursive: true });
  await mkdir(backupPath, { mode: 0o700 });
  await cp(databasePath, path.join(backupPath, "server-db"), {
    recursive: true,
  });
  const installationPath = path.join(appLocalDataPath, "installation");
  if (await pathExists(installationPath)) {
    await cp(installationPath, path.join(backupPath, "installation"), {
      recursive: true,
    });
  }

  database = new PGlite(databasePath);
  try {
    await database.exec("BEGIN");
    for (const ownerId of inspection.ownerIds) {
      await database.query(
        `UPDATE project_workspaces
         SET name_envelope = NULL,
             name_blind_index = NULL,
             name_format_version = NULL,
             name_key_revision = NULL
         WHERE owner_id = $1
           AND id = ('workspace:default:' || owner_id)`,
        [ownerId],
      );
      await database.query(
        "DELETE FROM encryption_key_grants WHERE owner_id = $1",
        [ownerId],
      );
      await database.query(
        "DELETE FROM encryption_principals WHERE owner_id = $1",
        [ownerId],
      );
      await database.query(
        "DELETE FROM account_encryption_profiles WHERE owner_id = $1",
        [ownerId],
      );
    }
    await database.exec("COMMIT");
  } catch (error) {
    await database.exec("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await database.close();
  }

  const nativeCatalogReset = await resetNativeCatalog(appLocalDataPath);

  return {
    backupPath,
    nativeCatalogReset,
    repairedOwners: inspection.ownerIds.length,
    status: "repaired",
  };
}
