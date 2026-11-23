import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationFlutterDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function verifyFlutterRunProvider({
  call,
  projectId,
  checkout,
  save,
  launchAndWait,
  readTail,
}) {
  const app = path.join(checkout, "flutter workspace", "app");
  const sdk = path.join(checkout, "flutter SDK fixture");
  const limitedSdk = path.join(checkout, "oversized flutter SDK fixture");
  const bin = path.join(sdk, "bin");
  const marker = path.join(checkout, ".flutter-invocations");
  const limitedPid = path.join(checkout, ".flutter-oversized-pid");
  for (const folder of [
    path.join(app, "lib"),
    path.join(app, "config"),
    bin,
    path.join(limitedSdk, "bin"),
  ]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(
    path.join(app, "pubspec.yaml"),
    "name: smoke_app\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\ndependencies:\n  flutter:\n    sdk: flutter\nflutter: # fixture\n  # theme\n  default-flavor: 'staging'\n  generate: true\n",
  );
  for (const source of ["main.dart", "main_staging.dart", "helper.dart"]) {
    await writeFile(path.join(app, "lib", source), "void main() {}\n");
  }
  await writeFile(
    path.join(app, "lib", "main_callee.dart"),
    "class Fixture {\n void main() {}\n}\n",
  );
  await symlink(
    path.join(app, "lib", "main.dart"),
    path.join(app, "lib", "main_linked.dart"),
  );
  await writeFile(path.join(app, "config", "define.json"), '{"FOO":"on"}\n');
  await writeFile(
    path.join(bin, "flutter"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${quote(marker)}`,
      'if [ "$1" = "devices" ] && [ "$2" = "--machine" ]; then',
      '  [ "$CI:$FLUTTER_SUPPRESS_ANALYTICS" = true:true ] || exit 28',
      `  printf '%s' ${quote(
        JSON.stringify([
          { id: "old", name: "Old device", isSupported: false },
          {
            id: "web-server",
            name: "Web Server",
            targetPlatform: "web-javascript",
          },
          {
            id: " chrome ",
            name: "Chrome",
            isSupported: true,
            emulator: false,
          },
        ]),
      )}`,
      "else",
      "  printf 'flutter-arg=<%s>\\n' \"$@\"",
      "fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(limitedSdk, "bin", "flutter"),
    [
      "#!/bin/sh",
      `printf '%s' "$$" > ${quote(limitedPid)}`,
      "/usr/bin/head -c 262145 /dev/zero >&2",
      "exec /bin/sleep 30",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(checkout, ".env.flutter-run"),
    `PATH=${quote([bin, "/usr/bin", "/bin"].join(path.delimiter))}\n`,
  );

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
    runConfigurationFlutterDocumentSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name,
      provider: "flutter",
      workingDirectory: "flutter workspace/app",
      target: { kind: "entrypoint", path: "lib/main.dart" },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.flutter-run"],
      },
      ...fields,
    });
  const typed = definition("Flutter SDK and platform options", {
    arguments: ["base arg"],
    options: {
      sdkHome: "overridden",
      deviceId: "web-server",
      flavor: "staging",
      dartDefineFiles: ["config/define.json"],
    },
    platformOverrides: {
      [process.platform]: {
        arguments: ["two words", "🚦"],
        options: {
          sdkHome: sdk,
          mode: "profile",
          usePub: false,
          dartDefines: [{ name: "CONFIG", value: "two words" }],
        },
      },
    },
    beforeLaunch: [
      { kind: "providerTask", task: "clean" },
      { kind: "command", command: "printf 'flutter-before\\n'" },
      { kind: "providerTask", task: "gen-l10n" },
      { kind: "providerTask", task: "pub get" },
    ],
  });
  const override = definition("Flutter shell override and PATH provider task", {
    commandOverride: "printf 'flutter-override=%s\\n'",
    arguments: ["two words"],
    beforeLaunch: [{ kind: "providerTask", task: "clean" }],
  });
  const comparable = ({ candidates, ...rest }) => ({
    ...rest,
    candidates: candidates.map(({ document, ...candidate }) => ({
      ...candidate,
      document: { ...document, id: null },
    })),
  });
  const inspect = async (document, operationId = randomUUID()) => {
    const result = await call("POST", `${prefix}/flutter-devices`, {
      operationId,
      document,
    });
    assert.equal(result.status, 200, JSON.stringify(result));
    return result.body;
  };
  try {
    const detectId = randomUUID();
    const detected = await call(
      "GET",
      `${prefix}/detect?operationId=${detectId}&provider=flutter`,
    );
    assert.equal(detected.status, 200, JSON.stringify(detected));
    const reference = await expected("detect", detectId, {
      providerKind: "flutter",
    });
    assert.deepEqual(comparable(detected.body), comparable(reference));
    const entries = detected.body.candidates.filter(
      ({ document }) => document.workingDirectory === "flutter workspace/app",
    );
    assert.deepEqual(
      entries.map(({ document }) => [
        document.target.path,
        document.options.flavor,
      ]),
      [
        ["lib/main.dart", "staging"],
        ["lib/main_staging.dart", "staging"],
      ],
    );

    for (const document of [
      typed,
      override,
      definition("Invalid Flutter package and inputs", {
        workingDirectory: ".",
        target: { kind: "entrypoint", path: "missing.dart" },
        options: { sdkHome: "relative", dartDefineFiles: ["missing.json"] },
        beforeLaunch: [{ kind: "providerTask", task: "build" }],
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

    for (const document of [typed, override]) await save(document);
    const listId = randomUUID();
    const inventory = await call("GET", `${prefix}?operationId=${listId}`);
    assert.equal(inventory.status, 200, JSON.stringify(inventory));
    assert.deepEqual(inventory.body, await expected("list", listId));
    await assert.rejects(readFile(marker), { code: "ENOENT" });

    const inspectId = randomUUID();
    const devices = await inspect(typed, inspectId);
    assert.equal(await readFile(marker, "utf8"), "devices --machine\n");
    assert.deepEqual(
      devices,
      await expected("flutter-devices", inspectId, { document: typed }),
    );
    assert.deepEqual(
      devices.devices.map(({ id, supported }) => [id, supported]),
      [
        ["chrome", true],
        ["web-server", true],
        ["old", false],
      ],
    );
    const bounded = await inspect(
      definition("Flutter output limit", {
        options: { sdkHome: limitedSdk },
      }),
    );
    assert.deepEqual(bounded.devices, []);
    assert.equal(
      bounded.diagnostics[0].code,
      "flutter-device-inspection-failed",
    );
    const pid = Number(await readFile(limitedPid, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    oracle.close();
  }

  const ran = await launchAndWait(typed.id, "exited");
  assert.equal(ran.exitCode, 0, JSON.stringify(ran));
  const output = (await readTail(ran)).data.replaceAll("\r", "");
  const args = output.trim().split("\n");
  assert.deepEqual(args, [
    "flutter-arg=<clean>",
    "flutter-before",
    "flutter-arg=<gen-l10n>",
    "flutter-arg=<pub>",
    "flutter-arg=<get>",
    "flutter-arg=<run>",
    "flutter-arg=<--profile>",
    "flutter-arg=<--target=lib/main.dart>",
    "flutter-arg=<--device-id=web-server>",
    "flutter-arg=<--flavor=staging>",
    "flutter-arg=<--dart-define=CONFIG=two words>",
    "flutter-arg=<--dart-define-from-file=config/define.json>",
    "flutter-arg=<--no-pub>",
    "flutter-arg=<--dart-entrypoint-args=two words>",
    "flutter-arg=<--dart-entrypoint-args=🚦>",
  ]);
  const overridden = await launchAndWait(override.id, "exited");
  assert.equal(overridden.exitCode, 0, JSON.stringify(overridden));
  assert.match(
    (await readTail(overridden)).data,
    /flutter-arg=<clean>[\s\S]*flutter-override=two words/u,
  );

  const calls = (await readFile(marker, "utf8")).split("\n");
  assert.equal(calls.filter((line) => line === "devices --machine").length, 2);

  const realSdk = process.env.CANTRIP_TEST_FLUTTER_SDK;
  if (realSdk) {
    const translations = path.join(app, "lib", "l10n");
    const home = path.join(checkout, ".flutter-fixture-home");
    await mkdir(translations);
    await mkdir(home);
    await writeFile(
      path.join(translations, "app_en.arb"),
      '{"hello":"Hello from the Flutter fixture"}\n',
    );
    await writeFile(
      path.join(checkout, ".env.flutter-real"),
      Object.entries({
        PATH: "/usr/bin:/bin",
        HOME: home,
        PUB_CACHE: path.join(home, "pub-cache"),
        CI: "true",
        FLUTTER_SUPPRESS_ANALYTICS: "true",
      })
        .map(([name, value]) => `${name}=${quote(value)}\n`)
        .join(""),
    );
    const generate = definition("Real Flutter localization tool", {
      commandOverride: "printf 'flutter-generated\\n'",
      options: { sdkHome: realSdk },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.flutter-real"],
      },
      beforeLaunch: [{ kind: "providerTask", task: "gen-l10n" }],
    });
    await save(generate);
    const generated = await launchAndWait(generate.id, "exited");
    const toolOutput = (await readTail(generated)).data;
    assert.equal(generated.exitCode, 0, toolOutput);
    assert.match(toolOutput, /flutter-generated/u);
    assert.match(
      await readFile(
        path.join(translations, "app_localizations_en.dart"),
        "utf8",
      ),
      /Hello from the Flutter fixture/u,
    );
  }
}
