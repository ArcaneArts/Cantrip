import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeRunConfigurationProvider } from "../src/run-configuration-node-provider.js";
import { javaRunConfigurationProvider } from "../src/run-configuration-java-provider.js";
import { dartRunConfigurationProvider } from "../src/run-configuration-dart-provider.js";
import { flutterRunConfigurationProvider } from "../src/run-configuration-flutter-provider.js";
import { rustRunConfigurationProvider } from "../src/run-configuration-rust-provider.js";
import {
  findRunConfigurationExecutable,
  shellRunConfigurationProvider,
} from "../src/run-configuration-provider.js";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-configuration-provider-"),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("findRunConfigurationExecutable", () => {
  it("requires POSIX execute permission and returns the canonical PATH match", async () => {
    const root = await createRoot();
    const executable = path.join(root, "cantrip-tool");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const context = {
      environment: { PATH: root },
      platform: "linux" as const,
      targetRoot: root,
    };

    await expect(
      findRunConfigurationExecutable("cantrip-tool", context),
    ).resolves.toBeNull();

    await chmod(executable, 0o755);
    await expect(
      findRunConfigurationExecutable("cantrip-tool", context),
    ).resolves.toBe(await realpath(executable));
  });

  it("uses case-insensitive Windows environment keys and PATHEXT", async () => {
    const root = await createRoot();
    const executable = path.join(root, "cantrip-tool.CMD");
    await writeFile(executable, "@exit /b 0\r\n");

    await expect(
      findRunConfigurationExecutable("cantrip-tool", {
        environment: {
          Path: `${path.join(root, "missing")};${root}`,
          pathext: ".COM;.EXE;.CMD",
        },
        platform: "win32",
        targetRoot: root,
      }),
    ).resolves.toBe(await realpath(executable));
  });

  it("returns null when the launch environment has no matching executable", async () => {
    const root = await createRoot();
    await expect(
      findRunConfigurationExecutable("missing-tool", {
        environment: { PATH: root },
        platform: "linux",
        targetRoot: root,
      }),
    ).resolves.toBeNull();
  });
});

describe("shellRunConfigurationProvider", () => {
  it("creates a complete default definition with live Codex environment injection", () => {
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run app",
    });
    expect(definition).toMatchObject({
      provider: "shell",
      target: { kind: "command", command: "echo Ready" },
      environment: { includeCodexEnvironment: true },
      options: { shell: "automatic", login: true },
    });
    expect(shellRunConfigurationProvider.capability).toMatchObject({
      provider: "shell",
      available: true,
      supportsDiscovery: false,
    });
  });

  it("materializes a POSIX login shell, quoted arguments, and before-launch commands", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "server"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run app",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        workingDirectory: "server",
        target: { kind: "command", command: "pnpm dev" },
        arguments: ["--host", "hello world", "it's-safe"],
        beforeLaunch: [
          {
            kind: "command",
            command: "pnpm build",
            workingDirectory: ".",
          },
        ],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/bash",
      },
    );
    expect(materialized).toEqual({
      executable: "/bin/bash",
      arguments: ["-lc", "pnpm dev '--host' 'hello world' 'it'\\''s-safe'"],
      workingDirectory: path.join(canonicalRoot, "server"),
      beforeLaunch: [
        {
          executable: "/bin/bash",
          arguments: ["-lc", "pnpm build"],
          workingDirectory: canonicalRoot,
        },
      ],
      effectiveCommand: "pnpm dev '--host' 'hello world' 'it'\\''s-safe'",
      environment: definition.environment,
    });
  });

  it("applies platform command, directory, shell, and environment overrides", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "windows"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "command", command: "echo default" },
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            workingDirectory: "windows",
            commandOverride: "Write-Output override",
            arguments: ["hello world"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: { shell: "powershell", login: false },
          },
        },
      },
      {
        platform: "win32",
        targetRoot: root,
        defaultShell: null,
      },
    );
    expect(materialized).toMatchObject({
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Output override 'hello world'",
      ],
      workingDirectory: path.join(canonicalRoot, "windows"),
      effectiveCommand: "Write-Output override 'hello world'",
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
    });
  });

  it("validates scripts, working directories, provider tasks, and platform shells without execution", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await writeFile(path.join(outside, "outside.sh"), "exit 0");
    await symlink(path.join(outside, "outside.sh"), path.join(root, "run.sh"));
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Run",
    });
    const diagnostics = await shellRunConfigurationProvider.validate(
      {
        ...definition,
        workingDirectory: "missing",
        target: { kind: "script", path: "run.sh", interpreter: "bash" },
        beforeLaunch: [{ kind: "providerTask", task: "build" }],
        options: { shell: "powershell", login: false },
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      },
    );
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      "provider-task-unsupported",
      "script-invalid",
      "shell-unavailable",
      "working-directory-invalid",
    ]);
    await expect(
      shellRunConfigurationProvider.materialize(
        {
          ...definition,
          workingDirectory: "missing",
          target: { kind: "script", path: "run.sh", interpreter: "bash" },
        },
        {
          platform: "linux",
          targetRoot: root,
          defaultShell: "/bin/sh",
        },
      ),
    ).rejects.toThrow("working directory");
  });

  it("materializes a real script and never follows a configured path outside the target root", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin/run.sh"), "#!/bin/sh\nexit 0\n");
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run script",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: {
          kind: "script",
          path: "bin/run.sh",
          interpreter: "/bin/sh",
        },
        arguments: ["--safe"],
      },
      {
        platform: "darwin",
        targetRoot: root,
        defaultShell: "/bin/zsh",
      },
    );
    expect(materialized).toMatchObject({
      executable: "/bin/zsh",
      arguments: ["-lc", "/bin/sh '" + canonicalRoot + "/bin/run.sh' '--safe'"],
      effectiveCommand: "/bin/sh 'bin/run.sh' '--safe'",
    });
  });

  it("uses the PowerShell invocation operator for a script target", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(path.join(root, "run.ps1"), "Write-Output ready\n");
    const definition = shellRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run PowerShell script",
    });
    const materialized = await shellRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "script", path: "run.ps1", interpreter: null },
        arguments: ["hello world"],
      },
      {
        platform: "win32",
        targetRoot: root,
        defaultShell: null,
      },
    );
    const command = "& '" + canonicalRoot + "/run.ps1' 'hello world'";
    expect(materialized).toMatchObject({
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ],
      effectiveCommand: "& 'run.ps1' 'hello world'",
    });
  });
});

