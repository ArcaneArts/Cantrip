import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  RUN_CONFIGURATION_DIRECTORY,
  runConfigurationAuthoringDocumentSchema,
  runConfigurationAuthoringSnapshotSchema,
  runConfigurationInspectionSchema,
  workerRunConfigurationWriteResultSchema,
  type RunConfigurationAuthoringDocument,
  type RunConfigurationAuthoringSnapshot,
  type RunConfigurationAction,
  type RunConfigurationDefinition,
  type RunConfigurationDiagnostic,
  type RunConfigurationInspection,
  type RunConfigurationPlatform,
  type RunConfigurationSetup,
  type RunConfigurationSelection,
  type RunConfigurationSourceControlState,
  type WorkerRunConfigurationWriteResult,
} from "@cantrip/protocol";
import { parse as parseToml } from "smol-toml";

const execFileAsync = promisify(execFile);
const MAX_CONFIGURATION_BYTES = 512 * 1_024;
const MAX_CONFIGURATIONS = 64;
const MAX_ACTIONS = 200;
const MAX_DIAGNOSTICS = 200;
const DISPLAY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const AUTHORING_ROOT_FIELDS = new Set(["version", "name", "setup", "actions"]);
const AUTHORING_SETUP_FIELDS = new Set(["script", "win32", "darwin", "linux"]);
const AUTHORING_ACTION_FIELDS = new Set([
  "name",
  "icon",
  "command",
  "platform",
]);

function platformName(platform: NodeJS.Platform): RunConfigurationPlatform {
  if (platform === "win32" || platform === "darwin") return platform;
  return "linux";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function diagnostic(
  severity: RunConfigurationDiagnostic["severity"],
  code: string,
  message: string,
  configurationPath: string | null = null,
  field: string | null = null,
): RunConfigurationDiagnostic {
  const compact = message.replace(/\s+/gu, " ").trim().slice(0, 1_000);
  return {
    severity,
    code,
    message: compact || "Run configuration validation failed.",
    configurationPath,
    field,
  };
}

function pushDiagnostic(
  diagnostics: RunConfigurationDiagnostic[],
  value: RunConfigurationDiagnostic,
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(value);
}

async function gitMatches(
  sourceRoot: string,
  args: string[],
): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", sourceRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function sourceControlState(
  sourceRoot: string,
  relativePath: string,
): Promise<Exclude<RunConfigurationSourceControlState, "absent">> {
  if (
    await gitMatches(sourceRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      relativePath,
    ])
  ) {
    return "tracked";
  }
  if (
    await gitMatches(sourceRoot, ["check-ignore", "-q", "--", relativePath])
  ) {
    return "ignored";
  }
  return "untracked";
}

function displayString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= maximum &&
    !DISPLAY_CONTROL_CHARACTERS.test(normalized)
    ? normalized
    : null;
}

function script(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() && value.length <= 100_000 && !value.includes("\0")
    ? value
    : null;
}

