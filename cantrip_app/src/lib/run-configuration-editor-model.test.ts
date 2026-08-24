import { describe, expect, it } from "vitest";

import {
  createDartRunConfigurationDocument,
  createFlutterRunConfigurationDocument,
  createJavaRunConfigurationDocument,
  createNodeRunConfigurationDocument,
  createShellRunConfigurationDocument,
  dartRunConfigurationEffectiveCommand,
  flutterRunConfigurationEffectiveCommand,
  javaRunConfigurationEffectiveCommand,
  nodeRunConfigurationEffectiveCommand,
  parseRunConfigurationEditorDocument,
  parseShellRunConfigurationEditorDocument,
  shellRunConfigurationEffectiveCommand,
} from "./run-configuration-editor-model";

describe("Shell Run configuration editor model", () => {
  it("defaults Codex environment inheritance on", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(document.environment.includeCodexEnvironment).toBe(true);
    expect(document.workingDirectory).toBe(".");
  });

  it("always resolves the effective command and marks overrides", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    document.target = {
      kind: "script",
      path: "tool/run.sh",
      interpreter: "bash",
    };
    document.arguments = ["--mode", "two words"];
    expect(shellRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'bash tool/run.sh --mode "two words"',
      overridden: false,
    });
    document.commandOverride = "pnpm dev";
    expect(shellRunConfigurationEffectiveCommand(document)).toMatchObject({
      command: 'pnpm dev --mode "two words"',
      overridden: true,
    });
  });

  it("reports document and platform override validation errors", () => {
    const document = createShellRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(parseShellRunConfigurationEditorDocument(document, "{")).toEqual({
      success: false,
      errors: ["Platform overrides must be valid JSON."],
    });
    const parsed = parseShellRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.errors.join(" ")).toContain("name");
  });

  it("builds structured Node package and entrypoint commands", () => {
    const document = createNodeRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    document.name = "Run web";
    document.options.packageManager = "pnpm";
    document.target = { kind: "packageScript", script: "dev" };
    document.arguments = ["--host", "two words"];
    expect(nodeRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'pnpm run dev -- --host "two words"',
      overridden: false,
    });
    document.target = { kind: "entry", path: "src/index.js" };
    document.options.runtimeArguments = ["--enable-source-maps"];
    expect(nodeRunConfigurationEffectiveCommand(document).command).toBe(
      'node --enable-source-maps src/index.js --host "two words"',
    );
    const parsed = parseRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.document.provider).toBe("node");
  });

  it("builds structured Gradle and Maven task and main-class commands", () => {
    const document = createJavaRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000001",
    );
    document.name = "Run Java API";
    document.target = {
      kind: "gradleMainClass",
      projectPath: ":api",
      className: "demo.ApiApplication",
    };
    document.arguments = ["--port", "two words"];
    document.options.vmArguments = ["-Xmx512m"];
    expect(javaRunConfigurationEffectiveCommand(document)).toMatchObject({
      overridden: false,
      command: expect.stringContaining(
        "./gradlew --init-script <cantrip-java-init.gradle>",
      ),
    });
    expect(javaRunConfigurationEffectiveCommand(document).command).toContain(
      ":api:_cantripRunConfigurationJava",
    );
    document.target = {
      kind: "mavenMainClass",
      module: ":api",
      className: "demo.ApiApplication",
    };
    document.options.useWrapper = false;
    document.options.jdkHome = "/opt/jdk-21";
    const maven = javaRunConfigurationEffectiveCommand(document);
    expect(maven.command).toContain("JAVA_HOME=/opt/jdk-21");
    expect(maven.command).toContain("JAVA_TOOL_OPTIONS=-Xmx512m");
    expect(maven.command).toContain(" mvn ");
    expect(maven.command).toContain("-pl :api -am");
    expect(maven.command).toContain("-Dexec.mainClass=demo.ApiApplication");
    document.commandOverride = "java";
    expect(javaRunConfigurationEffectiveCommand(document)).toEqual({
      command:
        'JAVA_HOME=/opt/jdk-21 JAVA_TOOL_OPTIONS=-Xmx512m java --port "two words"',
      overridden: true,
    });
    const parsed = parseRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.document.provider).toBe("java");
  });

  it("builds structured Dart entrypoint commands with SDK and VM options", () => {
    const document = createDartRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000002",
    );
    document.name = "Run Dart API";
    document.target = { kind: "entrypoint", path: "bin/server.dart" };
    document.arguments = ["--port", "two words"];
    document.options.sdkHome = "/opt/dart sdk";
    document.options.vmArguments = ["--enable-asserts"];
    expect(dartRunConfigurationEffectiveCommand(document)).toEqual({
      command:
        '"/opt/dart sdk/bin/dart" run --enable-asserts bin/server.dart --port "two words"',
      overridden: false,
    });
    document.commandOverride = "dart custom.dart";
    expect(dartRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'dart custom.dart --port "two words"',
      overridden: true,
    });
    const parsed = parseRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.document.provider).toBe("dart");
  });

  it("builds structured Flutter commands with device, flavor, mode, and Dart inputs", () => {
    const document = createFlutterRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000003",
    );
    document.name = "Run Flutter mobile";
    document.options.sdkHome = "/opt/flutter sdk";
    document.options.deviceId = "chrome";
    document.options.flavor = "staging";
    document.options.mode = "profile";
    document.options.usePub = false;
    document.options.dartDefines = [
      { name: "API_URL", value: "https://example.test" },
      { name: "TITLE", value: "two words" },
    ];
    document.options.dartDefineFiles = ["config/staging.env"];
    document.arguments = ["--route", "two words"];
    expect(flutterRunConfigurationEffectiveCommand(document)).toEqual({
      command:
        '"/opt/flutter sdk/bin/flutter" run --profile --target=lib/main.dart --device-id=chrome --flavor=staging --dart-define=API_URL=https://example.test "--dart-define=TITLE=two words" --dart-define-from-file=config/staging.env --no-pub --dart-entrypoint-args=--route "--dart-entrypoint-args=two words"',
      overridden: false,
    });
    document.commandOverride = "flutter custom";
    expect(flutterRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'flutter custom --route "two words"',
      overridden: true,
    });
    const parsed = parseRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.document.provider).toBe("flutter");
  });
});