describe("nodeRunConfigurationProvider", () => {
  it("discovers bounded package scripts and entrypoints without entering dependency directories", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(path.join(root, "packages", "api"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "hidden"), { recursive: true });
    await writeFile(
      path.join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9'\n",
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "workspace",
        packageManager: "pnpm@10.0.0",
        scripts: { start: "node server.js", dev: "node server.js --watch" },
        main: "server.js",
      }),
    );
    await writeFile(path.join(root, "server.js"), "console.log('ready')\n");
    await writeFile(
      path.join(root, "packages", "api", "package.json"),
      JSON.stringify({
        name: "@demo/api",
        scripts: { start: "node index.js" },
      }),
    );
    await writeFile(
      path.join(root, "packages", "api", "index.js"),
      "console.log('api')\n",
    );
    await writeFile(
      path.join(root, "node_modules", "hidden", "package.json"),
      JSON.stringify({ name: "hidden", scripts: { start: "never" } }),
    );
    await writeFile(
      path.join(outside, "package.json"),
      JSON.stringify({ name: "escaped", scripts: { start: "never" } }),
    );
    await symlink(outside, path.join(root, "linked-package"));

    const candidates = await nodeRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "node",
            name: "Run start",
            workingDirectory: ".",
            target: { kind: "packageScript", script: "start" },
            options: expect.objectContaining({ packageManager: "pnpm" }),
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            workingDirectory: "packages/api",
            target: { kind: "entry", path: "packages/api/index.js" },
          }),
        }),
      ]),
    );
    expect(
      candidates.some(
        ({ document }) =>
          document.name.includes("hidden") || document.name.includes("escaped"),
      ),
    ).toBe(false);
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
  });

  it("materializes package scripts, ordered provider tasks, and command steps", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { start: "node server.js", build: "node build.js" },
      }),
    );
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Node app",
    });
    const materialized = await nodeRunConfigurationProvider.materialize(
      {
        ...definition,
        arguments: ["--port", "4400"],
        options: {
          packageManager: "pnpm",
          runtime: "node",
          runtimeArguments: [],
        },
        beforeLaunch: [
          { kind: "providerTask", task: "build" },
          { kind: "command", command: "echo prepared", workingDirectory: "." },
        ],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/bash",
      },
    );
    expect(materialized).toEqual({
      executable: "pnpm",
      arguments: ["run", "start", "--", "--port", "4400"],
      workingDirectory: canonicalRoot,
      beforeLaunch: [
        {
          executable: "pnpm",
          arguments: ["run", "build"],
          workingDirectory: canonicalRoot,
        },
        {
          executable: "/bin/bash",
          arguments: ["-lc", "echo prepared"],
          workingDirectory: canonicalRoot,
        },
      ],
      effectiveCommand: "pnpm run start -- --port 4400",
      environment: definition.environment,
    });
  });

  it("materializes canonical entrypoints and reports missing scripts and files", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: {} }),
    );
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.js"), "console.log('ok')\n");
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run entry",
    });
    const entry = {
      ...definition,
      target: { kind: "entry" as const, path: "src/index.js" },
      arguments: ["two words"],
      options: {
        packageManager: "npm" as const,
        runtime: "node" as const,
        runtimeArguments: ["--enable-source-maps"],
      },
    };
    await expect(
      nodeRunConfigurationProvider.materialize(entry, {
        platform: "darwin",
        targetRoot: root,
        defaultShell: "/bin/zsh",
      }),
    ).resolves.toMatchObject({
      executable: "node",
      arguments: [
        "--enable-source-maps",
        path.join(canonicalRoot, "src", "index.js"),
        "two words",
      ],
      effectiveCommand: "node --enable-source-maps src/index.js 'two words'",
    });

    const diagnostics = await nodeRunConfigurationProvider.validate(
      {
        ...definition,
        target: { kind: "packageScript", script: "missing" },
        beforeLaunch: [{ kind: "providerTask", task: "also-missing" }],
      },
      {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      },
    );
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "package-script-missing",
      "package-script-missing",
    ]);
  });

  it("applies typed Windows package-manager and environment overrides", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js" } }),
    );
    const definition = nodeRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows package",
    });
    const materialized = await nodeRunConfigurationProvider.materialize(
      {
        ...definition,
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            arguments: ["two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: { packageManager: "yarn" },
          },
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized).toMatchObject({
      executable: "yarn",
      arguments: ["run", "start", "--", "two words"],
      effectiveCommand: 'yarn run start -- "two words"',
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
    });
  });
});

