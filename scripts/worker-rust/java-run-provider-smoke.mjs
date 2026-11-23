import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConfigurationJavaDocumentSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function verifyJavaRunProvider({
  call,
  projectId,
  checkout,
  save,
  launchAndWait,
  readTail,
}) {
  const workspace = path.join(checkout, "java workspace");
  const gradle = path.join(workspace, "gradle");
  const gradleApp = path.join(gradle, "modules", "app");
  const maven = path.join(workspace, "maven");
  const service = path.join(maven, "service");
  const jdk = path.join(workspace, "JDK fixture");
  const marker = path.join(workspace, "build-tool-invocations");
  for (const folder of [
    path.join(gradleApp, "src/main/java/demo"),
    path.join(service, "src/main/java/demo"),
    path.join(jdk, "bin"),
    path.join(gradle, "build", "generated", "src"),
  ]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(
    path.join(gradle, "settings.gradle"),
    "rootProject.name = 'java-fixture'\ninclude ':application'\nproject(':application').projectDir = file('modules/app')\n",
  );
  await writeFile(
    path.join(gradleApp, "build.gradle"),
    "plugins { id 'application' }\napplication { mainClass.set('demo.GradleMain') }\ntasks.register('seedData', JavaExec)\n",
  );
  await writeFile(
    path.join(gradleApp, "src/main/java/demo/GradleMain.java"),
    [
      "package demo;",
      "public class GradleMain {",
      "  public static void main(String... args) {",
      '    System.out.println("gradle-java-args=" + String.join("|", args));',
      '    System.out.println("gradle-java-vm=" + System.getProperty("fixture.vm"));',
      "  }",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(gradle, "build", "generated", "src", "Hidden.java"),
    "public class Hidden { public static void main(String[] args) {} }",
  );
  await writeFile(
    path.join(gradleApp, "src/main/java/demo/Commented.java"),
    "// public static void main(String[] args) {}\nclass Commented {}\n",
  );
  await writeFile(
    path.join(maven, "pom.xml"),
    "<project><artifactId>parent</artifactId><modules><module>service</module></modules></project>\n",
  );
  await writeFile(
    path.join(service, "pom.xml"),
    "<project><parent><artifactId>inherited</artifactId></parent><artifactId>service-app</artifactId><mainClass>demo.MavenMain</mainClass><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>\n",
  );
  await writeFile(
    path.join(service, "src/main/java/demo/MavenMain.java"),
    "package demo; public class MavenMain { public static void main(java.lang.String args[]) {} }\n",
  );
  await symlink(gradle, path.join(workspace, "linked-gradle"));

  const tool = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${quote(marker)}`,
    "printf 'java-home=<%s>\\n' \"$JAVA_HOME\"",
    "printf 'java-vm=<%s>\\n' \"$JAVA_TOOL_OPTIONS\"",
    "printf 'java-argv=<%s>\\n' \"$@\"",
    "previous=",
    'for argument in "$@"; do',
    '  if [ "$previous" = "--init-script" ]; then',
    "    /usr/bin/grep -q '_cantripRunConfigurationJava' \"$argument\" || exit 24",
    "  fi",
    '  previous="$argument"',
    "done",
    "",
  ].join("\n");
  await writeFile(path.join(gradle, "gradlew"), tool, { mode: 0o755 });
  await writeFile(path.join(maven, "mvnw"), tool, { mode: 0o755 });
  await writeFile(path.join(jdk, "bin", "java"), tool, { mode: 0o755 });
  await writeFile(
    path.join(checkout, ".env.java-run"),
    "JAVA_HOME=/discarded-by-provider\nJAVA_TOOL_OPTIONS=-Ddiscarded=1\n",
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
    runConfigurationJavaDocumentSchema.parse({
      schema: "cantrip.run-configuration",
      version: 1,
      id: randomUUID(),
      name,
      provider: "java",
      workingDirectory: "java workspace/gradle",
      target: { kind: "gradleTask", projectPath: ":application", task: "run" },
      environment: { includeCodexEnvironment: false, files: [".env.java-run"] },
      options: { jdkHome: jdk },
      ...fields,
    });
  const gradleMain = definition("Gradle generated main launcher", {
    target: {
      kind: "gradleMainClass",
      projectPath: ":application",
      className: "demo.GradleMain",
    },
    options: {
      jdkHome: jdk,
      buildToolArguments: ["--offline"],
      vmArguments: ["-Dfixture.vm=two words"],
    },
    arguments: ["base"],
    platformOverrides: {
      [process.platform]: { arguments: ["two words", "🛠"] },
    },
    beforeLaunch: [
      { kind: "providerTask", task: "classes" },
      { kind: "command", command: "printf 'java-before\\n'" },
    ],
  });
  const gradleTask = definition("Gradle task VM environment", {
    options: { jdkHome: jdk, vmArguments: ["-Dfixture.vm=two words"] },
    arguments: ["arg with spaces"],
  });
  const mavenMain = definition("Maven pinned exec goal and selected module", {
    workingDirectory: "java workspace/maven",
    target: {
      kind: "mavenMainClass",
      module: ":service-app",
      className: "demo.MavenMain",
    },
    arguments: ["maven arg"],
    options: {
      jdkHome: jdk,
      buildToolArguments: ["--offline"],
      vmArguments: ["-Dfixture.vm=two words"],
    },
    beforeLaunch: [{ kind: "providerTask", task: "verify" }],
  });
  const mavenGoal = definition("Maven Spring application goal", {
    workingDirectory: "java workspace/maven",
    target: { kind: "mavenGoal", module: "service", goal: "spring-boot:run" },
    arguments: ["spring arg"],
  });
  const override = definition("Java custom command and build task", {
    commandOverride: "printf 'java-override=%s\\n'",
    arguments: ["two words"],
    beforeLaunch: [{ kind: "providerTask", task: "classes" }],
  });

  try {
    const detectId = randomUUID();
    const detected = await call(
      "GET",
      `${prefix}/detect?operationId=${detectId}&provider=java`,
    );
    assert.equal(detected.status, 200, JSON.stringify(detected));
    const comparable = ({ candidates, ...rest }) => ({
      ...rest,
      candidates: candidates.map(({ document, ...candidate }) => ({
        ...candidate,
        document: { ...document, id: null },
      })),
    });
    assert.deepEqual(
      comparable(detected.body),
      comparable(await expected("detect", detectId, { providerKind: "java" })),
    );
    assert.equal(detected.body.candidates.length, 5);
    assert.ok(
      detected.body.candidates.every(
        ({ document }) => document.options.useWrapper,
      ),
    );

    for (const document of [
      gradleMain,
      gradleTask,
      mavenMain,
      mavenGoal,
      override,
      definition("Invalid Java wrapper and project", {
        workingDirectory: ".",
        options: { jdkHome: "relative/jdk" },
      }),
      definition("Invalid Maven goal", {
        workingDirectory: "java workspace/maven",
        target: {
          kind: "mavenGoal",
          module: ":service-app",
          goal: "missing:goal",
        },
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
    for (const document of [
      gradleMain,
      gradleTask,
      mavenMain,
      mavenGoal,
      override,
    ]) {
      await save(document);
    }
    const listId = randomUUID();
    const inventory = await call("GET", `${prefix}?operationId=${listId}`);
    assert.equal(inventory.status, 200, JSON.stringify(inventory));
    assert.deepEqual(inventory.body, await expected("list", listId));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    oracle.close();
  }

  const run = async (document) => {
    const result = await launchAndWait(document.id, "exited");
    const output = (await readTail(result)).data.replaceAll("\r", "");
    assert.equal(result.exitCode, 0, output);
    return output;
  };
  const launcherOutput = await run(gradleMain);
  assert.match(
    launcherOutput,
    /java-argv=<:application:classes>[\s\S]*java-before[\s\S]*java-argv=<:application:_cantripRunConfigurationJava>/u,
  );
  for (const [key, value] of [
    ["cantripArguments", ["two words", "🛠"]],
    ["cantripVmArguments", ["-Dfixture.vm=two words"]],
  ]) {
    const encoded = launcherOutput.match(
      new RegExp(`-P${key}=([^>]+)>`, "u"),
    )?.[1];
    assert.ok(encoded, launcherOutput);
    assert.deepEqual(
      JSON.parse(Buffer.from(encoded, "base64").toString()),
      value,
    );
  }
  const initScript = launcherOutput.match(
    /java-argv=<--init-script>\njava-argv=<([^>]+)>/u,
  )?.[1];
  assert.ok(initScript, launcherOutput);
  await assert.rejects(readFile(initScript), { code: "ENOENT" });
  assert.match(launcherOutput, /java-vm=<-Ddiscarded=1>/u);

  const taskOutput = await run(gradleTask);
  assert.match(taskOutput, /java-vm=<"-Dfixture.vm=two words">/u);
  assert.match(taskOutput, /java-argv=<--args='arg with spaces'>/u);
  assert.ok(taskOutput.includes(`java-home=<${jdk}>`));

  const mavenOutput = await run(mavenMain);
  assert.match(
    mavenOutput,
    /java-argv=<-pl>\njava-argv=<:service-app>\njava-argv=<-am>\njava-argv=<verify>/u,
  );
  assert.match(
    mavenOutput,
    /java-argv=<org\.codehaus\.mojo:exec-maven-plugin:3\.5\.1:java>\njava-argv=<-Dexec\.mainClass=demo\.MavenMain>\njava-argv=<-Dexec\.args='maven arg'>/u,
  );
  assert.match(
    await run(mavenGoal),
    /java-argv=<spring-boot:run>\njava-argv=<-Dspring-boot\.run\.arguments='spring arg'>/u,
  );
  assert.match(
    await run(override),
    /java-argv=<:application:classes>[\s\S]*java-override=two words/u,
  );

  const gradleBin = process.env.CANTRIP_TEST_GRADLE;
  const javaHome = process.env.CANTRIP_TEST_JDK_HOME;
  if (gradleBin && javaHome) {
    const home = path.join(gradle, ".gradle", "test-home");
    await mkdir(home, { recursive: true });
    const environment = {
      PATH: [path.dirname(gradleBin), "/usr/bin", "/bin"].join(path.delimiter),
      GRADLE_USER_HOME: home,
    };
    await writeFile(
      path.join(checkout, ".env.java-gradle"),
      Object.entries(environment)
        .map(([name, value]) => `${name}=${quote(value)}\n`)
        .join(""),
    );
    const real = definition("Real Gradle and JVM launch", {
      target: gradleMain.target,
      arguments: ["two words", "🛠"],
      options: {
        jdkHome: javaHome,
        useWrapper: false,
        buildToolArguments: [
          "--offline",
          "--no-daemon",
          "--max-workers=2",
          "--console=plain",
        ],
        vmArguments: ["-Dfixture.vm=two words"],
      },
      environment: {
        includeCodexEnvironment: false,
        files: [".env.java-gradle"],
      },
    });
    await save(real);
    const output = await run(real);
    assert.match(
      output,
      /gradle-java-args=two words\|🛠\ngradle-java-vm=two words/u,
    );
  }
}
