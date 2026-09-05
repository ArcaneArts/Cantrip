import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { ChatRuntimeContextRepository } from "../src/db/repository/chat-runtime-context.js";
import type { RepositoryDatabase } from "../src/db/repository/database.js";
import * as schema from "../src/db/schema.js";
import {
  COMPUTER_USE_AUTHORITY_CHANNEL,
  ComputerUseAuthorityChanges,
  type ComputerUseAuthorityChange,
} from "../src/db/repository/computer-use-authority.js";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);
const migrationName = "0199_computer_use_authority_generation.sql";
const projectChat = "11111111-1111-4111-8111-111111111111";
const explicitProjectChat = "22222222-2222-4222-8222-222222222222";
const otherProjectChat = "33333333-3333-4333-8333-333333333333";
const standaloneChat = "44444444-4444-4444-8444-444444444444";
const explicitStandaloneChat = "55555555-5555-4555-8555-555555555555";
const otherOwnerChat = "66666666-6666-4666-8666-666666666666";
const root = "77777777-7777-4777-8777-777777777777";
const explicitRoot = "88888888-8888-4888-8888-888888888888";

async function applyMigrations(database: PGlite, last: number) {
  for (const name of (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    if (Number(name.slice(0, 4)) <= last)
      await database.exec(
        await readFile(`${migrationsDirectory}/${name}`, "utf8"),
      );
  }
}

async function seed(database: PGlite) {
  await database.exec(`
    BEGIN;
    INSERT INTO users (id, kind, role, status, display_name, email, normalized_email, password_hash)
      VALUES ('owner-a', 'account', 'owner', 'active', 'Fixture A', 'a@example.com', 'a@example.com', 'hash'),
             ('owner-b', 'account', 'member', 'active', 'Fixture B', 'b@example.com', 'b@example.com', 'hash');
    INSERT INTO user_settings (user_id) VALUES ('owner-a'), ('owner-b');
    INSERT INTO workers (id, owner_id, name, platform, architecture, started_at, last_seen_at)
      VALUES ('worker-a', 'owner-a', 'Worker A', 'darwin', 'arm64', now(), now()),
             ('worker-b', 'owner-a', 'Worker B', 'darwin', 'arm64', now(), now()),
             ('worker-c', 'owner-b', 'Worker C', 'darwin', 'arm64', now(), now());
    INSERT INTO projects (id, owner_id, protected_label, github_repository_blind_index)
      VALUES ('project-a', 'owner-a', '{"ciphertext":"project-a"}', 'project-a'),
             ('project-b', 'owner-a', '{"ciphertext":"project-b"}', 'project-b'),
             ('project-c', 'owner-b', '{"ciphertext":"project-c"}', 'project-c');
    INSERT INTO project_sources (id, project_id, worker_id, absolute_path, display_path)
      VALUES ('source-a', 'project-a', 'worker-a', '/fixture-a', '/fixture-a'),
             ('source-b', 'project-b', 'worker-a', '/fixture-b', '/fixture-b'),
             ('source-c', 'project-c', 'worker-c', '/fixture-c', '/fixture-c');
    INSERT INTO project_worktrees (id, project_source_id, worker_id, name, absolute_path, display_path, is_primary, is_default, origin, lifecycle_state)
      VALUES ('worktree-a', 'source-a', 'worker-a', 'main', '/fixture-a', '/fixture-a', true, true, 'cantrip', 'ready'),
             ('worktree-a2', 'source-a', 'worker-a', 'feature', '/fixture-a2', '/fixture-a2', false, false, 'cantrip', 'ready'),
             ('worktree-b', 'source-b', 'worker-a', 'main', '/fixture-b', '/fixture-b', true, true, 'cantrip', 'ready'),
             ('worktree-c', 'source-c', 'worker-c', 'main', '/fixture-c', '/fixture-c', true, true, 'cantrip', 'ready');
    INSERT INTO chats (id, owner_id, project_id, protected_label, active_worktree_id, permission_profile_id)
      VALUES ('${projectChat}', 'owner-a', 'project-a', '{"ciphertext":"preserved-chat"}', 'worktree-a', NULL),
             ('${explicitProjectChat}', 'owner-a', 'project-a', '{}', 'worktree-a', ':yolo'),
             ('${otherProjectChat}', 'owner-a', 'project-b', '{}', 'worktree-b', NULL),
             ('${otherOwnerChat}', 'owner-b', 'project-c', '{}', 'worktree-c', NULL);
    INSERT INTO chats (id, owner_id, context_kind, project_id, protected_label, active_worker_id, active_worktree_id, active_scratch_root_id, worktree_mode, permission_profile_id)
      VALUES ('${standaloneChat}', 'owner-a', 'standalone', NULL, '{}', 'worker-a', NULL, '${root}', NULL, NULL),
             ('${explicitStandaloneChat}', 'owner-a', 'standalone', NULL, '{}', 'worker-a', NULL, '${explicitRoot}', NULL, ':yolo');
    INSERT INTO standalone_chat_roots (id, chat_id, owner_id, worker_id, protected_path_handle, status)
      VALUES ('${root}', '${standaloneChat}', 'owner-a', 'worker-a', 'ctrr_${"A".repeat(43)}', 'ready'),
             ('${explicitRoot}', '${explicitStandaloneChat}', 'owner-a', 'worker-a', 'ctrr_${"B".repeat(43)}', 'ready');
    INSERT INTO chat_messages (id, chat_id, worktree_id, role, protected_content)
      VALUES ('message-a', '${projectChat}', 'worktree-a', 'user', '{"ciphertext":"preserved-message"}');
    INSERT INTO chat_runtime_sessions (id, chat_id, worker_id, worktree_id)
      VALUES ('runtime-a', '${projectChat}', 'worker-a', 'worktree-a');
    INSERT INTO chat_execution_lanes (id, chat_id, worktree_id, worker_id, acquiring_actor, state)
      VALUES ('lane-a', '${projectChat}', 'worktree-a', 'worker-a', 'agent', 'suspended');
    COMMIT;
  `);
}

async function generations(database: PGlite) {
  return Object.fromEntries(
    (
      await database.query<{ id: string; generation: number }>(
        "SELECT id, computer_use_authority_generation AS generation FROM chats ORDER BY id",
      )
    ).rows.map((row) => [row.id, row.generation]),
  );
}
const initial = {
  [projectChat]: 1,
  [explicitProjectChat]: 1,
  [otherProjectChat]: 1,
  [standaloneChat]: 1,
  [explicitStandaloneChat]: 1,
  [otherOwnerChat]: 1,
};

describe("computer-use authority migration", () => {
  it("preserves historical data and atomically installs the column and all triggers", async () => {
    const database = new PGlite();
    try {
      await applyMigrations(database, 198);
      await seed(database);
      const snapshot = async (migrated: boolean) => {
        const result: Record<string, unknown> = {};
        for (const table of [
          "chats",
          "chat_messages",
          "chat_runtime_sessions",
          "chat_execution_lanes",
          "user_settings",
          "projects",
          "standalone_chat_roots",
        ]) {
          const projection =
            table === "chats" && migrated
              ? "to_jsonb(r) - 'computer_use_authority_generation'"
              : "to_jsonb(r)";
          result[table] = (
            await database.query(
              `SELECT ${projection} AS row FROM "${table}" r ORDER BY ${projection}`,
            )
          ).rows;
        }
        return result;
      };
      const before = await snapshot(false);
      const migration = await readFile(
        `${migrationsDirectory}/${migrationName}`,
        "utf8",
      );
      await database.exec("BEGIN");
      await database.exec(migration);
      expect(await generations(database)).toEqual(initial);
      await database.exec("ROLLBACK");
      expect(
        (
          await database.query(
            "SELECT 1 FROM information_schema.columns WHERE table_name='chats' AND column_name='computer_use_authority_generation'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await database.query(
            "SELECT tgname FROM pg_trigger WHERE tgname LIKE '%computer_use_authority_changed' OR tgname = 'chats_computer_use_authority_deleted'",
          )
        ).rows,
      ).toEqual([]);
      expect(await snapshot(false)).toEqual(before);
      await database.exec(`BEGIN; ${migration} COMMIT;`);
      expect(await generations(database)).toEqual(initial);
      expect(await snapshot(true)).toEqual(before);
      expect(
        (
          await database.query(
            "SELECT tgname FROM pg_trigger WHERE tgname LIKE '%computer_use_authority_changed' OR tgname = 'chats_computer_use_authority_deleted'",
          )
        ).rows,
      ).toHaveLength(6);
    } finally {
      await database.close();
    }
  }, 30_000);
});

describe("committed authority notifications from actual mutation triggers", () => {
  let database: PGlite;
  let unlisten: () => Promise<void>;
  const received: ComputerUseAuthorityChange[] = [];
  beforeAll(async () => {
    database = new PGlite();
    await applyMigrations(database, 199);
    await seed(database);
    const publisher = new ComputerUseAuthorityChanges();
    publisher.subscribe((change) => {
      received.push(change);
    });
    unlisten = await database.listen(
      COMPUTER_USE_AUTHORITY_CHANNEL,
      (payload) => publisher.receive(payload),
    );
  }, 30_000);
  beforeEach(() => {
    received.length = 0;
  });
  afterAll(async () => {
    await unlisten();
    await database.close();
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const change = (scope: ComputerUseAuthorityChange["scope"]) => ({
    ownerId: "owner-a",
    scope,
  });

  it("emits no notification before commit or after rollback, and deduplicates A→B→A within one commit", async () => {
    await database.exec(
      `BEGIN; UPDATE chats SET permission_profile_id=':yolo' WHERE id='${projectChat}';`,
    );
    await flush();
    expect(received).toEqual([]);
    await database.exec("ROLLBACK");
    await flush();
    expect(received).toEqual([]);
    await database.exec(
      `BEGIN; UPDATE chats SET permission_profile_id=':yolo' WHERE id='${projectChat}'; UPDATE chats SET permission_profile_id=NULL WHERE id='${projectChat}'; COMMIT;`,
    );
    await flush();
    expect(received).toEqual([change({ kind: "chat", chatId: projectChat })]);
  });

  it("does not publish unchanged settings, placement, status or routine turn/lane activity", async () => {
    await database.exec(`BEGIN;
      UPDATE chats SET permission_profile_id=permission_profile_id, active_worktree_id=active_worktree_id, status='idle', updated_at=now();
      UPDATE user_settings SET default_permission_profile_id=default_permission_profile_id, default_chat_permission_profile_id=default_chat_permission_profile_id;
      UPDATE projects SET worktree_policy=worktree_policy;
      UPDATE project_worktrees SET worker_id=worker_id, is_primary=is_primary;
      UPDATE standalone_chat_roots SET worker_id=worker_id;
      UPDATE chat_execution_lanes SET state='active' WHERE id='lane-a';
      UPDATE chat_execution_lanes SET state='suspended' WHERE id='lane-a';
      COMMIT;`);
    await flush();
    expect(received).toEqual([]);
  });

  it("publishes owner-scoped inherited defaults and project policy once per transaction", async () => {
    await database.exec(`BEGIN;
      UPDATE user_settings SET default_permission_profile_id=':yolo', default_chat_permission_profile_id=':yolo' WHERE user_id='owner-a';
      UPDATE user_settings SET default_permission_profile_id=':workspace', default_chat_permission_profile_id=':workspace' WHERE user_id='owner-a';
      UPDATE projects SET worktree_policy='required-for-writes' WHERE id='project-a';
      UPDATE projects SET worktree_policy='agent-managed' WHERE id='project-a';
      COMMIT;`);
    await flush();
    expect(received).toEqual([
      change({ kind: "inherited-default", contextKind: "project" }),
      change({ kind: "inherited-default", contextKind: "standalone" }),
      change({ kind: "project", projectId: "project-a" }),
    ]);
  });

  it("publishes background placement and underlying worktree changes only for affected chats", async () => {
    await database.exec(`BEGIN;
      UPDATE chats SET active_worktree_id='worktree-a2' WHERE id='${projectChat}';
      UPDATE chats SET active_worktree_id='worktree-a' WHERE id='${projectChat}';
      UPDATE project_worktrees SET is_primary=false WHERE id='worktree-a';
      UPDATE project_worktrees SET is_primary=true WHERE id='worktree-a';
      COMMIT;`);
    await flush();
    expect(received).toEqual(
      expect.arrayContaining([
        change({ kind: "chat", chatId: projectChat }),
        change({ kind: "chat", chatId: explicitProjectChat }),
      ]),
    );
    expect(received).toHaveLength(2);
  });

  it("publishes archive/restore and permanent deletion, and releases LISTEN ownership", async () => {
    const deletedId = "99999999-9999-4999-8999-999999999999";
    await database.exec(`BEGIN;
      UPDATE chats SET archived_at=now() WHERE id='${projectChat}';
      UPDATE chats SET archived_at=NULL WHERE id='${projectChat}';
      INSERT INTO chats(id,owner_id,project_id,protected_label,active_worktree_id) VALUES ('${deletedId}','owner-a','project-a','{}','worktree-a');
      DELETE FROM chats WHERE id='${deletedId}'; COMMIT;`);
    await flush();
    expect(received).toEqual([
      change({ kind: "chat", chatId: projectChat }),
      change({ kind: "chat", chatId: deletedId }),
    ]);
    await unlisten();
    received.length = 0;
    await database.exec(
      `UPDATE chats SET permission_profile_id=':yolo' WHERE id='${projectChat}';`,
    );
    await flush();
    expect(received).toEqual([]);
    unlisten = async () => {};
  });
});

describe("transactional computer-use authority generations", () => {
  let database: PGlite;
  let repository: ChatRuntimeContextRepository;
  beforeAll(async () => {
    database = new PGlite();
    await applyMigrations(database, 199);
    await seed(database);
    repository = new ChatRuntimeContextRepository(
      drizzle(database, { schema }) as unknown as RepositoryDatabase,
      {
        getChatExecutionContext: (owner, chat) =>
          repository.getChatExecutionContext(owner, chat),
      },
    );
  }, 30_000);
  beforeEach(async () => {
    await database.exec("BEGIN");
  });
  afterEach(async () => {
    await database.exec("ROLLBACK");
  });
  afterAll(async () => {
    await database?.close();
  });

  it("fences A→B→A selected-profile changes, including switching away from inherited policy", async () => {
    await database.exec(
      `UPDATE chats SET permission_profile_id=':yolo' WHERE id='${projectChat}'`,
    );
    expect((await generations(database))[projectChat]).toBe(2);
    await database.exec(
      `UPDATE chats SET permission_profile_id=NULL WHERE id='${projectChat}'`,
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 3,
    });
  });

  it("rejects invalid persisted generations without replacing existing authority", async () => {
    await database.exec("SAVEPOINT invalid_generation");
    await expect(
      database.exec(
        `UPDATE chats SET computer_use_authority_generation=0 WHERE id='${projectChat}'`,
      ),
    ).rejects.toThrow("chats_computer_use_authority_generation_check");
    await database.exec("ROLLBACK TO SAVEPOINT invalid_generation");
    expect(await generations(database)).toEqual(initial);
  });

  it("does not churn on unchanged authority, ordinary chat activity, messages, runtime changes, or lane reactivation", async () => {
    await database.exec(`
      UPDATE chats SET permission_profile_id=permission_profile_id, active_worker_id=active_worker_id, active_worktree_id=active_worktree_id, active_scratch_root_id=active_scratch_root_id, owner_id=owner_id, project_id=project_id, context_kind=context_kind, archived_at=archived_at;
      UPDATE chats SET status='running', updated_at=now(), has_unread_completion=true, reasoning_effort='high' WHERE id='${projectChat}';
      UPDATE chat_execution_lanes SET state='active', activated_at=now(), updated_at=now() WHERE id='lane-a';
      UPDATE chat_runtime_sessions SET codex_thread_id='genuine-thread', status='running', updated_at=now() WHERE id='runtime-a';
      INSERT INTO chat_messages (id,chat_id,worktree_id,role,protected_content) VALUES ('message-b','${projectChat}','worktree-a','assistant','{"ciphertext":"new-message"}');
      UPDATE chat_execution_lanes SET state='suspended', updated_at=now() WHERE id='lane-a';
      UPDATE chats SET status='idle', updated_at=now() WHERE id='${projectChat}';
      UPDATE user_settings SET default_permission_profile_id=default_permission_profile_id, default_chat_permission_profile_id=default_chat_permission_profile_id, theme='light';
      UPDATE projects SET worktree_policy=worktree_policy, updated_at=now();
      UPDATE project_worktrees SET worker_id=worker_id, is_primary=is_primary, head='abc', updated_at=now();
      UPDATE standalone_chat_roots SET worker_id=worker_id, updated_at=now();
    `);
    expect(await generations(database)).toEqual(initial);
  });

  it("advances only default-inheriting project chats owned by the changed user", async () => {
    await database.exec(
      "UPDATE user_settings SET default_permission_profile_id=':yolo' WHERE user_id='owner-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 2,
      [otherProjectChat]: 2,
    });
    await database.exec(
      "UPDATE user_settings SET default_permission_profile_id=':workspace' WHERE user_id='owner-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 3,
      [otherProjectChat]: 3,
    });
  });

  it("advances only default-inheriting standalone chats for the standalone default", async () => {
    await database.exec(
      "UPDATE user_settings SET default_chat_permission_profile_id=':yolo' WHERE user_id='owner-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [standaloneChat]: 2,
    });
    await database.exec(
      "UPDATE user_settings SET default_permission_profile_id=':read-only', default_chat_permission_profile_id=':read-only' WHERE user_id='owner-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 2,
      [otherProjectChat]: 2,
      [standaloneChat]: 3,
    });
  });

  it("fences project worktree-policy changes for the affected project only", async () => {
    await database.exec(
      "UPDATE projects SET worktree_policy='required-for-writes' WHERE id='project-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 2,
      [explicitProjectChat]: 2,
    });
    await database.exec(
      "UPDATE projects SET worktree_policy='agent-managed' WHERE id='project-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 3,
      [explicitProjectChat]: 3,
    });
  });

  it("fences actual chat worktree/worker/project ownership and archive transitions", async () => {
    await database.exec(
      `UPDATE chats SET active_worktree_id='worktree-a2' WHERE id='${projectChat}'`,
    );
    await database.exec(
      `UPDATE chats SET active_worker_id='worker-a' WHERE id='${projectChat}'`,
    );
    await database.exec(
      `UPDATE chats SET owner_id='owner-b', project_id='project-c', active_worker_id='worker-c', active_worktree_id='worktree-c' WHERE id='${projectChat}'`,
    );
    await database.exec(
      `UPDATE chats SET archived_at=now() WHERE id='${projectChat}'`,
    );
    await database.exec(
      `UPDATE chats SET archived_at=NULL WHERE id='${projectChat}'`,
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 6,
    });
  });

  it("fences an active underlying worktree worker or primary-policy change without touching other worktrees", async () => {
    await database.exec(
      "UPDATE project_worktrees SET worker_id='worker-b' WHERE id='worktree-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 2,
      [explicitProjectChat]: 2,
    });
    await database.exec(
      "UPDATE project_worktrees SET is_primary=false WHERE id='worktree-a'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 3,
      [explicitProjectChat]: 3,
    });
    await database.exec(
      "UPDATE project_worktrees SET worker_id='worker-b' WHERE id='worktree-a2'",
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [projectChat]: 3,
      [explicitProjectChat]: 3,
    });
  });

  it("fences a valid deferred standalone root/worker relocation and context-kind change", async () => {
    await database.exec(
      `UPDATE standalone_chat_roots SET worker_id='worker-b' WHERE id='${root}'`,
    );
    expect((await generations(database))[standaloneChat]).toBe(2);
    await database.exec(
      `UPDATE chats SET active_worker_id='worker-b' WHERE id='${standaloneChat}'`,
    );
    await database.exec("SET CONSTRAINTS ALL IMMEDIATE");
    expect((await generations(database))[standaloneChat]).toBe(3);
    // This row no longer uses a scratch root; the old root remains an owned record.
    await database.exec(
      `UPDATE chats SET context_kind='project', project_id='project-a', active_worktree_id='worktree-a', active_scratch_root_id=NULL, worktree_mode='agent-managed' WHERE id='${standaloneChat}'`,
    );
    expect(await generations(database)).toEqual({
      ...initial,
      [standaloneChat]: 4,
    });
  });

  it("rolls back authority changes and inherited fan-out in the same transaction", async () => {
    await database.exec("SAVEPOINT authority_change");
    await database.exec(
      `UPDATE chats SET permission_profile_id=':yolo' WHERE id='${projectChat}'`,
    );
    await database.exec(
      "UPDATE user_settings SET default_permission_profile_id=':read-only', default_chat_permission_profile_id=':read-only' WHERE user_id='owner-a'",
    );
    await database.exec(
      "UPDATE projects SET worktree_policy='required-for-writes' WHERE id='project-a'",
    );
    await database.exec(
      "UPDATE project_worktrees SET worker_id='worker-b' WHERE id='worktree-b'",
    );
    expect(await generations(database)).not.toEqual(initial);
    await database.exec("ROLLBACK TO SAVEPOINT authority_change");
    expect(await generations(database)).toEqual(initial);
    expect(
      (await repository.getChatExecutionContext("owner-a", projectChat))
        ?.permissionProfileId,
    ).toBeNull();
  });

  it("returns the exact fence on both existing context queries and never returns an archived or foreign chat", async () => {
    expect(
      await repository.getChatExecutionContext("owner-a", projectChat),
    ).toMatchObject({
      computerUseAuthorityGeneration: 1,
      workerId: "worker-a",
      worktreeId: "worktree-a",
    });
    expect(
      await repository.getChatExecutionContext("owner-a", standaloneChat),
    ).toMatchObject({
      computerUseAuthorityGeneration: 1,
      workerId: "worker-a",
      scratchRootId: root,
    });
    await database.exec(
      `UPDATE chats SET permission_profile_id=':yolo' WHERE id='${standaloneChat}'`,
    );
    expect(
      (await repository.getChatExecutionContext("owner-a", standaloneChat))
        ?.computerUseAuthorityGeneration,
    ).toBe(2);
    expect(
      await repository.getChatExecutionContext("owner-b", projectChat),
    ).toBeNull();
    await database.exec(
      `UPDATE chats SET archived_at=now() WHERE id='${projectChat}'`,
    );
    expect(
      await repository.getChatExecutionContext("owner-a", projectChat),
    ).toBeNull();
  });
});