describe("javaRunConfigurationProvider", () => {
  it("discovers bounded Gradle and Maven modules, tasks, and Java main classes without executing builds", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(
      path.join(
        root,
        "gradle-app",
        "modules",
        "api",
        "src",
        "main",
        "java",
        "demo",
      ),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(root, "gradle-app", "settings.gradle.kts"),
      'rootProject.name = "demo"\ninclude(":app")\nproject(":app").projectDir = file("modules/api")\n',
    );
    await writeFile(
      path.join(root, "gradle-app", "modules", "api", "build.gradle.kts"),
      'plugins { application }\napplication { mainClass.set("demo.GradleMain") }\ntasks.register<JavaExec>("seedData")\n',
    );
    await writeFile(
      path.join(root, "gradle-app", "gradlew"),
      "#!/bin/sh\nexit 0\n",
    );
    await chmod(path.join(root, "gradle-app", "gradlew"), 0o755);
    await writeFile(
      path.join(
        root,
        "gradle-app",
        "modules",
        "api",
        "src",
        "main",
        "java",
        "demo",
        "GradleMain.java",
      ),
      "package demo; public class GradleMain { public static void main(String[] args) {} }\n",
    );

    await mkdir(
      path.join(root, "maven-app", "service", "src", "main", "java", "demo"),
      { recursive: true },
    );
    await writeFile(
      path.join(root, "maven-app", "pom.xml"),
      "<project><artifactId>parent</artifactId><modules><module>service</module></modules></project>",
    );
    await writeFile(
      path.join(root, "maven-app", "mvnw"),
      "#!/bin/sh\nexit 0\n",
    );
    await chmod(path.join(root, "maven-app", "mvnw"), 0o755);
    await writeFile(
      path.join(root, "maven-app", "service", "pom.xml"),
      "<project><parent><artifactId>inherited-parent</artifactId></parent><artifactId>service</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
    );
    await writeFile(
      path.join(
        root,
        "maven-app",
        "service",
        "src",
        "main",
        "java",
        "demo",
        "MavenMain.java",
      ),
      "package demo; public class MavenMain { public static void main(String... args) {} }\n",
    );
    await mkdir(path.join(outside, "src", "main", "java"), { recursive: true });
    await writeFile(
      path.join(outside, "build.gradle"),
      "plugins { id 'application' }\n",
    );
    await symlink(outside, path.join(root, "linked-java-project"));

    const candidates = await javaRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "java",
            workingDirectory: "gradle-app",
            target: {
              kind: "gradleMainClass",
              projectPath: ":app",
              className: "demo.GradleMain",
            },
            options: expect.objectContaining({ useWrapper: true }),
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            workingDirectory: "gradle-app",
            target: {
              kind: "gradleTask",
              projectPath: ":app",
              task: "run",
            },
          }),
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            workingDirectory: "gradle-app",
            target: {
              kind: "gradleTask",
              projectPath: ":app",
              task: "seedData",
            },
          }),
        }),
        expect.objectContaining({
          reason: expect.stringContaining("in service."),
          document: expect.objectContaining({
            workingDirectory: "maven-app",
            target: {
              kind: "mavenMainClass",
              module: "service",
              className: "demo.MavenMain",
            },
          }),
        }),
        expect.objectContaining({
          document: expect.objectContaining({
            workingDirectory: "maven-app",
            target: {
              kind: "mavenGoal",
              module: "service",
              goal: "spring-boot:run",
            },
          }),
        }),
      ]),
    );
    expect(candidates.some(({ reason }) => reason.includes("linked"))).toBe(
      false,
    );
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
  });

  it("materializes a Gradle main-class launcher, JDK choice, and ordered before-launch steps", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    const jdk = path.join(root, "jdk");
    await mkdir(path.join(root, "app", "src", "main", "java", "demo"), {
      recursive: true,
    });
    await mkdir(path.join(jdk, "bin"), { recursive: true });
    await writeFile(path.join(root, "settings.gradle"), "include ':app'\n");
    await writeFile(
      path.join(root, "app", "build.gradle"),
      "plugins { id 'java' }\n",
    );
    await writeFile(
      path.join(root, "app", "src", "main", "java", "demo", "Main.java"),
      "package demo; public class Main { public static void main(String[] args) {} }\n",
    );
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(root, "gradlew"), 0o755);
    await writeFile(path.join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(jdk, "bin", "java"), 0o755);
    const canonicalJdk = await realpath(jdk);
    const definition = javaRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Java main",
    });
    const materialized = await javaRunConfigurationProvider.materialize(
      {
        ...definition,
        target: {
          kind: "gradleMainClass",
          projectPath: ":app",
          className: "demo.Main",
        },
        arguments: ["--port", "two words"],
        beforeLaunch: [
          { kind: "providerTask", task: "classes" },
          { kind: "command", command: "echo ready", workingDirectory: "." },
        ],
        options: {
          jdkHome: jdk,
          useWrapper: true,
          buildToolArguments: ["--console=plain"],
          vmArguments: ["-Xmx512m"],
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/bash" },
    );
    expect(materialized.executable).toBe(path.join(canonicalRoot, "gradlew"));
    expect(materialized.arguments).toEqual(
      expect.arrayContaining([
        "--console=plain",
        "-PcantripMainClass=demo.Main",
        expect.stringMatching(/^-PcantripArguments=/u),
        expect.stringMatching(/^-PcantripVmArguments=/u),
        ":app:_cantripRunConfigurationJava",
      ]),
    );
    expect(materialized.beforeLaunch).toEqual([
      {
        executable: path.join(canonicalRoot, "gradlew"),
        arguments: ["--console=plain", ":app:classes"],
        workingDirectory: canonicalRoot,
      },
      {
        executable: "/bin/bash",
        arguments: ["-lc", "echo ready"],
        workingDirectory: canonicalRoot,
      },
    ]);
    expect(materialized.environmentAdditions).toEqual({
      JAVA_HOME: canonicalJdk,
    });
    expect(materialized.effectiveCommand).toContain("JAVA_HOME=" + jdk);
  });

  it("materializes typed Maven goals and Windows wrapper invocation", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "pom.xml"),
      "<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
    );
    await writeFile(path.join(root, "mvnw.cmd"), "@echo off\r\n");
    const definition = javaRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Maven API",
    });
    const materialized = await javaRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "mavenGoal", module: null, goal: "spring-boot:run" },
        arguments: ["--ignored"],
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            arguments: ["--server.port=4400", "two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: {
              useWrapper: true,
              buildToolArguments: ["--no-transfer-progress"],
              vmArguments: ["-Xms128m"],
            },
          },
        },
        options: {
          jdkHome: null,
          useWrapper: false,
          buildToolArguments: ["--base"],
          vmArguments: [],
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized).toMatchObject({
      executable: "cmd.exe",
      arguments: ["/d", "/s", "/c", expect.stringContaining("mvnw.cmd")],
      environmentAdditions: { JAVA_TOOL_OPTIONS: "-Xms128m" },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
    });
    expect(materialized.effectiveCommand).toContain(
      "-Dspring-boot.run.arguments=",
    );
    expect(materialized.effectiveCommand).toContain("--no-transfer-progress");
    expect(materialized.effectiveCommand).not.toContain("--base");
    expect(materialized.effectiveCommand).not.toContain("--ignored");
  });

  it("launches a Maven main class with application and VM arguments", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src", "main", "java", "demo"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "pom.xml"),
      "<project><artifactId>api</artifactId></project>",
    );
    await writeFile(
      path.join(root, "src", "main", "java", "demo", "Main.java"),
      "package demo; public class Main { public static void main(String args[]) {} }\n",
    );
    await writeFile(path.join(root, "mvnw"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(root, "mvnw"), 0o755);
    const definition = javaRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Maven main",
    });
    const materialized = await javaRunConfigurationProvider.materialize(
      {
        ...definition,
        target: {
          kind: "mavenMainClass",
          module: null,
          className: "demo.Main",
        },
        arguments: ["--port", "two words"],
        options: {
          jdkHome: null,
          useWrapper: true,
          buildToolArguments: [],
          vmArguments: ["-Xmx256m", "-Dmode=development"],
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(materialized.arguments).toEqual([
      "org.codehaus.mojo:exec-maven-plugin:3.5.1:java",
      "-Dexec.mainClass=demo.Main",
      "-Dexec.args=--port 'two words'",
    ]);
    expect(materialized.environmentAdditions).toEqual({
      JAVA_TOOL_OPTIONS: "-Xmx256m -Dmode=development",
    });
    expect(materialized.effectiveCommand).toContain(
      "JAVA_TOOL_OPTIONS='-Xmx256m -Dmode=development'",
    );
  });

  it("keeps the selected JDK and VM environment on a command override", async () => {
    const root = await createRoot();
    const jdk = path.join(root, "jdk");
    await mkdir(path.join(jdk, "bin"), { recursive: true });
    await writeFile(path.join(jdk, "bin", "java"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(jdk, "bin", "java"), 0o755);
    const definition = javaRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Java override",
    });
    const materialized = await javaRunConfigurationProvider.materialize(
      {
        ...definition,
        commandOverride: "java",
        arguments: ["demo.Main"],
        options: {
          jdkHome: jdk,
          useWrapper: true,
          buildToolArguments: [],
          vmArguments: ["-Xmx192m"],
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(materialized.environmentAdditions).toEqual({
      JAVA_HOME: await realpath(jdk),
      JAVA_TOOL_OPTIONS: "-Xmx192m",
    });
    expect(materialized.effectiveCommand).toContain(
      "JAVA_TOOL_OPTIONS=-Xmx192m java demo.Main",
    );
  });

  it("fails closed for missing modules, main classes, wrappers, and JDKs", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "app"));
    await writeFile(path.join(root, "settings.gradle"), "include ':app'\n");
    await writeFile(
      path.join(root, "app", "build.gradle"),
      "plugins { id 'java' }\n",
    );
    const definition = javaRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Java run",
    });
    const diagnostics = await javaRunConfigurationProvider.validate(
      {
        ...definition,
        target: {
          kind: "gradleMainClass",
          projectPath: ":missing",
          className: "demo.Missing",
        },
        options: {
          ...definition.options,
          jdkHome: "relative/jdk",
          useWrapper: true,
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      "build-wrapper-invalid",
      "gradle-module-missing",
      "jdk-home-invalid",
    ]);
    const nonExecutableJdk = path.join(root, "non-executable-jdk");
    await mkdir(path.join(nonExecutableJdk, "bin"), { recursive: true });
    await writeFile(
      path.join(nonExecutableJdk, "bin", "java"),
      "not executable\n",
    );
    await expect(
      javaRunConfigurationProvider.validate(
        {
          ...definition,
          commandOverride: "java",
          options: { ...definition.options, jdkHome: nonExecutableJdk },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([expect.objectContaining({ code: "jdk-home-invalid" })]);
    await writeFile(path.join(root, "gradlew"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(root, "gradlew"), 0o755);
    await expect(
      javaRunConfigurationProvider.validate(
        {
          ...definition,
          target: {
            kind: "gradleMainClass",
            projectPath: ":app",
            className: "demo.Missing",
          },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ code: "java-main-class-missing" }),
    ]);
    await expect(
      javaRunConfigurationProvider.validate(
        {
          ...definition,
          target: {
            kind: "gradleTask",
            projectPath: ":app",
            task: "missingRun",
          },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ code: "gradle-task-missing" }),
    ]);
  });
});

