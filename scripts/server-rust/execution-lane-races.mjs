// Two actual server processes block on the same project row before competing.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const postgres = require("postgres");
async function waiters(sql, count) {
  const deadline = Date.now() + 20000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%locked_project%'`;
    if (
      rows.length === count &&
      rows.every((row) => row.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "actual admitted project lock waiter count");
  assert.ok(
    rows.every((row) => row.wait_event_type === "Lock"),
    "actual admitted requests must wait on SQL locks",
  );
  return rows;
}
export async function runLaneRaces({
  pair,
  urls,
  root,
  executable,
  owner,
  reset,
  snapshot,
  report,
  register,
  normalized,
}) {
  report.races = [];
  for (const secondaryChat of ["chat", "contender"]) {
    await reset();
    const results = [];
    for (const [i, kind] of ["node", "rust"].entries()) {
      const peer = await repositoryFixture({
        kind,
        executable,
        root: path.join(root, "peer"),
        databaseMode: "postgres",
        databaseUrl: urls[i],
      });
      const blocker = postgres(urls[i], { max: 1 }),
        observer = postgres(urls[i], { max: 1 });
      let release,
        held,
        pending = [];
      try {
        let ready;
        const locked = new Promise((resolve) => (ready = resolve)),
          unlocked = new Promise((resolve) => (release = resolve));
        held = blocker.begin(async (sql) => {
          await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
          ready();
          await unlocked;
        });
        await Promise.race([
          locked,
          held.then(() => {
            throw new Error("Project lock ended before contention");
          }),
        ]);
        const enqueue = (promise) => {
          promise.catch(() => {});
          pending.push(promise);
        };
        enqueue(
          pair[i].request({
            op: "native-command-lane-run",
            action: "start",
            owner,
            chat: "chat",
          }),
        );
        const first = await waiters(observer, 1);
        enqueue(
          peer.request({
            op: "native-command-lane-run",
            action: "start",
            owner,
            chat: secondaryChat,
          }),
        );
        const both = await waiters(observer, 2);
        release();
        await held;
        const outcomes = await Promise.all(pending);
        report.races.push({ kind, secondaryChat, first, both, outcomes });
        assert.equal(outcomes[0].rejected, false, outcomes[0].diagnostic);
        assert.equal(outcomes[1].rejected, true);
        assert.equal(outcomes[1].laneError, "ExecutionLaneBusyError");
        register(outcomes[0].value.executionLaneId, "lane", i);
        results.push({
          execution: outcomes[0].value,
          busy: {
            laneError: outcomes[1].laneError,
            message: outcomes[1].diagnostic,
          },
        });
      } finally {
        release?.();
        await held?.catch(() => {});
        await Promise.allSettled(pending);
        await peer.close();
        await blocker.end({ timeout: 5 });
        await observer.end({ timeout: 5 });
      }
    }
    assert.deepEqual(
      normalized(results[1], 1),
      normalized(results[0], 0),
      "concurrent SQL project coordination " + secondaryChat,
    );
    const states = await snapshot(
      "actual two-process lane race " + secondaryChat,
    );
    for (const state of states) {
      assert.equal(state.lanes.length, 1);
      assert.equal(state.runtimes.length, 1);
      assert.equal(state.leases.length, 1);
      assert.equal(state.lanes[0].chat_id, "chat");
      assert.equal(state.leases[0].state, "active");
      assert.equal(
        state.chats.find((chat) => chat.id === "contender").status,
        "idle",
      );
    }
  }
}
