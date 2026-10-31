import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { inventorySeed } from "./native-model-inventory-fixtures.mjs";
import {
  settingsHttpFixture,
  settingsChat as chat,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";
import { literal } from "./project-target-state.mjs";
const require = createRequire(
    new URL("../../cantrip_server/package.json", import.meta.url),
  ),
  postgres = require("postgres");
async function waiting(sql) {
  const deadline = Date.now() + 15000;
  let rows = [];
  while (Date.now() < deadline) {
    rows =
      await sql`SELECT pid,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%provider_model_availability%'`;
    if (rows.length === 1 && rows[0].wait_event_type === "Lock") return rows;
    await delay(20);
  }
  assert.equal(
    rows.length,
    1,
    "one actual blocked provider availability query",
  );
  assert.equal(rows[0].wait_event_type, "Lock");
  return rows;
}
export async function nativeModelInventoryHttpRaces({
  pg,
  root,
  executable,
  repositoryExecutable,
  passwordHash,
  report,
}) {
  report.readRaces = [];
  const outputs = [];
  for (const kind of ["node", "rust"]) {
    const url = await pg.database(),
      result = { kind, observations: [], snapshotProofs: 0, locks: [] };
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
      configure: (owner, scope) => {
        scope.modelRouteId = "inventory-provider-route-0";
        return [
          ...inventorySeed(owner, { kind: "openai-compatible", worker }),
          "UPDATE chat_runtime_sessions SET model_route_id='inventory-provider-route-0' WHERE id='settings-runtime'",
          `INSERT INTO model_providers(id,owner_id,name,kind,base_url) VALUES('inventory-second',${literal(owner)},'Second provider','openai-compatible','http://fixture.invalid')`,
        ];
      },
    });
    const blocker = postgres(url, { max: 1 }),
      observer = postgres(url, { max: 1 });
    try {
      for (const scenario of [
        "unchanged",
        "binding",
        "provider-kind",
        "provider-id",
      ]) {
        const state = await h.visit(
          "race source " + scenario,
          "POST",
          "/api/chats/" + chat + "/native-settings/refresh",
        );
        let held, release, pending;
        const entry = { kind, scenario, phase: "starting" };
        report.readRaces.push(entry);
        try {
          let ready;
          const locked = new Promise((resolve) => (ready = resolve)),
            unlocked = new Promise((resolve) => (release = resolve));
          held = blocker.begin(async (sql) => {
            await sql`LOCK TABLE provider_model_availability IN ACCESS EXCLUSIVE MODE`;
            ready();
            await unlocked;
          });
          await Promise.race([
            locked,
            held.then(() => {
              throw new Error("Inventory lock ended before the read");
            }),
          ]);
          pending = h.visit(
            "inventory read fence " + scenario,
            "GET",
            "/api/chats/" +
              chat +
              "/native-settings/models?bindingId=" +
              encodeURIComponent(state.binding.bindingId),
            { status: scenario === "unchanged" ? 200 : 409 },
          );
          pending.catch(() => {});
          entry.waiters = await waiting(observer);
          if (scenario === "binding") {
            h.setVersion("replacement-epoch", "1");
            const fresh = await h.visit(
              "fresh binding commits while inventory waits",
              "POST",
              "/api/chats/" + chat + "/native-settings/refresh",
            );
            assert.notEqual(fresh.binding.bindingId, state.binding.bindingId);
          } else if (scenario === "provider-kind")
            await observer`UPDATE model_providers SET kind='ollama' WHERE id='inventory-provider'`;
          else if (scenario === "provider-id")
            await observer`UPDATE model_routes SET provider_id='inventory-second' WHERE id='inventory-provider-route-0'`;
          release();
          await held;
          const value = await pending;
          if (scenario !== "unchanged")
            assert.equal(value.code, "settings-binding-replaced");
          if (["provider-kind", "provider-id"].includes(scenario))
            assert.equal(
              value.error,
              "The native model inventory source changed while it was being read.",
            );
          entry.phase = "complete";
        } finally {
          release?.();
          await held?.catch(() => {});
          await pending?.catch(() => {});
        }
        if (scenario === "provider-kind")
          await observer`UPDATE model_providers SET kind='openai-compatible' WHERE id='inventory-provider'`;
        if (scenario === "provider-id")
          await observer`UPDATE model_routes SET provider_id='inventory-provider' WHERE id='inventory-provider-route-0'`;
      }
    } finally {
      await blocker.end({ timeout: 5 });
      await observer.end({ timeout: 5 });
      await h.close();
    }
  }
  assert.deepEqual(
    outputs[1].observations,
    outputs[0].observations,
    "live inventory read fences match actual Node service",
  );
}
