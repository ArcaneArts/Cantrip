import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectChatExecutionLock } from "../src/db/repository/chat-execution-lock.js";
import {
  COMPUTER_USE_AUTHORITY_CHANNEL,
  ComputerUseAuthorityChanges,
  type ComputerUseAuthorityChange,
} from "../src/db/repository/computer-use-authority.js";

// Opt in with an isolated PostgreSQL instance. No existing schema is modified:
// the test owns and removes only its randomly named schema on that instance.
const databaseUrl = process.env.CANTRIP_CUA_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)(
  "computer-use authority on real PostgreSQL",
  () => {
    const fixtureSchema = `cua_authority_${randomUUID().replaceAll("-", "")}`;
    let database: ReturnType<typeof postgres>;
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
    async function until(predicate: () => Promise<boolean>) {
      const deadline = Date.now() + 3000;
      while (!(await predicate())) {
        if (Date.now() >= deadline)
          throw new Error("PostgreSQL test did not reach expected state");
        await pause();
      }
    }
    beforeAll(async () => {
      database = postgres(databaseUrl!, {
        max: 5,
        connection: {
          search_path: fixtureSchema,
          application_name: "cantrip-cua-authority-test",
        },
        onnotice: () => {},
      });
      await database.unsafe(`CREATE SCHEMA "${fixtureSchema}";
      CREATE TABLE projects(id text PRIMARY KEY, owner_id text NOT NULL, worktree_policy text NOT NULL);
      CREATE TABLE chats(id text PRIMARY KEY, owner_id text NOT NULL, project_id text REFERENCES projects(id), context_kind text NOT NULL, computer_use_authority_generation integer NOT NULL DEFAULT 1);
      INSERT INTO projects VALUES ('project-a','owner-a','agent-managed');
      INSERT INTO chats(id,owner_id,project_id,context_kind) VALUES ('chat-a','owner-a','project-a','project');`);
      const migration = await readFile(
        new URL(
          "../drizzle/0199_computer_use_authority_generation.sql",
          import.meta.url,
        ),
        "utf8",
      );
      // Execute the production fanout function/trigger, not a modeled substitute.
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (
          statement.includes(
            'CREATE FUNCTION "advance_project_computer_use_authority"',
          ) ||
          statement.includes(
            'CREATE TRIGGER "projects_computer_use_authority_changed"',
          )
        )
          await database.unsafe(statement);
      }
    });
    afterAll(async () => {
      if (!database) return;
      try {
        await database.unsafe(`DROP SCHEMA "${fixtureSchema}" CASCADE`);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    async function contend(useProductionLock: boolean) {
      const lane = await database.reserve();
      const policy = await database.reserve();
      try {
        await lane`BEGIN`;
        await policy`BEGIN`;
        // Pause the policy UPDATE after acquiring its project lock and before
        // its AFTER trigger requests chats. This deterministically exposes the
        // same lock-order cycle as an unpaused concurrent production UPDATE.
        await policy`SELECT id FROM projects WHERE id='project-a' FOR UPDATE`;
        const [{ pid }] = await lane`SELECT pg_backend_pid() AS pid`;
        const settle = async (
          operation: PromiseLike<unknown>,
          connection: typeof lane,
        ) => {
          try {
            await operation;
            await connection`COMMIT`;
            return "ok";
          } catch (error) {
            await connection`ROLLBACK`;
            return (error as { code: string }).code;
          }
        };
        const query = new PgDialect().sqlToQuery(
          projectChatExecutionLock("owner-a", "chat-a"),
        );
        const laneResult = settle(
          useProductionLock
            ? lane.unsafe(query.sql, query.params)
            : lane`SELECT chats.id FROM chats INNER JOIN projects ON projects.id=chats.project_id AND projects.owner_id='owner-a' WHERE chats.id='chat-a' FOR UPDATE`,
          lane,
        );
        await until(
          async () =>
            (
              await database`SELECT wait_event FROM pg_stat_activity WHERE pid=${pid}`
            )[0]?.wait_event === "transactionid",
        );
        const policyResult = settle(
          policy`UPDATE projects SET worktree_policy=CASE WHEN worktree_policy='agent-managed' THEN 'required-for-writes' ELSE 'agent-managed' END WHERE id='project-a'`,
          policy,
        );
        return await Promise.all([laneResult, policyResult]);
      } finally {
        await lane`ROLLBACK`;
        await policy`ROLLBACK`;
        lane.release();
        policy.release();
      }
    }

    it("reproduces the old lock inversion and prevents it with the actual materialized production lock", async () => {
      expect(await contend(false)).toContain("40P01");
      expect(await contend(true)).toEqual(["ok", "ok"]);
      expect(await contend(true)).toEqual(["ok", "ok"]);
    }, 15_000);

    it("delivers cross-connection notifications only after commit, deduplicates scopes and unlistens", async () => {
      const publisher = new ComputerUseAuthorityChanges();
      const received: ComputerUseAuthorityChange[] = [];
      const unsubscribe = publisher.subscribe((change) => {
        received.push(change);
      });
      const listener = await database.listen(
        COMPUTER_USE_AUTHORITY_CHANNEL,
        (payload) => publisher.receive(payload),
      );
      const writer = await database.reserve();
      try {
        const toggle = () =>
          writer`UPDATE projects SET worktree_policy=CASE WHEN worktree_policy='agent-managed' THEN 'required-for-writes' ELSE 'agent-managed' END WHERE id='project-a'`;
        await writer`BEGIN`;
        await toggle();
        expect(received).toEqual([]);
        await writer`ROLLBACK`;
        await pause();
        expect(received).toEqual([]);
        await writer`BEGIN`;
        await toggle();
        await toggle();
        expect(received).toEqual([]);
        await writer`COMMIT`;
        await until(async () => received.length > 0);
        expect(received).toEqual([
          {
            ownerId: "owner-a",
            scope: { kind: "project", projectId: "project-a" },
          },
        ]);
        await listener.unlisten();
        received.length = 0;
        await toggle();
        await pause();
        expect(received).toEqual([]);
      } finally {
        await writer`ROLLBACK`;
        writer.release();
        await listener.unlisten();
        unsubscribe();
      }
    });
  },
);
