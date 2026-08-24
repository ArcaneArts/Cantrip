import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  RUN_CONFIGURATION_FILE_VERSION,
  runConfigurationProviderCapabilitySchema,
  runConfigurationRustDocumentSchema,
  runConfigurationRustPackageNameSchema,
  runConfigurationRustTargetNameSchema,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationPlatform,
  type RunConfigurationRustDocument,
} from "@cantrip/protocol/run-configuration-definitions";
import { parse as parseToml } from "smol-toml";

import {
  findRunConfigurationExecutable,
  type MaterializedRunCommand,
  type RunConfigurationProvider,
  type RunConfigurationProviderCandidate,
  type RunConfigurationProviderContext,
  resolveRealDirectory,
  runConfigurationExecutableDiagnostic,
  runConfigurationProviderDiagnostic,
  shellCommandInvocation,
} from "./run-configuration-provider.js";

const MAX_DISCOVERY_DIRECTORIES = 1_024;
const MAX_DISCOVERY_DEPTH = 10;
const MAX_DISCOVERY_MANIFESTS = 256;
const MAX_DISCOVERY_TARGETS = 1_024;
const MAX_DISCOVERY_CANDIDATES = 128;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RUSTUP_TOOLCHAINS = 512;
const SUPPORTED_PROVIDER_TASKS = new Set(["build", "check", "clippy"]);

