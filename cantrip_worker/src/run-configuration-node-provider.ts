import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  runConfigurationNodeDocumentSchema,
  runConfigurationProviderCapabilitySchema,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationNodeDocument,
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

const MAX_DISCOVERY_DIRECTORIES = 512;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_MANIFESTS = 128;
const MAX_DISCOVERY_CANDIDATES = 128;
const MAX_PACKAGE_JSON_BYTES = 512 * 1024;
const MAX_SCRIPTS_PER_MANIFEST = 64;
const IGNORED_DIRECTORIES = new Set([
  ".cantrip",
  ".git",
  ".gradle",
  ".idea",
  ".next",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

interface NodeManifest {
  entries: string[];
  name: string | null;
  packageManager: string | null;
  scripts: Record<string, string>;
}

type NodePlatformOverride = NonNullable<
  RunConfigurationNodeDocument["platformOverrides"]["win32"]
>;

interface ResolvedNodeConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  options: RunConfigurationNodeDocument["options"];
  workingDirectory: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function portableEntryPath(value: string): string | null {
  const normalized = value.replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function manifestEntries(manifest: Record<string, unknown>): string[] {
  const entries = new Set<string>();
  for (const value of [manifest.main, manifest.module]) {
    if (typeof value === "string") {
      const normalized = portableEntryPath(value);
      if (normalized) entries.add(normalized);
    }
  }
  if (typeof manifest.bin === "string") {
    const normalized = portableEntryPath(manifest.bin);
    if (normalized) entries.add(normalized);
  } else {
    const bins = objectValue(manifest.bin);
    for (const value of Object.values(bins ?? {})) {
      if (typeof value !== "string") continue;
      const normalized = portableEntryPath(value);
      if (normalized) entries.add(normalized);
    }
  }
  return [...entries].slice(0, 32);
}

async function readNodeManifest(
  targetRoot: string,
  packageDirectory: string,
): Promise<NodeManifest> {
  const directory = await resolveRealDirectory(targetRoot, packageDirectory);
  const manifestPath = path.join(directory, "package.json");
  const metadata = await lstat(manifestPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("package.json must be a real file.");
  }
  if (metadata.size > MAX_PACKAGE_JSON_BYTES) {
    throw new Error("package.json exceeds the discovery size limit.");
  }
  const value = objectValue(
    JSON.parse(await readFile(manifestPath, { encoding: "utf8" })),
  );
  if (!value) throw new Error("package.json must contain a JSON object.");
  const scripts = Object.fromEntries(
    Object.entries(objectValue(value.scripts) ?? {})
      .filter(
        (entry): entry is [string, string] =>
          entry[0].trim().length > 0 &&
          entry[0].length <= 200 &&
          typeof entry[1] === "string" &&
          entry[1].trim().length > 0,
      )
      .slice(0, MAX_SCRIPTS_PER_MANIFEST),
  );
  return {
    entries: manifestEntries(value),
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim().slice(0, 200)
        : null,
    packageManager:
      typeof value.packageManager === "string" ? value.packageManager : null,
    scripts,
  };
}

async function realRegularFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function packageManagerFor(
  targetRoot: string,
  packageDirectory: string,
  manifest: NodeManifest,
): Promise<RunConfigurationNodeDocument["options"]["packageManager"]> {
  const declared = manifest.packageManager?.split("@")[0];
  if (
    declared === "npm" ||
    declared === "pnpm" ||
    declared === "yarn" ||
    declared === "bun"
  ) {
    return declared;
  }
  const root = await realpath(targetRoot);
  const packageRoot = await resolveRealDirectory(targetRoot, packageDirectory);
  for (const directory of packageRoot === root ? [root] : [packageRoot, root]) {
    if (await realRegularFile(path.join(directory, "pnpm-lock.yaml"))) {
      return "pnpm";
    }
    if (await realRegularFile(path.join(directory, "yarn.lock"))) return "yarn";
    if (
      (await realRegularFile(path.join(directory, "bun.lock"))) ||
      (await realRegularFile(path.join(directory, "bun.lockb")))
    ) {
      return "bun";
    }
    if (await realRegularFile(path.join(directory, "package-lock.json"))) {
      return "npm";
    }
  }
  return "npm";
}

function packageLabel(
  packageDirectory: string,
  manifest: NodeManifest,
): string {
  return (
    manifest.name ??
    (packageDirectory === "." ? "Node package" : packageDirectory)
  );
}

function candidateName(value: string): string {
  return value.slice(0, 200);
}

function rootRelativeEntry(packageDirectory: string, entry: string): string {
  return packageDirectory === "." ? entry : `${packageDirectory}/${entry}`;
}

async function discoverManifests(
  context: RunConfigurationProviderContext,
): Promise<Array<{ directory: string; manifest: NodeManifest }>> {
  const root = await realpath(context.targetRoot);
  const queue = [{ absolute: root, directory: ".", depth: 0 }];
  const manifests: Array<{ directory: string; manifest: NodeManifest }> = [];
  let visited = 0;
  while (
    queue.length > 0 &&
    visited < MAX_DISCOVERY_DIRECTORIES &&
    manifests.length < MAX_DISCOVERY_MANIFESTS
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
    if (
      entries.some(
        (entry) =>
          entry.name === "package.json" &&
          entry.isFile() &&
          !entry.isSymbolicLink(),
      )
    ) {
      try {
        manifests.push({
          directory: current.directory,
          manifest: await readNodeManifest(
            context.targetRoot,
            current.directory,
          ),
        });
      } catch {
        // One malformed package must not hide valid workspace packages.
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
        directory:
          current.directory === "."
            ? entry.name
            : `${current.directory}/${entry.name}`,
        depth: current.depth + 1,
      });
    }
  }
  return manifests;
}

function baseDocument(input: {
  id: string;
  name: string;
}): Omit<RunConfigurationNodeDocument, "target"> {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1,
    id: input.id,
    name: input.name,
    provider: "node",
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
      packageManager: "npm",
      runtime: "node",
      runtimeArguments: [],
    },
    stop: { gracePeriodMs: 3_000 },
  };
}