describe("dartRunConfigurationProvider", () => {
  it("discovers bounded package entrypoints while excluding tests, Flutter packages, and symlink escapes", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(path.join(root, "workspace", "tool"), { recursive: true });
    await mkdir(path.join(root, "workspace", "packages", "cli", "bin"), {
      recursive: true,
    });
    await mkdir(path.join(root, "workspace", "packages", "cli", "tool"), {
      recursive: true,
    });
    await mkdir(path.join(root, "workspace", "packages", "cli", "test"), {
      recursive: true,
    });
    await mkdir(path.join(root, "workspace", "packages", "cli", "lib"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "workspace", "pubspec.yaml"),
      "name: workspace_root\n",
    );
    await writeFile(
      path.join(root, "workspace", "tool", "root.dart"),
      "Future<void> main() async {}\n",
    );
    await writeFile(
      path.join(root, "workspace", "packages", "cli", "pubspec.yaml"),
      "name: 'demo_cli'\n",
    );
    await writeFile(
      path.join(root, "workspace", "packages", "cli", "bin", "demo_cli.dart"),
      "void main(List<String> arguments) {}\n",
    );
    await writeFile(
      path.join(root, "workspace", "packages", "cli", "tool", "dev.dart"),
      "dynamic main() {}\n",
    );
    await writeFile(
      path.join(
        root,
        "workspace",
        "packages",
        "cli",
        "test",
        "ignored_test.dart",
      ),
      "void main() {}\n",
    );
    await writeFile(
      path.join(
        root,
        "workspace",
        "packages",
        "cli",
        "lib",
        "not_entrypoint.dart",
      ),
      "const example = '''void main() {}''';\nclass Helper {\n  void main() {}\n}\n",
    );
    await mkdir(path.join(root, "mobile", "lib"), { recursive: true });
    await writeFile(
      path.join(root, "mobile", "pubspec.yaml"),
      "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(
      path.join(root, "mobile", "lib", "main.dart"),
      "void main() {}\n",
    );
    await writeFile(path.join(outside, "pubspec.yaml"), "name: escaped\n");
    await writeFile(path.join(outside, "main.dart"), "void main() {}\n");
    await symlink(outside, path.join(root, "linked-dart-package"));

    const candidates = await dartRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "dart",
            workingDirectory: "workspace/packages/cli",
            target: { kind: "entrypoint", path: "bin/demo_cli.dart" },
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          confidence: "medium",
          document: expect.objectContaining({
            workingDirectory: "workspace/packages/cli",
            target: { kind: "entrypoint", path: "tool/dev.dart" },
          }),
        }),
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            workingDirectory: "workspace",
            target: { kind: "entrypoint", path: "tool/root.dart" },
          }),
        }),
      ]),
    );
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
    expect(
      candidates.some(
        ({ document, reason }) =>
          document.workingDirectory === "mobile" ||
          document.target.path.includes("test/") ||
          reason.includes("linked"),
      ),
    ).toBe(false);
  });

  it("materializes SDK, VM, program, environment, and ordered before-launch settings", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    const sdkHome = path.join(root, "dart-sdk");
    await mkdir(path.join(root, "api", "bin"), { recursive: true });
    await mkdir(path.join(sdkHome, "bin"), { recursive: true });
    await writeFile(path.join(root, "api", "pubspec.yaml"), "name: api\n");
    await writeFile(
      path.join(root, "api", "bin", "server.dart"),
      "void main(List<String> arguments) {}\n",
    );
    await writeFile(path.join(sdkHome, "bin", "dart"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(sdkHome, "bin", "dart"), 0o755);
    const definition = dartRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Dart API",
    });
    const materialized = await dartRunConfigurationProvider.materialize(
      {
        ...definition,
        workingDirectory: "api",
        target: { kind: "entrypoint", path: "bin/server.dart" },
        arguments: ["--port", "two words"],
        beforeLaunch: [
          { kind: "command", command: "echo prepared", workingDirectory: "." },
        ],
        options: {
          sdkHome,
          vmArguments: ["--enable-asserts", "--observe=127.0.0.1:0"],
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/bash" },
    );
    expect(materialized).toMatchObject({
      executable: await realpath(path.join(sdkHome, "bin", "dart")),
      arguments: [
        "run",
        "--enable-asserts",
        "--observe=127.0.0.1:0",
        "bin/server.dart",
        "--port",
        "two words",
      ],
      workingDirectory: path.join(canonicalRoot, "api"),
      beforeLaunch: [
        {
          executable: "/bin/bash",
          arguments: ["-lc", "echo prepared"],
          workingDirectory: canonicalRoot,
        },
      ],
      environment: definition.environment,
    });
    expect(materialized.effectiveCommand).toContain(
      "run --enable-asserts --observe=127.0.0.1:0 bin/server.dart --port 'two words'",
    );
  });

  it("applies typed Windows argument, SDK, and environment overrides", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "windows", "bin"), { recursive: true });
    await writeFile(
      path.join(root, "windows", "pubspec.yaml"),
      "name: windows_api\n",
    );
    await writeFile(
      path.join(root, "windows", "bin", "main.dart"),
      "void main() {}\n",
    );
    const definition = dartRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows Dart",
    });
    const materialized = await dartRunConfigurationProvider.materialize(
      {
        ...definition,
        arguments: ["--base"],
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            workingDirectory: "windows",
            arguments: ["two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: {
              sdkHome: null,
              vmArguments: ["--enable-asserts"],
            },
          },
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized).toMatchObject({
      executable: "dart",
      arguments: ["run", "--enable-asserts", "bin/main.dart", "two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
      effectiveCommand: 'dart run --enable-asserts bin/main.dart "two words"',
    });
  });

  it("fails closed for invalid packages, entrypoints, SDKs, and provider tasks", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "main.dart"), "void main() {}\n");
    const definition = dartRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Dart",
    });
    await expect(
      dartRunConfigurationProvider.validate(definition, {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ code: "dart-package-invalid" }),
    ]);
    await writeFile(path.join(root, "pubspec.yaml"), "name: api\n");
    await expect(
      dartRunConfigurationProvider.validate(
        {
          ...definition,
          target: { kind: "entrypoint", path: "bin/missing.dart" },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ code: "dart-entrypoint-invalid" }),
    ]);
    await writeFile(
      path.join(root, "pubspec.yaml"),
      "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const flutterDiagnostics = await dartRunConfigurationProvider.validate(
      {
        ...definition,
        beforeLaunch: [{ kind: "providerTask", task: "pub get" }],
        options: { sdkHome: "relative/sdk", vmArguments: [] },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(flutterDiagnostics.map(({ code }) => code).sort()).toEqual([
      "dart-package-is-flutter",
      "dart-provider-task-unsupported",
      "dart-sdk-invalid",
    ]);
    await expect(
      dartRunConfigurationProvider.validate(
        {
          ...definition,
          commandOverride: "echo overridden",
          options: { sdkHome: "relative/sdk", vmArguments: [] },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([]);
  });
});

describe("flutterRunConfigurationProvider", () => {
  it("discovers likely Flutter entrypoints and default flavors without crossing package or symlink boundaries", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(path.join(root, "apps", "mobile", "lib"), { recursive: true });
    await mkdir(path.join(root, "apps", "mobile", "test"), {
      recursive: true,
    });
    await mkdir(path.join(root, "packages", "models", "lib"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "apps", "mobile", "pubspec.yaml"),
      [
        "name: mobile",
        "dependencies:",
        "  flutter:",
        "    sdk: flutter",
        "flutter:",
        "  default-flavor: staging",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "apps", "mobile", "lib", "main.dart"),
      "void main() {}\n",
    );
    await writeFile(
      path.join(root, "apps", "mobile", "lib", "main_staging.dart"),
      "Future<void> main() async {}\n",
    );
    await writeFile(
      path.join(root, "apps", "mobile", "lib", "helper.dart"),
      "void main() {}\n",
    );
    await writeFile(
      path.join(root, "apps", "mobile", "lib", "not_entrypoint.dart"),
      "const sample = '''void main() {}''';\nclass Helper {\n  void main() {}\n}\n",
    );
    await writeFile(
      path.join(root, "apps", "mobile", "test", "main_test.dart"),
      "void main() {}\n",
    );
    await writeFile(
      path.join(root, "packages", "models", "pubspec.yaml"),
      "name: models\n",
    );
    await writeFile(
      path.join(root, "packages", "models", "lib", "main.dart"),
      "void main() {}\n",
    );
    await mkdir(path.join(outside, "lib"));
    await writeFile(
      path.join(outside, "pubspec.yaml"),
      "name: escaped\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(path.join(outside, "lib", "main.dart"), "void main() {}\n");
    await symlink(outside, path.join(root, "linked-flutter-app"));

    const candidates = await flutterRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "flutter",
            workingDirectory: "apps/mobile",
            target: { kind: "entrypoint", path: "lib/main.dart" },
            options: expect.objectContaining({ flavor: "staging" }),
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          confidence: "medium",
          document: expect.objectContaining({
            target: { kind: "entrypoint", path: "lib/main_staging.dart" },
          }),
        }),
      ]),
    );
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
    expect(
      candidates.some(
        ({ document, reason }) =>
          document.workingDirectory.includes("models") ||
          document.target.path.includes("test/") ||
          reason.includes("linked"),
      ),
    ).toBe(false);
  });

  it("materializes SDK, device, flavor, mode, Dart defines, program arguments, and before-launch tasks", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    const sdkHome = path.join(root, "flutter-sdk");
    await mkdir(path.join(root, "mobile", "lib"), { recursive: true });
    await mkdir(path.join(root, "mobile", "config"), { recursive: true });
    await mkdir(path.join(sdkHome, "bin"), { recursive: true });
    await writeFile(
      path.join(root, "mobile", "pubspec.yaml"),
      "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(
      path.join(root, "mobile", "lib", "main.dart"),
      "void main(List<String> arguments) {}\n",
    );
    await writeFile(
      path.join(root, "mobile", "config", "staging.env"),
      "API_TOKEN=public-fixture\n",
    );
    await writeFile(
      path.join(sdkHome, "bin", "flutter"),
      "#!/bin/sh\nexit 0\n",
    );
    await chmod(path.join(sdkHome, "bin", "flutter"), 0o755);
    const definition = flutterRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Flutter mobile",
    });
    const materialized = await flutterRunConfigurationProvider.materialize(
      {
        ...definition,
        workingDirectory: "mobile",
        arguments: ["--route", "two words"],
        beforeLaunch: [
          { kind: "providerTask", task: "pub get" },
          { kind: "command", command: "echo prepared", workingDirectory: "." },
        ],
        options: {
          sdkHome,
          deviceId: "chrome",
          flavor: "staging",
          mode: "profile",
          dartDefines: [
            { name: "API_URL", value: "https://example.test" },
            { name: "TITLE", value: "two words" },
          ],
          dartDefineFiles: ["config/staging.env"],
          usePub: false,
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/bash" },
    );
    const flutterExecutable = await realpath(
      path.join(sdkHome, "bin", "flutter"),
    );
    expect(materialized).toMatchObject({
      executable: flutterExecutable,
      arguments: [
        "run",
        "--profile",
        "--target=lib/main.dart",
        "--device-id=chrome",
        "--flavor=staging",
        "--dart-define=API_URL=https://example.test",
        "--dart-define=TITLE=two words",
        "--dart-define-from-file=config/staging.env",
        "--no-pub",
        "--dart-entrypoint-args=--route",
        "--dart-entrypoint-args=two words",
      ],
      workingDirectory: path.join(canonicalRoot, "mobile"),
      beforeLaunch: [
        {
          executable: flutterExecutable,
          arguments: ["pub", "get"],
          workingDirectory: path.join(canonicalRoot, "mobile"),
        },
        {
          executable: "/bin/bash",
          arguments: ["-lc", "echo prepared"],
          workingDirectory: canonicalRoot,
        },
      ],
      environment: definition.environment,
    });
    expect(materialized.effectiveCommand).toContain(
      "flutter run --profile --target=lib/main.dart --device-id=chrome --flavor=staging",
    );
    expect(materialized.effectiveCommand).toContain(
      "'--dart-entrypoint-args=two words'",
    );
  });

  it("applies typed Windows launch and environment overrides through Command Prompt", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "windows", "lib"), { recursive: true });
    await writeFile(
      path.join(root, "windows", "pubspec.yaml"),
      "name: windows_app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(
      path.join(root, "windows", "lib", "main.dart"),
      "void main() {}\n",
    );
    const definition = flutterRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows Flutter",
    });
    const materialized = await flutterRunConfigurationProvider.materialize(
      {
        ...definition,
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            workingDirectory: "windows",
            arguments: ["two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: {
              deviceId: "windows",
              flavor: null,
              mode: "release",
              dartDefines: [],
              dartDefineFiles: [],
              usePub: true,
            },
          },
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized.executable).toBe("cmd.exe");
    expect(materialized.arguments.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(materialized.arguments[3]).toContain(
      'flutter.bat run --release --target=lib/main.dart --device-id=windows --pub "--dart-entrypoint-args=two words"',
    );
    expect(materialized.environment).toMatchObject({
      includeCodexEnvironment: false,
      files: [".env.windows"],
    });
    expect(
      flutterRunConfigurationProvider.renderEffectiveCommand(
        {
          ...definition,
          options: {
            ...definition.options,
            sdkHome: "C:\\Program Files\\Flutter",
          },
        },
        "win32",
      ),
    ).toContain('"C:\\Program Files\\Flutter\\bin\\flutter.bat" run');
  });

  it("fails closed for invalid projects, targets, define files, SDKs, and provider tasks", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "lib"));
    await writeFile(path.join(root, "lib", "main.dart"), "void main() {}\n");
    const definition = flutterRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Flutter",
    });
    await expect(
      flutterRunConfigurationProvider.validate(definition, {
        platform: "linux",
        targetRoot: root,
        defaultShell: "/bin/sh",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ code: "flutter-package-invalid" }),
    ]);
    await writeFile(
      path.join(root, "pubspec.yaml"),
      "name: mobile\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const diagnostics = await flutterRunConfigurationProvider.validate(
      {
        ...definition,
        target: { kind: "entrypoint", path: "lib/missing.dart" },
        beforeLaunch: [{ kind: "providerTask", task: "build" }],
        options: {
          ...definition.options,
          sdkHome: "relative/sdk",
          dartDefineFiles: ["config/missing.env"],
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      "flutter-dart-define-file-invalid",
      "flutter-entrypoint-invalid",
      "flutter-provider-task-invalid",
      "flutter-sdk-invalid",
    ]);
    await expect(
      flutterRunConfigurationProvider.validate(
        {
          ...definition,
          commandOverride: "echo overridden",
          target: { kind: "entrypoint", path: "lib/missing.dart" },
          options: {
            ...definition.options,
            sdkHome: "relative/sdk",
            dartDefineFiles: ["config/missing.env"],
          },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([]);
  });
});

