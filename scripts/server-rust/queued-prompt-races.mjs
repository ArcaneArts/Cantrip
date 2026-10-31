// The source API performs ordinary statements, so two processes may both read
// before an insert/delete. Preserve its actual conflict/captured-row behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { repositoryFixture } from "./repository-fixture.mjs";
import { retainedPrompt, promptId } from "./native-settlement-fixtures.mjs";
import { queuedPromptCreateSchema } from "../../packages/protocol/dist/index.js";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiters(sql, count, entry) {
  let rows = [],
    last;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND (query ILIKE '%insert into%queued_prompts%' OR query ILIKE '%delete from%queued_prompts%')`;
    const value = JSON.stringify(rows);
    if (value !== last) {
      entry.observations.push({ count, rows, at: Date.now() });
      last = value;
    }
    if (
      rows.length === count &&
      rows.every((r) => r.wait_event_type === "Lock")
    )
      return rows;
    await sleep(20);
  }
  assert.equal(rows.length, count, "queued prompt statement waiter count");
  assert.ok(
    rows.every((r) => r.wait_event_type === "Lock"),
    "actual prompt table lock contention",
  );
  return rows;
}
export async function runQueuedPromptRaces({
  pair,
  urls,
  root,
  executable,
  owner,
  reset,
  observe,
  snapshot,
  report,
  register,
  normalized,
}) {
  report.promptRaces = [];
  for (const mixed of [false, true])
    for (const scenario of ["create-encrypted", "create-visible", "delete"]) {
      await reset();
      if (scenario === "delete")
        await observe(
          "prompt race delete fixture",
          {
            chat: "chat",
            action: "create-encrypted",
            content: retainedPrompt(),
            attachments: [],
          },
          { op: "native-command-prompt-run", shape: "raw" },
        );
      const results = [];
      for (const [i, kind] of ["node", "rust"].entries()) {
        const peerKind = mixed ? (kind === "node" ? "rust" : "node") : kind;
        const peer = await repositoryFixture({
          kind: peerKind,
          executable,
          root: path.join(root, "prompt-peer"),
          databaseMode: "postgres",
          databaseUrl: urls[i],
        });
        const blocker = postgres(urls[i], { max: 1 }),
          observer = postgres(urls[i], { max: 1 }),
          pending = [];
        const entry = {
          kind,
          peerKind,
          mixed,
          scenario,
          observations: [],
          phase: "starting",
        };
        report.promptRaces.push(entry);
        let release, held;
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`LOCK TABLE queued_prompts IN SHARE MODE`;
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Prompt blocker ended before observation");
            }),
          ]);
          const request = {
            op: "native-command-prompt-run",
            owner,
            chat: "chat",
            action: scenario,
            prompt: promptId,
            content:
              scenario === "create-visible"
                ? queuedPromptCreateSchema.parse({
                    text: "Legacy race",
                    idempotencyKey: "prompt-race-key",
                  })
                : retainedPrompt(),
            model: "queue-model",
            attachments: [],
          };
          const enqueue = (p) => {
            p.catch(() => {});
            pending.push(p);
          };
          enqueue(pair[i].request(request));
          entry.first = await waiters(observer, 1, entry);
          enqueue(peer.request(request));
          entry.both = await waiters(observer, 2, entry);
          release();
          await held;
          const outcomes = await Promise.all(pending);
          entry.outcomes = outcomes;
          const successes = outcomes.filter((r) => !r.rejected),
            failures = outcomes.filter((r) => r.rejected);
          assert.equal(successes.length, scenario === "delete" ? 2 : 1);
          assert.equal(failures.length, scenario === "delete" ? 0 : 1);
          for (const failed of failures)
            assert.equal(failed.databaseCode, "23505");
          if (scenario === "create-visible")
            for (const result of successes)
              register(result.value.id, "prompt", i);
          results.push({
            values: successes.map((r) => r.value),
            failures: failures.map((r) => r.databaseCode),
          });
          entry.phase = "complete";
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
        "queued prompt two-process " + scenario + mixed,
      );
      const states = await snapshot(
        "queued prompt race durable state " + scenario + mixed,
      );
      for (const state of states)
        assert.equal(state.prompts?.length ?? 0, scenario === "delete" ? 0 : 1);
    }
}