function parsePlatform(
  value: unknown,
): RunConfigurationPlatform | null | undefined {
  if (value === undefined) return null;
  return value === "win32" || value === "darwin" || value === "linux"
    ? value
    : undefined;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains fields the Environment editor cannot preserve: ${unknown.join(", ")}. Edit this file with repository tools instead.`,
    );
  }
}

function authoringDocument(value: unknown): RunConfigurationAuthoringDocument {
  const root = record(value);
  if (!root) throw new Error("The canonical environment must be a TOML table.");
  assertKnownFields(root, AUTHORING_ROOT_FIELDS, "The environment");
  if (root.version !== 1) {
    throw new Error(
      "The Environment editor supports only configuration version 1.",
    );
  }
  const name = displayString(root.name, 200);
  if (!name) throw new Error("The environment name is invalid.");

  const setup = {
    default: null as string | null,
    win32: null as string | null,
    darwin: null as string | null,
    linux: null as string | null,
  };
  if (root.setup !== undefined) {
    const setupTable = record(root.setup);
    if (!setupTable) throw new Error("setup must be a TOML table.");
    assertKnownFields(setupTable, AUTHORING_SETUP_FIELDS, "setup");
    if (setupTable.script !== undefined) {
      setup.default = script(setupTable.script);
      if (!setup.default) throw new Error("setup.script is invalid.");
    }
    for (const platform of ["win32", "darwin", "linux"] as const) {
      if (setupTable[platform] === undefined) continue;
      const platformTable = record(setupTable[platform]);
      if (!platformTable) {
        throw new Error(`setup.${platform} must be a TOML table.`);
      }
      assertKnownFields(
        platformTable,
        new Set(["script"]),
        `setup.${platform}`,
      );
      const command = script(platformTable.script);
      if (!command) throw new Error(`setup.${platform}.script is invalid.`);
      setup[platform] = command;
    }
  }

  const actionValues = root.actions === undefined ? [] : root.actions;
  if (!Array.isArray(actionValues) || actionValues.length > MAX_ACTIONS) {
    throw new Error(`actions must contain at most ${MAX_ACTIONS} TOML tables.`);
  }
  const actions = actionValues.map((value, index) => {
    const action = record(value);
    if (!action) throw new Error(`Action ${index + 1} must be a TOML table.`);
    assertKnownFields(action, AUTHORING_ACTION_FIELDS, `Action ${index + 1}`);
    const actionName = displayString(action.name, 200);
    const icon = displayString(action.icon, 100);
    const command = script(action.command);
    const platform = parsePlatform(action.platform);
    if (!actionName || !icon || !command || platform === undefined) {
      throw new Error(`Action ${index + 1} contains invalid fields.`);
    }
    return { name: actionName, icon, command, platform };
  });
  return runConfigurationAuthoringDocumentSchema.parse({
    version: 1,
    name,
    setup,
    actions,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function serializeRunConfiguration(
  input: RunConfigurationAuthoringDocument,
): string {
  const document = runConfigurationAuthoringDocumentSchema.parse(input);
  const lines = [
    "# Generated by Cantrip Environment settings.",
    "# This file is compatible with Codex local environments.",
    "version = 1",
    `name = ${tomlString(document.name)}`,
  ];
  const setupEntries = [
    ["default", document.setup.default],
    ["win32", document.setup.win32],
    ["darwin", document.setup.darwin],
    ["linux", document.setup.linux],
  ] as const;
  for (const [platform, command] of setupEntries) {
    if (!command) continue;
    lines.push(
      "",
      platform === "default" ? "[setup]" : `[setup.${platform}]`,
      `script = ${tomlString(command)}`,
    );
  }
  for (const action of document.actions) {
    lines.push(
      "",
      "[[actions]]",
      `name = ${tomlString(action.name)}`,
      `icon = ${tomlString(action.icon)}`,
      `command = ${tomlString(action.command)}`,
    );
    if (action.platform) {
      lines.push(`platform = ${tomlString(action.platform)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

interface CanonicalFileState {
  directoryPath: string;
  exists: boolean;
  contents: string | null;
  revision: string | null;
  sourceRoot: string;
}

async function canonicalFileState(
  sourcePath: string,
): Promise<CanonicalFileState> {
  const sourceRoot = await realpath(sourcePath);
  if (!(await stat(sourceRoot)).isDirectory()) {
    throw new Error("The registered project source is not a directory.");
  }
  const directoryPath = path.join(sourceRoot, RUN_CONFIGURATION_DIRECTORY);
  try {
    const directoryMetadata = await lstat(directoryPath);
    if (!directoryMetadata.isDirectory()) {
      throw new Error(
        "The Run configuration directory must not be a symbolic link.",
      );
    }
    if (!isWithin(sourceRoot, await realpath(directoryPath))) {
      throw new Error(
        "The Run configuration directory escapes the project source.",
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directoryPath,
        exists: false,
        contents: null,
        revision: null,
        sourceRoot,
      };
    }
    throw error;
  }
  const configurationPath = path.join(
    sourceRoot,
    RUN_CONFIGURATION_CANONICAL_PATH,
  );
  try {
    const metadata = await lstat(configurationPath);
    if (!metadata.isFile()) {
      throw new Error(
        "The canonical Run configuration must be a regular file.",
      );
    }
    if (metadata.size > MAX_CONFIGURATION_BYTES) {
      throw new Error(
        `Run configuration files cannot exceed ${MAX_CONFIGURATION_BYTES} bytes.`,
      );
    }
    if (!isWithin(sourceRoot, await realpath(configurationPath))) {
      throw new Error(
        "The canonical Run configuration escapes the project source.",
      );
    }
    const contents = await readFile(configurationPath, "utf8");
    return {
      directoryPath,
      exists: true,
      contents,
      revision: createHash("sha256").update(contents).digest("hex"),
      sourceRoot,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directoryPath,
        exists: false,
        contents: null,
        revision: null,
        sourceRoot,
      };
    }
    throw error;
  }
}

function compactError(error: unknown): string {
  return (
    error instanceof Error ? error.message : "The environment cannot be edited."
  )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

function parseSetup(
  input: Record<string, unknown>,
  platform: RunConfigurationPlatform,
  relativePath: string,
  diagnostics: RunConfigurationDiagnostic[],
): RunConfigurationSetup | null {
  if (input.setup === undefined) return null;
  const setup = record(input.setup);
  if (!setup) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "invalid-setup",
        "setup must be a TOML table.",
        relativePath,
        "setup",
      ),
    );
    return null;
  }

  const defaultCommand =
    setup.script === undefined ? null : script(setup.script);
  if (setup.script !== undefined && !defaultCommand) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "invalid-setup-script",
        "setup.script must be a non-empty script no longer than 100,000 characters.",
        relativePath,
        "setup.script",
      ),
    );
  }

  const platformScripts = new Map<RunConfigurationPlatform, string>();
  for (const candidate of ["win32", "darwin", "linux"] as const) {
    if (setup[candidate] === undefined) continue;
    const platformSetup = record(setup[candidate]);
    const platformCommand = script(platformSetup?.script);
    if (!platformSetup || !platformCommand) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "invalid-platform-setup",
          `setup.${candidate}.script must be a non-empty script no longer than 100,000 characters.`,
          relativePath,
          `setup.${candidate}.script`,
        ),
      );
      continue;
    }
    platformScripts.set(candidate, platformCommand);
  }

  const selected = platformScripts.get(platform);
  if (selected) return { command: selected, platform };
  return defaultCommand ? { command: defaultCommand, platform: null } : null;
}