describe("rustRunConfigurationProvider", () => {
  it("discovers Cargo workspace binaries and examples without executing manifests or crossing ignored and symlinked directories", async () => {
    const root = await createRoot();
    const outside = await createRoot();
    await mkdir(path.join(root, "crates", "api", "src"), { recursive: true });
    await mkdir(path.join(root, "crates", "api", "examples"), {
      recursive: true,
    });
    await mkdir(path.join(root, "crates", "cli", "src", "bin"), {
      recursive: true,
    });
    await mkdir(path.join(root, "crates", "cli", "examples", "demo"), {
      recursive: true,
    });
    await mkdir(path.join(root, "crates", "library", "src"), {
      recursive: true,
    });
    await mkdir(path.join(root, "disabled", "src"), { recursive: true });
    await mkdir(path.join(root, "vendor", "vendored", "src"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/*"]\nresolver = "3"\n',
    );
    await writeFile(
      path.join(root, "crates", "api", "Cargo.toml"),
      [
        "[package]",
        'name = "api"',
        'version = "0.1.0"',
        'default-run = "server"',
        "",
        "[features]",
        "server = []",
        "",
        "[[bin]]",
        'name = "server"',
        'path = "src/main.rs"',
        'required-features = ["server"]',
        "",
        "[[example]]",
        'name = "quickstart"',
        'path = "examples/quickstart.rs"',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "crates", "api", "src", "main.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "crates", "api", "examples", "quickstart.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "crates", "cli", "Cargo.toml"),
      '[package]\nname = "cli"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(root, "crates", "cli", "src", "main.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "crates", "cli", "src", "bin", "admin.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "crates", "cli", "examples", "demo", "main.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "crates", "library", "Cargo.toml"),
      '[package]\nname = "library"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(root, "crates", "library", "src", "lib.rs"),
      "pub fn value() -> u8 { 1 }\n",
    );
    await writeFile(
      path.join(root, "disabled", "Cargo.toml"),
      '[package]\nname = "disabled"\nversion = "0.1.0"\nautobins = false\n',
    );
    await writeFile(
      path.join(root, "disabled", "src", "main.rs"),
      "fn main() {}\n",
    );
    await writeFile(
      path.join(root, "vendor", "vendored", "Cargo.toml"),
      '[package]\nname = "vendored"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(root, "vendor", "vendored", "src", "main.rs"),
      "fn main() {}\n",
    );
    await mkdir(path.join(outside, "src"));
    await writeFile(
      path.join(outside, "Cargo.toml"),
      '[package]\nname = "escaped"\nversion = "0.1.0"\n',
    );
    await writeFile(path.join(outside, "src", "main.rs"), "fn main() {}\n");
    await symlink(outside, path.join(root, "linked-cargo-package"));

    const candidates = await rustRunConfigurationProvider.discover({
      platform: "linux",
      targetRoot: root,
      defaultShell: "/bin/sh",
    });
    expect(candidates).toHaveLength(5);
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            provider: "rust",
            workingDirectory: "crates/api",
            target: { kind: "binary", package: "api", name: "server" },
            options: expect.objectContaining({ features: ["server"] }),
            environment: expect.objectContaining({
              includeCodexEnvironment: true,
            }),
          }),
        }),
        expect.objectContaining({
          confidence: "high",
          document: expect.objectContaining({
            workingDirectory: "crates/cli",
            target: { kind: "binary", package: "cli", name: "cli" },
          }),
        }),
        expect.objectContaining({
          confidence: "medium",
          document: expect.objectContaining({
            target: { kind: "example", package: "cli", name: "demo" },
          }),
        }),
      ]),
    );
    expect(new Set(candidates.map(({ document }) => document.id)).size).toBe(
      candidates.length,
    );
    expect(
      candidates.some(({ document, reason }) =>
        [document.target.package, reason].some((value) =>
          /disabled|escaped|library|vendored/u.test(value),
        ),
      ),
    ).toBe(false);
  });

  it("validates explicit Rustup toolchains from the launch environment without executing them", async () => {
    const root = await createRoot();
    const cargoHome = path.join(root, "cargo-bin");
    const rustupHome = path.join(root, "rustup");
    const installedToolchain = "nightly-2026-08-01-x86_64-unknown-linux-gnu";
    const toolchainBin = path.join(
      rustupHome,
      "toolchains",
      installedToolchain,
      "bin",
    );
    const marker = path.join(root, "executed.txt");
    await Promise.all([
      mkdir(path.join(root, "src"), { recursive: true }),
      mkdir(cargoHome, { recursive: true }),
      mkdir(toolchainBin, { recursive: true }),
    ]);
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "api"\nversion = "0.1.0"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\n',
    );
    await writeFile(path.join(root, "src", "server.rs"), "fn main() {}\n");
    const executableBody = `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`;
    const cargo = path.join(cargoHome, "cargo");
    const toolchainCargo = path.join(toolchainBin, "cargo");
    await Promise.all([
      writeFile(cargo, executableBody),
      writeFile(toolchainCargo, executableBody),
    ]);
    await Promise.all([chmod(cargo, 0o755), chmod(toolchainCargo, 0o755)]);
    const definition = rustRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Rust API",
    });
    const document = {
      ...definition,
      target: { kind: "binary" as const, package: "api", name: "server" },
      options: {
        ...definition.options,
        toolchain: "nightly-2026-08-01",
      },
    };
    const context = {
      defaultShell: "/bin/sh",
      environment: { PATH: cargoHome, RUSTUP_HOME: rustupHome },
      platform: "linux" as const,
      targetRoot: root,
    };

    await expect(
      rustRunConfigurationProvider.validate(document, context),
    ).resolves.toEqual([]);
    await expect(
      rustRunConfigurationProvider.validate(
        {
          ...document,
          options: { ...document.options, toolchain: "default" },
        },
        {
          ...context,
          environment: {
            ...context.environment,
            RUSTUP_TOOLCHAIN: "nightly-2026-08-01",
          },
        },
      ),
    ).resolves.toEqual([]);
    await expect(
      rustRunConfigurationProvider.validate(
        {
          ...document,
          options: { ...document.options, toolchain: "nightly-2026-08-02" },
        },
        context,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        code: "rust-toolchain-unavailable",
        field: "options.toolchain",
        severity: "error",
      }),
    ]);
    await expect(access(marker)).rejects.toThrow();
  });

  it("materializes toolchain, package, target, feature, profile, target-triple, lock, program argument, environment, and ordered task controls", async () => {
    const root = await createRoot();
    const canonicalRoot = await realpath(root);
    await mkdir(path.join(root, "api", "src"), { recursive: true });
    await writeFile(
      path.join(root, "api", "Cargo.toml"),
      '[package]\nname = "api"\nversion = "0.1.0"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\nrequired-features = ["tls"]\n',
    );
    await writeFile(
      path.join(root, "api", "src", "server.rs"),
      "fn main() {}\n",
    );
    const definition = rustRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Rust API",
    });
    const materialized = await rustRunConfigurationProvider.materialize(
      {
        ...definition,
        workingDirectory: "api",
        target: { kind: "binary", package: "api", name: "server" },
        arguments: ["--listen", "two words"],
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        beforeLaunch: [
          { kind: "providerTask", task: "build" },
          { kind: "command", command: "echo prepared", workingDirectory: "." },
        ],
        options: {
          toolchain: "nightly-2026-08-01",
          features: ["tls", "tracing"],
          allFeatures: false,
          useDefaultFeatures: false,
          targetTriple: "aarch64-apple-darwin",
          profile: "release-lto",
          locked: true,
          offline: true,
        },
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/bash" },
    );
    const cargoOptions = [
      "+nightly-2026-08-01",
      "run",
      "--package=api",
      "--bin=server",
      "--features=tls",
      "--features=tracing",
      "--no-default-features",
      "--target=aarch64-apple-darwin",
      "--profile=release-lto",
      "--locked",
      "--offline",
    ];
    expect(materialized).toMatchObject({
      executable: "cargo",
      arguments: [...cargoOptions, "--", "--listen", "two words"],
      workingDirectory: path.join(canonicalRoot, "api"),
      beforeLaunch: [
        {
          executable: "cargo",
          arguments: ["+nightly-2026-08-01", "build", ...cargoOptions.slice(2)],
          workingDirectory: path.join(canonicalRoot, "api"),
        },
        {
          executable: "/bin/bash",
          arguments: ["-lc", "echo prepared"],
          workingDirectory: canonicalRoot,
        },
      ],
      environment: {
        includeCodexEnvironment: true,
        files: [".env"],
      },
    });
    expect(materialized.effectiveCommand).toContain(
      "cargo +nightly-2026-08-01 run --package=api --bin=server --features=tls --features=tracing",
    );
    expect(materialized.effectiveCommand).toContain("-- --listen 'two words'");
  });

  it("applies typed Windows Cargo and environment overrides", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "windows", "examples"), { recursive: true });
    await writeFile(
      path.join(root, "windows", "Cargo.toml"),
      '[package]\nname = "demo"\nversion = "0.1.0"\n',
    );
    await writeFile(
      path.join(root, "windows", "examples", "quickstart.rs"),
      "fn main() {}\n",
    );
    const definition = rustRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Run Windows Rust",
    });
    const materialized = await rustRunConfigurationProvider.materialize(
      {
        ...definition,
        target: { kind: "example", package: "demo", name: "quickstart" },
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [],
          secrets: [],
        },
        platformOverrides: {
          win32: {
            workingDirectory: "windows",
            arguments: ["two words"],
            environment: {
              includeCodexEnvironment: false,
              files: [".env.windows"],
            },
            options: {
              toolchain: "stable",
              features: [],
              allFeatures: true,
              useDefaultFeatures: true,
              targetTriple: null,
              profile: "release",
              locked: false,
              offline: false,
            },
          },
        },
      },
      { platform: "win32", targetRoot: root, defaultShell: null },
    );
    expect(materialized).toMatchObject({
      executable: "cargo.exe",
      arguments: [
        "+stable",
        "run",
        "--package=demo",
        "--example=quickstart",
        "--all-features",
        "--release",
        "--",
        "two words",
      ],
      environment: {
        includeCodexEnvironment: false,
        files: [".env.windows"],
      },
      effectiveCommand:
        'cargo.exe +stable run --package=demo --example=quickstart --all-features --release -- "two words"',
    });
  });

  it("fails closed for missing packages, targets, required features, and unsupported provider tasks while honoring complete command overrides", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "Cargo.toml"),
      '[package]\nname = "api"\nversion = "0.1.0"\n\n[[bin]]\nname = "server"\npath = "src/server.rs"\nrequired-features = ["tls"]\n',
    );
    await writeFile(path.join(root, "src", "server.rs"), "fn main() {}\n");
    const definition = rustRunConfigurationProvider.createDefault({
      id: randomUUID(),
      name: "Invalid Rust",
    });
    await expect(
      rustRunConfigurationProvider.validate(
        {
          ...definition,
          target: { kind: "binary", package: "missing", name: "server" },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ code: "cargo-package-missing" }),
    ]);
    await expect(
      rustRunConfigurationProvider.validate(
        {
          ...definition,
          target: { kind: "binary", package: "api", name: "missing" },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ code: "cargo-target-missing" }),
    ]);
    const diagnostics = await rustRunConfigurationProvider.validate(
      {
        ...definition,
        target: { kind: "binary", package: "api", name: "server" },
        beforeLaunch: [{ kind: "providerTask", task: "publish" }],
      },
      { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
    );
    expect(diagnostics.map(({ code }) => code).sort()).toEqual([
      "cargo-target-features-missing",
      "rust-provider-task-invalid",
    ]);
    await expect(
      rustRunConfigurationProvider.validate(
        {
          ...definition,
          commandOverride: "echo overridden",
          target: { kind: "binary", package: "missing", name: "missing" },
        },
        { platform: "linux", targetRoot: root, defaultShell: "/bin/sh" },
      ),
    ).resolves.toEqual([]);
  });
});
