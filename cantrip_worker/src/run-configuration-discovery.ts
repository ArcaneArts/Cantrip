import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  RUN_CONFIGURATION_DIRECTORY,
  runConfigurationInspectionSchema,
  type RunConfigurationAction,
  type RunConfigurationDefinition,
  type RunConfigurationDiagnostic,
  type RunConfigurationInspection,
  type RunConfigurationPlatform,
  type RunConfigurationSetup,
  type RunConfigurationSourceControlState,
} from "@cantrip/protocol";
import { parse as parseToml } from "smol-toml";

const execFileAsync = promisify(execFile);
const MAX_CONFIGURATION_BYTES = 512 * 1_024;
const MAX_CONFIGURATIONS = 64;
const MAX_ACTIONS = 200;
const MAX_DIAGNOSTICS = 200;
const DISPLAY_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

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
