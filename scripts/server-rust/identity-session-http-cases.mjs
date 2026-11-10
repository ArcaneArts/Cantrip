// Verify the changed repository seams through their real public callers.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mobileSignInGrantCreateResultSchema } from "../../packages/protocol/dist/index.js";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function identitySessionHttpCases(h, result, sql) {
  const sessions = await sql(
    [],
    [
      `SELECT coalesce(jsonb_agg(entry),'[]'::jsonb)::text result FROM (SELECT jsonb_build_object('id',id,'hash',csrf_token_hash,'seen',floor(extract(epoch from last_seen_at)*1000),'updated',floor(extract(epoch from updated_at)*1000)) entry FROM user_sessions WHERE user_id=${literal(h.owner)} AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) sessions`,
    ],
  );
  const session = sessions[0][0];
  result.sessionProofs = [];
  if (!session) {
    await h.visit(
      "anonymous mobile sign-in remains unavailable",
      "POST",
      "/api/auth/mobile-sign-in/grants",
      { json: {}, status: 404 },
    );
    return;
  }
  const expectedCsrf = h.fixture.client().csrf;
  const before = (
    await sql(
      [
        `UPDATE user_sessions SET csrf_token_hash='retained-old-hash' WHERE id=${literal(session.id)}`,
      ],
      [
        `SELECT jsonb_build_object('hash',csrf_token_hash,'seen',floor(extract(epoch from last_seen_at)*1000),'updated',floor(extract(epoch from updated_at)*1000))::text result FROM user_sessions WHERE id=${literal(session.id)}`,
      ],
    )
  )[0];
  assert.equal(before.hash, "retained-old-hash");
  const start = Date.now();
  const resolved = await h.visit(
    "repair retained session CSRF through GET",
    "GET",
    "/api/auth/session",
  );
  const end = Date.now();
  assert.equal(resolved.csrfToken, expectedCsrf);
  const after = (
    await sql(
      [],
      [
        `SELECT jsonb_build_object('hash',csrf_token_hash,'seen',floor(extract(epoch from last_seen_at)*1000),'updated',floor(extract(epoch from updated_at)*1000))::text result FROM user_sessions WHERE id=${literal(session.id)}`,
      ],
    )
  )[0];
  assert.equal(after.hash, hash(expectedCsrf));
  for (const field of ["seen", "updated"])
    assert.ok(after[field] >= start && after[field] <= end);
  result.sessionProofs.push({
    name: "real CSRF repair",
    before,
    after,
    start,
    end,
  });

  const old = new Date(Date.now() - 25 * 3600000).toISOString(),
    recent = new Date(Date.now() - 23 * 3600000).toISOString();
  await sql([
    ...[
      ["cleanup-old", old],
      ["cleanup-recent", recent],
    ].map(
      ([id, expires]) =>
        `INSERT INTO mobile_sign_in_grants(id,owner_id,created_by_session_id,code_hash,expires_at) VALUES(${literal(id)},${literal(h.owner)},${literal(session.id)},${literal(hash(id))},${literal(expires)})`,
    ),
  ]);
  const grantStart = Date.now();
  const grant = mobileSignInGrantCreateResultSchema.parse(
    await h.visit(
      "public mobile grant applies retention cutoff",
      "POST",
      "/api/auth/mobile-sign-in/grants",
      { json: {}, status: 201 },
    ),
  );
  const grantEnd = Date.now();
  assert.ok(
    Date.parse(grant.expiresAt) >= grantStart + 120000 &&
      Date.parse(grant.expiresAt) <= grantEnd + 120000,
  );
  const read = async () =>
    (
      await sql(
        [],
        [
          "SELECT coalesce(jsonb_agg(id ORDER BY id),'[]')::text result FROM mobile_sign_in_grants WHERE id IN ('cleanup-old','cleanup-recent')",
        ],
      )
    )[0];
  await eventually(read, (ids) => assert.deepEqual(ids, ["cleanup-recent"]));
  const retained = (
    await sql(
      [],
      [
        `SELECT jsonb_build_object('owner',owner_id,'session',created_by_session_id,'expires',expires_at)::text result FROM mobile_sign_in_grants WHERE code_hash=${literal(hash(grant.code))}`,
      ],
    )
  )[0];
  assert.equal(retained.owner, h.owner);
  assert.equal(retained.session, session.id);
  assert.equal(Date.parse(retained.expires), Date.parse(grant.expiresAt));
  result.sessionProofs.push({
    name: "actual mobile grant and prune",
    old,
    recent,
    retained,
    grantStart,
    grantEnd,
    codeHash: hash(grant.code),
    remaining: await read(),
  });
  const observation = result.observations.at(-1);
  observation.body.code = "<schema-valid code with verified durable hash>";
  observation.body.expiresAt = "<verified two-minute expiry>";
}
