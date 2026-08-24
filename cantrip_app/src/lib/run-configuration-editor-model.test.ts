import { describe, expect, it } from "vitest";

import {
  applyRunConfigurationDetectionCandidate,
  createDartRunConfigurationDocument,
  createFlutterRunConfigurationDocument,
  createJavaRunConfigurationDocument,
  createNodeRunConfigurationDocument,
  createRustRunConfigurationDocument,
  createShellRunConfigurationDocument,
  dartRunConfigurationEffectiveCommand,
  flutterRunConfigurationEffectiveCommand,
  javaRunConfigurationEffectiveCommand,
  nodeRunConfigurationEffectiveCommand,
  parseRunConfigurationEditorDocument,
  parseShellRunConfigurationEditorDocument,
  rustRunConfigurationEffectiveCommand,
  shellRunConfigurationEffectiveCommand,
  runConfigurationTargetLabel,
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

  it("builds structured Cargo commands with target, toolchain, feature, target, and profile controls", () => {
    const document = createRustRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000004",
    );
    document.name = "Run Rust API";
    document.target = {
      kind: "example",
      package: "api",
      name: "quickstart",
    };
    document.arguments = ["--listen", "two words"];
    document.options = {
      toolchain: "nightly-2026-08-01",
      features: ["tls", "tracing"],
      allFeatures: false,
      useDefaultFeatures: false,
      targetTriple: "aarch64-apple-darwin",
      profile: "release-lto",
      locked: true,
      offline: true,
    };
    expect(rustRunConfigurationEffectiveCommand(document)).toEqual({
      command:
        'cargo +nightly-2026-08-01 run --package=api --example=quickstart --features=tls --features=tracing --no-default-features --target=aarch64-apple-darwin --profile=release-lto --locked --offline -- --listen "two words"',
      overridden: false,
    });
    document.commandOverride = "cargo custom";
    expect(rustRunConfigurationEffectiveCommand(document)).toEqual({
      command: 'cargo custom --listen "two words"',
      overridden: true,
    });
    const parsed = parseRunConfigurationEditorDocument(document, "{}");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.document.provider).toBe("rust");
  });
});

describe("Run configuration detected target application", () => {
  it("applies a Node target and discovery-owned runtime defaults without replacing common settings", () => {
    const current = createNodeRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000011",
    );
    current.name = "My API";
    current.arguments = ["--inspect"];
    current.environment.variables = [
      { name: "LOG_LEVEL", value: "debug", enabled: true },
    ];
    current.options.runtimeArguments = ["--enable-source-maps"];
    const detected = createNodeRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000012",
    );
    detected.name = "Detected Bun API";
    detected.workingDirectory = "packages/api";
    detected.target = { kind: "entry", path: "packages/api/server.ts" };
    detected.options = {
      packageManager: "bun",
      runtime: "bun",
      runtimeArguments: [],
    };

    const applied = applyRunConfigurationDetectionCandidate(current, {
      provider: "node",
      confidence: "high",
      reason: "The package declares an entrypoint.",
      effectiveCommand: "bun packages/api/server.ts",
      document: detected,
    });

    expect(applied).toMatchObject({
      id: current.id,
      name: "My API",
      workingDirectory: "packages/api",
      target: { kind: "entry", path: "packages/api/server.ts" },
      arguments: ["--inspect"],
      environment: current.environment,
      options: {
        packageManager: "bun",
        runtime: "bun",
        runtimeArguments: ["--enable-source-maps"],
      },
    });
  });

  it("keeps Java runtime tuning while applying the discovered module, main class, and wrapper", () => {
    const current = createJavaRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000013",
    );
    current.name = "Java API";
    current.options = {
      jdkHome: "/opt/jdk-21",
      useWrapper: false,
      buildToolArguments: ["--quiet"],
      vmArguments: ["-Xmx1g"],
    };
    const detected = createJavaRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000014",
    );
    detected.workingDirectory = "services/api";
    detected.target = {
      kind: "gradleMainClass",
      projectPath: ":api",
      className: "demo.ApiApplication",
    };
    detected.options.useWrapper = true;

    const applied = applyRunConfigurationDetectionCandidate(current, {
      provider: "java",
      confidence: "high",
      reason: "A static main method was found.",
      effectiveCommand: "./gradlew :api:run",
      document: detected,
    });

    expect(applied).toMatchObject({
      id: current.id,
      name: "Java API",
      workingDirectory: "services/api",
      target: detected.target,
      options: {
        jdkHome: "/opt/jdk-21",
        useWrapper: true,
        buildToolArguments: ["--quiet"],
        vmArguments: ["-Xmx1g"],
      },
    });
  });

  it("applies Flutter flavor discovery and unions required Cargo features with user features", () => {
    const flutter = createFlutterRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000015",
    );
    flutter.options.deviceId = "chrome";
    flutter.options.mode = "profile";
    const detectedFlutter = createFlutterRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000016",
    );
    detectedFlutter.workingDirectory = "apps/mobile";
    detectedFlutter.target.path = "lib/main_staging.dart";
    detectedFlutter.options.flavor = "staging";
    const appliedFlutter = applyRunConfigurationDetectionCandidate(flutter, {
      provider: "flutter",
      confidence: "medium",
      reason: "A likely Flutter entrypoint was found.",
      effectiveCommand: "flutter run --target=lib/main_staging.dart",
      document: detectedFlutter,
    });
    expect(appliedFlutter).toMatchObject({
      workingDirectory: "apps/mobile",
      target: { kind: "entrypoint", path: "lib/main_staging.dart" },
      options: { deviceId: "chrome", mode: "profile", flavor: "staging" },
    });
    flutter.options.flavor = "local";
    expect(
      applyRunConfigurationDetectionCandidate(flutter, {
        provider: "flutter",
        confidence: "medium",
        reason: "A likely Flutter entrypoint was found.",
        effectiveCommand: "flutter run --target=lib/main_staging.dart",
        document: detectedFlutter,
      }),
    ).toMatchObject({ options: { flavor: "local" } });

    const rust = createRustRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000017",
    );
    rust.options.features = ["tracing", "tls"];
    rust.options.toolchain = "nightly";
    const detectedRust = createRustRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000018",
    );
    detectedRust.target = {
      kind: "binary",
      package: "api",
      name: "api-server",
    };
    detectedRust.options.features = ["tls", "server"];
    const appliedRust = applyRunConfigurationDetectionCandidate(rust, {
      provider: "rust",
      confidence: "high",
      reason: "The Cargo target is statically declared.",
      effectiveCommand: "cargo run --package=api --bin=api-server",
      document: detectedRust,
    });
    expect(appliedRust).toMatchObject({
      target: detectedRust.target,
      options: {
        toolchain: "nightly",
        features: ["tls", "server", "tracing"],
      },
    });
  });

  it("rejects cross-provider candidates and renders concise searchable target labels", () => {
    const current = createDartRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000019",
    );
    const rust = createRustRunConfigurationDocument(
      "00000000-0000-4000-8000-000000000020",
    );
    expect(
      applyRunConfigurationDetectionCandidate(current, {
        provider: "rust",
        confidence: "low",
        reason: "A Rust target was found.",
        effectiveCommand: "cargo run --package=app --bin=app",
        document: rust,
      }),
    ).toBe(current);
    expect(runConfigurationTargetLabel(current)).toBe(
      "Dart entrypoint: bin/main.dart",
    );
    expect(runConfigurationTargetLabel(rust)).toBe("Cargo app · binary app");
  });
});
