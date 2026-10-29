// Observe the real blocked backend; introduce a fence while it waits for locks.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const postgres = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
)("postgres");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { resolve, reject, promise };
};
export async function chatRuntimeLocks({
  pair,
  urls,
  owner,
  report,
  standalone,
}) {
  report.lockRaces = [];
  for (const scenario of [
    "project-model-handoff",
    "standalone-model-handoff",
    "runtime-route-replaced",
  ]) {
    const outcomes = [];
    report.lockRaces.push({ scenario, outcomes });
    for (let index = 0; index < pair.length; index++) {
      const repo = pair[index],
        observer = postgres(urls[index], { max: 1 }),
        locker = postgres(urls[index], { max: 1 });
      const held = deferred(),
        release = deferred();
      let transaction, pending, lockerPid;
      try {
        const chat =
          scenario === "standalone-model-handoff" ? standalone : "chat";
        await observer`DELETE FROM native_runtime_handoffs WHERE chat_id=${chat}`;
        await observer`DELETE FROM native_settings_states WHERE chat_id=${chat}`;
        const original = (
          await observer`SELECT model_id FROM chats WHERE id=${chat}`
        )[0].model_id;
        const bindings = async () =>
          (
            await observer`SELECT jsonb_build_object('runtimes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM chat_runtime_sessions r WHERE r.chat_id=${chat}),'lanes',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM chat_execution_lanes l WHERE l.chat_id=${chat})) state`
          )[0].state;
        const beforeBindings = await bindings();
        transaction = locker.begin(async (sql) => {
          lockerPid = (await sql`SELECT pg_backend_pid() pid`)[0].pid;
          if (scenario === "project-model-handoff")
            await sql`SELECT id FROM projects WHERE id='github' FOR UPDATE`;
          else await sql`SELECT id FROM chats WHERE id=${chat} FOR UPDATE`;
          held.resolve();
          await release.promise;
          if (scenario === "runtime-route-replaced") {
            const binding = {
              workerId: "alpha",
              threadId: "lock-thread",
              placementId: "github-alpha-main",
              modelRouteId: "console-route-two",
              providerAccountId: "account-two",
            };
            await sql`INSERT INTO native_settings_states(chat_id,state) VALUES(${chat},${sql.json({ binding })})`;
          } else
            await sql`INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,phase,source,target_model_route_id) VALUES(${scenario},${owner},${chat},'alpha','preparing','{}','console-route')`;
        });
        transaction.catch(held.reject);
        await held.promise;
        const request =
          scenario === "runtime-route-replaced"
            ? {
                op: "chat-runtime",
                owner,
                chat,
                worker: "alpha",
                worktree: "github-alpha-main",
                thread: "lock-thread",
                route: "console-route",
                providerAccountId: "account-one",
              }
            : { op: "chat-model", owner, chat, model: "console-model-two" };
        pending = repo.request(request);
        let blocked;
        const end = Date.now() + 10000;
        do {
          blocked =
            await observer`SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND ${lockerPid}=ANY(pg_blocking_pids(pid))`;
          if (blocked.length) break;
          assert.ok(
            Date.now() < end,
            "observe actual chat writer waiting for the held lock",
          );
          await delay(10);
        } while (true);
        assert.equal(blocked.length, 1);
        release.resolve();
        await transaction;
        const result = await pending;
        assert.equal(result.rejected, true);
        assert.equal(
          result.code,
          scenario === "runtime-route-replaced"
            ? "native-runtime-route-replaced"
            : "native-runtime-handoff-pending",
        );
        assert.equal(
          (await observer`SELECT model_id FROM chats WHERE id=${chat}`)[0]
            .model_id,
          original,
          "late fence prevents any model write",
        );
        const afterBindings = await bindings();
        assert.deepEqual(
          afterBindings,
          beforeBindings,
          "late fence preserves exact runtime and lane rows",
        );
        outcomes.push({
          kind: index === 0 ? "node" : "rust",
          blockedBackend: blocked[0],
          result,
          beforeBindings,
          afterBindings,
        });
        await observer`DELETE FROM native_runtime_handoffs WHERE chat_id=${chat}`;
        await observer`DELETE FROM native_settings_states WHERE chat_id=${chat}`;
      } finally {
        release.resolve();
        await transaction?.catch(() => {});
        await pending?.catch(() => {});
        await locker.end({ timeout: 5 });
        await observer.end({ timeout: 5 });
      }
    }
    const observable = ({ result: { rejected, code, diagnostic } }) => ({
      rejected,
      code,
      diagnostic,
    });
    assert.deepEqual(
      observable(outcomes[1]),
      observable(outcomes[0]),
      scenario + " real lock and late-fence behavior",
    );
  }
}
