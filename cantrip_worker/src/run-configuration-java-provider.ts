import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  runConfigurationJavaDocumentSchema,
  runConfigurationProviderCapabilitySchema,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationJavaDocument,
  type RunConfigurationPlatform,
} from "@cantrip/protocol/run-configuration-definitions";

import {
  resolveRealDirectory,
  runConfigurationProviderDiagnostic,
  shellCommandInvocation,
  validateRealScript,
  type MaterializedRunCommand,
  type RunConfigurationProvider,
  type RunConfigurationProviderCandidate,
  type RunConfigurationProviderContext,
} from "./run-configuration-provider.js";

const MAX_DISCOVERY_DIRECTORIES = 1_024;
const MAX_DISCOVERY_DEPTH = 10;
const MAX_DISCOVERY_MANIFESTS = 256;
const MAX_DISCOVERY_SOURCES = 512;
const MAX_DISCOVERY_CANDIDATES = 128;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const GRADLE_MAIN_TASK = "_cantripRunConfigurationJava";
const MAVEN_EXEC_GOAL = "org.codehaus.mojo:exec-maven-plugin:3.5.1:java";
const IGNORED_DIRECTORIES = new Set([
  ".cantrip",
  ".git",
  ".gradle",
  ".idea",
  ".mvn-cache",
  ".settings",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const GRADLE_INIT_SCRIPT = `
import groovy.json.JsonSlurper

def cantripDecodeList = { value ->
  if (!value) return []
  def json = new String(Base64.decoder.decode(value), 'UTF-8')
  return new JsonSlurper().parseText(json)
}

gradle.beforeProject { project ->
  project.plugins.withId('java') {
    if (project.tasks.findByName('${GRADLE_MAIN_TASK}') == null) {
      project.tasks.register('${GRADLE_MAIN_TASK}', JavaExec) {
        group = 'application'
        description = 'Cantrip managed Java main-class launcher'
        classpath = project.extensions.getByName('sourceSets').getByName('main').runtimeClasspath
        mainClass.set(project.providers.gradleProperty('cantripMainClass'))
        args(cantripDecodeList(project.findProperty('cantripArguments')))
        jvmArgs(cantripDecodeList(project.findProperty('cantripVmArguments')))
      }
    }
  }
}
`.trimStart();

let gradleInitScriptPromise: Promise<string> | null = null;

type JavaPlatformOverride = NonNullable<
  RunConfigurationJavaDocument["platformOverrides"]["win32"]
>;

interface ResolvedJavaConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  options: RunConfigurationJavaDocument["options"];
  workingDirectory: string;
}

interface ScannedMainClass {
  className: string;
  directory: string;
  relativePath: string;
}

interface ScannedDirectory {
  directory: string;
  gradleBuild: string | null;
  gradleSettings: string | null;
  mavenPom: string | null;
}

interface JavaModule {
  artifactId: string | null;
  declaredMainClass: string | null;
  directory: string;
  gradleTasks: string[];
  mainClasses: ScannedMainClass[];
  selector: string | null;
}

interface JavaBuild {
  directory: string;
  modules: JavaModule[];
  system: "gradle" | "maven";
}

interface ProjectScan {
  builds: JavaBuild[];
}

function candidateName(value: string): string {
  return value.slice(0, 200);
}

function portableJoin(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function depth(directory: string): number {
  return directory === "." ? 0 : directory.split("/").length;
}

function isAtOrBelow(directory: string, parent: string): boolean {
  return parent === "."
    ? true
    : directory === parent || directory.startsWith(`${parent}/`);
}

function relativeDirectory(parent: string, child: string): string {
  if (parent === ".") return child;
  if (parent === child) return ".";
  return child.slice(parent.length + 1);
}

function mainsForModule(
  mains: ScannedMainClass[],
  moduleDirectory: string,
  moduleDirectories: string[],
): ScannedMainClass[] {
  const nestedModules = moduleDirectories.filter(
    (candidate) =>
      candidate !== moduleDirectory && isAtOrBelow(candidate, moduleDirectory),
  );
  return mains.filter(
    ({ directory }) =>
      isAtOrBelow(directory, moduleDirectory) &&
      !nestedModules.some((nested) => isAtOrBelow(directory, nested)),
  );
}

function normalizeModulePath(value: string): string | null {
  const normalized = value.trim().replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

async function readBoundedText(
  filePath: string,
  maximumBytes: number,
): Promise<string | null> {
  try {
    const metadata = await lstat(filePath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > maximumBytes
    ) {
      return null;
    }
    const value = await readFile(filePath, "utf8");
    return value.includes("\0") ? null : value;
  } catch {
    return null;
  }
}

function withoutJavaComments(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\r\n]*/gu, " ");
}

function javaMainClass(source: string, fileName: string): string | null {
  const cleaned = withoutJavaComments(source);
  if (
    !/\bpublic\s+(?:final\s+)?static\s+(?:final\s+)?void\s+main\s*\(\s*(?:final\s+)?(?:java\.lang\.)?String(?:\s*\[\s*\]\s*[A-Za-z_$]|\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\[\s*\]|\s*\.\.\.\s*[A-Za-z_$])/u.test(
      cleaned,
    )
  ) {
    return null;
  }
  const simpleName = fileName.replace(/\.java$/u, "");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(simpleName)) return null;
  const packageName = cleaned.match(
    /\bpackage\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*;/u,
  )?.[1];
  return packageName ? `${packageName}.${simpleName}` : simpleName;
}

function firstMatch(value: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = value.match(pattern)?.[1]?.trim();
    if (
      match &&
      /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(match)
    ) {
      return match;
    }
  }
  return null;
}

