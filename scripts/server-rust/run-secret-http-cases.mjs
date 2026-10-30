import assert from "node:assert/strict";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
export async function runSecretHttpCases({ visit, projectId, profile }) {
  const endpoint = `/api/projects/${projectId}/run-configuration-secrets`;
  const protectedValue =
    fileDocumentWireFixtures().fileDocumentCreateSchema[0].stateProtection
      .protectedState;
  const input = {
    operationId: "77777777-7777-4777-8777-000000000001",
    reference: "run/http-secret",
    protectedValue,
  };
  const began = Date.now();
  await visit(
    "secret invalid body before missing project",
    "PUT",
    "/api/projects/missing/run-configuration-secrets",
    { json: {}, status: 400 },
  );
  await visit(
    "secret missing project write",
    "PUT",
    "/api/projects/missing/run-configuration-secrets",
    { json: input, status: 404 },
  );
  await visit(
    "secret missing project read",
    "GET",
    "/api/projects/missing/run-configuration-secrets",
    { status: 404 },
  );
  if (profile !== "none") {
    await visit("secret unauthenticated read", "GET", endpoint, {
      client: "anonymous",
      status: 401,
    });
    await visit("secret missing CSRF", "PUT", endpoint, {
      json: input,
      csrf: false,
      status: 403,
    });
  }
  if (profile === "accounts") {
    await visit("secret foreign read", "GET", endpoint, {
      client: "other",
      status: 404,
    });
    await visit("secret foreign write", "PUT", endpoint, {
      client: "other",
      json: input,
      status: 404,
    });
  }
  const first = await visit("secret create", "PUT", endpoint, {
    json: input,
    status: 201,
  });
  assert.equal(first.secret.revision, 1);
  assert.equal(first.replayed, false);
  assert.ok(
    Date.parse(first.secret.updatedAt) >= began &&
      Date.parse(first.secret.updatedAt) <= Date.now(),
  );
  const second = await visit("secret update same envelope", "PUT", endpoint, {
    json: { ...input, operationId: "77777777-7777-4777-8777-000000000002" },
    status: 200,
  });
  assert.equal(second.secret.revision, 2);
  const replay = await visit("secret replay old receipt", "PUT", endpoint, {
    json: input,
    status: 200,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.secret, first.secret);
  const conflict = await visit("secret conflicting receipt", "PUT", endpoint, {
    json: { ...input, reference: "run/different" },
    status: 502,
  });
  assert.equal(
    conflict.error,
    "The Run configuration secret operation identity is already in use.",
  );
  const listed = await visit("secret current summaries", "GET", endpoint, {
    status: 200,
  });
  assert.deepEqual(
    listed.secrets.find((row) => row.reference === input.reference),
    second.secret,
  );
  assert.equal(JSON.stringify(listed).includes("protectedValue"), false);
}
