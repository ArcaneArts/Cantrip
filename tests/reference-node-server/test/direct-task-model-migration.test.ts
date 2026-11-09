import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";

it.each([false, true])(
  "migrates models and snapshots without retaining preset gates (legacy enabled: %s)",
  async (enabled) => {
    const db = new PGlite();
    try {
      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL("../../../cantrip_server/drizzle", import.meta.url),
        ),
      });
      // Drizzle identifies 0236_direct_task_models by its journal timestamp.
      // Later migrations must not change which upgrade this fixture exercises.
      const migrationIndex = migrations.findIndex(
        ({ folderMillis }) => folderMillis === 1793624400000,
      );
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const migration = migrations[migrationIndex]!;
      expect(migration.sql.join("\n")).toContain(
        "ALTER TABLE tasks ADD COLUMN model_configuration",
      );
      for (const earlier of migrations.slice(0, migrationIndex))
        for (const statement of earlier.sql) await db.exec(statement);
      await db.exec(`
      INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner');
      INSERT INTO model_profiles(id,owner_id,name) VALUES('preset','owner','Preset'),('runtime','owner','Runtime'),('default','owner','Default');
      INSERT INTO projects(id,owner_id,protected_label,github_repository_blind_index) VALUES('project','owner','{}','blind-index');
      INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','linux','x64',now(),now());
      INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path) VALUES('source','project','worker','/fixture','/fixture');
      INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state) VALUES('worktree','source','worker','main','/fixture','/fixture',true,true,'cantrip','ready');
      INSERT INTO chats(id,owner_id,project_id,protected_label,experience,active_worktree_id,active_worker_id,model_id) VALUES('explicit','owner','project','{}','task','worktree','worker','default'),('running','owner','project','{}','task','worktree','worker','default'),('default','owner','project','{}','task','worktree','worker','default');
      INSERT INTO task_workers(id,owner_id,name,model_id,continuity_family,enabled,allows_plan_goal,max_concurrency) VALUES('preset','owner','Old preset','preset','legacy',${enabled},false,1);
      INSERT INTO tasks(chat_id,protected_content,requested_task_worker_id) VALUES('explicit','{}','preset'),('running','{}','preset'),('default','{}',NULL);
      INSERT INTO task_dispatch_cycles(id,owner_id,chat_id,operation_id,operation_kind,state,fifo_created_at,model_configuration) VALUES('running-cycle','owner','running','running-operation','finalize','paused',now(),'{"modelId":"runtime","reasoningEffort":"high","customSubagentModel":false,"subagentModelId":null,"subagentReasoningEffort":null}'),('queued-cycle','owner','explicit','queued-operation','initial-plan','queued',now(),NULL);
    `);
      for (const statement of migration.sql) await db.exec(statement);
      const tasks = await db.query<{
        chat_id: string;
        model: string;
        requested_task_worker_id: null;
      }>(
        "SELECT chat_id, model_configuration->>'modelId' AS model, requested_task_worker_id FROM tasks ORDER BY chat_id",
      );
      expect(tasks.rows).toEqual([
        {
          chat_id: "default",
          model: enabled ? "preset" : "default",
          requested_task_worker_id: null,
        },
        {
          chat_id: "explicit",
          model: "preset",
          requested_task_worker_id: null,
        },
        {
          chat_id: "running",
          model: "runtime",
          requested_task_worker_id: null,
        },
      ]);
      const cycles = await db.query<{
        id: string;
        model: string;
        state: string;
      }>(
        "SELECT id,model_configuration->>'modelId' AS model,state FROM task_dispatch_cycles ORDER BY id",
      );
      expect(cycles.rows).toEqual([
        { id: "queued-cycle", model: "preset", state: "queued" },
        { id: "running-cycle", model: "runtime", state: "paused" },
      ]);
    } finally {
      await db.close();
    }
  },
);