function parseActions(
  input: Record<string, unknown>,
  platform: RunConfigurationPlatform,
  relativePath: string,
  diagnostics: RunConfigurationDiagnostic[],
): RunConfigurationAction[] {
  if (input.actions === undefined) return [];
  if (!Array.isArray(input.actions)) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "invalid-actions",
        "actions must be an array of TOML tables.",
        relativePath,
        "actions",
      ),
    );
    return [];
  }
  if (input.actions.length > MAX_ACTIONS) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "too-many-actions",
        `A run configuration may contain at most ${MAX_ACTIONS} actions.`,
        relativePath,
        "actions",
      ),
    );
  }

  const actions: RunConfigurationAction[] = [];
  input.actions.slice(0, MAX_ACTIONS).forEach((value, sourceIndex) => {
    const action = record(value);
    if (!action) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "invalid-action",
          `Action ${sourceIndex + 1} must be a TOML table.`,
          relativePath,
          `actions.${sourceIndex}`,
        ),
      );
      return;
    }
    const name = displayString(action.name, 200);
    const icon = displayString(action.icon, 100);
    const command = script(action.command);
    const actionPlatform = parsePlatform(action.platform);
    const invalidFields = [
      ...(name ? [] : ["name"]),
      ...(icon ? [] : ["icon"]),
      ...(command ? [] : ["command"]),
      ...(actionPlatform === undefined ? ["platform"] : []),
    ];
    if (invalidFields.length > 0) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "invalid-action",
          `Action ${sourceIndex + 1} has invalid fields: ${invalidFields.join(", ")}.`,
          relativePath,
          `actions.${sourceIndex}`,
        ),
      );
      return;
    }
    if (actionPlatform !== null && actionPlatform !== platform) return;
    actions.push({
      id: createHash("sha256")
        .update(`${relativePath}\0${sourceIndex}`)
        .digest("hex"),
      name: name!,
      icon: icon!,
      command: command!,
      platform: actionPlatform,
      configurationPath: relativePath,
      sourceIndex,
    });
  });
  return actions;
}

