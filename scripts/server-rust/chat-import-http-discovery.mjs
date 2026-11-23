import assert from "node:assert/strict";
import { literal, stamp } from "./project-target-state.mjs";

export async function importDiscoveryEdges({
  fixture,
  visit,
  state,
  workers,
  projectId,
  owner,
  imported,
  result,
}) {
  const url = "/api/projects/" + projectId + "/external-chat-history";
  state.discoveryThread = imported.sourceThreadId;
  const offset = state.commands.length;
  const annotated = await visit(
    "already-imported archive discovery",
    "GET",
    url + "?includeArchived=true",
  );
  result.discoveryEdgeRaw = { annotated };
  for (const worker of annotated.workers) {
    const thread = worker.sources[0].threads[0];
    assert.equal(thread.createdAt, stamp);
    assert.equal(thread.updatedAt, stamp);
    assert.deepEqual(
      thread.existingImport,
      worker.workerId === "alpha"
        ? {
            jobId: imported.id,
            projectId,
            chatId: imported.chatId,
            state: "succeeded",
          }
        : null,
    );
  }
  const commands = state.commands
    .slice(offset)
    .filter((c) => c.command.type === "external.chat-history.discover");
  assert.equal(commands.length, 2);
  assert.ok(commands.every((c) => c.command.includeArchived === true));
  state.discoveryThread = undefined;
  state.mode = "discovery-invalid";
  const invalid = await visit("invalid discovery worker result", "GET", url);
  assert.ok(
    invalid.workers.every(
      (w) => w.status === "error" && w.error.code === "worker-error",
    ),
  );
  assert.equal(invalid.partial, true);
  state.mode = "success";
  workers[0].heartbeat.externalCodexHistory = false;
  await workers[0].pulse();
  try {
    const unsupported = await visit("discovery capability missing", "GET", url);
    assert.equal(
      unsupported.workers.find((w) => w.workerId === "alpha").status,
      "unsupported",
    );
    assert.equal(unsupported.partial, true);
  } finally {
    workers[0].heartbeat.externalCodexHistory = true;
    await workers[0].pulse();
  }
  const labels = ["a", "A", "á", "Å", "ß", "ss", "Ö", "o", "👨", "😀", "中"];
  const fleet = Array.from({ length: 66 }, (_, n) => ({
    workerId: "fleet-" + String(n).padStart(2, "0"),
    sourceId: "fleet-source-" + n,
    name:
      n === 0 ? "n" + "😀".repeat(110) : labels[n % labels.length] + " - " + n,
    platform: n === 0 ? "p" + "😀".repeat(60) : "fixture-platform",
  }));
  result.discoveryEdgeRaw.fleetDefinition = fleet;
  try {
    await fixture.sql(
      fleet.flatMap((w) => [
        "INSERT INTO workers SELECT (jsonb_populate_record(NULL::workers,to_jsonb(w)||jsonb_build_object('id'," +
          literal(w.workerId) +
          ",'name'," +
          literal(w.name) +
          ",'display_name',NULL,'platform'," +
          literal(w.platform) +
          ",'external_codex_history_capability',false))).* FROM workers w WHERE w.id='alpha' AND w.owner_id=" +
          literal(owner),
        "INSERT INTO project_sources SELECT (jsonb_populate_record(NULL::project_sources,to_jsonb(s)||jsonb_build_object('id'," +
          literal(w.sourceId) +
          ",'worker_id'," +
          literal(w.workerId) +
          "))).* FROM project_sources s WHERE s.id='github-alpha' AND s.project_id=" +
          literal(projectId),
      ]),
    );
    const wide = await visit(
      "discovery fleet bound and Unicode collation",
      "GET",
      url,
    );
    result.discoveryEdgeRaw.fleet = wide;
    const expected = [
      ...workers.map((w) => ({
        workerId: w.heartbeat.workerId,
        name: w.heartbeat.name,
        platform: w.heartbeat.platform,
      })),
      ...fleet,
    ]
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || a.workerId.localeCompare(b.workerId),
      )
      .slice(0, 64);
    assert.equal(wide.partial, true);
    assert.equal(wide.truncated, true);
    assert.deepEqual(
      wide.workers.map((w) => w.workerId),
      expected.map((w) => w.workerId),
    );
    for (const worker of wide.workers) {
      const original = expected.find((w) => w.workerId === worker.workerId);
      assert.equal(worker.workerName, original.name.slice(0, 200));
      assert.equal(worker.platform, original.platform.slice(0, 100));
      if (worker.workerId.startsWith("fleet-"))
        assert.equal(worker.status, "unsupported");
    }
  } finally {
    await fixture.sql([
      "DELETE FROM project_sources WHERE id IN (" +
        fleet.map((w) => literal(w.sourceId)).join(",") +
        ")",
      "DELETE FROM workers WHERE id IN (" +
        fleet.map((w) => literal(w.workerId)).join(",") +
        ")",
    ]);
  }
}
