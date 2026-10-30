import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
export async function prepareRunDefinition({
  page,
  projectId,
  document,
  definitionPath,
  secret,
  result,
}) {
  const call = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        const api = await import("/src/lib/run-configuration-api.ts");
        return api[operation](...args);
      },
      { operation, args },
    );
  const captured = [];
  const capture = (request) => {
    if (
      request.method() === "PUT" &&
      request.url().includes("/run-configuration-secrets")
    )
      captured.push(request.postData());
  };
  page.on("request", capture);
  let storedSecret;
  try {
    storedSecret = await call("setRunConfigurationSecret", [
      projectId,
      "run/acceptance",
      secret,
    ]);
  } finally {
    page.off("request", capture);
  }
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0].includes(secret),
    false,
    "plaintext secret never appears in the browser-to-server request",
  );
  assert.ok(JSON.parse(captured[0]).protectedValue.envelope);
  assert.equal(storedSecret.secret.available, true);
  const summaries = await call("listRunConfigurationSecrets", [projectId]);
  assert.deepEqual(
    summaries.find((row) => row.reference === "run/acceptance"),
    storedSecret.secret,
  );
  const capabilities = await call("getRunConfigurationCapabilities", [
    projectId,
  ]);
  assert.equal(
    capabilities.find((row) => row.provider === "shell").available,
    true,
  );
  const detection = await call("detectRunConfigurations", [projectId, "shell"]);
  assert.ok(Array.isArray(detection.candidates));
  const paths = await call("discoverRunConfigurationPaths", [
    projectId,
    "file",
    "retained",
  ]);
  assert.ok(paths.suggestions.some((row) => row.path === "retained.txt"));
  result.steps.push(
    "existing browser discovers real worker capabilities and repository paths without sending the plaintext secret to the server",
  );
  const created = await call("saveRunConfiguration", [
    projectId,
    { expectedRevision: null, document },
  ]);
  assert.equal(created.outcome, "created");
  assert.deepEqual(
    JSON.parse(await readFile(definitionPath, "utf8")),
    created.entry.document,
  );
  const revised = {
    ...created.entry.document,
    name: document.name + " updated",
  };
  const updated = await call("saveRunConfiguration", [
    projectId,
    { expectedRevision: created.entry.revision, document: revised },
  ]);
  assert.equal(updated.outcome, "updated");
  assert.notEqual(updated.entry.revision, created.entry.revision);
  const stale = await call("saveRunConfiguration", [
    projectId,
    {
      expectedRevision: created.entry.revision,
      document: created.entry.document,
    },
  ]);
  assert.equal(stale.outcome, "revision-mismatch");
  assert.deepEqual(JSON.parse(await readFile(definitionPath, "utf8")), revised);
  const read = await call("getRunConfiguration", [projectId, document.id]);
  assert.equal(read.found, true);
  assert.equal(read.entry.revision, updated.entry.revision);
  const inventory = await call("listRunConfigurations", [projectId]);
  assert.ok(inventory.entries.some((entry) => entry.id === document.id));
  const validation = await call("validateRunConfiguration", [
    projectId,
    revised,
  ]);
  assert.equal(validation.valid, true);
  result.steps.push(
    "existing browser API persists encrypted Run secret and creates/updates/reads a real worker definition; stale revision preserves file contents",
  );
  return {
    revision: updated.entry.revision,
    staleRevision: created.entry.revision,
  };
}
