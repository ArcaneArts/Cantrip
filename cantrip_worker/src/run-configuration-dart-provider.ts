import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  runConfigurationDartDocumentSchema,
  runConfigurationProviderCapabilitySchema,
  type RunConfigurationDartDocument,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationPlatform,
} from "@cantrip/protocol/run-configuration-definitions";

import {
  resolveRealDirectory,
  runConfigurationExecutableDiagnostic,
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
const MAX_DISCOVERY_PACKAGES = 256;
const MAX_DISCOVERY_SOURCES = 512;
const MAX_DISCOVERY_CANDIDATES = 128;
const MAX_PUBSPEC_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".cantrip",
  ".dart_tool",
  ".git",
  ".idea",
  ".pub-cache",
  "build",
  "coverage",
  "node_modules",
  "target",
]);

type DartPlatformOverride = NonNullable<
  RunConfigurationDartDocument["platformOverrides"]["win32"]
>;

interface ResolvedDartConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  options: RunConfigurationDartDocument["options"];
  workingDirectory: string;
}

interface ScannedDartSource {
  relativePath: string;
}

interface ScannedPubspec {
  directory: string;
  flutter: boolean;
  name: string | null;
}

interface DartPackage {
  directory: string;
  entrypoints: string[];
  name: string;
}

