// Representative post-write database rollback through actual service APIs.
// Full profile/file/key activation and product-wide rollback remain separate.
import assert from "node:assert/strict";
import { HttpFixture } from "./http-fixture.mjs";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { fixtureEnvironment } from "./process.mjs";
import {
  initialization,
  projectLabel,
  password,
} from "./security-fixtures.mjs";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
const workspaceId = "77777777-7777-4777-8777-000000000091";
const passwordHash = hashPassword(password);

async function visit(fixture, label, method, route, options = {}) {
  await fixture.observe(label, method, route, {
    csrf: method !== "GET",
    ...options,
  });
  return fixture.records.get(label);
}
export async function nativeExportHttpWrites({
  executable,
  environment,
  data,
  mode,
  root,
}) {
  const auth = {
    CANTRIP_AUTH_MODE: "password",
    CANTRIP_PASSWORD_HASH: await passwordHash,
  };
  const fixture = new HttpFixture({
    kind: "rust",
    executable,
    root,
    name: "native-export-http-" + mode,
    databaseMode: mode,
    environment: { ...environment, ...auth, CANTRIP_DATA_DIR: data },
  });
  const result = { workspaceId, operations: [] };
  try {
    await fixture.start();
    result.session = await visit(
      fixture,
      "source login",
      "POST",
      "/api/auth/login",
      { csrf: false, json: { password } },
    );
    assert.ok(result.session.currentUser);
    assert.ok(fixture.client().cookies.size > 0);
    assert.equal(typeof result.session.csrfToken, "string");
    result.bootstrap = await visit(
      fixture,
      "source bootstrap",
      "GET",
      "/api/bootstrap",
    );
    assert.equal(result.bootstrap.auth.state, "authenticated");
    await visit(
      fixture,
      "initialize encryption",
      "POST",
      "/api/encryption/profile/initialize",
      { status: 201, json: initialization() },
    );
    const nameProtection =
      discoveryWireFixtures(projectLabel)
        .encryptedProjectWorkspaceCreateSchema[0].nameProtection;
    const created = await visit(
      fixture,
      "create workspace",
      "POST",
      "/api/workspaces",
      {
        status: 201,
        json: { id: workspaceId, nameProtection, storage: { kind: "managed" } },
      },
    );
    assert.equal(created.id, workspaceId);
    assert.equal(created.revision, 1);
    result.workspace = await visit(
      fixture,
      "promote workspace",
      "PATCH",
      "/api/workspaces/" + workspaceId,
      { json: { expectedRevision: 1, isDefault: true } },
    );
    assert.equal(result.workspace.revision, 2);
    assert.equal(result.workspace.isDefault, true);
    assert.deepEqual(result.workspace.nameProtection, nameProtection);
    result.operations.push(
      "initialize account encryption",
      "create encrypted workspace",
      "promote workspace with revision fence",
    );
  } finally {
    await fixture.close();
  }
  return { fixture, result, auth };
}
export async function verifyNodeAfterNativeExport({
  source,
  reverseRoot,
  executable,
  root,
  mode,
}) {
  const fixture = new HttpFixture({
    kind: "node",
    executable,
    root,
    name: "node-after-export-" + mode,
    databaseMode: "pglite",
    environment: { ...fixtureEnvironment(reverseRoot), ...source.auth },
  });
  // Reuse the actual Rust-issued cookie and CSRF token, not a fresh login.
  fixture.clients = source.fixture.clients;
  fixture.tokens = source.fixture.tokens;
  try {
    await fixture.start();
    const session = await visit(
      fixture,
      "retained session",
      "GET",
      "/api/auth/session",
    );
    assert.equal(session.currentUser.id, source.result.session.currentUser.id);
    assert.equal(session.csrfToken, source.result.session.csrfToken);
    const bootstrap = await visit(
      fixture,
      "retained server identity",
      "GET",
      "/api/bootstrap",
    );
    assert.equal(bootstrap.server.id, source.result.bootstrap.server.id);
    assert.equal(bootstrap.auth.state, "authenticated");
    const catalog = await visit(
      fixture,
      "retained workspace",
      "GET",
      "/api/workspaces",
    );
    const workspace = catalog.workspaces.find(
      (item) => item.id === source.result.workspaceId,
    );
    assert.deepEqual(
      workspace,
      source.result.workspace,
      "Node observes the complete workspace written through Rust",
    );
    const updated = await visit(
      fixture,
      "Node revision-fenced write",
      "PATCH",
      "/api/workspaces/" + source.result.workspaceId,
      { json: { expectedRevision: 2, isDefault: true } },
    );
    assert.equal(updated.revision, 3);
    assert.deepEqual(updated.nameProtection, workspace.nameProtection);
    return {
      retainedSession: true,
      workspace,
      nodeWriteRevision: updated.revision,
    };
  } finally {
    await fixture.close();
  }
}
