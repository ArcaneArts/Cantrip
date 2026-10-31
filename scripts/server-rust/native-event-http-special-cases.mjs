// Fault injection into the disposable PostgreSQL fixture while real HTTP stays
// live. It exercises historical Task context and actual commit/publication fences.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsProject as project,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import {
  seedEventChats,
  prepareEventCommands,
} from "./native-event-http-setup.mjs";
import {
  eventContents,
  eventPrivateMarker,
  scrubEventContent,
} from "./native-event-http-content.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waitForEventLock(sql) {
  const deadline = Date.now() + 15000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    if (rows.length === 1 && rows[0].wait_event_type === "Lock") return rows;
    await sleep(20);
  }
  assert.equal(rows.length, 1, "one actual native event project lock waiter");
  assert.equal(rows[0].wait_event_type, "Lock");
  return rows;
}
export async function nativeEventHttpSpecialCases({
  pg,
  root,
  executable,
  repositoryExecutable,
  passwordHash,
  report,
}) {
  const outputs = [];
  report.specialCases = outputs;
  for (const kind of ["node", "rust"]) {
    const url = await pg.database(),
      sql = postgres(url, { max: 1 }),
      blocker = postgres(url, { max: 1 });
    const result = {
      kind,
      observations: [],
      snapshotProofs: 0,
      events: [],
      checks: [],
    };
    outputs.push(result);
    const h = await settingsHttpFixture({
      kind,
      profile: "accounts",
      root: path.join(root, "event-special"),
      executable,
      repositoryExecutable,
      passwordHash,
      databaseMode: "postgres",
      url,
      result,
      configure: seedEventChats,
    });
    let pending, held, release;
    try {
      h.prepared = await prepareEventCommands(h);
      await h.live.subscribed("special-event-scopes", [
        { kind: "chat", chatId: chat },
        { kind: "project", projectId: project },
      ]);
      const content = await eventContents(h),
        endpoint = "/api/internal/native-commands/events";
      const envelope = (event) => ({
        workerId: worker,
        operationId: h.prepared[chat].operationId,
        operationGeneration: h.prepared[chat].operationGeneration,
        event,
      });
      const send = async (name, event, status = 200) => {
        const before = h.live.history.filter((v) => v.type === "event").length;
        const value = await h.visit(name, "POST", endpoint, {
          client: "worker",
          headers: { authorization: "Bearer " + h.credential },
          json: envelope(event),
          status,
        });
        await h.live.ping(name);
        const events = h.live.history
          .filter((v) => v.type === "event")
          .slice(before);
        result.events.push({
          name,
          events: events.map((e) => ({
            scope: e.scope,
            resource: e.resource,
            entityId: e.entityId,
            revision: e.revision,
            payload: scrubEventContent(e.payload),
          })),
        });
        if (status === 200) assert.deepEqual(value, { applied: true });
        else assert.equal(events.length, 0, "rollback must not publish");
        return events;
      };
      await sql`CREATE FUNCTION fixture_fail_native_interaction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='waiting-for-approval' AND EXISTS(SELECT 1 FROM agent_interaction_requests WHERE request_key='event-interaction') THEN RAISE EXCEPTION 'fixture native event failure'; END IF; RETURN NEW; END $$`;
      await sql`CREATE TRIGGER fixture_fail_native_interaction BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION fixture_fail_native_interaction()`;
      await send(
        "actual SQL error rolls back interaction insert",
        {
          type: "agent.interaction.requested.protected",
          request: content.request,
        },
        500,
      );
      const rolledBack =
        await sql`SELECT count(*)::int count FROM agent_interaction_requests WHERE request_key='event-interaction'`;
      assert.equal(rolledBack[0].count, 0);
      result.checks.push(
        "real SQL failure rolls back insert and publishes no Live event",
      );
      await sql`DROP TRIGGER fixture_fail_native_interaction ON chats`;
      await sql`DROP FUNCTION fixture_fail_native_interaction()`;
      // Existing commands retain the Source historical Task event path when
      // experience changes after their actual Agent-project admission.
      await sql`UPDATE chats SET experience='task' WHERE id=${chat}`;
      const message = {
        type: "agent.protected-task-message",
        message: content.taskMessage,
        telemetry: { kind: "checkpoint", turnId: "turn" },
      };
      const events = await send("historical Task message event", message);
      assert.deepEqual(
        events.map((e) => [e.resource, e.scope.kind]),
        [
          ["chat-message", "chat"],
          ["task", "chat"],
          ["task", "project"],
        ],
      );
      const plan = await send("historical Task plan event", {
        type: "agent.plan.protected",
        turnId: null,
        state: content.plan,
      });
      assert.deepEqual(
        plan.map((e) => [e.resource, e.scope.kind]),
        [
          ["chat-plan", "chat"],
          ["chat", "project"],
          ["chat-plan", "project"],
        ],
      );
      const interaction = await send("historical Task interaction event", {
        type: "agent.interaction.requested.protected",
        request: content.request,
      });
      assert.deepEqual(
        interaction.map((e) => [e.resource, e.scope.kind]),
        [
          ["agent-interaction", "chat"],
          ["chat", "project"],
          ["agent-interaction", "project"],
        ],
      );
      result.checks.push(
        "actual historical Task message, plan and interaction HTTP fanout order",
      );
      let ready;
      const locked = new Promise((resolve) => (ready = resolve)),
        unlocked = new Promise((resolve) => (release = resolve));
      held = blocker.begin(async (transaction) => {
        await transaction`SELECT id FROM projects WHERE id=${project} FOR UPDATE`;
        ready();
        await unlocked;
      });
      await Promise.race([
        locked,
        held.then(() => {
          throw new Error("Project lock ended before event contention");
        }),
      ]);
      const before = h.live.history.filter((v) => v.type === "event").length;
      pending = send("HTTP event waits for real commit fence", message);
      pending.catch(() => {});
      const waiters = await waitForEventLock(sql);
      await h.live.ping("event still blocked");
      assert.equal(
        h.live.history.filter((v) => v.type === "event").length,
        before,
      );
      release();
      await held;
      await pending;
      result.lockProof = {
        waiters: waiters.length,
        allLockWaits: waiters.every((v) => v.wait_event_type === "Lock"),
      };
      result.checks.push(
        "real blocked HTTP transaction publishes only after lock release and commit",
      );
      assert.equal(
        JSON.stringify([
          ...h.fixture.records.values(),
          h.live.history,
        ]).includes(eventPrivateMarker),
        false,
      );
      result.observations = scrubEventContent(result.observations);
    } finally {
      release?.();
      await held?.catch(() => {});
      await pending?.catch(() => {});
      await h.close();
      await sql.end({ timeout: 5 });
      await blocker.end({ timeout: 5 });
    }
  }
  for (const key of ["observations", "events", "checks", "lockProof"])
    assert.deepEqual(
      outputs[1][key],
      outputs[0][key],
      "native HTTP special " + key,
    );
}