const IGNORED_DIRECTORIES = new Set([
  ".cantrip",
  ".cargo-cache",
  ".git",
  ".idea",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

type RustPlatformOverride = NonNullable<
  RunConfigurationRustDocument["platformOverrides"]["win32"]
>;

interface ResolvedRustConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  options: RunConfigurationRustDocument["options"];
  workingDirectory: string;
}

interface RustToolchainPreflight {
  diagnostic: RunConfigurationDiagnostic | null;
  roots: string[];
}

interface CargoTarget {
  kind: "binary" | "example";
  name: string;
  requiredFeatures: string[];
  sourcePath: string;
}

interface CargoPackage {
  defaultRun: string | null;
  directory: string;
  name: string;
  targets: CargoTarget[];
}

interface DirectoryQueueEntry {
  absolute: string;
  depth: number;
  relative: string;
}

function portableJoin(parent: string, child: string): string {
  return parent === "." ? child : `${parent}/${child}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isPortableManifestPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value
      .split("/")
      .every(
        (segment) => segment.length > 0 && segment !== "." && segment !== "..",
      )
  );
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
    const contents = await readFile(filePath, "utf8");
    return contents.includes("\0") ? null : contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function realRegularFile(
  root: string,
  filePath: string,
): Promise<boolean> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    return isInside(root, await realpath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function validPackageName(value: unknown): string | null {
  const parsed = runConfigurationRustPackageNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function validTargetName(value: unknown): string | null {
  const parsed = runConfigurationRustTargetNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function requiredFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            /^[A-Za-z0-9_+.-]+$/u.test(item) &&
            item.length <= 256,
        )
        .slice(0, 128),
    ),
  ];
}

function explicitTargetTables(
  manifest: Record<string, unknown>,
  kind: "bin" | "example",
): Record<string, unknown>[] {
  const value = manifest[kind];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 256);
}

async function firstExistingTargetPath(
  root: string,
  packageDirectory: string,
  candidates: string[],
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!isPortableManifestPath(candidate) || !candidate.endsWith(".rs")) {
      continue;
    }
    if (await realRegularFile(root, path.join(packageDirectory, candidate))) {
      return candidate;
    }
  }
  return null;
}

async function conventionalTargets(
  root: string,
  packageDirectory: string,
  kind: "binary" | "example",
): Promise<CargoTarget[]> {
  const parent = kind === "binary" ? "src/bin" : "examples";
  const directory = path.join(packageDirectory, ...parent.split("/"));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const targets: CargoTarget[] = [];
  for (const entry of entries
    .filter(({ name }) => !name.includes("\0"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 256)) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && entry.name.endsWith(".rs")) {
      const name = validTargetName(entry.name.slice(0, -3));
      const sourcePath = `${parent}/${entry.name}`;
      if (
        name &&
        (await realRegularFile(root, path.join(packageDirectory, sourcePath)))
      ) {
        targets.push({ kind, name, requiredFeatures: [], sourcePath });
      }
      continue;
    }
    if (entry.isDirectory()) {
      const name = validTargetName(entry.name);
      const sourcePath = `${parent}/${entry.name}/main.rs`;
      if (
        name &&
        (await realRegularFile(root, path.join(packageDirectory, sourcePath)))
      ) {
        targets.push({ kind, name, requiredFeatures: [], sourcePath });
      }
    }
  }
  return targets;
}

async function packageTargets(input: {
  manifest: Record<string, unknown>;
  packageDirectory: string;
  packageName: string;
  root: string;
}): Promise<CargoTarget[]> {
  const packageTable = input.manifest.package;
  if (!isRecord(packageTable)) return [];
  const targets = new Map<string, CargoTarget>();
  const claimedSources = new Set<string>();
  const add = (target: CargoTarget) => {
    targets.set(`${target.kind}:${target.name}`, target);
    claimedSources.add(target.sourcePath);
  };
  for (const [manifestKind, kind] of [
    ["bin", "binary"],
    ["example", "example"],
  ] as const) {
    for (const table of explicitTargetTables(input.manifest, manifestKind)) {
      const name = validTargetName(table.name);
      if (!name) continue;
      const configuredPath = typeof table.path === "string" ? table.path : null;
      const sourcePath = await firstExistingTargetPath(
        input.root,
        input.packageDirectory,
        configuredPath
          ? [configuredPath]
          : kind === "binary"
            ? name === input.packageName
              ? ["src/main.rs", `src/bin/${name}.rs`, `src/bin/${name}/main.rs`]
              : [`src/bin/${name}.rs`, `src/bin/${name}/main.rs`]
            : [`examples/${name}.rs`, `examples/${name}/main.rs`],
      );
      if (!sourcePath) continue;
      add({
        kind,
        name,
        requiredFeatures: requiredFeatures(table["required-features"]),
        sourcePath,
      });
    }
  }
  if (packageTable.autobins !== false) {
    const mainPath = await firstExistingTargetPath(
      input.root,
      input.packageDirectory,
      ["src/main.rs"],
    );
    if (
      mainPath &&
      !targets.has(`binary:${input.packageName}`) &&
      !claimedSources.has(mainPath)
    ) {
      add({
        kind: "binary",
        name: input.packageName,
        requiredFeatures: [],
        sourcePath: mainPath,
      });
    }
    for (const target of await conventionalTargets(
      input.root,
      input.packageDirectory,
      "binary",
    )) {
      if (
        !targets.has(`binary:${target.name}`) &&
        !claimedSources.has(target.sourcePath)
      ) {
        add(target);
      }
    }
  }
  if (packageTable.autoexamples !== false) {
    for (const target of await conventionalTargets(
      input.root,
      input.packageDirectory,
      "example",
    )) {
      if (
        !targets.has(`example:${target.name}`) &&
        !claimedSources.has(target.sourcePath)
      ) {
        add(target);
      }
    }
  }
  return [...targets.values()].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
}

async function readCargoPackage(
  root: string,
  directory: DirectoryQueueEntry,
): Promise<CargoPackage | null> {
  const contents = await readBoundedText(
    path.join(directory.absolute, "Cargo.toml"),
    MAX_MANIFEST_BYTES,
  );
  if (contents === null) return null;
  let manifest: unknown;
  try {
    manifest = parseToml(contents);
  } catch {
    return null;
  }
  if (!isRecord(manifest) || !isRecord(manifest.package)) return null;
  const name = validPackageName(manifest.package.name);
  if (!name) return null;
  const targets = await packageTargets({
    manifest,
    packageDirectory: directory.absolute,
    packageName: name,
    root,
  });
  return {
    defaultRun:
      typeof manifest.package["default-run"] === "string"
        ? (validTargetName(manifest.package["default-run"]) ?? null)
        : null,
    directory: directory.relative,
    name,
    targets,
  };
}

async function scanPackages(
  context: RunConfigurationProviderContext,
): Promise<CargoPackage[]> {
  const root = await realpath(context.targetRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) return [];
  const queue: DirectoryQueueEntry[] = [
    { absolute: root, depth: 0, relative: "." },
  ];
  const packages: CargoPackage[] = [];
  let visitedDirectories = 0;
  let manifests = 0;
  let targets = 0;
  while (
    queue.length > 0 &&
    visitedDirectories < MAX_DISCOVERY_DIRECTORIES &&
    manifests < MAX_DISCOVERY_MANIFESTS &&
    targets < MAX_DISCOVERY_TARGETS
  ) {
    const current = queue.shift()!;
    visitedDirectories += 1;
    const package_ = await readCargoPackage(root, current);
    if (package_) {
      manifests += 1;
      targets += package_.targets.length;
      if (package_.targets.length > 0) packages.push(package_);
    }
    if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (
        queue.length + visitedDirectories >= MAX_DISCOVERY_DIRECTORIES ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.includes("\0") ||
        IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      queue.push({
        absolute: path.join(current.absolute, entry.name),
        depth: current.depth + 1,
        relative: portableJoin(current.relative, entry.name),
      });
    }
  }
  return packages.sort(
    (left, right) =>
      left.directory.localeCompare(right.directory) ||
      left.name.localeCompare(right.name),
  );
}

function baseDocument(input: {
  id: string;
  name: string;
}): Omit<RunConfigurationRustDocument, "target"> {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: RUN_CONFIGURATION_FILE_VERSION,
    id: input.id,
    name: input.name,
    provider: "rust",
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
      toolchain: "default",
      features: [],
      allFeatures: false,
      useDefaultFeatures: true,
      targetTriple: null,
      profile: "dev",
      locked: false,
      offline: false,
    },
    stop: { gracePeriodMs: 3_000 },
  };
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: RustPlatformOverride["environment"],
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
  document: RunConfigurationRustDocument,
  platform: RunConfigurationPlatform,
): ResolvedRustConfiguration {
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
      toolchain: override?.options?.toolchain ?? document.options.toolchain,
      features: override?.options?.features ?? document.options.features,
      allFeatures:
        override?.options?.allFeatures ?? document.options.allFeatures,
      useDefaultFeatures:
        override?.options?.useDefaultFeatures ??
        document.options.useDefaultFeatures,
      targetTriple:
        override?.options && Object.hasOwn(override.options, "targetTriple")
          ? (override.options.targetTriple ?? null)
          : document.options.targetTriple,
      profile: override?.options?.profile ?? document.options.profile,
      locked: override?.options?.locked ?? document.options.locked,
      offline: override?.options?.offline ?? document.options.offline,
    },
  };
}

function quoteArgument(
  value: string,
  platform: RunConfigurationPlatform,
): string {
  if (/^[A-Za-z0-9_./:@%+=,+-]+$/u.test(value)) return value;
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
    quoteArgument(executable, platform),
    ...arguments_.map((value) => quoteArgument(value, platform)),
  ].join(" ");
}

function renderCommandOverride(
  command: string,
  arguments_: string[],
  platform: RunConfigurationPlatform,
): string {
  return [
    command,
    ...arguments_.map((value) => quoteArgument(value, platform)),
  ].join(" ");
}

function cargoExecutable(platform: RunConfigurationPlatform): string {
  return platform === "win32" ? "cargo.exe" : "cargo";
}

function launchEnvironmentValue(
  context: RunConfigurationProviderContext,
  name: string,
): string | undefined {
  if (!context.environment) return undefined;
  if (context.platform !== "win32") return context.environment[name];
  const normalizedName = name.toUpperCase();
  return Object.entries(context.environment).find(
    ([key]) => key.toUpperCase() === normalizedName,
  )?.[1];
}

function absoluteEnvironmentPath(
  value: string,
  workingDirectory: string,
): string {
  return path.isAbsolute(value) ? value : path.resolve(workingDirectory, value);
}

function rustupHome(
  context: RunConfigurationProviderContext,
  workingDirectory: string,
): string | null {
  const configured = launchEnvironmentValue(context, "RUSTUP_HOME");
  if (configured !== undefined) {
    return absoluteEnvironmentPath(configured, workingDirectory);
  }
  let userHome = launchEnvironmentValue(context, "HOME");
  if (context.platform === "win32") {
    userHome = launchEnvironmentValue(context, "USERPROFILE") ?? userHome;
    if (!userHome) {
      const drive = launchEnvironmentValue(context, "HOMEDRIVE");
      const homePath = launchEnvironmentValue(context, "HOMEPATH");
      if (drive && homePath) userHome = `${drive}${homePath}`;
    }
  }
  return userHome
    ? path.join(absoluteEnvironmentPath(userHome, workingDirectory), ".rustup")
    : null;
}

function rustupToolchainNameMatches(
  requested: string,
  installed: string,
): boolean {
  if (installed === requested) return true;
  const shorthand =
    /^(?:(?:stable|beta|nightly)(?:-\d{4}-\d{2}-\d{2})?|\d+\.\d+(?:\.\d+)?)$/u.test(
      requested,
    );
  return shorthand && installed.startsWith(`${requested}-`);
}

async function rustToolchainPreflight(
  toolchain: string,
  workingDirectory: string,
  context: RunConfigurationProviderContext,
): Promise<RustToolchainPreflight> {
  if (!context.environment) return { diagnostic: null, roots: [] };
  const requested =
    toolchain === "default"
      ? launchEnvironmentValue(context, "RUSTUP_TOOLCHAIN")
      : toolchain;
  if (!requested) return { diagnostic: null, roots: [] };
  const home = rustupHome(context, workingDirectory);
  if (home) {
    try {
      const installed = await readdir(path.join(home, "toolchains"));
      if (installed.length > MAX_RUSTUP_TOOLCHAINS) {
        return {
          diagnostic: runConfigurationProviderDiagnostic(
            "rust-toolchain-inventory-too-large",
            "The Rustup toolchain inventory exceeds the validation limit.",
            "options.toolchain",
          ),
          roots: [],
        };
      }
      const roots = new Set<string>();
      for (const name of installed) {
        if (!rustupToolchainNameMatches(requested, name)) continue;
        const root = path.join(home, "toolchains", name);
        const executable = path.join(
          root,
          "bin",
          cargoExecutable(context.platform),
        );
        if (
          await findRunConfigurationExecutable(executable, {
            environment: context.environment,
            platform: context.platform,
            targetRoot: workingDirectory,
          })
        ) {
          try {
            const canonicalRoot = await realpath(root);
            if ((await lstat(canonicalRoot)).isDirectory()) {
              roots.add(canonicalRoot);
            }
          } catch {
            // Another matching installed toolchain may still be usable.
          }
        }
      }
      if (roots.size > 0) {
        return { diagnostic: null, roots: [...roots] };
      }
    } catch {
      // The actionable missing-toolchain diagnostic below covers absent or
      // unreadable Rustup state without executing rustup during validation.
    }
  }
  return {
    diagnostic: runConfigurationProviderDiagnostic(
      "rust-toolchain-unavailable",
      `The selected Rust toolchain ${JSON.stringify(requested)} is not installed for this launch environment. Install it with rustup or select an installed toolchain.`,
      "options.toolchain",
    ),
    roots: [],
  };
}

async function rustTargetDiagnostic(
  targetTriple: string,
  toolchainRoots: string[],
): Promise<RunConfigurationDiagnostic | null> {
  for (const root of toolchainRoots) {
    try {
      const libraryDirectory = await realpath(
        path.join(root, "lib", "rustlib", targetTriple, "lib"),
      );
      if ((await lstat(libraryDirectory)).isDirectory()) return null;
    } catch {
      // Check every matching toolchain before reporting the target missing.
    }
  }
  return runConfigurationProviderDiagnostic(
    "rust-target-unavailable",
    `The selected Rust target ${JSON.stringify(targetTriple)} is not installed for the launch toolchain. Install it with rustup target add or choose an installed target.`,
    "options.targetTriple",
  );
}

function cargoSelectionArguments(
  document: RunConfigurationRustDocument,
  options: RunConfigurationRustDocument["options"],
): string[] {
  return [
    `--package=${document.target.package}`,
    document.target.kind === "binary"
      ? `--bin=${document.target.name}`
      : `--example=${document.target.name}`,
    ...(options.allFeatures
      ? ["--all-features"]
      : options.features.map((feature) => `--features=${feature}`)),
    ...(!options.useDefaultFeatures ? ["--no-default-features"] : []),
    ...(options.targetTriple ? [`--target=${options.targetTriple}`] : []),
    ...(options.profile === "dev"
      ? []
      : options.profile === "release"
        ? ["--release"]
        : [`--profile=${options.profile}`]),
    ...(options.locked ? ["--locked"] : []),
    ...(options.offline ? ["--offline"] : []),
  ];
}

function cargoArguments(
  command: string,
  document: RunConfigurationRustDocument,
  resolved: ResolvedRustConfiguration,
  includeProgramArguments: boolean,
): string[] {
  return [
    ...(resolved.options.toolchain === "default"
      ? []
      : [`+${resolved.options.toolchain}`]),
    command,
    ...cargoSelectionArguments(document, resolved.options),
    ...(includeProgramArguments && resolved.arguments.length > 0
      ? ["--", ...resolved.arguments]
      : []),
  ];
}

function effectiveCommand(
  document: RunConfigurationRustDocument,
  resolved: ResolvedRustConfiguration,
  platform: RunConfigurationPlatform,
): string {
  return resolved.commandOverride !== null
    ? renderCommandOverride(
        resolved.commandOverride,
        resolved.arguments,
        platform,
      )
    : renderCommand(
        cargoExecutable(platform),
        cargoArguments("run", document, resolved, true),
        platform,
      );
}

function providerTask(task: string): string {
  if (!SUPPORTED_PROVIDER_TASKS.has(task)) {
    throw new Error(
      "Rust provider tasks must be one of: build, check, or clippy.",
    );
  }
  return task;
}

async function materializeBeforeLaunch(
  document: RunConfigurationRustDocument,
  context: RunConfigurationProviderContext,
  resolved: ResolvedRustConfiguration,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  const workingDirectory = await resolveRealDirectory(
    context.targetRoot,
    resolved.workingDirectory,
  );
  for (const step of document.beforeLaunch) {
    if (step.kind === "providerTask") {
      commands.push({
        executable: cargoExecutable(context.platform),
        arguments: cargoArguments(
          providerTask(step.task),
          document,
          resolved,
          false,
        ),
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

function candidateConfidence(
  package_: CargoPackage,
  target: CargoTarget,
): "high" | "medium" {
  return package_.targets.length === 1 ||
    package_.defaultRun === target.name ||
    (target.kind === "binary" && target.sourcePath === "src/main.rs")
    ? "high"
    : "medium";
}

function candidateName(package_: CargoPackage, target: CargoTarget): string {
  return target.kind === "binary"
    ? `Rust ${package_.name}: ${target.name}`.slice(0, 200)
    : `Rust ${package_.name} example: ${target.name}`.slice(0, 200);
}

function targetRequiredFeaturesEnabled(
  packageName: string,
  required: string[],
  resolved: ResolvedRustConfiguration,
): boolean {
  if (resolved.options.allFeatures) return true;
  const enabled = new Set(resolved.options.features);
  return required.every(
    (feature) =>
      enabled.has(feature) || enabled.has(`${packageName}/${feature}`),
  );
}

export const rustRunConfigurationProvider: RunConfigurationProvider<RunConfigurationRustDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "rust",
      label: "Rust / Cargo",
      icon: "boxes",
      available: true,
      supportsDiscovery: true,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationRustDocumentSchema.parse({
        ...baseDocument({ id, name }),
        target: { kind: "binary", package: "app", name: "app" },
      });
    },

    async discover(
      context,
    ): Promise<
      RunConfigurationProviderCandidate<RunConfigurationRustDocument>[]
    > {
      const candidates: RunConfigurationProviderCandidate<RunConfigurationRustDocument>[] =
        [];
      for (const package_ of await scanPackages(context)) {
        for (const target of package_.targets) {
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
          const confidence = candidateConfidence(package_, target);
          const document = baseDocument({
            id: randomUUID(),
            name: candidateName(package_, target),
          });
          candidates.push({
            confidence,
            reason:
              package_.defaultRun === target.name
                ? `${target.name} is the default Cargo binary for ${package_.name}.`
                : target.sourcePath === "src/main.rs"
                  ? `${package_.name} has the conventional binary target ${target.sourcePath}.`
                  : package_.targets.length === 1
                    ? `${target.name} is the only runnable Cargo target discovered in ${package_.name}.`
                    : `${target.name} is a statically declared or conventional Cargo ${target.kind} target in ${package_.name}.`,
            document: runConfigurationRustDocumentSchema.parse({
              ...document,
              workingDirectory: package_.directory,
              target: {
                kind: target.kind,
                package: package_.name,
                name: target.name,
              },
              options: {
                ...document.options,
                features: target.requiredFeatures,
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
      const parsed = runConfigurationRustDocumentSchema.parse(document);
      return effectiveCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationRustDocumentSchema.parse(document);
      const resolved = resolveConfiguration(parsed, context.platform);
      const diagnostics: RunConfigurationDiagnostic[] = [];
      let workingDirectory: string | null = null;
      try {
        workingDirectory = await resolveRealDirectory(
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
      const hasProviderTask = parsed.beforeLaunch.some(
        ({ kind }) => kind === "providerTask",
      );
      if (
        workingDirectory &&
        (resolved.commandOverride === null || hasProviderTask)
      ) {
        const diagnostic = await runConfigurationExecutableDiagnostic(
          cargoExecutable(context.platform),
          context,
          "options.toolchain",
        );
        if (diagnostic) diagnostics.push(diagnostic);
        if (!diagnostic) {
          const toolchain = await rustToolchainPreflight(
            resolved.options.toolchain,
            workingDirectory,
            context,
          );
          if (toolchain.diagnostic) {
            diagnostics.push(toolchain.diagnostic);
          } else if (
            resolved.options.targetTriple &&
            toolchain.roots.length > 0
          ) {
            const targetDiagnostic = await rustTargetDiagnostic(
              resolved.options.targetTriple,
              toolchain.roots,
            );
            if (targetDiagnostic) diagnostics.push(targetDiagnostic);
          }
        }
        const packages = await scanPackages({
          ...context,
          targetRoot: workingDirectory,
        });
        const matchingPackages = packages.filter(
          (package_) => package_.name === parsed.target.package,
        );
        if (matchingPackages.length === 0) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "cargo-package-missing",
              `Cargo package ${parsed.target.package} was not found beneath the start directory.`,
              "target.package",
            ),
          );
        } else if (matchingPackages.length > 1) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "cargo-package-ambiguous",
              `More than one Cargo package named ${parsed.target.package} exists beneath the start directory.`,
              "target.package",
            ),
          );
        } else {
          const package_ = matchingPackages[0]!;
          const target = package_.targets.find(
            (candidate) =>
              candidate.kind === parsed.target.kind &&
              candidate.name === parsed.target.name,
          );
          if (!target) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "cargo-target-missing",
                `Cargo ${parsed.target.kind} target ${parsed.target.name} was not found in package ${parsed.target.package}.`,
                "target.name",
              ),
            );
          } else if (
            !targetRequiredFeaturesEnabled(
              package_.name,
              target.requiredFeatures,
              resolved,
            )
          ) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "cargo-target-features-missing",
                `Cargo target ${target.name} requires features: ${target.requiredFeatures.join(", ")}.`,
                "options.features",
              ),
            );
          }
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "providerTask") {
          try {
            providerTask(step.task);
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "rust-provider-task-invalid",
                error instanceof Error ? error.message : String(error),
                `beforeLaunch[${index}].task`,
              ),
            );
          }
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
      const parsed = runConfigurationRustDocumentSchema.parse(document);
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
        executable = cargoExecutable(context.platform);
        arguments_ = cargoArguments("run", parsed, resolved, true);
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