function gradleDeclaredMainClass(value: string): string | null {
  return firstMatch(value, [
    /\bmainClass(?:Name)?\s*(?:\.set\s*\()?\s*["']([^"']+)["']/u,
    /\bmainClass(?:Name)?\s*=\s*["']([^"']+)["']/u,
  ]);
}

function mavenDeclaredMainClass(value: string): string | null {
  return firstMatch(value, [
    /<mainClass>\s*([^<]+?)\s*<\/mainClass>/u,
    /<start-class>\s*([^<]+?)\s*<\/start-class>/u,
  ]);
}

function mavenArtifactId(value: string): string | null {
  const projectWithoutParent = value.replace(
    /<parent\b[^>]*>[\s\S]*?<\/parent>/u,
    "",
  );
  return (
    projectWithoutParent
      .match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/u)?.[1]
      ?.trim() ?? null
  );
}

function mavenModules(value: string): string[] {
  const modules: string[] = [];
  const pattern = /<module>\s*([^<]+?)\s*<\/module>/gu;
  for (const match of value.matchAll(pattern)) {
    const normalized = normalizeModulePath(match[1] ?? "");
    if (normalized && !modules.includes(normalized)) modules.push(normalized);
    if (modules.length >= 128) break;
  }
  return modules;
}

function gradleTasks(value: string): string[] {
  const tasks = new Set<string>();
  if (/\bapplication\b/u.test(value) || /\bmainClass(?:Name)?\b/u.test(value)) {
    tasks.add("run");
  }
  if (/org\.springframework\.boot|spring-boot/u.test(value)) {
    tasks.add("bootRun");
  }
  if (/io\.quarkus/u.test(value)) tasks.add("quarkusDev");
  const patterns = [
    /tasks\.(?:register|create)\s*<\s*JavaExec\s*>\s*\(\s*["']([A-Za-z0-9_.-]+)["']/gu,
    /tasks\.(?:register|create)\s*\(\s*["']([A-Za-z0-9_.-]+)["'][^\n)]*\bJavaExec\b/gu,
    /\btask\s+([A-Za-z0-9_.-]+)\s*\([^\n)]*type\s*:\s*JavaExec/gu,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (match[1]) tasks.add(match[1]);
      if (tasks.size >= 64) break;
    }
  }
  return [...tasks].sort();
}

function gradleProjectDirectoryMap(value: string): Map<string, string> {
  const projects = new Map<string, string>();
  const pattern =
    /project\s*\(\s*["'](:[A-Za-z0-9_.:-]+)["']\s*\)\.projectDir\s*=\s*(?:file\s*\(|new\s+File\s*\(\s*rootDir\s*,\s*)["']([^"']+)["']/gu;
  for (const match of value.matchAll(pattern)) {
    const projectPath = match[1];
    const directory = normalizeModulePath(match[2] ?? "");
    if (projectPath && directory) projects.set(directory, projectPath);
    if (projects.size >= 128) break;
  }
  return projects;
}

function mavenGoals(value: string): string[] {
  const goals = new Set<string>();
  if (/spring-boot-maven-plugin/u.test(value)) goals.add("spring-boot:run");
  if (/exec-maven-plugin/u.test(value)) goals.add("exec:java");
  if (/quarkus-maven-plugin/u.test(value)) goals.add("quarkus:dev");
  return [...goals].sort();
}

async function scanProject(
  context: RunConfigurationProviderContext,
): Promise<ProjectScan> {
  const root = await realpath(context.targetRoot);
  const queue = [{ absolute: root, directory: ".", depth: 0 }];
  const directories: ScannedDirectory[] = [];
  const mains: ScannedMainClass[] = [];
  let visited = 0;
  let manifests = 0;
  while (
    queue.length > 0 &&
    visited < MAX_DISCOVERY_DIRECTORIES &&
    manifests < MAX_DISCOVERY_MANIFESTS
  ) {
    const current = queue.shift()!;
    visited += 1;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const regularFiles = new Set(
      entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map(({ name }) => name),
    );
    const settingsName = regularFiles.has("settings.gradle.kts")
      ? "settings.gradle.kts"
      : regularFiles.has("settings.gradle")
        ? "settings.gradle"
        : null;
    const buildName = regularFiles.has("build.gradle.kts")
      ? "build.gradle.kts"
      : regularFiles.has("build.gradle")
        ? "build.gradle"
        : null;
    const hasPom = regularFiles.has("pom.xml");
    if (settingsName || buildName || hasPom) {
      manifests +=
        Number(Boolean(settingsName)) +
        Number(Boolean(buildName)) +
        Number(hasPom);
      directories.push({
        directory: current.directory,
        gradleBuild: buildName
          ? await readBoundedText(
              path.join(current.absolute, buildName),
              MAX_METADATA_BYTES,
            )
          : null,
        gradleSettings: settingsName
          ? await readBoundedText(
              path.join(current.absolute, settingsName),
              MAX_METADATA_BYTES,
            )
          : null,
        mavenPom: hasPom
          ? await readBoundedText(
              path.join(current.absolute, "pom.xml"),
              MAX_METADATA_BYTES,
            )
          : null,
      });
    }
    if (mains.length < MAX_DISCOVERY_SOURCES) {
      for (const fileName of [...regularFiles].filter((name) =>
        name.endsWith(".java"),
      )) {
        if (mains.length >= MAX_DISCOVERY_SOURCES) break;
        const relativePath = portableJoin(current.directory, fileName);
        if (!relativePath.split("/").includes("src")) continue;
        const source = await readBoundedText(
          path.join(current.absolute, fileName),
          MAX_SOURCE_BYTES,
        );
        const className = source ? javaMainClass(source, fileName) : null;
        if (className) {
          mains.push({ className, directory: current.directory, relativePath });
        }
      }
    }
    if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      queue.push({
        absolute: path.join(current.absolute, entry.name),
        directory: portableJoin(current.directory, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  const gradleDirectories = directories.filter(
    ({ gradleBuild, gradleSettings }) => gradleBuild || gradleSettings,
  );
  const settingsRoots = gradleDirectories
    .filter(({ gradleSettings }) => gradleSettings)
    .map(({ directory }) => directory);
  const gradleRoots = new Set(settingsRoots);
  for (const entry of gradleDirectories.filter(
    ({ gradleBuild }) => gradleBuild,
  )) {
    if (
      !settingsRoots.some((rootDirectory) =>
        isAtOrBelow(entry.directory, rootDirectory),
      )
    ) {
      gradleRoots.add(entry.directory);
    }
  }
  const builds: JavaBuild[] = [];
  for (const rootDirectory of [...gradleRoots].sort(
    (left, right) => depth(left) - depth(right) || left.localeCompare(right),
  )) {
    const rootSettings =
      gradleDirectories.find(({ directory }) => directory === rootDirectory)
        ?.gradleSettings ?? "";
    const projectDirectories = gradleProjectDirectoryMap(rootSettings);
    const nestedRoots = [...gradleRoots].filter(
      (candidate) =>
        candidate !== rootDirectory && isAtOrBelow(candidate, rootDirectory),
    );
    const moduleEntries = gradleDirectories.filter(
      (entry) =>
        entry.gradleBuild &&
        isAtOrBelow(entry.directory, rootDirectory) &&
        !nestedRoots.some((nested) => isAtOrBelow(entry.directory, nested)),
    );
    const moduleDirectories = moduleEntries.map(({ directory }) => directory);
    const modules = moduleEntries.map((entry): JavaModule => {
      const relative = relativeDirectory(rootDirectory, entry.directory);
      const selector =
        relative === "."
          ? ":"
          : (projectDirectories.get(relative) ??
            `:${relative.split("/").join(":")}`);
      const buildText = entry.gradleBuild ?? "";
      return {
        artifactId: null,
        declaredMainClass: gradleDeclaredMainClass(buildText),
        directory: entry.directory,
        gradleTasks: gradleTasks(buildText),
        mainClasses: mainsForModule(mains, entry.directory, moduleDirectories),
        selector,
      };
    });
    if (modules.length === 0) {
      modules.push({
        artifactId: null,
        declaredMainClass: null,
        directory: rootDirectory,
        gradleTasks: [],
        mainClasses: mainsForModule(mains, rootDirectory, [rootDirectory]),
        selector: ":",
      });
    }
    builds.push({ directory: rootDirectory, modules, system: "gradle" });
  }

  const pomByDirectory = new Map(
    directories
      .filter((entry): entry is ScannedDirectory & { mavenPom: string } =>
        Boolean(entry.mavenPom),
      )
      .map((entry) => [entry.directory, entry]),
  );
  const assignedPoms = new Set<string>();
  for (const rootDirectory of [...pomByDirectory.keys()].sort(
    (left, right) => depth(left) - depth(right) || left.localeCompare(right),
  )) {
    if (assignedPoms.has(rootDirectory)) continue;
    const moduleDirectories: string[] = [];
    const moduleQueue = [rootDirectory];
    while (moduleQueue.length > 0 && moduleDirectories.length < 128) {
      const directory = moduleQueue.shift()!;
      if (assignedPoms.has(directory) || moduleDirectories.includes(directory))
        continue;
      const entry = pomByDirectory.get(directory);
      if (!entry?.mavenPom) continue;
      moduleDirectories.push(directory);
      assignedPoms.add(directory);
      for (const declared of mavenModules(entry.mavenPom)) {
        const child = portableJoin(directory, declared);
        if (pomByDirectory.has(child)) moduleQueue.push(child);
      }
    }
    const modules = moduleDirectories.map((directory): JavaModule => {
      const entry = pomByDirectory.get(directory)!;
      const relative = relativeDirectory(rootDirectory, directory);
      return {
        artifactId: mavenArtifactId(entry.mavenPom ?? ""),
        declaredMainClass: mavenDeclaredMainClass(entry.mavenPom ?? ""),
        directory,
        gradleTasks: mavenGoals(entry.mavenPom ?? ""),
        mainClasses: mainsForModule(mains, directory, moduleDirectories),
        selector: relative === "." ? null : relative,
      };
    });
    builds.push({ directory: rootDirectory, modules, system: "maven" });
  }
  return { builds };
}

function baseDocument(input: {
  id: string;
  name: string;
}): Omit<RunConfigurationJavaDocument, "target"> {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1,
    id: input.id,
    name: input.name,
    provider: "java",
    workingDirectory: ".",
    commandOverride: null,
    arguments: [],
    environment: {
      includeCodexEnvironment: true,
      files: [],
      variables: [],
      secrets: [],
    },
    beforeLaunch: [],
    platformOverrides: {},
    options: {
      jdkHome: null,
      useWrapper: true,
      buildToolArguments: [],
      vmArguments: [],
    },
    stop: { gracePeriodMs: 3_000 },
  };
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: JavaPlatformOverride["environment"],
): RunConfigurationEnvironment {
  if (!override) return base;
  return {
    includeCodexEnvironment:
      override.includeCodexEnvironment ?? base.includeCodexEnvironment,
    files: override.files ?? base.files,
    variables: override.variables ?? base.variables,
    secrets: override.secrets ?? base.secrets,
  };
}

function resolveConfiguration(
  document: RunConfigurationJavaDocument,
  platform: RunConfigurationPlatform,
): ResolvedJavaConfiguration {
  const override = document.platformOverrides[platform];
  return {
    workingDirectory: override?.workingDirectory ?? document.workingDirectory,
    commandOverride:
      override && Object.hasOwn(override, "commandOverride")
        ? (override.commandOverride ?? null)
        : document.commandOverride,
    arguments: override?.arguments ?? document.arguments,
    environment: mergeEnvironment(document.environment, override?.environment),
    options: {
      jdkHome:
        override?.options && Object.hasOwn(override.options, "jdkHome")
          ? (override.options.jdkHome ?? null)
          : document.options.jdkHome,
      useWrapper: override?.options?.useWrapper ?? document.options.useWrapper,
      buildToolArguments:
        override?.options?.buildToolArguments ??
        document.options.buildToolArguments,
      vmArguments:
        override?.options?.vmArguments ?? document.options.vmArguments,
    },
  };
}

function targetBuildSystem(
  document: RunConfigurationJavaDocument,
): "gradle" | "maven" {
  return document.target.kind.startsWith("gradle") ? "gradle" : "maven";
}

function targetModule(document: RunConfigurationJavaDocument): string | null {
  switch (document.target.kind) {
    case "gradleTask":
    case "gradleMainClass":
      return document.target.projectPath;
    case "mavenGoal":
    case "mavenMainClass":
      return document.target.module;
  }
}

function quoteArgument(
  value: string,
  platform: RunConfigurationPlatform,
): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function renderCommand(
  executable: string,
  arguments_: string[],
  platform: RunConfigurationPlatform,
): string {
  return [
    executable,
    ...arguments_.map((value) => quoteArgument(value, platform)),
  ].join(" ");
}

function wrapperName(
  system: "gradle" | "maven",
  platform: RunConfigurationPlatform,
): string {
  if (system === "gradle")
    return platform === "win32" ? "gradlew.bat" : "gradlew";
  return platform === "win32" ? "mvnw.cmd" : "mvnw";
}

function systemExecutable(
  system: "gradle" | "maven",
  platform: RunConfigurationPlatform,
): string {
  if (platform !== "win32") return system === "gradle" ? "gradle" : "mvn";
  return system === "gradle" ? "gradle.bat" : "mvn.cmd";
}

function displayExecutable(
  system: "gradle" | "maven",
  resolved: ResolvedJavaConfiguration,
  platform: RunConfigurationPlatform,
): string {
  if (!resolved.options.useWrapper) return systemExecutable(system, platform);
  const name = wrapperName(system, platform);
  return platform === "win32" ? name : `./${name}`;
}

function qualifiedGradleTask(projectPath: string, task: string): string {
  if (task.startsWith(":")) return task;
  return projectPath === ":" ? task : `${projectPath}:${task}`;
}

function encodeList(values: string[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64");
}

function programArgumentString(
  values: string[],
  platform: RunConfigurationPlatform,
): string {
  return values.map((value) => quoteArgument(value, platform)).join(" ");
}

function renderedBuildArguments(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  platform: RunConfigurationPlatform,
): string[] {
  const common = [...resolved.options.buildToolArguments];
  switch (document.target.kind) {
    case "gradleTask":
      return [
        ...common,
        qualifiedGradleTask(document.target.projectPath, document.target.task),
        ...(resolved.arguments.length &&
        (document.target.task === "run" || document.target.task === "bootRun")
          ? [`--args=${programArgumentString(resolved.arguments, platform)}`]
          : resolved.arguments),
      ];
    case "gradleMainClass":
      return [
        ...common,
        "--init-script",
        "<cantrip-java-init.gradle>",
        `-PcantripMainClass=${document.target.className}`,
        qualifiedGradleTask(document.target.projectPath, GRADLE_MAIN_TASK),
        ...(resolved.arguments.length ? ["--", ...resolved.arguments] : []),
      ];
    case "mavenGoal": {
      const module = document.target.module
        ? ["-pl", document.target.module, "-am"]
        : [];
      const programArguments = resolved.arguments.length
        ? document.target.goal === "spring-boot:run"
          ? [
              `-Dspring-boot.run.arguments=${programArgumentString(resolved.arguments, platform)}`,
            ]
          : document.target.goal.endsWith("exec:java")
            ? [
                `-Dexec.args=${programArgumentString(resolved.arguments, platform)}`,
              ]
            : resolved.arguments
        : [];
      return [...common, ...module, document.target.goal, ...programArguments];
    }
    case "mavenMainClass":
      return [
        ...common,
        ...(document.target.module
          ? ["-pl", document.target.module, "-am"]
          : []),
        MAVEN_EXEC_GOAL,
        `-Dexec.mainClass=${document.target.className}`,
        ...(resolved.arguments.length
          ? [
              `-Dexec.args=${programArgumentString(resolved.arguments, platform)}`,
            ]
          : []),
      ];
  }
}

function actualBuildArguments(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  platform: RunConfigurationPlatform,
  gradleInitScript: string | null,
): string[] {
  if (document.target.kind !== "gradleMainClass") {
    return renderedBuildArguments(document, resolved, platform);
  }
  if (!gradleInitScript)
    throw new Error("The Gradle Java launcher is unavailable.");
  return [
    ...resolved.options.buildToolArguments,
    "--init-script",
    gradleInitScript,
    `-PcantripMainClass=${document.target.className}`,
    `-PcantripArguments=${encodeList(resolved.arguments)}`,
    `-PcantripVmArguments=${encodeList(resolved.options.vmArguments)}`,
    qualifiedGradleTask(document.target.projectPath, GRADLE_MAIN_TASK),
  ];
}

function javaToolOptions(values: string[]): string {
  return values
    .map((value) =>
      /\s|"/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value,
    )
    .join(" ");
}

function renderEnvironmentPrefix(
  command: string,
  resolved: ResolvedJavaConfiguration,
  platform: RunConfigurationPlatform,
  includeVmArguments: boolean,
): string {
  const values: Array<[string, string]> = [];
  if (resolved.options.jdkHome)
    values.push(["JAVA_HOME", resolved.options.jdkHome]);
  if (resolved.options.vmArguments.length > 0 && includeVmArguments) {
    values.push([
      "JAVA_TOOL_OPTIONS",
      javaToolOptions(resolved.options.vmArguments),
    ]);
  }
  if (values.length === 0) return command;
  if (platform === "win32") {
    return `${values.map(([name, value]) => `set "${name}=${value.replaceAll('"', '""')}"`).join(" && ")} && ${command}`;
  }
  return `${values.map(([name, value]) => `${name}=${quoteArgument(value, platform)}`).join(" ")} ${command}`;
}

function effectiveCommand(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  platform: RunConfigurationPlatform,
): string {
  const command =
    resolved.commandOverride !== null
      ? renderCommand(resolved.commandOverride, resolved.arguments, platform)
      : renderCommand(
          displayExecutable(targetBuildSystem(document), resolved, platform),
          renderedBuildArguments(document, resolved, platform),
          platform,
        );
  return renderEnvironmentPrefix(
    command,
    resolved,
    platform,
    resolved.commandOverride !== null ||
      document.target.kind !== "gradleMainClass",
  );
}

async function realRegularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function wrapperRelativePath(
  context: RunConfigurationProviderContext,
  resolved: ResolvedJavaConfiguration,
  system: "gradle" | "maven",
): Promise<string> {
  const name = wrapperName(system, context.platform);
  const relative =
    resolved.workingDirectory === "."
      ? name
      : `${resolved.workingDirectory}/${name}`;
  const canonical = await validateRealScript(context.targetRoot, relative);
  if (context.platform !== "win32") {
    const metadata = await lstat(canonical);
    if ((metadata.mode & 0o111) === 0) {
      throw new Error("The selected build wrapper is not executable.");
    }
  }
  return relative;
}

async function hasWrapper(
  context: RunConfigurationProviderContext,
  workingDirectory: string,
  system: "gradle" | "maven",
): Promise<boolean> {
  const directory = await resolveRealDirectory(
    context.targetRoot,
    workingDirectory,
  );
  const wrapper = path.join(directory, wrapperName(system, context.platform));
  if (!(await realRegularFile(wrapper))) return false;
  if (context.platform === "win32") return true;
  return ((await lstat(wrapper)).mode & 0o111) !== 0;
}

async function canonicalJdkHome(
  value: string,
  platform: RunConfigurationPlatform,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) {
    throw new Error(
      "The selected JDK home must be an absolute path for the target platform.",
    );
  }
  const canonical = await realpath(value);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory())
    throw new Error("The selected JDK home is not a directory.");
  const executable = path.join(
    canonical,
    "bin",
    platform === "win32" ? "java.exe" : "java",
  );
  const executableCanonical = await realpath(executable);
  const executableMetadata = await lstat(executableCanonical);
  if (
    !executableMetadata.isFile() ||
    (platform !== "win32" && (executableMetadata.mode & 0o111) === 0)
  ) {
    throw new Error(
      "The selected JDK home does not contain a Java executable.",
    );
  }
  return canonical;
}

function findBuild(
  scan: ProjectScan,
  system: "gradle" | "maven",
  workingDirectory: string,
): JavaBuild | null {
  return (
    scan.builds.find(
      (build) =>
        build.system === system && build.directory === workingDirectory,
    ) ?? null
  );
}

function findModule(
  build: JavaBuild,
  selector: string | null,
): JavaModule | null {
  if (build.system === "gradle") {
    return build.modules.find((module) => module.selector === selector) ?? null;
  }
  if (selector === null) {
    return build.modules.find((module) => module.selector === null) ?? null;
  }
  return (
    build.modules.find(
      (module) =>
        module.selector === selector ||
        module.artifactId === selector ||
        (module.artifactId && `:${module.artifactId}` === selector),
    ) ?? null
  );
}

async function validateJavaTarget(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  context: RunConfigurationProviderContext,
): Promise<RunConfigurationDiagnostic[]> {
  const system = targetBuildSystem(document);
  const scan = await scanProject(context);
  const build = findBuild(scan, system, resolved.workingDirectory);
  if (!build) {
    return [
      runConfigurationProviderDiagnostic(
        `${system}-build-missing`,
        `The start directory does not contain a discovered ${system === "gradle" ? "Gradle" : "Maven"} build root.`,
        "workingDirectory",
      ),
    ];
  }
  const selector = targetModule(document);
  const module = findModule(build, selector);
  if (!module) {
    return [
      runConfigurationProviderDiagnostic(
        `${system}-module-missing`,
        `The selected ${system === "gradle" ? "project" : "module"} ${selector ?? "(root)"} was not found in the build.`,
        document.target.kind.startsWith("gradle")
          ? "target.projectPath"
          : "target.module",
      ),
    ];
  }
  if (
    document.target.kind === "gradleMainClass" ||
    document.target.kind === "mavenMainClass"
  ) {
    const selectedClassName = document.target.className;
    if (
      !module.mainClasses.some(
        ({ className }) => className === selectedClassName,
      )
    ) {
      return [
        runConfigurationProviderDiagnostic(
          "java-main-class-missing",
          `The Java main class ${selectedClassName} was not found in the selected module.`,
          "target.className",
        ),
      ];
    }
  }
  if (
    document.target.kind === "gradleTask" &&
    !module.gradleTasks.includes(document.target.task)
  ) {
    return [
      runConfigurationProviderDiagnostic(
        "gradle-task-missing",
        `The Gradle application task ${document.target.task} was not found in the selected project.`,
        "target.task",
      ),
    ];
  }
  if (
    document.target.kind === "mavenGoal" &&
    !module.gradleTasks.includes(document.target.goal) &&
    document.target.goal.split(":").length < 4
  ) {
    return [
      runConfigurationProviderDiagnostic(
        "maven-goal-missing",
        `The Maven application goal ${document.target.goal} was not found in the selected module.`,
        "target.goal",
      ),
    ];
  }
  return [];
}

async function ensureGradleInitScript(): Promise<string> {
  gradleInitScriptPromise ??= (async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-run-java-provider-"),
    );
    const destination = path.join(directory, "java-main.gradle");
    await writeFile(destination, GRADLE_INIT_SCRIPT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (
      (await readBoundedText(destination, MAX_METADATA_BYTES)) !==
      GRADLE_INIT_SCRIPT
    ) {
      throw new Error(
        "The worker Java launcher could not be materialized safely.",
      );
    }
    return destination;
  })();
  return gradleInitScriptPromise;
}

async function materializedToolInvocation(
  executable: string,
  arguments_: string[],
  context: RunConfigurationProviderContext,
): Promise<Pick<MaterializedRunCommand, "arguments" | "executable">> {
  if (context.platform === "win32" && /\.(?:bat|cmd)$/iu.test(executable)) {
    return shellCommandInvocation(
      renderCommand(executable, arguments_, context.platform),
      context,
      { shell: "cmd", login: false },
    );
  }
  return { executable, arguments: arguments_ };
}

async function buildToolExecutable(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  context: RunConfigurationProviderContext,
): Promise<string> {
  const system = targetBuildSystem(document);
  if (!resolved.options.useWrapper)
    return systemExecutable(system, context.platform);
  return validateRealScript(
    context.targetRoot,
    await wrapperRelativePath(context, resolved, system),
  );
}

async function materializeProviderTask(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  task: string,
  context: RunConfigurationProviderContext,
): Promise<MaterializedRunCommand> {
  const system = targetBuildSystem(document);
  const executable = await buildToolExecutable(document, resolved, context);
  const selector = targetModule(document);
  const arguments_ =
    system === "gradle"
      ? [
          ...resolved.options.buildToolArguments,
          qualifiedGradleTask(selector ?? ":", task),
        ]
      : [
          ...resolved.options.buildToolArguments,
          ...(selector ? ["-pl", selector, "-am"] : []),
          task,
        ];
  return {
    ...(await materializedToolInvocation(executable, arguments_, context)),
    workingDirectory: await resolveRealDirectory(
      context.targetRoot,
      resolved.workingDirectory,
    ),
  };
}

async function materializeBeforeLaunch(
  document: RunConfigurationJavaDocument,
  resolved: ResolvedJavaConfiguration,
  context: RunConfigurationProviderContext,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  for (const step of document.beforeLaunch) {
    if (step.kind === "providerTask") {
      commands.push(
        await materializeProviderTask(document, resolved, step.task, context),
      );
    } else {
      commands.push({
        ...shellCommandInvocation(step.command, context),
        workingDirectory: await resolveRealDirectory(
          context.targetRoot,
          step.workingDirectory,
        ),
      });
    }
  }
  return commands;
}

function moduleLabel(build: JavaBuild, module: JavaModule): string {
  if (build.system === "gradle") return module.selector ?? ":";
  return module.artifactId ?? module.selector ?? "root";
}

function candidateConfidence(
  module: JavaModule,
  className: string,
): "high" | "medium" {
  return module.declaredMainClass === className ||
    module.mainClasses.length === 1
    ? "high"
    : "medium";
}

export const javaRunConfigurationProvider: RunConfigurationProvider<RunConfigurationJavaDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "java",
      label: "Java",
      icon: "coffee",
      available: true,
      supportsDiscovery: true,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationJavaDocumentSchema.parse({
        ...baseDocument({ id, name }),
        target: { kind: "gradleTask", projectPath: ":", task: "run" },
      });
    },

    async discover(
      context,
    ): Promise<
      RunConfigurationProviderCandidate<RunConfigurationJavaDocument>[]
    > {
      const candidates: RunConfigurationProviderCandidate<RunConfigurationJavaDocument>[] =
        [];
      const scan = await scanProject(context);
      for (const build of scan.builds) {
        const useWrapper = await hasWrapper(
          context,
          build.directory,
          build.system,
        );
        for (const module of build.modules) {
          const label = moduleLabel(build, module);
          for (const main of module.mainClasses) {
            if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
            const target =
              build.system === "gradle"
                ? {
                    kind: "gradleMainClass" as const,
                    projectPath: module.selector ?? ":",
                    className: main.className,
                  }
                : {
                    kind: "mavenMainClass" as const,
                    module: module.selector,
                    className: main.className,
                  };
            candidates.push({
              confidence: candidateConfidence(module, main.className),
              reason:
                module.declaredMainClass === main.className
                  ? `${build.system === "gradle" ? "Gradle" : "Maven"} declares ${main.className} as the application main class in ${label}.`
                  : `${main.relativePath} contains a Java main method in ${label}.`,
              document: runConfigurationJavaDocumentSchema.parse({
                ...baseDocument({
                  id: randomUUID(),
                  name: candidateName(
                    `${build.system === "gradle" ? "Gradle" : "Maven"} ${label}: ${main.className.split(".").at(-1)}`,
                  ),
                }),
                workingDirectory: build.directory,
                target,
                options: {
                  jdkHome: null,
                  useWrapper,
                  buildToolArguments: [],
                  vmArguments: [],
                },
              }),
            });
          }
          for (const task of module.gradleTasks) {
            if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
            const target =
              build.system === "gradle"
                ? {
                    kind: "gradleTask" as const,
                    projectPath: module.selector ?? ":",
                    task,
                  }
                : {
                    kind: "mavenGoal" as const,
                    module: module.selector,
                    goal: task,
                  };
            candidates.push({
              confidence:
                task === "run" ||
                task === "bootRun" ||
                task === "spring-boot:run"
                  ? "high"
                  : "medium",
              reason: `${build.system === "gradle" ? "Gradle" : "Maven"} declares the ${task} application target in ${label}.`,
              document: runConfigurationJavaDocumentSchema.parse({
                ...baseDocument({
                  id: randomUUID(),
                  name: candidateName(
                    `${build.system === "gradle" ? "Gradle" : "Maven"} ${label}: ${task}`,
                  ),
                }),
                workingDirectory: build.directory,
                target,
                options: {
                  jdkHome: null,
                  useWrapper,
                  buildToolArguments: [],
                  vmArguments: [],
                },
              }),
            });
          }
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
        }
        if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
      }
      const confidenceOrder = { high: 0, medium: 1, low: 2 } as const;
      return candidates.sort(
        (left, right) =>
          confidenceOrder[left.confidence] -
            confidenceOrder[right.confidence] ||
          left.document.name.localeCompare(right.document.name),
      );
    },

    renderEffectiveCommand(document, platform) {
      const parsed = runConfigurationJavaDocumentSchema.parse(document);
      return effectiveCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationJavaDocumentSchema.parse(document);
      const resolved = resolveConfiguration(parsed, context.platform);
      const diagnostics: RunConfigurationDiagnostic[] = [];
      try {
        await resolveRealDirectory(
          context.targetRoot,
          resolved.workingDirectory,
        );
      } catch (error) {
        diagnostics.push(
          runConfigurationProviderDiagnostic(
            "working-directory-invalid",
            error instanceof Error ? error.message : String(error),
            "workingDirectory",
          ),
        );
      }
      if (resolved.options.jdkHome) {
        try {
          await canonicalJdkHome(resolved.options.jdkHome, context.platform);
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "jdk-home-invalid",
              error instanceof Error ? error.message : String(error),
              "options.jdkHome",
            ),
          );
        }
      }
      if (
        resolved.commandOverride === null &&
        diagnostics.every(({ code }) => code !== "working-directory-invalid")
      ) {
        diagnostics.push(
          ...(await validateJavaTarget(parsed, resolved, context)),
        );
        if (resolved.options.useWrapper) {
          try {
            await wrapperRelativePath(
              context,
              resolved,
              targetBuildSystem(parsed),
            );
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "build-wrapper-invalid",
                error instanceof Error ? error.message : String(error),
                "options.useWrapper",
              ),
            );
          }
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "command") {
          try {
            await resolveRealDirectory(
              context.targetRoot,
              step.workingDirectory,
            );
            shellCommandInvocation(step.command, context);
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "before-launch-command-invalid",
                error instanceof Error ? error.message : String(error),
                `beforeLaunch[${index}]`,
              ),
            );
          }
        }
      }
      if (resolved.commandOverride !== null) {
        try {
          shellCommandInvocation(
            renderCommand(
              resolved.commandOverride,
              resolved.arguments,
              context.platform,
            ),
            context,
          );
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "shell-unavailable",
              error instanceof Error ? error.message : String(error),
              "commandOverride",
            ),
          );
        }
      }
      return diagnostics;
    },

    async materialize(document, context) {
      const parsed = runConfigurationJavaDocumentSchema.parse(document);
      const diagnostics = await this.validate(parsed, context);
      if (diagnostics.length > 0) {
        throw new Error(diagnostics.map(({ message }) => message).join(" "));
      }
      const resolved = resolveConfiguration(parsed, context.platform);
      const workingDirectory = await resolveRealDirectory(
        context.targetRoot,
        resolved.workingDirectory,
      );
      let executable: string;
      let arguments_: string[];
      if (resolved.commandOverride !== null) {
        const invocation = shellCommandInvocation(
          renderCommand(
            resolved.commandOverride,
            resolved.arguments,
            context.platform,
          ),
          context,
        );
        executable = invocation.executable;
        arguments_ = invocation.arguments;
      } else {
        const tool = await buildToolExecutable(parsed, resolved, context);
        const initScript =
          parsed.target.kind === "gradleMainClass"
            ? await ensureGradleInitScript()
            : null;
        const invocation = await materializedToolInvocation(
          tool,
          actualBuildArguments(parsed, resolved, context.platform, initScript),
          context,
        );
        executable = invocation.executable;
        arguments_ = invocation.arguments;
      }
      const environmentAdditions: Record<string, string> = {};
      if (resolved.options.jdkHome) {
        environmentAdditions.JAVA_HOME = await canonicalJdkHome(
          resolved.options.jdkHome,
          context.platform,
        );
      }
      if (
        resolved.options.vmArguments.length > 0 &&
        (resolved.commandOverride !== null ||
          parsed.target.kind !== "gradleMainClass")
      ) {
        environmentAdditions.JAVA_TOOL_OPTIONS = javaToolOptions(
          resolved.options.vmArguments,
        );
      }
      return {
        executable,
        arguments: arguments_,
        workingDirectory,
        beforeLaunch: await materializeBeforeLaunch(parsed, resolved, context),
        effectiveCommand: effectiveCommand(parsed, resolved, context.platform),
        environment: resolved.environment,
        environmentAdditions,
      };
    },
  };