async function inspectConfiguration(
  sourceRoot: string,
  pathname: string,
  relativePath: string,
  platform: RunConfigurationPlatform,
): Promise<RunConfigurationDefinition> {
  const diagnostics: RunConfigurationDiagnostic[] = [];
  const metadata = await stat(pathname);
  if (!metadata.isFile()) throw new Error("Run configuration is not a file.");
  if (metadata.size > MAX_CONFIGURATION_BYTES) {
    // Oversized configurations are never parsed or executable. Keep their
    // rejection revision stable without reading attacker-controlled amounts
    // of data into memory.
    const rejectedRevision = `rejected-oversized\0${metadata.size}`;
    return {
      relativePath,
      revision: createHash("sha256").update(rejectedRevision).digest("hex"),
      version: null,
      name: null,
      sourceControlState: await sourceControlState(sourceRoot, relativePath),
      setup: null,
      actions: [],
      diagnostics: [
        diagnostic(
          "error",
          "configuration-too-large",
          `Run configuration files cannot exceed ${MAX_CONFIGURATION_BYTES} bytes.`,
          relativePath,
        ),
      ],
    };
  }
  const contents = await readFile(pathname, "utf8");
  const revision = createHash("sha256").update(contents).digest("hex");
  const state = await sourceControlState(sourceRoot, relativePath);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = record(parseToml(contents));
  } catch (error) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "invalid-toml",
        error instanceof Error
          ? error.message
          : "The TOML could not be parsed.",
        relativePath,
      ),
    );
  }
  if (!parsed) {
    return {
      relativePath,
      revision,
      version: null,
      name: null,
      sourceControlState: state,
      setup: null,
      actions: [],
      diagnostics,
    };
  }

  const version =
    Number.isInteger(parsed.version) && Number(parsed.version) > 0
      ? Number(parsed.version)
      : null;
  if (version !== 1) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        version === null ? "invalid-version" : "unsupported-version",
        version === null
          ? "version must be the integer 1."
          : `Run configuration version ${version} is not supported.`,
        relativePath,
        "version",
      ),
    );
  }
  const name = displayString(parsed.name, 200);
  if (!name) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "invalid-name",
        "name must be non-empty display text no longer than 200 characters.",
        relativePath,
        "name",
      ),
    );
  }
  const setup = parseSetup(parsed, platform, relativePath, diagnostics);
  const actions = parseActions(parsed, platform, relativePath, diagnostics);
  return {
    relativePath,
    revision,
    version,
    name,
    sourceControlState: state,
    setup,
    actions,
    diagnostics,
  };
}

