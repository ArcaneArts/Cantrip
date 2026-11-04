// Real HTTP updates must reach the actual connected worker admission pool.
import assert from "node:assert/strict";
import { literal } from "./project-target-state.mjs";
import { settingsWorker } from "./native-settings-http-fixture.mjs";

export async function runSettingsInferenceHttpCases(h, visit, result) {
  const query =
    "SELECT jsonb_build_object('thread',codex_thread_id,'status',status,'route',model_route_id)::text result FROM chat_runtime_sessions WHERE id='settings-runtime'";
  const [original] = await h.fixture.sql([], [query]);
  assert.ok(original);
  await h.fixture.sql([
    "UPDATE chat_runtime_sessions SET model_route_id='probe-generic-route' WHERE id='settings-runtime'",
  ]);
  const [before] = await h.fixture.sql([], [query]);
  const cases = [];
  try {
    for (const [limit, revision] of [
      [2, 1],
      [2, 1],
      [1, 2],
      [8, 3],
    ]) {
      const start = h.inferenceSyncs.length;
      const provider = await visit(
        `live provider limit ${limit} at revision ${revision}`,
        "PATCH",
        "/api/settings/providers/probe-zai",
        {
          json: {
            name: "Probe",
            kind: "openai-compatible",
            baseUrl: "https://api.z.ai/api/v1",
            maxConcurrentInference: limit,
          },
        },
      );
      assert.equal(provider.maxConcurrentInference, limit);
      assert.equal(provider.inferenceConfigRevision, revision);
      const delivery = h.inferenceSyncs
        .slice(start)
        .find((sync) =>
          sync.configurations.some(
            (configuration) =>
              configuration.providerId === "probe-zai" &&
              configuration.maxConcurrentInference === limit &&
              configuration.inferenceConfigRevision === revision,
          ),
        );
      assert.ok(
        delivery,
        "HTTP response follows delivery to the connected worker",
      );
      assert.equal(delivery.status.workerId, settingsWorker);
      assert.equal(delivery.status.ownerId, h.owner);
      assert.equal(delivery.status.serverId, h.serverId);
      const pool = h
        .inferenceStatus()
        .pools.find((pool) => pool.providerId === "probe-zai");
      assert.equal(pool.maxConcurrentInference, limit);
      assert.equal(pool.inferenceConfigRevision, revision);
      const [after] = await h.fixture.sql([], [query]);
      assert.deepEqual(
        after,
        before,
        "Limit-only edits preserve the current native runtime",
      );
      cases.push({
        limit,
        revision,
        deliveredBeforeResponse: true,
        runtimePreserved: true,
      });
    }
    result.providerInferenceLiveSynchronization = {
      actualWorkerAdmission: true,
      cases,
    };
  } finally {
    await h.fixture.sql([
      `UPDATE chat_runtime_sessions SET model_route_id=${literal(original.route)} WHERE id='settings-runtime'`,
    ]);
  }
}
