import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationNodeDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

export async function verifyNodeRunProvider({
  call,
  projectId,
  checkout,
  save,
  launchAndWait,
  readTail,
}) {
  const packageDirectory = path.join(checkout, "packages", "api");
  const hidden = path.join(checkout, "node_modules", "hidden");
  await mkdir(packageDirectory, { recursive: true });
  await mkdir(hidden, { recursive: true });
  await writeFile(
    path.join(checkout, "pnpm-lock.yaml"),
    "lockfileVersion: '9'\n",
  );
  await writeFile(
    path.join(checkout, "package.json"),
    JSON.stringify({
      name: "workspace-fixture",
      packageManager: "npm@11.0.0",
      main: "./index.js",
      scripts: {
        start: "node index.js package",
        build: "node index.js build",
        dev: "node index.js dev",
      },
    }),
  );
  await writeFile(
    path.join(checkout, "index.js"),
    "console.log('node-argv=' + JSON.stringify(process.argv.slice(2)));\n",
  );
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: "@fixture/api",
      scripts: { start: "node index.js" },
    }),
  );
  await writeFile(
    path.join(packageDirectory, "index.js"),
    "console.log('api');\n",
  );
  await writeFile(
    path.join(hidden, "package.json"),
    JSON.stringify({
      name: "hidden-fixture",
      scripts: { start: "never" },
    }),
  );
  await symlink(packageDirectory, path.join(checkout, "linked-api"));

  const prefix = `/api/projects/${projectId}/run-configurations`;
  const { RunConfigurationDefinitionService } =
    await import("../../tests/reference-node-worker/src/run-configuration-definition-service.ts");
  // The worker baseline in this fixture contains native utilities only. The
  // execution cases below add Node and npm through a project environment file.
  const oracle = new RunConfigurationDefinitionService({
    emit: () => {},
    environment: { SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
  });
  const expected = (action, operationId, fields = {}) =>
    oracle.execute({
      type: `project.run-configuration-definitions.${action}`,
      sourcePath: checkout,
      projectId,
      operationId,
      ...fields,
    });
  const runDefinition = (fields) =>
    runConfigurationNodeDocumentSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name: "External Node fixture",
      provider: "node",
      target: { kind: "packageScript", script: "start" },
      environment: { includeCodexEnvironment: false, files: [".env.node-run"] },
      ...fields,
    });
  const npm = runDefinition({
    name: "External npm provider",
    arguments: ["--tag", "two words"],
    beforeLaunch: [
      { kind: "providerTask", task: "build" },
      { kind: "command", command: "printf 'command-step\\n'" },
    ],
  });
  const node = runDefinition({
    name: "External Node entry",
    target: { kind: "entry", path: "index.js" },
    options: { runtime: "bun" },
    arguments: ["plain"],
    platformOverrides: {
      [process.platform]: {
        options: {
          runtime: "node",
          runtimeArguments: ["--enable-source-maps"],
        },
        arguments: ["override value"],
      },
    },
  });
  const shellOverride = runDefinition({
    name: "Custom override",
    commandOverride: "printf 'override=%s\\n'",
    arguments: ["two words"],
    environment: { includeCodexEnvironment: false },
    target: { kind: "entry", path: "missing.js" },
  });
  const get = async (action, query, operationId = randomUUID()) => {
    const params = new URLSearchParams({ ...query, operationId });
    const route = action === "list" ? prefix : `${prefix}/${action}`;
    const response = await call("GET", `${route}?${params}`);
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.body;
  };
  try {
    const capabilityId = randomUUID();
    const capabilities = await get("capabilities", {}, capabilityId);
    const reference = await expected("capabilities", capabilityId);
    assert.deepEqual(capabilities, {
      ...reference,
      capabilities: reference.capabilities.filter(({ provider }) =>
        ["shell", "node", "java", "dart", "flutter", "rust"].includes(provider),
      ),
    });

    const detectId = randomUUID();
    const discovered = await get("detect", { provider: "node" }, detectId);
    const baseline = await expected("detect", detectId, {
      providerKind: "node",
    });
    const contents = ({ candidates, ...rest }) => ({
      ...rest,
      candidates: candidates.map(({ document, ...candidate }) => ({
        ...candidate,
        document: { ...document, id: null },
      })),
    });
    assert.deepEqual(contents(discovered), contents(baseline));
    assert.ok(
      discovered.candidates.some(
        ({ document }) =>
          document.workingDirectory === "packages/api" &&
          document.options.packageManager === "pnpm",
      ),
    );
    assert.ok(!JSON.stringify(discovered).includes("hidden-fixture"));
    assert.ok(!JSON.stringify(discovered).includes("linked-api"));

    for (const document of [
      npm,
      node,
      shellOverride,
      runDefinition({
        target: { kind: "packageScript", script: "missing-script" },
        beforeLaunch: [{ kind: "providerTask", task: "missing-task" }],
      }),
    ]) {
      const operationId = randomUUID();
      const result = await call("POST", `${prefix}/validate`, {
        operationId,
        document,
      });
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.deepEqual(
        result.body,
        await expected("validate", operationId, { document }),
      );
    }
    await save(npm);
    await save(node);
    await save(shellOverride);
    const listId = randomUUID();
    const inventory = await get("list", {}, listId);
    assert.deepEqual(inventory, await expected("list", listId));
  } finally {
    oracle.close();
  }

  const tools = path.dirname(process.execPath);
  await writeFile(
    path.join(checkout, ".env.node-run"),
    `PATH='${tools}:/usr/bin:/bin'\nNPM_CONFIG_CACHE='${path.join(checkout, "node_modules", ".npm-fixture-cache")}'\n`,
  );
  const started = await launchAndWait(npm.id, "exited");
  assert.equal(started.exitCode, 0, JSON.stringify(started));
  const packageOutput = (await readTail(started)).data;
  assert.match(
    packageOutput,
    /node-argv=\["build"\][\s\S]*command-step[\s\S]*node-argv=\["package","--tag","two words"\]/u,
  );

  const entry = await launchAndWait(node.id, "exited");
  assert.equal(entry.exitCode, 0, JSON.stringify(entry));
  assert.match((await readTail(entry)).data, /node-argv=\["override value"\]/u);

  const overridden = await launchAndWait(shellOverride.id, "exited");
  assert.equal(overridden.exitCode, 0, JSON.stringify(overridden));
  assert.match((await readTail(overridden)).data, /override=two words/u);

  const missingTool = runDefinition({
    name: "Node unavailable in launch environment",
    target: { kind: "entry", path: "index.js" },
    environment: { includeCodexEnvironment: false },
  });
  await save(missingTool);
  const failed = await launchAndWait(missingTool.id, "failed");
  assert.equal(failed.failure.phase, "spawn", JSON.stringify(failed));
}
