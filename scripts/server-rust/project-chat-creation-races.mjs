// Actual PostgreSQL transaction failures, duplicate requests and caller loss.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  settingsHttpFixture,
  settingsProject as project,
  settingsChat as originalChat,
} from "./native-settings-http-fixture.mjs";
import { eventually } from "./full-worker.mjs";
import { label, literal } from "./project-target-state.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
const id = (n) => `f8f8f8f8-8888-4888-8888-${String(n).padStart(12, "0")}`;
const input = (chat, extra = {}) => ({
  id: chat,
  titleProtection: label("chat"),
  attachToTabLayout: false,
  ...extra,
});

export async function projectChatCreationHttpRaces({
  pg,
  root,
  executable,
  repositoryExecutable,
  passwordHash,
  report,
}) {
  const outputs = [];
  report.transactionRaces = outputs;
  for (const kind of ["node", "rust"]) {
    const url = await pg.database();
    const result = { kind, observations: [], snapshotProofs: 0, proofs: [] };
    outputs.push(result);
    const h = await settingsHttpFixture({
      kind,
      profile: "accounts",
      root,
      executable,
      repositoryExecutable,
      passwordHash,
      databaseMode: "postgres",
      url,
      result,
      configure: () => [
        "UPDATE user_settings SET default_model_id=NULL,auto_name_chats=false,auto_name_tasks=false",
      ],
    });
    const sql = postgres(url, { max: 1 }),
      blocker = postgres(url, { max: 1 });
    let held = false;
    const create = `/api/projects/${project}/chats`,
      use = (chat) => `/api/chats/${chat}/usage`;
    const raw = async (route, json, { signal } = {}) => {
      const client = h.fixture.client();
      const response = await fetch(new URL(route, h.fixture.server.origin), {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "x-cantrip-csrf": client.csrf,
        },
        body: JSON.stringify(json),
      });
      return { status: response.status, body: await response.json() };
    };
    const lock = async () => {
      await blocker`SELECT pg_advisory_lock(7723)`;
      held = true;
    };
    const unlock = async () => {
      if (held) {
        await blocker`SELECT pg_advisory_unlock(7723)`;
        held = false;
      }
    };
    const waitForLock = (count) =>
      eventually(
        async () =>
          sql`SELECT l.pid FROM pg_locks l INNER JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.objid=7723 AND NOT l.granted`,
        (rows) =>
          assert.equal(
            rows.length,
            count,
            "actual request transactions wait inside their writes",
          ),
        15000,
      );
    try {
      await sql.unsafe(`CREATE FUNCTION conversation_fixture_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id=${literal(id(1))} THEN PERFORM pg_advisory_xact_lock(7723); END IF; RETURN NEW; END $$;
        CREATE TRIGGER conversation_fixture_insert BEFORE INSERT ON chats FOR EACH ROW EXECUTE FUNCTION conversation_fixture_insert();
        CREATE FUNCTION conversation_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.chat_id=${literal(id(4))} THEN PERFORM pg_advisory_xact_lock(7723); END IF; RETURN NEW; END $$;
        CREATE TRIGGER conversation_fixture_receipt BEFORE INSERT ON conversation_creation_requests FOR EACH ROW EXECUTE FUNCTION conversation_fixture_receipt();
        CREATE FUNCTION conversation_fixture_lane() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.chat_id=${literal(id(3))} THEN RAISE EXCEPTION 'conversation lane fixture failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER conversation_fixture_lane AFTER INSERT ON chat_execution_lanes FOR EACH ROW EXECUTE FUNCTION conversation_fixture_lane();
        CREATE FUNCTION conversation_fixture_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.operation_id=${literal(id(30))} THEN RAISE EXCEPTION 'usage receipt fixture failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER conversation_fixture_usage BEFORE INSERT ON conversation_usage_receipts FOR EACH ROW EXECUTE FUNCTION conversation_fixture_usage();`);
      await lock();
      const duplicate = Promise.all([
        raw(create, input(id(1))),
        raw(create, input(id(1))),
      ]);
      duplicate.catch(() => {});
      await waitForLock(2);
      await unlock();
      const same = await duplicate;
      assert.deepEqual(
        same.map((r) => r.status),
        [201, 201],
      );
      assert.equal(same[0].body.id, id(1));
      assert.deepEqual(same[1].body, same[0].body);
      result.proofs.push(
        "two actual concurrent creation transactions resolve one retained identity",
      );

      const competingInputs = [input(id(2)), input(id(2), { autoTitle: true })];
      const competing = await Promise.all(
        competingInputs.map((v) => raw(create, v)),
      );
      assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
      const winner = competing.findIndex((r) => r.status === 201);
      assert.equal(
        competing[1 - winner].body.error,
        "Conversation creation identity is already in use.",
      );
      assert.equal((await raw(create, competingInputs[winner])).status, 201);
      assert.equal(
        (await raw(create, competingInputs[1 - winner])).status,
        409,
      );
      result.proofs.push(
        "conflicting concurrent creation inputs commit one request and preserve its exact replay",
      );

      await h.visit("creation lane failure rolls back", "POST", create, {
        json: input(id(3)),
        status: 500,
      });
      const failed =
        await sql`SELECT (SELECT count(*)::int FROM chats WHERE id=${id(3)}) AS chats,(SELECT count(*)::int FROM chat_runtime_sessions WHERE chat_id=${id(3)}) AS runtimes,(SELECT count(*)::int FROM chat_execution_lanes WHERE chat_id=${id(3)}) AS lanes,(SELECT count(*)::int FROM conversation_creation_requests WHERE chat_id=${id(3)}) AS receipts`;
      assert.deepEqual(Array.from(failed), [
        { chats: 0, runtimes: 0, lanes: 0, receipts: 0 },
      ]);
      result.proofs.push(
        "a real SQL exception after the lane insert rolls back the already-written Chat, runtime, lane and receipt",
      );

      await lock();
      const aborted = new AbortController();
      const pending = raw(create, input(id(4)), { signal: aborted.signal });
      const completion = pending.then(
        () => {
          throw new Error("request unexpectedly completed before caller abort");
        },
        (error) => assert.equal(error.name, "AbortError"),
      );
      await waitForLock(1);
      aborted.abort();
      await completion;
      await unlock();
      await eventually(
        async () =>
          sql`SELECT count(*)::int AS receipts FROM conversation_creation_requests WHERE chat_id=${id(4)}`,
        (rows) => assert.equal(rows[0].receipts, 1),
        15000,
      );
      await h.visit(
        "aborted caller replays committed creation",
        "POST",
        create,
        { json: input(id(4)), status: 201 },
      );
      result.proofs.push(
        "caller disconnection during the real receipt write does not abandon or duplicate creation",
      );

      const usage = { clientId: id(20), operationId: id(21), sequence: 10 };
      const used = await Promise.all([
        raw(use(id(1)), usage),
        raw(use(id(1)), usage),
      ]);
      assert.deepEqual(
        used.map((r) => r.status),
        [200, 200],
      );
      assert.deepEqual(used[0].body, used[1].body);
      assert.equal(used[0].body.applied, true);
      const conflict = await Promise.all([
        raw(use(id(1)), { ...usage, operationId: id(22), sequence: 11 }),
        raw(use(id(2)), { ...usage, operationId: id(22), sequence: 11 }),
      ]);
      assert.deepEqual(conflict.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        conflict.find((r) => r.status === 409).body.error,
        "Usage operation was already used for different input.",
      );
      result.proofs.push(
        "concurrent same-client usage is receipt-idempotent and fences conflicting Chat identities",
      );
      const before =
        await sql`SELECT last_used_at::text FROM chats WHERE id=${originalChat}`;
      await h.visit(
        "usage receipt failure rolls back",
        "POST",
        use(originalChat),
        {
          json: { clientId: id(29), operationId: id(30), sequence: 100 },
          status: 500,
        },
      );
      assert.deepEqual(
        await sql`SELECT last_used_at::text FROM chats WHERE id=${originalChat}`,
        before,
      );
      const failedUsage =
        await sql`SELECT (SELECT count(*)::int FROM conversation_usage_clients WHERE client_id=${id(29)}) AS clients,(SELECT count(*)::int FROM conversation_usage_receipts WHERE operation_id=${id(30)}) AS receipts`;
      assert.deepEqual(Array.from(failedUsage), [{ clients: 0, receipts: 0 }]);
      result.proofs.push(
        "a real usage receipt SQL exception rolls back recency, client sequence and receipt",
      );

      const port = Number(new URL(h.fixture.server.origin).port);
      await h.fixture.close();
      await h.fixture.start({ port });
      await h.visit(
        "creation identity survives server restart",
        "POST",
        create,
        { json: input(id(4)), status: 201 },
      );
      const replay = await h.visit(
        "usage receipt survives server restart",
        "POST",
        use(id(1)),
        { json: usage },
      );
      assert.deepEqual(replay, used[0].body);
      const counts =
        await sql`SELECT (SELECT count(*)::int FROM chats WHERE id=ANY(${[id(1), id(2), id(4)]})) AS chats,(SELECT count(*)::int FROM chat_runtime_sessions WHERE chat_id=ANY(${[id(1), id(2), id(4)]})) AS runtimes,(SELECT count(*)::int FROM chat_execution_lanes WHERE chat_id=ANY(${[id(1), id(2), id(4)]})) AS lanes,(SELECT count(*)::int FROM conversation_creation_requests) AS creations,(SELECT count(*)::int FROM conversation_usage_receipts) AS usages,(SELECT sequence::int FROM conversation_usage_clients WHERE client_id=${id(20)}) AS sequence`;
      assert.deepEqual(Array.from(counts), [
        {
          chats: 3,
          runtimes: 3,
          lanes: 3,
          creations: 3,
          usages: 2,
          sequence: 11,
        },
      ]);
      result.proofs.push(
        "server restart preserves all committed identities, usage receipts and monotonic client sequence",
      );
    } finally {
      await unlock();
      await blocker.end({ timeout: 5 });
      await sql.end({ timeout: 5 });
      await h.close();
    }
  }
  assert.deepEqual(outputs[1].proofs, outputs[0].proofs);
  assert.deepEqual(
    outputs[1].observations,
    outputs[0].observations,
    "failure/restart HTTP results match the actual Node service",
  );
}