function quoteArgument(
  value: string,
  platform: RunConfigurationPlatform,
): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"`
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

function packageScriptArguments(script: string, values: string[]): string[] {
  return ["run", script, ...(values.length ? ["--", ...values] : [])];
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: NodePlatformOverride["environment"],
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
  document: RunConfigurationNodeDocument,
  platform: RunConfigurationPlatform,
): ResolvedNodeConfiguration {
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
      packageManager:
        override?.options?.packageManager ?? document.options.packageManager,
      runtime: override?.options?.runtime ?? document.options.runtime,
      runtimeArguments:
        override?.options?.runtimeArguments ??
        document.options.runtimeArguments,
    },
  };
}

function effectiveCommand(
  document: RunConfigurationNodeDocument,
  resolved: ResolvedNodeConfiguration,
  platform: RunConfigurationPlatform,
): string {
  if (resolved.commandOverride !== null) {
    return renderCommand(
      resolved.commandOverride,
      resolved.arguments,
      platform,
    );
  }
  if (document.target.kind === "packageScript") {
    return renderCommand(
      resolved.options.packageManager,
      packageScriptArguments(document.target.script, resolved.arguments),
      platform,
    );
  }
  return renderCommand(
    resolved.options.runtime,
    [
      ...resolved.options.runtimeArguments,
      document.target.path,
      ...resolved.arguments,
    ],
    platform,
  );
}

async function validateProviderTask(
  document: RunConfigurationNodeDocument,
  context: RunConfigurationProviderContext,
  task: string,
  field: string,
): Promise<RunConfigurationDiagnostic | null> {
  try {
    const manifest = await readNodeManifest(
      context.targetRoot,
      resolveConfiguration(document, context.platform).workingDirectory,
    );
    if (!manifest.scripts[task]) {
      return runConfigurationProviderDiagnostic(
        "package-script-missing",
        `package.json does not define the ${task} script.`,
        field,
      );
    }
    return null;
  } catch (error) {
    return runConfigurationProviderDiagnostic(
      "package-manifest-invalid",
      error instanceof Error ? error.message : String(error),
      field,
    );
  }
}