export async function inspectRunConfigurations(
  sourcePath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<RunConfigurationInspection> {
  const platform = platformName(hostPlatform);
  const sourceRoot = await realpath(sourcePath);
  const sourceMetadata = await stat(sourceRoot);
  if (!sourceMetadata.isDirectory()) {
    throw new Error("The registered project source is not a directory.");
  }

  const diagnostics: RunConfigurationDiagnostic[] = [];
  const directoryPath = path.join(sourceRoot, RUN_CONFIGURATION_DIRECTORY);
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return runConfigurationInspectionSchema.parse({
        platform,
        canonical: {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          sourceControlState: "absent",
        },
        configured: false,
        valid: true,
        configurations: [],
        diagnostics: [],
      });
    }
    throw error;
  }
  if (!directoryMetadata.isDirectory()) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "unsafe-configuration-directory",
        "The run configuration location must be a real directory inside the project source.",
      ),
    );
    return runConfigurationInspectionSchema.parse({
      platform,
      canonical: {
        relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
        sourceControlState: "absent",
      },
      configured: false,
      valid: false,
      configurations: [],
      diagnostics,
    });
  }
  const canonicalDirectory = await realpath(directoryPath);
  if (!isWithin(sourceRoot, canonicalDirectory)) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "configuration-directory-escape",
        "The run configuration directory resolves outside the project source.",
      ),
    );
    return runConfigurationInspectionSchema.parse({
      platform,
      canonical: {
        relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
        sourceControlState: "absent",
      },
      configured: false,
      valid: false,
      configurations: [],
      diagnostics,
    });
  }

  const entries = (await readdir(canonicalDirectory, { withFileTypes: true }))
    .filter((entry) => entry.name.toLocaleLowerCase().endsWith(".toml"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_CONFIGURATIONS) {
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "error",
        "too-many-configurations",
        `A project may contain at most ${MAX_CONFIGURATIONS} run configuration files.`,
      ),
    );
  }

  const configurations: RunConfigurationDefinition[] = [];
  for (const entry of entries.slice(0, MAX_CONFIGURATIONS)) {
    const relativePath = `${RUN_CONFIGURATION_DIRECTORY}/${entry.name}`;
    if (!entry.isFile()) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "unsafe-configuration-file",
          "Run configurations must be regular files and cannot be symbolic links.",
          relativePath,
        ),
      );
      continue;
    }
    const pathname = path.join(canonicalDirectory, entry.name);
    const canonicalFile = await realpath(pathname);
    if (!isWithin(sourceRoot, canonicalFile)) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "configuration-file-escape",
          "A run configuration resolves outside the project source.",
          relativePath,
        ),
      );
      continue;
    }
    try {
      configurations.push(
        await inspectConfiguration(
          sourceRoot,
          canonicalFile,
          relativePath,
          platform,
        ),
      );
    } catch (error) {
      pushDiagnostic(
        diagnostics,
        diagnostic(
          "error",
          "configuration-read-failed",
          error instanceof Error
            ? error.message
            : "The run configuration could not be read.",
          relativePath,
        ),
      );
    }
  }

  const actionNames = new Map<string, RunConfigurationAction[]>();
  for (const configuration of configurations) {
    for (const action of configuration.actions) {
      const matches = actionNames.get(action.name) ?? [];
      matches.push(action);
      actionNames.set(action.name, matches);
    }
  }
  for (const [name, actions] of actionNames) {
    if (actions.length < 2) continue;
    pushDiagnostic(
      diagnostics,
      diagnostic(
        "warning",
        "ambiguous-action-name",
        `Action name ${JSON.stringify(name)} matches ${actions.length} platform-compatible actions; select one by ID.`,
      ),
    );
  }

  const canonicalConfiguration = configurations.find(
    ({ relativePath }) => relativePath === RUN_CONFIGURATION_CANONICAL_PATH,
  );
  const hasErrors = [
    ...diagnostics,
    ...configurations.flatMap((configuration) => configuration.diagnostics),
  ].some(({ severity }) => severity === "error");
  return runConfigurationInspectionSchema.parse({
    platform,
    canonical: {
      relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
      sourceControlState:
        canonicalConfiguration?.sourceControlState ?? "absent",
    },
    configured: configurations.length > 0,
    valid: !hasErrors,
    configurations,
    diagnostics,
  });
}

