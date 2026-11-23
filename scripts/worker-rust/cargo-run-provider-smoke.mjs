import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationRustDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

export async function verifyCargoRunProvider({
  call,
  projectId,
  checkout,
  save,
  launchAndWait,
  readTail,
}) {
  const project = path.join(checkout, "packages", "cargo-demo");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "runner"), { recursive: true });
  await mkdir(path.join(project, "examples", "demo"), { recursive: true });
  await mkdir(path.join(checkout, "vendor", "hidden", "src"), {
    recursive: true,
  });
  await writeFile(
    path.join(checkout, "Cargo.toml"),
    '[workspace]\nmembers = ["packages/cargo-demo"]\nresolver = "2"\n',
  );
  await writeFile(
    path.join(project, "Cargo.toml"),
    `[package]
name = "cantrip-run-fixture"
version = "0.1.0"
edition = "2021"
autobins = false
default-run = "chosen"
[features]
demo-feature = []
[[bin]]
name = "chosen"
path = "runner/main.rs"
required-features = ["demo-feature"]
`,
  );
  await writeFile(
    path.join(project, "src", "main.rs"),
    'fn main() { println!("disabled-autobin"); }\n',
  );
  await writeFile(
    path.join(project, "runner", "main.rs"),
    'fn main() { println!("cargo-arg={}", std::env::args().nth(1).unwrap()); }\n',
  );
  await writeFile(
    path.join(project, "examples", "demo", "main.rs"),
    'fn main() { println!("cargo-example"); }\n',
  );
  await writeFile(
    path.join(checkout, "vendor", "hidden", "Cargo.toml"),
    '[package]\nname="hidden-cargo-fixture"\nversion="0.1.0"\n',
  );
  await writeFile(
    path.join(checkout, "vendor", "hidden", "src", "main.rs"),
    "fn main() {}\n",
  );
  await symlink(project, path.join(checkout, "linked-cargo-fixture"));

  const prefix = `/api/projects/${projectId}/run-configurations`;
  const { RunConfigurationDefinitionService } =
    await import("../../tests/reference-node-worker/src/run-configuration-definition-service.ts");
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
  const definition = (fields) =>
    runConfigurationRustDocumentSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name: "Owned Cargo fixture",
      provider: "rust",
      target: {
        kind: "binary",
        package: "cantrip-run-fixture",
        name: "chosen",
      },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.cargo-run"],
      },
      ...fields,
    });
  const binary = definition({
    name: "Cargo binary and check",
    options: {
      features: ["demo-feature"],
      useDefaultFeatures: false,
      offline: true,
      locked: true,
    },
    arguments: ["base value"],
    platformOverrides: {
      [process.platform]: { arguments: ["platform value"] },
    },
    beforeLaunch: [
      { kind: "providerTask", task: "check" },
      { kind: "command", command: "printf 'cargo-before-launch\\n'" },
    ],
  });
  const example = definition({
    name: "Cargo example",
    target: { kind: "example", package: "cantrip-run-fixture", name: "demo" },
    options: { offline: true, locked: true },
  });
  const invalid = definition({
    name: "Cargo target reported by actual executable",
    target: { kind: "binary", package: "cantrip-run-fixture", name: "missing" },
    options: { offline: true, locked: true },
  });
  try {
    const detectId = randomUUID();
    const detected = await call(
      "GET",
      `${prefix}/detect?operationId=${detectId}&provider=rust`,
    );
    assert.equal(detected.status, 200, JSON.stringify(detected));
    const comparable = ({ candidates, ...rest }) => ({
      ...rest,
      candidates: candidates.map(({ document, ...candidate }) => ({
        ...candidate,
        document: { ...document, id: null },
      })),
    });
    const reference = await expected("detect", detectId, {
      providerKind: "rust",
    });
    assert.deepEqual(comparable(detected.body), comparable(reference));
    assert.deepEqual(
      detected.body.candidates.map(({ document }) => document.target.name),
      ["chosen", "demo"],
    );
    assert.deepEqual(detected.body.candidates[0].document.options.features, [
      "demo-feature",
    ]);

    for (const document of [
      binary,
      example,
      invalid,
      definition({
        options: { features: [] },
        beforeLaunch: [{ kind: "providerTask", task: "publish" }],
      }),
    ]) {
      const operationId = randomUUID();
      const response = await call("POST", `${prefix}/validate`, {
        operationId,
        document,
      });
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.deepEqual(
        response.body,
        await expected("validate", operationId, { document }),
      );
    }

    for (const document of [binary, example, invalid]) await save(document);
    const listId = randomUUID();
    const inventory = await call("GET", `${prefix}?operationId=${listId}`);
    assert.equal(inventory.status, 200, JSON.stringify(inventory));
    assert.deepEqual(inventory.body, await expected("list", listId));
  } finally {
    oracle.close();
  }

  const cargo = execFileSync("rustup", ["which", "cargo"], {
    encoding: "utf8",
  }).trim();
  const cache = path.join(checkout, ".cargo-cache");
  const environment = {
    PATH: [path.dirname(cargo), "/usr/bin", "/bin"].join(path.delimiter),
    CARGO_HOME: path.join(cache, "home"),
    CARGO_TARGET_DIR: path.join(cache, "target"),
    CARGO_INCREMENTAL: "0",
    CARGO_TERM_COLOR: "never",
  };
  await writeFile(
    path.join(checkout, ".env.cargo-run"),
    Object.entries(environment)
      .map(([name, value]) => `${name}='${value}'\n`)
      .join(""),
  );
  execFileSync(cargo, ["generate-lockfile", "--offline"], {
    cwd: checkout,
    env: { ...process.env, ...environment },
  });

  const ran = await launchAndWait(binary.id, "exited");
  const output = (await readTail(ran)).data;
  assert.equal(ran.exitCode, 0, output);
  assert.match(
    output,
    /Checking cantrip-run-fixture[\s\S]*cargo-before-launch[\s\S]*cargo-arg=platform value/u,
  );

  const sampled = await launchAndWait(example.id, "exited");
  const exampleOutput = (await readTail(sampled)).data;
  assert.equal(sampled.exitCode, 0, exampleOutput);
  assert.match(exampleOutput, /cargo-example/u);

  const rejected = await launchAndWait(invalid.id, "exited");
  const cargoError = (await readTail(rejected)).data;
  assert.notEqual(rejected.exitCode, 0);
  assert.match(cargoError, /no bin target named.*missing/u);
}
