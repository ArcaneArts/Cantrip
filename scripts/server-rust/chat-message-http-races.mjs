// Real HTTP callers wait on observed PostgreSQL locks before each fault.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { streamingHttpRequest } from "./streaming-http-request.mjs";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");

export async function chatMessageHttpRaces({
  fixture,
  databaseUrl,
  project,
  agent,
  standalone,
  protect,
  prove,
  live,
}) {
  const sql = postgres(databaseUrl, { max: 3 });
  const evidence = { waits: [], outcomes: [] };
  fixture.messageRaceEvidence = evidence;
  let held;
  const pending = [];
  async function until(read, matches, label) {
    const end = Date.now() + 15000;
    while (true) {
      const value = await read();
      if (matches(value)) return value;
      assert.ok(Date.now() < end, label);
      await delay(10);
    }
  }
  async function lock(table, id) {
    held = await sql.reserve();
    await held.unsafe("BEGIN");
    const pid = (await held`SELECT pg_backend_pid() pid`)[0].pid;
    await held.unsafe(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    return pid;
  }
  async function release() {
    if (!held) return;
    await held.unsafe("COMMIT");
    held.release();
    held = undefined;
  }
  async function waiting(pid, count) {
    const rows = await until(
      () => sql`WITH RECURSIVE waiting AS (
        SELECT pid,query,wait_event_type FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid,a.query,a.wait_event_type FROM pg_stat_activity a
        JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
        WHERE a.datname=current_database()) SELECT * FROM waiting`,
      (rows) => rows.length === count,
      `observe ${count} actual blocked message writer(s)`,
    );
    for (const row of rows) assert.equal(row.wait_event_type, "Lock");
    evidence.waits.push({ lockerPid: pid, rows });
  }
  function call(chat, input, signal = AbortSignal.timeout(30000)) {
    const client = fixture.client();
    const request = streamingHttpRequest(
      fixture.server.origin + `/api/chats/${chat}/messages`,
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:5173",
          "content-type": "application/json",
          cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(client.csrf ? { "x-cantrip-csrf": client.csrf } : {}),
        },
        body: JSON.stringify(input),
        signal,
      },
    ).then(async (response) => {
      const body = await response.json();
      if (response.status === 500) {
        assert.equal(body.requestId, response.headers.get("x-request-id"));
        body.requestId = "<request-id>";
      }
      return { status: response.status, body };
    });
    // A fault may reject before the caller below awaits its result.
    request.catch(() => {});
    pending.push(request);
    return request;
  }
  async function saved(input) {
    const rows = await sql`SELECT id FROM chat_messages WHERE id=${input.id}`;
    return rows.length;
  }
  async function event(input) {
    await until(
      () =>
        live.history.filter(
          (e) =>
            e.type === "event" &&
            e.resource === "chat-message" &&
            e.entityId === input.id,
        ),
      (rows) => rows.length === 1,
      "one direct publication after the actual commit",
    );
  }
  try {
    for (const [index, chat] of [agent, standalone].entries()) {
      const input = await protect(60 + index, chat, [
        { type: "text", text: "SENTINEL admitted after caller disconnect" },
      ]);
      const pid = await lock(
        index ? "chats" : "projects",
        index ? chat : project,
      );
      const controller = new AbortController();
      const request = call(chat, input, controller.signal);
      await waiting(pid, 1);
      controller.abort();
      await assert.rejects(request, { name: "AbortError" });
      assert.equal(await saved(input), 0);
      await release();
      await until(
        () => saved(input),
        (count) => count === 1,
        "admitted write commits after caller disconnect",
      );
      await event(input);
      evidence.outcomes.push({
        scenario: "caller-disconnect",
        chat,
        committed: 1,
      });
    }
    const duplicate = await protect(62, agent, [
      { type: "text", text: "SENTINEL competing idempotency writers" },
    ]);
    const pid = await lock("projects", project);
    const first = call(agent, duplicate);
    await waiting(pid, 1);
    const second = call(agent, duplicate);
    await waiting(pid, 2);
    await release();
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [201, 500]);
    await prove(replies.find((r) => r.status === 201).body);
    assert.equal(await saved(duplicate), 1);
    await event(duplicate);
    evidence.outcomes.push({
      scenario: "competing-idempotency",
      statuses: [201, 500],
      committed: 1,
    });

    const archived = await protect(63, agent, [
      { type: "text", text: "SENTINEL archive while waiting" },
    ]);
    const archivePid = await lock("projects", project);
    const request = call(agent, archived);
    await waiting(archivePid, 1);
    await held`UPDATE chats SET archived_at=now() WHERE id=${agent}`;
    await release();
    const response = await request;
    assert.deepEqual(response, {
      status: 404,
      body: { error: "Chat not found" },
    });
    assert.equal(await saved(archived), 0);
    await sql`UPDATE chats SET archived_at=NULL WHERE id=${agent}`;
    evidence.outcomes.push({
      scenario: "late-archive",
      ...response,
      committed: 0,
    });

    const failed = await protect(64, agent, [
      { type: "text", text: "SENTINEL rollback after insert" },
    ]);
    const before = (
      await sql`SELECT to_jsonb(c) state FROM chats c WHERE id=${agent}`
    )[0].state;
    await sql.unsafe(
      "CREATE FUNCTION reject_http_message_touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Controlled message touch failure' USING ERRCODE='P0001';END$$",
    );
    await sql.unsafe(
      "CREATE TRIGGER reject_http_message_touch BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION reject_http_message_touch()",
    );
    const rejected = await call(agent, failed);
    assert.equal(rejected.status, 500);
    assert.equal(await saved(failed), 0);
    assert.deepEqual(
      (await sql`SELECT to_jsonb(c) state FROM chats c WHERE id=${agent}`)[0]
        .state,
      before,
    );
    evidence.outcomes.push({
      scenario: "touch-failure",
      status: 500,
      committed: 0,
      unchangedChat: true,
    });
    await live.ping("message races complete");
    for (const input of [archived, failed])
      assert.equal(
        live.history.some(
          (e) =>
            e.type === "event" &&
            e.resource === "chat-message" &&
            e.entityId === input.id,
        ),
        false,
      );
    return evidence.outcomes;
  } finally {
    await release();
    await Promise.allSettled(pending);
    await sql.unsafe(
      "DROP TRIGGER IF EXISTS reject_http_message_touch ON chats",
    );
    await sql.unsafe("DROP FUNCTION IF EXISTS reject_http_message_touch()");
    await sql.end({ timeout: 5 });
  }
}
