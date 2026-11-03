import assert from "node:assert/strict";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";
import { skillSettingsAudienceKey as key } from "./skill-settings-http-worker.mjs";
import { literal, json } from "./project-target-state.mjs";

export async function runSkillAudienceHttpCases({ h, result, profile }) {
  const provider = "inventory-provider",
    other = "skill-settings-other-worker",
    context = { workerId: worker, providerId: provider },
    route = (value = context) =>
      "/api/skill-audiences?" + new URLSearchParams(value),
    update = (name, body, status = 200) =>
      h.visit(name, "PATCH", "/api/skill-audiences", { json: body, status }),
    sql = (...statements) => h.fixture.sql(statements);
  assert.deepEqual(await h.visit("empty owned audiences", "GET", route()), []);
  for (const query of [
    "",
    "workerId=" + worker,
    "workerId=a&workerId=b&providerId=" + provider,
    "workerId=" + worker + "&providerId=" + provider + "&extra=true",
  ])
    await h.visit(
      "invalid audience query " + query,
      "GET",
      "/api/skill-audiences?" + query,
      { status: 400 },
    );
  for (const body of [
    {},
    null,
    { ...context, audienceKey: "invalid" },
    { ...context, audienceKey: key(60), projectId: null },
    { ...context, audienceKey: key(60), audience: "invalid" },
  ])
    await update("invalid audience body " + JSON.stringify(body), body, 400);
  await h.visit(
    "missing audience worker",
    "GET",
    route({ ...context, workerId: "missing" }),
    { status: 404 },
  );
  await h.visit(
    "missing audience provider",
    "GET",
    route({ ...context, providerId: "missing" }),
    { status: 404 },
  );
  if (profile !== "none") {
    await h.visit("audience login required", "GET", route(), {
      client: "stranger",
      status: 401,
    });
    await h.visit("audience mutation CSRF", "PATCH", "/api/skill-audiences", {
      json: { ...context, audienceKey: key(60) },
      csrf: false,
      status: 403,
    });
  }
  if (profile === "accounts") {
    await h.visit("foreign audiences", "GET", route(), {
      client: "other",
      status: 404,
    });
    await h.visit("foreign audience update", "PATCH", "/api/skill-audiences", {
      json: { ...context, audienceKey: key(60) },
      client: "other",
      status: 404,
    });
  }
  for (const [n, audience] of [
    [62, "chat"],
    [61, "both"],
    [63, undefined],
  ]) {
    const value = await update("owned audience " + n, {
      ...context,
      audienceKey: key(n),
      ...(audience ? { audience } : {}),
    });
    assert.deepEqual(value, {
      audienceKey: key(n),
      audience: audience ?? "ide",
    });
  }
  await update("same audience writes again", {
    ...context,
    audienceKey: key(62),
    audience: "ide",
  });
  const rows = await h.visit("ordered persisted audiences", "GET", route());
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.audienceKey === key(62)).audience, "ide");
  async function durable(label) {
    const [raw] = await h.fixture.sql(
      [],
      [
        `SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY worker_id,provider_id,audience_key),'[]')::text result FROM skill_audiences s WHERE owner_id=${literal(h.owner)}`,
      ],
    );
    const state = raw.map(
      ({ owner_id, worker_id, provider_id, audience_key, audience }) => ({
        owner_id,
        worker_id,
        provider_id,
        audience_key,
        audience,
      }),
    );
    result.durable.push({ label, state: h.fixture.normalize(state) });
    return raw;
  }
  await durable("initial audience upserts");
  await sql(
    `INSERT INTO workers SELECT populated.* FROM workers original CROSS JOIN LATERAL jsonb_populate_record(NULL::workers,to_jsonb(original)||jsonb_build_object('id',${literal(other)})) populated WHERE original.id=${literal(worker)}`,
  );
  assert.deepEqual(
    await h.visit(
      "owned offline worker audience context",
      "GET",
      route({ ...context, workerId: other }),
    ),
    [],
  );
  await update("audience accepts owned independently selected worker", {
    ...context,
    workerId: other,
    audienceKey: key(61),
    audience: "chat",
  });
  await sql(`UPDATE workers SET unlinked_at=now() WHERE id=${literal(other)}`);
  await h.visit(
    "unlinked audience worker",
    "GET",
    route({ ...context, workerId: other }),
    { status: 404 },
  );
  await update(
    "unlinked worker audience update",
    { ...context, workerId: other, audienceKey: key(61) },
    404,
  );
  await sql(`UPDATE workers SET unlinked_at=NULL WHERE id=${literal(other)}`);
  const before = await durable("before audience SQL failure");
  await sql(
    "CREATE FUNCTION fixture_skill_audience_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled skill audience persistence failure'; END $$",
    "CREATE TRIGGER fixture_skill_audience_failure BEFORE INSERT OR UPDATE ON skill_audiences FOR EACH ROW EXECUTE FUNCTION fixture_skill_audience_failure()",
  );
  await update(
    "audience SQL failure is rolled back",
    { ...context, audienceKey: key(61), audience: "ide" },
    500,
  );
  assert.deepEqual(await durable("after audience SQL failure"), before);
  await sql(
    "DROP TRIGGER fixture_skill_audience_failure ON skill_audiences",
    "DROP FUNCTION fixture_skill_audience_failure()",
  );
  await update("audience SQL failure retry", {
    ...context,
    audienceKey: key(61),
    audience: "chat",
  });
  result.recovery.push({
    case: "audience-sql-rollback-and-retry",
    verified: true,
  });

  // Exercise the actual public list boundary without exploding the recursive
  // contract fuzzer's nested-vector count. Keep this separate owned context.
  const bulk = Array.from({ length: 5000 }, (_, n) => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(n);
    return { key: bytes.toString("base64url") };
  });
  await sql(
    `DELETE FROM skill_audiences WHERE owner_id=${literal(h.owner)} AND worker_id=${literal(other)} AND provider_id=${literal(provider)}`,
    `INSERT INTO skill_audiences(owner_id,worker_id,provider_id,audience_key,audience) SELECT ${literal(h.owner)},${literal(other)},${literal(provider)},value->>'key','ide' FROM jsonb_array_elements(${json(bulk)}) value`,
  );
  const maximum = await h.visit(
    "audience maximum5000",
    "GET",
    route({ ...context, workerId: other }),
  );
  assert.equal(maximum.length, 5000);
  await sql(
    `INSERT INTO skill_audiences(owner_id,worker_id,provider_id,audience_key,audience) VALUES(${literal(h.owner)},${literal(other)},${literal(provider)},${literal(key(99))},'ide')`,
  );
  await h.visit(
    "audience list above5000 retains internal failure",
    "GET",
    route({ ...context, workerId: other }),
    { status: 500 },
  );
  await sql(
    `DELETE FROM skill_audiences WHERE owner_id=${literal(h.owner)} AND worker_id=${literal(other)} AND provider_id=${literal(provider)}`,
  );
  result.recovery.push({
    case: "audience-public-list-boundary",
    maximum: 5000,
    overflowStatus: 500,
  });
  return { context, route, update, durable, otherWorker: other };
}
