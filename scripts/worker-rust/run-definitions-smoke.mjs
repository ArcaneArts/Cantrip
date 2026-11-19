import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function verifyRunDefinitions({
  call,
  projectId,
  checkout,
  restartWorker,
}) {
  const { RunConfigurationDefinitionService } =
    await import("../../cantrip_worker/src/run-configuration-definition-service.ts");
  const oracle = await mkdtemp(
    path.join(path.dirname(path.dirname(checkout)), "node-reference-"),
  );
  const service = new RunConfigurationDefinitionService({ emit: () => {} });
  try {
    const definitionId = "88888888-8888-4888-8888-000000000191";
    const otherId = "88888888-8888-4888-8888-000000000192";
    const unsupportedId = "88888888-8888-4888-8888-000000000193";
    const symlinkId = "88888888-8888-4888-8888-000000000194";
    const document = {
      schema: "cantrip.run-configuration",
      version: 1,
      id: definitionId,
      name: "Dévelop 🧪",
      provider: "shell",
      target: { kind: "script", path: "scripts/dev.sh" },
    };
    const definitionFile = (root, id) =>
      path.join(root, ".cantrip", "run-configurations", id + ".json");
    const configPath = (id) =>
      `/api/projects/${projectId}/run-configurations/${id}`;
    const environment = "[setup]\nscript = 'echo fixture-only'\n";
    for (const root of [oracle, checkout]) {
      await mkdir(path.join(root, ".codex", "environments"), {
        recursive: true,
      });
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, "node_modules", "hidden"), {
        recursive: true,
      });
      await writeFile(path.join(root, ".env"), "FIXTURE=true\n");
      await writeFile(path.join(root, "scripts", "dev.sh"), "#!/bin/sh\n");
      await writeFile(path.join(root, "scripts", "launch"), "#!/bin/sh\n");
      await chmod(path.join(root, "scripts", "launch"), 0o755);
      await writeFile(path.join(root, "node_modules", "hidden", "bad.sh"), "");
      await writeFile(
        path.join(root, ".codex", "environments", "environment.toml"),
        environment,
      );
      for (let index = 0; index < 106; index += 1)
        await mkdir(
          path.join(root, `fixture-${String(index).padStart(3, "0")}`),
        );
    }
    await symlink(oracle, path.join(checkout, "linked-outside"));
    await symlink(checkout, path.join(oracle, "linked-outside"));

    const compare = async (
      method,
      route,
      action,
      properties,
      status,
      body,
      nodeRoot = oracle,
    ) => {
      const operationId = randomUUID();
      const url =
        method === "GET"
          ? `${route}${route.includes("?") ? "&" : "?"}operationId=${operationId}`
          : route;
      const response = await call(
        method,
        url,
        body === undefined ? undefined : { ...body, operationId },
      );
      assert.equal(response.status, status, JSON.stringify(response.body));
      assert.deepEqual(
        response.body,
        await service.execute({
          type: "project.run-configuration-definitions." + action,
          operationId,
          projectId,
          sourcePath: nodeRoot,
          ...properties,
        }),
      );
      return response.body;
    };
    for (const [purpose, query] of [
      ["directory", ""],
      ["directory", "fixture-"],
      ["shell-script", "scripts\\"],
      ["environment-file", "env"],
      ["file", "hidden"],
    ]) {
      const route =
        configPath("paths") + "?" + new URLSearchParams({ purpose, query });
      await compare("GET", route, "paths", { purpose, query }, 200);
    }

    const get = (id, root) =>
      compare(
        "GET",
        configPath(id),
        "get",
        { configurationId: id },
        200,
        undefined,
        root,
      );
    const save = (document, expectedRevision, status) => {
      const request = { document, expectedRevision };
      return compare(
        "PUT",
        configPath(document.id),
        "write",
        { request },
        status,
        request,
      );
    };

    assert.equal((await get(definitionId)).result.found, false);
    const created = await save(document, null, 201);
    const revision = created.result.entry.revision;
    assert.equal(created.result.outcome, "created");
    assert.deepEqual(
      await readFile(definitionFile(checkout, definitionId)),
      await readFile(definitionFile(oracle, definitionId)),
    );
    assert.equal(
      (await save(document, null, 409)).result.outcome,
      "already-exists",
    );
    assert.equal(
      (await save(document, revision, 200)).result.outcome,
      "unchanged",
    );
    assert.equal(
      (
        await save(
          { ...document, id: otherId, name: document.name.toUpperCase() },
          null,
          409,
        )
      ).result.outcome,
      "name-conflict",
    );
    assert.equal((await get(definitionId)).codexEnvironment.hasSetup, true);

    for (const root of [oracle, checkout]) {
      await writeFile(
        definitionFile(root, unsupportedId),
        JSON.stringify({
          ...document,
          id: unsupportedId,
          provider: "external-demo",
        }),
      );
      await symlink(
        definitionFile(root, definitionId),
        definitionFile(root, symlinkId),
      );
      await writeFile(
        path.join(root, ".codex", "environments", "environment.toml"),
        "[setup]\nscript = 42\n",
      );
    }
    const unsupported = await get(unsupportedId);
    assert.equal(unsupported.result.entry.status, "unsupported");
    assert.equal(
      unsupported.result.entry.diagnostics[0].code,
      "provider-unavailable",
    );
    assert.equal(
      unsupported.codexEnvironment.diagnostics[0].field,
      "setup.script",
    );
    const symlinkResult = await call(
      "GET",
      configPath(symlinkId) + "?operationId=" + randomUUID(),
    );
    assert.equal(symlinkResult.status, 200, JSON.stringify(symlinkResult.body));
    assert.equal(symlinkResult.body.result.entry.status, "invalid");
    assert.equal(symlinkResult.body.result.entry.revision, null);

    const changed = { ...document, name: "Dévelop updated" };
    const updated = await save(changed, revision, 200);
    const updatedRevision = updated.result.entry.revision;
    assert.equal(updated.result.outcome, "updated");
    assert.equal(
      (await save(document, revision, 409)).result.outcome,
      "revision-mismatch",
    );

    // A reference-written file remains readable with the exact revision across
    // a worker restart, including unknown-provider files and UTF-8 formatting.
    await writeFile(
      definitionFile(checkout, definitionId),
      await readFile(definitionFile(oracle, definitionId)),
    );
    await restartWorker();
    assert.equal(
      (await get(definitionId)).result.entry.revision,
      updatedRevision,
    );
    const deleteDefinition = (expectedRevision, status) =>
      compare(
        "DELETE",
        configPath(definitionId),
        "delete",
        {
          request: { id: definitionId, expectedRevision },
        },
        status,
        { expectedRevision },
      );
    assert.equal(
      (await deleteDefinition(revision, 409)).result.outcome,
      "revision-mismatch",
    );
    assert.equal(
      (await deleteDefinition(updatedRevision, 200)).result.outcome,
      "deleted",
    );
    assert.equal(
      (await deleteDefinition(updatedRevision, 404)).result.outcome,
      "not-found",
    );
    assert.equal((await get(definitionId)).result.found, false);
  } finally {
    service.close();
    await rm(oracle, { recursive: true, force: true });
  }
}