export async function readRunConfigurationAuthoring(
  sourcePath: string,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<RunConfigurationAuthoringSnapshot> {
  const inspection = await inspectRunConfigurations(sourcePath, hostPlatform);
  try {
    const state = await canonicalFileState(sourcePath);
    if (!state.exists || !state.contents) {
      return runConfigurationAuthoringSnapshotSchema.parse({
        relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
        sourceControlState: "absent",
        revision: null,
        document: null,
        editingError: null,
        inspection,
      });
    }
    return runConfigurationAuthoringSnapshotSchema.parse({
      relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
      sourceControlState: inspection.canonical.sourceControlState,
      revision: state.revision,
      document: authoringDocument(parseToml(state.contents)),
      editingError: null,
      inspection,
    });
  } catch (error) {
    const canonical = inspection.configurations.find(
      ({ relativePath }) => relativePath === RUN_CONFIGURATION_CANONICAL_PATH,
    );
    return runConfigurationAuthoringSnapshotSchema.parse({
      relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
      sourceControlState: inspection.canonical.sourceControlState,
      revision: canonical?.revision ?? null,
      document: null,
      editingError: compactError(error),
      inspection,
    });
  }
}

async function ensureAuthoringDirectory(
  sourceRoot: string,
  directoryPath: string,
): Promise<void> {
  const codexPath = path.join(sourceRoot, ".codex");
  for (const candidate of [codexPath, directoryPath]) {
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(candidate);
    if (
      !metadata.isDirectory() ||
      !isWithin(sourceRoot, await realpath(candidate))
    ) {
      throw new Error(
        "The Run configuration directory must be a real directory inside the project source.",
      );
    }
  }
}

export async function writeRunConfiguration(
  sourcePath: string,
  expectedRevision: string | null,
  input: RunConfigurationAuthoringDocument,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<WorkerRunConfigurationWriteResult> {
  const document = runConfigurationAuthoringDocumentSchema.parse(input);
  const contents = serializeRunConfiguration(document);
  if (Buffer.byteLength(contents, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new Error(
      `Run configuration files cannot exceed ${MAX_CONFIGURATION_BYTES} bytes.`,
    );
  }
  let current = await canonicalFileState(sourcePath);
  if (current.revision !== expectedRevision) {
    return workerRunConfigurationWriteResultSchema.parse({
      written: false,
      reason: "revision-mismatch",
      snapshot: await readRunConfigurationAuthoring(sourcePath, hostPlatform),
    });
  }
  await ensureAuthoringDirectory(current.sourceRoot, current.directoryPath);
  current = await canonicalFileState(sourcePath);
  if (current.revision !== expectedRevision) {
    return workerRunConfigurationWriteResultSchema.parse({
      written: false,
      reason: "revision-mismatch",
      snapshot: await readRunConfigurationAuthoring(sourcePath, hostPlatform),
    });
  }

  const configurationPath = path.join(
    current.sourceRoot,
    RUN_CONFIGURATION_CANONICAL_PATH,
  );
  const temporaryPath = path.join(
    current.directoryPath,
    `.environment.toml.${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    const beforeRename = await canonicalFileState(sourcePath);
    if (beforeRename.revision !== expectedRevision) {
      return workerRunConfigurationWriteResultSchema.parse({
        written: false,
        reason: "revision-mismatch",
        snapshot: await readRunConfigurationAuthoring(sourcePath, hostPlatform),
      });
    }
    await rename(temporaryPath, configurationPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return workerRunConfigurationWriteResultSchema.parse({
    written: true,
    snapshot: await readRunConfigurationAuthoring(sourcePath, hostPlatform),
  });
}

export async function resolveRunConfigurationAction(
  sourcePath: string,
  actionId: string,
  expectedRevision: string,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<RunConfigurationSelection> {
  const inspection = await inspectRunConfigurations(sourcePath, hostPlatform);
  if (!inspection.valid) {
    throw new Error(
      "Run configuration validation failed. Validate the environment before starting an action.",
    );
  }
  const matches = inspection.configurations.flatMap((configuration) =>
    configuration.actions
      .filter((action) => action.id === actionId)
      .map((action) => ({ action, configuration })),
  );
  if (matches.length !== 1) {
    throw new Error(
      "The requested Run action is not available on this worker platform.",
    );
  }
  const selected = matches[0]!;
  if (selected.configuration.revision !== expectedRevision) {
    throw new Error(
      "The Run configuration changed. List its actions again before starting it.",
    );
  }
  return selected;
}
