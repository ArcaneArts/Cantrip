import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationDartDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

export async function verifyDartRunProvider({
  call,
  projectId,
  checkout,
  save,
  launchAndWait,
  readTail,
}) {
  const workspace = path.join(checkout, "dart workspace");
  const owned = path.join(workspace, "packages", "cli");
  const mobile = path.join(workspace, "mobile");
  const noPubspec = path.join(workspace, "no-pubspec");
  for (const directory of [
    path.join(workspace, "tool"),
    path.join(owned, "bin"),
    path.join(owned, "tool"),
    path.join(owned, "test"),
    path.join(owned, ".dart_tool"),
    path.join(mobile, "lib"),
    noPubspec,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(path.join(workspace, "pubspec.yaml"), "name: parent_dart\n");
  await writeFile(path.join(workspace, "tool", "one.dart"), "void main() {}\n");
  await writeFile(
    path.join(owned, "pubspec.yaml"),
    '\uFEFFname: "owned_cli" # test fixture\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n',
  );
  await writeFile(
    path.join(owned, "bin", "main.dart"),
    [
      "void main(List<String> args) {",
      "  var asserts = false;",
      "  assert(asserts = true);",
      "  print('dart-asserts=$asserts');",
      "  print(\"dart-args=${args.join('|')}\");",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(owned, "tool", "dev.dart"),
    "@pragma('vm:entry-point') Future<void> main() async {}\n",
  );
  await writeFile(
    path.join(owned, "tool", "not_main.dart"),
    "class Other {\n void main() {}\n}\nfinal text = r'''\nvoid main() {}\n''';",
  );
  await writeFile(path.join(owned, "test", "skip.dart"), "void main() {}\n");
  await writeFile(
    path.join(owned, ".dart_tool", "skip.dart"),
    "void main() {}\n",
  );
  await writeFile(
    path.join(mobile, "pubspec.yaml"),
    "name: mobile_fixture\ndependencies:\n  flutter:\n    sdk: flutter # SDK\n",
  );
  await writeFile(path.join(mobile, "lib", "main.dart"), "void main() {}\n");
  await symlink(owned, path.join(workspace, "linked-cli"));
  await symlink(
    path.join(owned, "tool", "dev.dart"),
    path.join(owned, "bin", "linked.dart"),
  );

  const sdk = process.env.CANTRIP_TEST_DART_SDK;
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
  const definition = (name, fields) =>
    runConfigurationDartDocumentSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name,
      provider: "dart",
      workingDirectory: "dart workspace/packages/cli",
      target: { kind: "entrypoint", path: "bin/main.dart" },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.dart-run"],
      },
      ...fields,
    });
  const override = definition("Dart custom command", {
    commandOverride: "printf 'dart-custom=%s\\n'",
    arguments: ["two words"],
    options: { sdkHome: "ignored/relative-sdk" },
    target: { kind: "entrypoint", path: "ignored.dart" },
    workingDirectory: "dart workspace/no-pubspec",
    environment: { includeCodexEnvironment: false },
  });
  const missingSdk = definition("Missing Dart SDK reported by spawn", {
    options: { sdkHome: path.join(owned, "missing-sdk") },
    environment: { includeCodexEnvironment: false },
  });
  const fromPath = definition("Dart SDK on the Run PATH", {
    arguments: ["path argument"],
  });
  const explicit =
    sdk &&
    definition("Dart SDK selection and platform overrides", {
      options: { sdkHome: "ignored/relative-sdk" },
      beforeLaunch: [{ kind: "command", command: "printf 'dart-before\\n'" }],
      arguments: ["base argument"],
      platformOverrides: {
        [process.platform]: {
          options: { sdkHome: sdk, vmArguments: ["--enable-asserts"] },
          arguments: ["platform value", "é 🙂"],
        },
      },
    });
  try {
    const detectId = randomUUID();
    const detected = await call(
      "GET",
      `${prefix}/detect?operationId=${detectId}&provider=dart`,
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
      providerKind: "dart",
    });
    assert.deepEqual(comparable(detected.body), comparable(reference));
    assert.deepEqual(
      detected.body.candidates.map(({ document }) => document.target.path),
      ["bin/main.dart", "tool/one.dart", "tool/dev.dart"],
    );

    for (const document of [
      override,
      missingSdk,
      fromPath,
      ...(explicit ? [explicit] : []),
      definition("Dart used in a Flutter package", {
        workingDirectory: "dart workspace/mobile",
        target: { kind: "entrypoint", path: "lib/main.dart" },
        beforeLaunch: [{ kind: "providerTask", task: "pub get" }],
        options: { sdkHome: "relative/sdk" },
      }),
      definition("Dart project and entrypoint diagnostics", {
        workingDirectory: "dart workspace/no-pubspec",
        target: { kind: "entrypoint", path: "missing.dart" },
      }),
      definition("Dart symlink diagnostic", {
        target: { kind: "entrypoint", path: "bin/linked.dart" },
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
    for (const document of [override, missingSdk, fromPath])
      await save(document);
    if (explicit) await save(explicit);
    const listId = randomUUID();
    const inventory = await call("GET", `${prefix}?operationId=${listId}`);
    assert.equal(inventory.status, 200, JSON.stringify(inventory));
    assert.deepEqual(inventory.body, await expected("list", listId));
  } finally {
    oracle.close();
  }

  const custom = await launchAndWait(override.id, "exited");
  assert.equal(custom.exitCode, 0, JSON.stringify(custom));
  assert.match((await readTail(custom)).data, /dart-custom=two words/u);
  const failed = await launchAndWait(missingSdk.id, "failed");
  assert.equal(failed.failure.phase, "spawn", JSON.stringify(failed));

  if (explicit) {
    const bin = path.join(sdk, "bin");
    const home = path.join(checkout, ".dart-home");
    const environment = {
      HOME: home,
      PUB_CACHE: path.join(home, "pub-cache"),
      DART_SUPPRESS_ANALYTICS: "1",
      PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    };
    await mkdir(home);
    await writeFile(
      path.join(checkout, ".env.dart-run"),
      Object.entries(environment)
        .map(([name, value]) => `${name}='${value}'\n`)
        .join(""),
    );
    const executable = path.join(
      bin,
      process.platform === "win32" ? "dart.exe" : "dart",
    );
    execFileSync(executable, ["pub", "get", "--offline"], {
      cwd: owned,
      env: { ...process.env, ...environment },
    });

    const selected = await launchAndWait(explicit.id, "exited");
    const output = (await readTail(selected)).data;
    assert.equal(selected.exitCode, 0, output);
    assert.match(
      output,
      /dart-before[\s\S]*dart-asserts=true[\s\S]*dart-args=platform value\|é 🙂/u,
    );

    const onPath = await launchAndWait(fromPath.id, "exited");
    const pathOutput = (await readTail(onPath)).data;
    assert.equal(onPath.exitCode, 0, pathOutput);
    assert.match(pathOutput, /dart-args=path argument/u);
  }
}