async function materializeBeforeLaunch(
  document: RunConfigurationNodeDocument,
  context: RunConfigurationProviderContext,
  resolved: ResolvedNodeConfiguration,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  const workingDirectory = await resolveRealDirectory(
    context.targetRoot,
    resolved.workingDirectory,
  );
  for (const step of document.beforeLaunch) {
    if (step.kind === "providerTask") {
      commands.push({
        executable: resolved.options.packageManager,
        arguments: packageScriptArguments(step.task, []),
        workingDirectory,
      });
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

export const nodeRunConfigurationProvider: RunConfigurationProvider<RunConfigurationNodeDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "node",
      label: "Node / package",
      icon: "package",
      available: true,
      supportsDiscovery: true,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationNodeDocumentSchema.parse({
        ...baseDocument({ id, name }),
        target: { kind: "packageScript", script: "start" },
      });
    },

    async discover(
      context,
    ): Promise<
      RunConfigurationProviderCandidate<RunConfigurationNodeDocument>[]
    > {
      const candidates: RunConfigurationProviderCandidate<RunConfigurationNodeDocument>[] =
        [];
      for (const { directory, manifest } of await discoverManifests(context)) {
        const label = packageLabel(directory, manifest);
        const packageManager = await packageManagerFor(
          context.targetRoot,
          directory,
          manifest,
        );
        const scripts = Object.keys(manifest.scripts).sort((left, right) => {
          const priority = (value: string) =>
            value === "start" ? 0 : value === "dev" ? 1 : 2;
          return priority(left) - priority(right) || left.localeCompare(right);
        });
        for (const script of scripts) {
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
          const confidence =
            script === "start" ? "high" : script === "dev" ? "medium" : "low";
          candidates.push({
            confidence,
            reason: `${label} defines the ${script} package script.`,
            document: runConfigurationNodeDocumentSchema.parse({
              ...baseDocument({
                id: randomUUID(),
                name: candidateName(
                  directory === "." ? `Run ${script}` : `${label}: ${script}`,
                ),
              }),
              workingDirectory: directory,
              target: { kind: "packageScript", script },
              options: {
                packageManager,
                runtime: packageManager === "bun" ? "bun" : "node",
                runtimeArguments: [],
              },
            }),
          });
        }
        const knownEntries = new Set(manifest.entries);
        for (const known of [
          "index.js",
          "index.mjs",
          "index.cjs",
          "server.js",
          "src/index.js",
          "src/index.mjs",
          "src/main.js",
        ]) {
          if (
            await realRegularFile(
              path.join(
                await resolveRealDirectory(context.targetRoot, directory),
                ...known.split("/"),
              ),
            )
          ) {
            knownEntries.add(known);
          }
        }
        for (const entry of knownEntries) {
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
          const targetPath = rootRelativeEntry(directory, entry);
          try {
            await validateRealScript(context.targetRoot, targetPath);
          } catch {
            continue;
          }
          candidates.push({
            confidence: manifest.entries.includes(entry) ? "high" : "medium",
            reason: manifest.entries.includes(entry)
              ? `${label} declares ${entry} as an entrypoint.`
              : `${label} contains the likely entrypoint ${entry}.`,
            document: runConfigurationNodeDocumentSchema.parse({
              ...baseDocument({
                id: randomUUID(),
                name: candidateName(
                  directory === "." ? `Run ${entry}` : `${label}: ${entry}`,
                ),
              }),
              workingDirectory: directory,
              target: { kind: "entry", path: targetPath },
              options: {
                packageManager,
                runtime: packageManager === "bun" ? "bun" : "node",
                runtimeArguments: [],
              },
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
      const parsed = runConfigurationNodeDocumentSchema.parse(document);
      return effectiveCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationNodeDocumentSchema.parse(document);
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
      if (resolved.commandOverride === null) {
        if (parsed.target.kind === "packageScript") {
          const issue = await validateProviderTask(
            parsed,
            context,
            parsed.target.script,
            "target.script",
          );
          if (issue) diagnostics.push(issue);
        } else {
          try {
            await validateRealScript(context.targetRoot, parsed.target.path);
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "entrypoint-invalid",
                error instanceof Error ? error.message : String(error),
                "target.path",
              ),
            );
          }
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "providerTask") {
          const issue = await validateProviderTask(
            parsed,
            context,
            step.task,
            `beforeLaunch[${index}].task`,
          );
          if (issue) diagnostics.push(issue);
        } else {
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
            effectiveCommand(parsed, resolved, context.platform),
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
      const parsed = runConfigurationNodeDocumentSchema.parse(document);
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
      } else if (parsed.target.kind === "packageScript") {
        executable = resolved.options.packageManager;
        arguments_ = packageScriptArguments(
          parsed.target.script,
          resolved.arguments,
        );
      } else {
        executable = resolved.options.runtime;
        arguments_ = [
          ...resolved.options.runtimeArguments,
          await validateRealScript(context.targetRoot, parsed.target.path),
          ...resolved.arguments,
        ];
      }
      return {
        executable,
        arguments: arguments_,
        workingDirectory,
        beforeLaunch: await materializeBeforeLaunch(parsed, context, resolved),
        effectiveCommand: effectiveCommand(parsed, resolved, context.platform),
        environment: resolved.environment,
      };
    },
  };
