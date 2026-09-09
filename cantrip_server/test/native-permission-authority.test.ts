import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

describe("confirmed native permissions and computer-use authority", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE chats(id text PRIMARY KEY, owner_id text, context_kind text, project_id text,
        active_worker_id text, active_worktree_id text, active_scratch_root_id text,
        permission_profile_id text, computer_use_authority_generation int DEFAULT 1);
      CREATE TABLE native_settings_states(chat_id text PRIMARY KEY, state jsonb NOT NULL);
      CREATE TABLE chat_runtime_sessions(chat_id text, codex_thread_id text, worker_id text,
        worktree_id text, scratch_root_id text, model_route_id text, provider_account_id text);
      CREATE TABLE project_worktrees(id text, worker_id text);
      CREATE TABLE user_settings(user_id text PRIMARY KEY, default_permission_profile_id text, default_chat_permission_profile_id text);
    `);
    await db.exec(
      await readFile(
        new URL(
          "../drizzle/0210_confirmed_native_permission_authority.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(`
      CREATE TRIGGER user_settings_computer_use_authority_changed AFTER UPDATE ON user_settings
        FOR EACH ROW EXECUTE FUNCTION advance_inherited_computer_use_authority();
      INSERT INTO user_settings VALUES ('owner', ':workspace', ':workspace');
      INSERT INTO project_worktrees VALUES ('placement','worker');
      INSERT INTO chats(id,owner_id,context_kind,project_id,active_worktree_id) VALUES
        ('bound','owner','project','project','placement'), ('unbound','owner','project','project','placement');
      INSERT INTO chat_runtime_sessions VALUES ('bound','thread','worker','placement',NULL,'route','account');
      INSERT INTO native_settings_states VALUES ('bound', '{"permissionPolicy":null,"pending":[]}');
    `);
  }, 30000);
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.exec("BEGIN");
  });
  afterEach(async () => {
    await db.exec("ROLLBACK");
  });
  const source = {
    threadId: "thread",
    workerId: "worker",
    contextKind: "project",
    projectId: "project",
    placementId: "placement",
    modelRouteId: "route",
    providerAccountId: "account",
    runtimeGeneration: "runtime",
  };
  const policy = {
    selectedId: null,
    resolvedSelectedId: ":workspace",
    effectiveId: ":workspace",
    revision: "1",
    source,
  };
  const setPolicy = async (value: unknown) =>
    db.query(
      "UPDATE native_settings_states SET state=jsonb_set(state,'{permissionPolicy}',$1::jsonb) WHERE chat_id='bound'",
      [JSON.stringify(value)],
    );
  const generations = async () =>
    Object.fromEntries(
      (
        await db.query<{
          id: string;
          computer_use_authority_generation: number;
        }>("SELECT id,computer_use_authority_generation FROM chats ORDER BY id")
      ).rows.map((r) => [r.id, r.computer_use_authority_generation]),
    );
  const defaultChange = () =>
    db.exec(
      "UPDATE user_settings SET default_permission_profile_id=':yolo' WHERE user_id='owner'",
    );

  it("keeps native confirmed sessions stable when an account default changes", async () => {
    await setPolicy(policy);
    const before = await generations();
    await defaultChange();
    expect(await generations()).toEqual({
      ...before,
      unbound: before.unbound! + 1,
    });
  });
  it("pending selection neither changes authority nor pretends native application occurred", async () => {
    await db.exec(
      `UPDATE native_settings_states SET state=jsonb_set(state,'{pending}','[{"effectiveId":":yolo"}]')`,
    );
    expect(await generations()).toEqual({ bound: 1, unbound: 1 });
    await defaultChange();
    expect(await generations()).toEqual({ bound: 2, unbound: 2 });
  });
  it.each([
    "threadId",
    "workerId",
    "placementId",
    "modelRouteId",
    "providerAccountId",
    "contextKind",
    "projectId",
  ])("does not pin stale %s provenance", async (key) => {
    await setPolicy({ ...policy, source: { ...source, [key]: "other" } });
    const before = await generations();
    await defaultChange();
    expect(await generations()).toEqual({
      bound: before.bound! + 1,
      unbound: before.unbound! + 1,
    });
  });
  it("fences applied default-following changes while leaving the nullable preference intact", async () => {
    await setPolicy(policy);
    await setPolicy({
      ...policy,
      revision: "2",
      resolvedSelectedId: ":yolo",
      effectiveId: ":yolo",
    });
    expect(await generations()).toEqual({ bound: 3, unbound: 1 });
    expect(
      (
        await db.query(
          "SELECT permission_profile_id FROM chats WHERE id='bound'",
        )
      ).rows,
    ).toEqual([{ permission_profile_id: null }]);
    await setPolicy({ ...policy, revision: "3" });
    expect(await generations()).toEqual({ bound: 4, unbound: 1 });
  });
  it("unchanged applied evidence and pending/model metadata do not churn authority", async () => {
    await setPolicy(policy);
    const before = await generations();
    await setPolicy(policy);
    await db.exec(
      `UPDATE native_settings_states SET state=jsonb_set(state,'{desiredStatus}','"dispatched"')`,
    );
    expect(await generations()).toEqual(before);
  });
  it("rolls back applied policy and the authority fence together", async () => {
    await db.exec("SAVEPOINT permission");
    await setPolicy(policy);
    await db.exec("ROLLBACK TO SAVEPOINT permission");
    expect(await generations()).toEqual({ bound: 1, unbound: 1 });
    expect(
      (
        await db.query(
          "SELECT state->'permissionPolicy' AS policy FROM native_settings_states",
        )
      ).rows,
    ).toEqual([{ policy: null }]);
  });
});
