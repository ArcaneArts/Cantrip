import assert from "node:assert/strict";
import { literal } from "./project-target-state.mjs";
import { taskTimestamp } from "./task-wire-fixtures.mjs";
import { settingsWorker } from "./native-settings-http-fixture.mjs";
import {
  providerStateId,
  providerStateKinds,
} from "./provider-state-worker.mjs";
import { runSettingsInferenceStatusHttpCases } from "./settings-inference-status-http-cases.mjs";

export async function providerStateHttpCases(h, result, controller, profile) {
  const started = result.startedAt;
  const runtimeAliases = new Map();
  function verifiedRuntime(value) {
    if (Array.isArray(value)) return value.map(verifiedRuntime);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, verifiedRuntime(v)]),
      );
    return runtimeAliases.get(value) ?? value;
  }
  const storageSql = `SELECT jsonb_build_object('models',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY provider_id,native_model_id),'[]'::jsonb) FROM provider_models m JOIN model_providers p ON p.id=m.provider_id WHERE p.owner_id=${literal(h.owner)} AND m.provider_id LIKE 'qualified-%'),'snapshots',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY provider_id,metadata_hash),'[]'::jsonb) FROM provider_model_catalog_snapshots s WHERE owner_id=${literal(h.owner)} AND provider_id LIKE 'qualified-%'),'suppressions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY provider_model_id,operation),'[]'::jsonb) FROM provider_model_suppressions s WHERE owner_id=${literal(h.owner)}),'profiles',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY name),'[]'::jsonb) FROM model_profiles m WHERE owner_id=${literal(h.owner)} AND EXISTS(SELECT 1 FROM model_routes r WHERE r.model_id=m.id AND r.provider_id LIKE 'qualified-%')),'routes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY provider_id,model_name),'[]'::jsonb) FROM model_routes r WHERE provider_id LIKE 'qualified-%'),'sync',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY provider_id,scope_key),'[]'::jsonb) FROM provider_catalog_sync_states s WHERE provider_id LIKE 'qualified-%')) result`;
  function clocks(value, key = "") {
    if (Array.isArray(value)) return value.map((v) => clocks(v, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, clocks(v, k)]),
      );
    if (
      typeof value === "string" &&
      key.endsWith("_at") &&
      /^\d{4}-/.test(value)
    ) {
      if (Date.parse(value) === Date.parse(taskTimestamp))
        return "<original worker timestamp>";
      assert.ok(
        Date.parse(value) >= started && Date.parse(value) <= Date.now() + 1000,
        key,
      );
      return "<validated catalog write clock>";
    }
    return value;
  }
  const read = async () =>
    (
      await h.fixture.sql(
        [],
        [storageSql.replace(") result", ")::text result")],
      )
    )[0];
  const snapshot = async (name) => {
    const value = await read();
    const bindings = [];
    for (const profile of value.profiles) {
      assert.equal(profile.discovery_managed, true);
      assert.equal(profile.operation, "language");
      const route = value.routes.find((r) => r.model_id === profile.id);
      assert.ok(route);
      const model = value.models.find((m) => m.id === route.provider_model_id);
      assert.ok(model);
      assert.equal(route.provider_id, model.provider_id);
      assert.equal(route.model_name, model.native_model_id);
      assert.equal(profile.id, "discovered:model:" + model.id);
      assert.equal(route.id, "discovered:route:" + model.id);
      runtimeAliases.set(
        profile.id,
        "discovered:model:" + h.fixture.normalize(model.id),
      );
      runtimeAliases.set(
        route.id,
        "discovered:route:" + h.fixture.normalize(model.id),
      );
      bindings.push({
        providerModelId: model.id,
        profileId: profile.id,
        routeId: route.id,
        providerId: model.provider_id,
        nativeModelId: model.native_model_id,
      });
    }
    (result.catalogIdentityProofs ??= []).push({ name, bindings });
    result.rawStages.push({ name, value });
    result.stages.push({
      name,
      value: verifiedRuntime(clocks(h.fixture.normalize(value))),
    });
    return value;
  };
  const catalog = async (kind, name, force = true, extra = {}) =>
    h.visit(
      name,
      force ? "POST" : "GET",
      `/api/settings/providers/${providerStateId(kind)}/catalog${force ? "/refresh" : ""}?workerId=${encodeURIComponent(settingsWorker)}`,
      extra,
    );
  for (const kind of providerStateKinds) {
    const value = await catalog(
      kind,
      "discover " + kind + " through actual worker",
    );
    assert.ok(value.models.length > 0);
    assert.equal(value.servedStale, false);
  }
  const initial = await snapshot("initial complete catalogs");
  assert.equal(initial.snapshots.length, 4);
  assert.equal(initial.suppressions.length, 0);
  for (const s of initial.snapshots)
    assert.match(s.metadata_hash, /^[a-f0-9]{64}$/);
  for (const kind of providerStateKinds)
    await catalog(
      kind,
      "identical " + kind + " refresh retains metadata snapshot",
    );
  const unchanged = await snapshot(
    "identical metadata reuses original snapshots",
  );
  assert.deepEqual(unchanged.snapshots, initial.snapshots);
  controller.state.revision = 1;
  await catalog("chatgpt", "changed metadata creates one durable version");
  const changed = await snapshot("one changed model creates one snapshot");
  assert.equal(changed.snapshots.length, 5);
  const before = await read();
  await h.fixture.sql([
    "CREATE FUNCTION fail_provider_state_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_id='qualified-chatgpt' THEN RAISE EXCEPTION 'actual catalog snapshot write failure'; END IF; RETURN NEW; END $$",
    "CREATE TRIGGER fail_provider_state_snapshot BEFORE INSERT ON provider_model_catalog_snapshots FOR EACH ROW EXECUTE FUNCTION fail_provider_state_snapshot()",
  ]);
  controller.state.revision = 2;
  const stale = await catalog(
    "chatgpt",
    "actual SQL failure retains complete previous catalog",
  );
  assert.equal(stale.servedStale, true);
  const after = await snapshot(
    "catalog transaction rolls back models and snapshots",
  );
  for (const key of [
    "models",
    "snapshots",
    "suppressions",
    "profiles",
    "routes",
  ])
    assert.deepEqual(after[key], before[key], key);
  assert.equal(
    after.sync.find((s) => s.provider_id === providerStateId("chatgpt")).status,
    "stale",
  );
  await h.fixture.sql([
    "DROP TRIGGER fail_provider_state_snapshot ON provider_model_catalog_snapshots",
    "DROP FUNCTION fail_provider_state_snapshot()",
  ]);
  controller.state.revision = 1;
  await catalog("chatgpt", "catalog recovers after actual SQL failure");
  const [selected] = await h.fixture.sql(
    [],
    [
      `SELECT jsonb_build_object('id',m.id)::text result FROM model_profiles m JOIN model_routes r ON r.model_id=m.id WHERE r.provider_id='qualified-chatgpt' AND r.model_name='gpt-second' LIMIT 1`,
    ],
  );
  assert.ok(selected?.id);
  await h.visit(
    "delete discovered nondefault model",
    "DELETE",
    "/api/settings/models/" + selected.id,
    { status: 204 },
  );
  const suppressed = await snapshot(
    "deletion persists provider model suppression",
  );
  assert.equal(suppressed.suppressions.length, 1);
  await catalog("chatgpt", "refresh honors the durable suppression");
  const retained = await snapshot("suppressed logical model is not recreated");
  assert.equal(retained.suppressions.length, 1);
  assert.equal(
    retained.profiles.some((m) => m.id === selected.id),
    false,
  );
  assert.deepEqual(retained.snapshots, changed.snapshots);
  controller.state.fail = "grok";
  assert.equal(
    (
      await catalog(
        "grok",
        "worker discovery failure serves original stale catalog",
      )
    ).servedStale,
    true,
  );
  controller.state.fail = null;
  await catalog("grok", "worker discovery recovers");
  if (profile === "accounts")
    await catalog(
      "chatgpt",
      "foreign account cannot discover owned catalog",
      true,
      { client: "other", status: 404 },
    );
  const testStarted = Date.now();
  const tested = await h.visit(
    "run actual provider test command",
    "POST",
    `/api/settings/providers/${providerStateId("ollama")}/test?workerId=${encodeURIComponent(settingsWorker)}`,
  );
  assert.equal(tested.ok, true);
  assert.equal(tested.stage, "completed");
  const providerModel = retained.models.find(
    (m) =>
      m.provider_id === providerStateId("ollama") &&
      m.native_model_id === "qualified-llama",
  );
  const testCommands = result.catalogCommands.filter(
    (c) => c.type === "model.provider.test",
  );
  assert.equal(testCommands.length, 1);
  const testModel = testCommands[0].model;
  assert.equal(testModel.id, "discovered:model:" + providerModel.id);
  assert.equal(testModel.routeId, "discovered:route:" + providerModel.id);
  result.runtimeBindings = [
    {
      providerModelId: providerModel.id,
      modelId: testModel.id,
      routeId: testModel.routeId,
    },
  ];
  runtimeAliases.set(
    testModel.id,
    "discovered:model:" + h.fixture.normalize(providerModel.id),
  );
  runtimeAliases.set(
    testModel.routeId,
    "discovered:route:" + h.fixture.normalize(providerModel.id),
  );
  assert.ok(
    Number.isInteger(tested.durationMs) &&
      tested.durationMs >= 0 &&
      tested.durationMs <= Date.now() - testStarted + 1000,
  );
  result.observations.at(-1).body.durationMs = "<validated test duration>";
  const old = h.worker.connectionGeneration();
  h.worker.close();
  await h.reconnectWorker();
  assert.notEqual(h.worker.connectionGeneration(), old);
  await catalog(
    "chatgpt",
    "refresh after worker replacement retains suppression",
  );
  const process = h.fixture.server,
    port = Number(new URL(process.origin).port);
  await h.live.close();
  h.worker.close();
  await h.fixture.close();
  result.serverExits.push(process.diagnostics());
  await h.fixture.start({ port });
  await h.reconnectWorker();
  assert.equal(
    (
      await h.visit(
        "catalog identity after server restart",
        "GET",
        "/api/bootstrap",
      )
    ).server.id,
    h.serverId,
  );
  await catalog("chatgpt", "refresh after server restart retains suppression");
  // New Live connection after the real server restart.
  const { LiveProbe } = await import("./live-sockets.mjs");
  const live = await new LiveProbe(h.fixture).open();
  await live.initialized();
  const view = { ...h, live };
  try {
    await runSettingsInferenceStatusHttpCases(view, h.visit, result, profile);
  } finally {
    result.workerInferenceEvents = live.history
      .filter((e) => e.resource === "worker-inference")
      .map(({ cursor, ...e }) => h.fixture.normalize(e));
    await live.close();
  }
  const final = await snapshot(
    "catalog and suppression remain after server restart",
  );
  assert.equal(final.suppressions.length, 1);
  assert.deepEqual(final.snapshots, changed.snapshots);
  result.rawCatalogCommands = structuredClone(result.catalogCommands);
  result.catalogCommands = verifiedRuntime(
    h.fixture.normalize(result.catalogCommands),
  );
  return {
    storageSql,
    final,
    canonical: (value) => verifiedRuntime(clocks(h.fixture.normalize(value))),
  };
}