function portableJoin(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function isAtOrBelow(candidate: string, parent: string): boolean {
  return parent === "."
    ? true
    : candidate === parent || candidate.startsWith(`${parent}/`);
}

function relativeToPackage(packageDirectory: string, filePath: string): string {
  return packageDirectory === "."
    ? filePath
    : filePath.slice(packageDirectory.length + 1);
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

function dartPackageName(pubspec: string): string | null {
  const match = pubspec.match(
    /^(?:\uFEFF)?name\s*:\s*(?:"([a-z_][a-z0-9_]*)"|'([a-z_][a-z0-9_]*)'|([a-z_][a-z0-9_]*))\s*(?:#.*)?$/mu,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isFlutterPubspec(pubspec: string): boolean {
  return /^[ \t]+sdk\s*:\s*flutter\s*(?:#.*)?$/mu.test(pubspec);
}

function blankDartSyntax(value: string): string {
  return value.replace(/[^\r\n]/gu, " ");
}

function scrubDartCommentsAndStrings(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[rR]?'''[\s\S]*?'''|[rR]?"""[\s\S]*?"""|[rR]?'(?:\\.|[^'\\\r\n])*'|[rR]?"(?:\\.|[^"\\\r\n])*"/gu,
    blankDartSyntax,
  );
}

function hasDartMain(source: string): boolean {
  const declaration =
    /^\s*(?:@[^\r\n]+\s*)*(?:(?:Future(?:Or)?\s*<\s*void\s*>|void|dynamic)\s+)?main\s*\(/u;
  let braceDepth = 0;
  for (const line of scrubDartCommentsAndStrings(source).split(/\r?\n/u)) {
    if (braceDepth === 0 && declaration.test(line)) return true;
    for (const character of line) {
      if (character === "{") braceDepth += 1;
      if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
  }
  return false;
}

function isRunnableSource(relativePath: string): boolean {
  const first = relativePath.split("/")[0];
  return first !== "test" && first !== "integration_test";
}

async function scanPackages(
  context: RunConfigurationProviderContext,
): Promise<DartPackage[]> {
  const root = await realpath(context.targetRoot);
  const queue = [{ absolute: root, directory: ".", depth: 0 }];
  const pubspecs: ScannedPubspec[] = [];
  const sources: ScannedDartSource[] = [];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_DISCOVERY_DIRECTORIES) {
    const current = queue.shift()!;
    visited += 1;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const regularFiles = entries.filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink(),
    );
    if (
      pubspecs.length < MAX_DISCOVERY_PACKAGES &&
      regularFiles.some(({ name }) => name === "pubspec.yaml")
    ) {
      const pubspec = await readBoundedText(
        path.join(current.absolute, "pubspec.yaml"),
        MAX_PUBSPEC_BYTES,
      );
      if (pubspec !== null) {
        pubspecs.push({
          directory: current.directory,
          flutter: isFlutterPubspec(pubspec),
          name: dartPackageName(pubspec),
        });
      }
    }
    if (sources.length < MAX_DISCOVERY_SOURCES) {
      for (const entry of regularFiles) {
        if (sources.length >= MAX_DISCOVERY_SOURCES) break;
        if (!entry.name.endsWith(".dart")) continue;
        const relativePath = portableJoin(current.directory, entry.name);
        const source = await readBoundedText(
          path.join(current.absolute, entry.name),
          MAX_SOURCE_BYTES,
        );
        if (source !== null && hasDartMain(source)) {
          sources.push({
            relativePath,
          });
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

  const packageDirectories = pubspecs.map(({ directory }) => directory);
  return pubspecs.flatMap((pubspec): DartPackage[] => {
    if (pubspec.flutter || !pubspec.name) return [];
    const nestedPackages = packageDirectories.filter(
      (candidate) =>
        candidate !== pubspec.directory &&
        isAtOrBelow(candidate, pubspec.directory),
    );
    const entrypoints = sources
      .filter(
        ({ relativePath }) =>
          isAtOrBelow(relativePath, pubspec.directory) &&
          !nestedPackages.some((nested) => isAtOrBelow(relativePath, nested)),
      )
      .map(({ relativePath }) =>
        relativeToPackage(pubspec.directory, relativePath),
      )
      .filter(isRunnableSource)
      .sort();
    return [{ directory: pubspec.directory, entrypoints, name: pubspec.name }];
  });
}

function baseDocument(input: {
  id: string;
  name: string;
}): Omit<RunConfigurationDartDocument, "target"> {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1,
    id: input.id,
    name: input.name,
    provider: "dart",
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
    options: { sdkHome: null, vmArguments: [] },
    stop: { gracePeriodMs: 3_000 },
  };
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: DartPlatformOverride["environment"],
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
  document: RunConfigurationDartDocument,
  platform: RunConfigurationPlatform,
): ResolvedDartConfiguration {
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
      sdkHome:
        override?.options && Object.hasOwn(override.options, "sdkHome")
          ? (override.options.sdkHome ?? null)
          : document.options.sdkHome,
      vmArguments:
        override?.options?.vmArguments ?? document.options.vmArguments,
    },
  };
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

function sdkExecutablePath(
  sdkHome: string,
  platform: RunConfigurationPlatform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    sdkHome,
    "bin",
    platform === "win32" ? "dart.exe" : "dart",
  );
}

function displayExecutable(
  resolved: ResolvedDartConfiguration,
  platform: RunConfigurationPlatform,
): string {
  return resolved.options.sdkHome
    ? sdkExecutablePath(resolved.options.sdkHome, platform)
    : "dart";
}

function dartArguments(
  document: RunConfigurationDartDocument,
  resolved: ResolvedDartConfiguration,
): string[] {
  return [
    "run",
    ...resolved.options.vmArguments,
    document.target.path,
    ...resolved.arguments,
  ];
}

function effectiveCommand(
  document: RunConfigurationDartDocument,
  resolved: ResolvedDartConfiguration,
  platform: RunConfigurationPlatform,
): string {
  return resolved.commandOverride !== null
    ? renderCommand(resolved.commandOverride, resolved.arguments, platform)
    : renderCommand(
        displayExecutable(resolved, platform),
        dartArguments(document, resolved),
        platform,
      );
}

async function canonicalDartExecutable(
  sdkHome: string,
  platform: RunConfigurationPlatform,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(sdkHome)) {
    throw new Error(
      "The selected Dart SDK home must be an absolute path for the target platform.",
    );
  }
  const canonicalHome = await realpath(sdkHome);
  const homeMetadata = await lstat(canonicalHome);
  if (!homeMetadata.isDirectory()) {
    throw new Error("The selected Dart SDK home is not a directory.");
  }
  const executable = await realpath(sdkExecutablePath(canonicalHome, platform));
  const metadata = await lstat(executable);
  if (
    !metadata.isFile() ||
    (platform !== "win32" && (metadata.mode & 0o111) === 0)
  ) {
    throw new Error(
      "The selected Dart SDK home does not contain a Dart executable.",
    );
  }
  return executable;
}

async function readPackageAtWorkingDirectory(
  context: RunConfigurationProviderContext,
  workingDirectory: string,
): Promise<{ flutter: boolean; name: string }> {
  const directory = await resolveRealDirectory(
    context.targetRoot,
    workingDirectory,
  );
  const pubspec = await readBoundedText(
    path.join(directory, "pubspec.yaml"),
    MAX_PUBSPEC_BYTES,
  );
  if (pubspec === null) {
    throw new Error(
      "The start directory does not contain a readable pubspec.yaml file.",
    );
  }
  const name = dartPackageName(pubspec);
  if (!name)
    throw new Error("pubspec.yaml does not declare a valid package name.");
  return { flutter: isFlutterPubspec(pubspec), name };
}

function targetPath(
  document: RunConfigurationDartDocument,
  resolved: ResolvedDartConfiguration,
): string {
  return portableJoin(resolved.workingDirectory, document.target.path);
}

async function materializeBeforeLaunch(
  document: RunConfigurationDartDocument,
  context: RunConfigurationProviderContext,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  for (const step of document.beforeLaunch) {
    if (step.kind === "providerTask") {
      throw new Error(
        "Dart Run configurations do not support provider before-launch tasks.",
      );
    }
    commands.push({
      ...shellCommandInvocation(step.command, context),
      workingDirectory: await resolveRealDirectory(
        context.targetRoot,
        step.workingDirectory,
      ),
    });
  }
  return commands;
}

function candidateConfidence(
  package_: DartPackage,
  entrypoint: string,
): "high" | "medium" {
  return package_.entrypoints.length === 1 ||
    entrypoint === `bin/${package_.name}.dart` ||
    entrypoint === "bin/main.dart"
    ? "high"
    : "medium";
}

function conventionalEntrypoint(
  package_: DartPackage,
  entrypoint: string,
): boolean {
  return (
    entrypoint === `bin/${package_.name}.dart` || entrypoint === "bin/main.dart"
  );
}

function candidateName(package_: DartPackage, entrypoint: string): string {
  const fileName =
    entrypoint
      .split("/")
      .at(-1)
      ?.replace(/\.dart$/u, "") ?? "entrypoint";
  return `Dart ${package_.name}: ${fileName}`.slice(0, 200);
}

export const dartRunConfigurationProvider: RunConfigurationProvider<RunConfigurationDartDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "dart",
      label: "Dart",
      icon: "file-code",
      available: true,
      supportsDiscovery: true,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationDartDocumentSchema.parse({
        ...baseDocument({ id, name }),
        target: { kind: "entrypoint", path: "bin/main.dart" },
      });
    },

    async discover(
      context,
    ): Promise<
      RunConfigurationProviderCandidate<RunConfigurationDartDocument>[]
    > {
      const candidates: RunConfigurationProviderCandidate<RunConfigurationDartDocument>[] =
        [];
      for (const package_ of await scanPackages(context)) {
        for (const entrypoint of package_.entrypoints) {
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
          const confidence = candidateConfidence(package_, entrypoint);
          candidates.push({
            confidence,
            reason: conventionalEntrypoint(package_, entrypoint)
              ? `${package_.name} has the conventional Dart entrypoint ${entrypoint}.`
              : package_.entrypoints.length === 1
                ? `${entrypoint} is the only Dart entrypoint discovered in ${package_.name}.`
                : `${entrypoint} declares a Dart main function in ${package_.name}.`,
            document: runConfigurationDartDocumentSchema.parse({
              ...baseDocument({
                id: randomUUID(),
                name: candidateName(package_, entrypoint),
              }),
              workingDirectory: package_.directory,
              target: { kind: "entrypoint", path: entrypoint },
            }),
          });
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
      const parsed = runConfigurationDartDocumentSchema.parse(document);
      return effectiveCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationDartDocumentSchema.parse(document);
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
      if (
        resolved.commandOverride === null &&
        diagnostics.every(({ code }) => code !== "working-directory-invalid")
      ) {
        try {
          const package_ = await readPackageAtWorkingDirectory(
            context,
            resolved.workingDirectory,
          );
          if (package_.flutter) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "dart-package-is-flutter",
                "The start directory is a Flutter package; use a Flutter Run configuration.",
                "workingDirectory",
              ),
            );
          }
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "dart-package-invalid",
              error instanceof Error ? error.message : String(error),
              "workingDirectory",
            ),
          );
        }
        try {
          await validateRealScript(
            context.targetRoot,
            targetPath(parsed, resolved),
          );
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "dart-entrypoint-invalid",
              error instanceof Error ? error.message : String(error),
              "target.path",
            ),
          );
        }
        if (resolved.options.sdkHome) {
          try {
            await canonicalDartExecutable(
              resolved.options.sdkHome,
              context.platform,
            );
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "dart-sdk-invalid",
                error instanceof Error ? error.message : String(error),
                "options.sdkHome",
              ),
            );
          }
        } else {
          const diagnostic = await runConfigurationExecutableDiagnostic(
            "dart",
            context,
            "options.sdkHome",
          );
          if (diagnostic) diagnostics.push(diagnostic);
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "providerTask") {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "dart-provider-task-unsupported",
              "Dart Run configurations support command before-launch steps, not provider tasks.",
              `beforeLaunch[${index}]`,
            ),
          );
          continue;
        }
        try {
          await resolveRealDirectory(context.targetRoot, step.workingDirectory);
          const invocation = shellCommandInvocation(step.command, context);
          const diagnostic = await runConfigurationExecutableDiagnostic(
            invocation.executable,
            context,
            `beforeLaunch[${index}]`,
          );
          if (diagnostic) diagnostics.push(diagnostic);
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
      if (resolved.commandOverride !== null) {
        try {
          const invocation = shellCommandInvocation(
            effectiveCommand(parsed, resolved, context.platform),
            context,
          );
          const diagnostic = await runConfigurationExecutableDiagnostic(
            invocation.executable,
            context,
            "commandOverride",
          );
          if (diagnostic) diagnostics.push(diagnostic);
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
      const parsed = runConfigurationDartDocumentSchema.parse(document);
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
          effectiveCommand(parsed, resolved, context.platform),
          context,
        );
        executable = invocation.executable;
        arguments_ = invocation.arguments;
      } else {
        executable = resolved.options.sdkHome
          ? await canonicalDartExecutable(
              resolved.options.sdkHome,
              context.platform,
            )
          : "dart";
        arguments_ = dartArguments(parsed, resolved);
      }
      return {
        executable,
        arguments: arguments_,
        workingDirectory,
        beforeLaunch: await materializeBeforeLaunch(parsed, context),
        effectiveCommand: effectiveCommand(parsed, resolved, context.platform),
        environment: resolved.environment,
      };
    },
  };
