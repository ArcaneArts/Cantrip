// Protected worker-scoped catalog operations through the production Rust server
// and worker. The gh boundary is an owned native shell fixture, never GitHub.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function verifyGithubCatalog({
  operation,
  fixture,
  workerId,
  workerDirectory,
  restartWorker,
}) {
  let commands = 0;
  async function query(type, arguments_ = {}, ok = true) {
    const result = await operation(
      "github-catalog",
      { type, arguments: arguments_ },
      `/api/workers/${workerId}/repository-operation`,
      {
        scopeId: "github-catalog",
        access: type === "github.repositories.create" ? "write" : "read",
        agent: false,
      },
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.outcome.ok, ok, JSON.stringify(result));
    const wire = JSON.stringify(result.body);
    assert.equal(
      wire.includes("ArcaneArts"),
      false,
      "catalog is ciphertext at the server boundary",
    );
    assert.equal(
      wire.includes("fixture-user"),
      false,
      "login is ciphertext at the server boundary",
    );
    commands++;
    return result.outcome;
  }
  assert.deepEqual((await query("github.auth.status")).result, {
    authenticated: true,
    login: "fixture-user",
    source: "gh-cli",
  });
  assert.deepEqual(
    (await query("github.repositories.cached", { login: "fixture-user" }))
      .result,
    [],
  );
  const listed = (await query("github.repositories.list")).result;
  assert.equal(listed[0].nameWithOwner, "ArcaneArts/cantrip-labs");
  assert.equal(listed[0].id, "123");
  assert.equal("imported" in listed[0], false);
  assert.deepEqual((await query("github.repository-owners.list")).result, [
    { login: "fixture-user", kind: "user" },
    { login: "ArcaneArts", kind: "organization" },
  ]);
  await fixture.calls();
  const request = {
    owner: "ArcaneArts",
    name: "cantrip-labs",
    description: "  owned fixture 😀  ",
    visibility: "private",
  };
  assert.deepEqual(
    (await query("github.repositories.create", { request })).result,
    listed[0],
  );
  assert.deepEqual(await fixture.calls(), [
    ["api", "repos/ArcaneArts/cantrip-labs"],
    [
      "repo",
      "create",
      "ArcaneArts/cantrip-labs",
      "--private",
      "--add-readme",
      "--description",
      "owned fixture 😀",
    ],
  ]);
  const cache = path.join(workerDirectory, "github", "repositories.json");
  const saved = await readFile(cache, "utf8");
  await restartWorker();
  await fixture.calls();
  assert.deepEqual(
    (await query("github.repositories.cached", { login: "fixture-user" }))
      .result,
    listed,
  );
  assert.deepEqual(
    (await query("github.repositories.cached", { login: "different-user" }))
      .result,
    [],
  );
  assert.deepEqual(
    await fixture.calls(),
    [],
    "cache reopening requires no GitHub process",
  );
  assert.equal(await readFile(cache, "utf8"), saved);
  await fixture.response("repositories", "", {
    raw: true,
    status: 7,
    stderr: "owned offline failure\n",
  });
  assert.match(
    (await query("github.repositories.list", {}, false)).error,
    /owned offline failure/,
  );
  assert.equal(
    await readFile(cache, "utf8"),
    saved,
    "failed refresh preserves durable catalog",
  );
  await fixture.response("auth", "", { raw: true, status: 1 });
  assert.deepEqual((await query("github.auth.status")).result, {
    authenticated: false,
    login: null,
    source: "none",
  });
  assert.match(
    (await query("github.repository-owners.list", {}, false)).error,
    /GitHub is not authenticated/,
  );
  assert.deepEqual(
    (await query("github.repositories.cached", { login: "fixture-user" }))
      .result,
    listed,
  );
  return {
    encryptedCatalogCommands: commands,
    checkoutIndependent: true,
    createArgvAndMetadata: true,
    cacheSurvivesRestart: true,
    offlineCachePreserved: true,
  };
}
