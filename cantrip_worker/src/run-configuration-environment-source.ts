import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runConfigurationCodexEnvironmentSourceStatusSchema,
  runConfigurationDiagnosticSchema,
  type RunConfigurationCodexEnvironmentSourceStatus,
  type RunConfigurationEnvironment,
  type RunConfigurationPlatform,
  type RunConfigurationRevision,
} from "@cantrip/protocol/run-configuration-definitions";
import { parse as parseDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";

import {
  type MaterializedRunCommand,
  shellCommandInvocation,
} from "./run-configuration-provider.js";

const CODEX_ENVIRONMENT_DIRECTORY = ".codex/environments";
const CODEX_ENVIRONMENT_PATH = `${CODEX_ENVIRONMENT_DIRECTORY}/environment.toml`;
const MAX_CODEX_ENVIRONMENT_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_FILE_BYTES = 512 * 1024;
const MAX_ENVIRONMENT_FILES_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SETUP_CAPTURE_BYTES = 1024 * 1024;
const MAX_SETUP_COMMAND_CHARACTERS = 100_000;
const MAX_SETUP_DURATION_MS = 120_000;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_ENVIRONMENT_NAME_CHARACTERS = 256;
const MAX_ENVIRONMENT_VALUE_CHARACTERS = 16 * 1024;
const MAX_ENVIRONMENT_TOTAL_CHARACTERS = 128 * 1024;
const CAPTURE_ENVIRONMENT_NAME = "_CANTRIP_RUN_ENV_CAPTURE";
const TRANSIENT_ENVIRONMENT_NAMES = new Set(["_", "OLDPWD", "PWD", "SHLVL"]);

interface InspectedCodexEnvironment {
  setupCommand: string | null;
  status: Omit<RunConfigurationCodexEnvironmentSourceStatus, "enabled">;
}

export interface RunConfigurationEnvironmentExecutionResult {
  exitCode: number;
  signal: string | null;
}

export interface RunConfigurationEnvironmentResolutionInput {
  baseline: Record<string, string>;
  defaultShell: string | null;
  environment: RunConfigurationEnvironment;
  expectedCodexEnvironmentRevision: RunConfigurationRevision | null;
  platform: RunConfigurationPlatform;
  sourceRoot: string;
  targetRoot: string;
  execute(
    command: MaterializedRunCommand,
    environment: Record<string, string>,
    timeoutMs: number,
  ): Promise<RunConfigurationEnvironmentExecutionResult>;
}

export interface RunConfigurationEnvironmentResolution {
  codex: Record<string, string>;
  codexEnvironmentRevision: RunConfigurationRevision | null;
  files: Record<string, string>;
  secrets: Record<string, string>;
}

export class RunConfigurationEnvironmentResolutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "RunConfigurationEnvironmentResolutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathIsAtOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function readBoundedRegularFile(
  filePath: string,
  maximumBytes: number,
): Promise<{ contents: Buffer; size: number }> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new Error("The environment source is not a bounded regular file.");
    }
    const bounded = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < bounded.byteLength) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        bounded.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new Error("The environment source exceeded its bounded size.");
    }
    const contents = bounded.subarray(0, offset);
    return { contents, size: contents.byteLength };
  } finally {
    await handle.close();
  }
}

function diagnostic(
  code: string,
  message: string,
  field: string | null = null,
) {
  return runConfigurationDiagnosticSchema.parse({
    severity: "error",
    code,
    message,
    relativePath: CODEX_ENVIRONMENT_PATH,
    field,
  });
}

function status(
  input: Omit<RunConfigurationCodexEnvironmentSourceStatus, "enabled">,
): Omit<RunConfigurationCodexEnvironmentSourceStatus, "enabled"> {
  const parsed = runConfigurationCodexEnvironmentSourceStatusSchema.parse({
    enabled: false,
    ...input,
  });
  return {
    configured: parsed.configured,
    valid: parsed.valid,
    revision: parsed.revision,
    hasSetup: parsed.hasSetup,
    diagnostics: parsed.diagnostics,
  };
}

function absentSource(): InspectedCodexEnvironment {
  return {
    setupCommand: null,
    status: status({
      configured: false,
      valid: true,
      revision: null,
      hasSetup: false,
      diagnostics: [],
    }),
  };
}

function invalidSource(
  code: string,
  message: string,
  input: {
    configured?: boolean;
    revision?: string | null;
    field?: string;
  } = {},
): InspectedCodexEnvironment {
  return {
    setupCommand: null,
    status: status({
      configured: input.configured ?? true,
      valid: false,
      revision: input.revision ?? null,
      hasSetup: false,
      diagnostics: [diagnostic(code, message, input.field ?? null)],
    }),
  };
}

function setupScript(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_SETUP_COMMAND_CHARACTERS &&
    !value.includes("\0")
    ? value
    : null;
}

function selectedSetupCommand(
  parsed: Record<string, unknown>,
  platform: RunConfigurationPlatform,
): { command: string | null; error: string | null; field: string | null } {
  if (parsed.setup === undefined) {
    return { command: null, error: null, field: null };
  }
  if (!isRecord(parsed.setup)) {
    return {
      command: null,
      error: "setup must be a TOML table.",
      field: "setup",
    };
  }
  const configuredDefault = parsed.setup.script;
  const defaultCommand =
    configuredDefault === undefined ? null : setupScript(configuredDefault);
  if (configuredDefault !== undefined && defaultCommand === null) {
    return {
      command: null,
      error:
        "setup.script must be a non-empty script no longer than 100,000 characters.",
      field: "setup.script",
    };
  }
  const platformValue = parsed.setup[platform];
  if (platformValue === undefined) {
    return { command: defaultCommand, error: null, field: null };
  }
  if (!isRecord(platformValue)) {
    return {
      command: null,
      error: `setup.${platform} must be a TOML table.`,
      field: `setup.${platform}`,
    };
  }
  const command = setupScript(platformValue.script);
  return command
    ? { command, error: null, field: null }
    : {
        command: null,
        error: `setup.${platform}.script must be a non-empty script no longer than 100,000 characters.`,
        field: `setup.${platform}.script`,
      };
}

async function inspectCodexEnvironment(
  sourceRoot: string,
  platform: RunConfigurationPlatform,
): Promise<InspectedCodexEnvironment> {
  const root = await realpath(sourceRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    return invalidSource(
      "codex-environment-root-invalid",
      "The registered Primary project root is not a directory.",
      { configured: false },
    );
  }
  const directory = path.join(root, ...CODEX_ENVIRONMENT_DIRECTORY.split("/"));
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return absentSource();
    throw error;
  }
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    return invalidSource(
      "codex-environment-directory-unsafe",
      "The Codex environment directory must be a real directory inside Primary.",
      { configured: false },
    );
  }
  const canonicalDirectory = await realpath(directory);
  if (!pathIsAtOrInside(root, canonicalDirectory)) {
    return invalidSource(
      "codex-environment-directory-escape",
      "The Codex environment directory resolves outside Primary.",
      { configured: false },
    );
  }
  const file = path.join(directory, "environment.toml");
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return absentSource();
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_CODEX_ENVIRONMENT_BYTES
  ) {
    return invalidSource(
      "codex-environment-file-unsafe",
      "The Codex environment must be a bounded real file inside Primary.",
    );
  }
  const canonicalFile = await realpath(file);
  if (!pathIsAtOrInside(root, canonicalFile)) {
    return invalidSource(
      "codex-environment-file-escape",
      "The Codex environment resolves outside Primary.",
    );
  }
  let contents: Buffer;
  try {
    ({ contents } = await readBoundedRegularFile(
      file,
      MAX_CODEX_ENVIRONMENT_BYTES,
    ));
  } catch {
    return invalidSource(
      "codex-environment-file-unsafe",
      "The Codex environment changed or became unreadable while it was inspected.",
    );
  }
  const revision = createHash("sha256").update(contents).digest("hex");
  const text = contents.toString("utf8");
  if (text.includes("\0")) {
    return invalidSource(
      "codex-environment-file-invalid",
      "The Codex environment contains a NUL character.",
      { revision },
    );
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    return invalidSource(
      "codex-environment-toml-invalid",
      "The Codex environment is not valid TOML.",
      { revision },
    );
  }
  if (!isRecord(parsed)) {
    return invalidSource(
      "codex-environment-toml-invalid",
      "The Codex environment must contain a TOML document.",
      { revision },
    );
  }
  const selected = selectedSetupCommand(parsed, platform);
  if (selected.error) {
    return invalidSource("codex-environment-setup-invalid", selected.error, {
      revision,
      field: selected.field ?? undefined,
    });
  }
  return {
    setupCommand: selected.command,
    status: status({
      configured: true,
      valid: true,
      revision,
      hasSetup: selected.command !== null,
      diagnostics: [],
    }),
  };
}

export async function inspectRunConfigurationCodexEnvironmentSource(input: {
  enabled: boolean;
  platform: RunConfigurationPlatform;
  sourceRoot: string;
}): Promise<RunConfigurationCodexEnvironmentSourceStatus> {
  const inspected = await inspectCodexEnvironment(
    input.sourceRoot,
    input.platform,
  );
  return runConfigurationCodexEnvironmentSourceStatusSchema.parse({
    enabled: input.enabled,
    ...inspected.status,
  });
}

function protectedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("CANTRIP_") ||
    upper.startsWith("_CANTRIP_") ||
    upper === "CODEX_WORKTREE_PATH" ||
    TRANSIENT_ENVIRONMENT_NAMES.has(upper)
  );
}

function boundedEnvironmentDelta(
  baseline: Record<string, string>,
  captured: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(captured).filter(
    ([name, value]) =>
      !protectedEnvironmentName(name) &&
      baseline[name] !== value &&
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) &&
      name.length <= MAX_ENVIRONMENT_NAME_CHARACTERS &&
      value.length <= MAX_ENVIRONMENT_VALUE_CHARACTERS &&
      !value.includes("\0"),
  );
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new RunConfigurationEnvironmentResolutionError(
      "codex-environment-too-large",
      "The Codex environment exported too many variables.",
      false,
    );
  }
  const total = entries.reduce(
    (size, [name, value]) => size + name.length + value.length,
    0,
  );
  if (total > MAX_ENVIRONMENT_TOTAL_CHARACTERS) {
    throw new RunConfigurationEnvironmentResolutionError(
      "codex-environment-too-large",
      "The Codex environment exceeded the bounded variable size.",
      false,
    );
  }
  return Object.fromEntries(entries);
}

function parsePosixEnvironment(contents: Buffer): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of contents.toString("utf8").split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

function parseWindowsEnvironment(contents: Buffer): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    value = null;
  }
  if (!isRecord(value)) {
    throw new RunConfigurationEnvironmentResolutionError(
      "codex-environment-capture-invalid",
      "The Codex environment setup returned an invalid environment capture.",
      true,
    );
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function captureWrapper(
  command: string,
  platform: RunConfigurationPlatform,
): string {
  if (platform === "win32") {
    return `$cantripExit = 0
$ErrorActionPreference = "Stop"
try {
  & {
${command}
  }
  if ($LASTEXITCODE -is [int]) { $cantripExit = $LASTEXITCODE }
  if ($cantripExit -eq 0) {
    $cantripEnvironment = @{}
    Get-ChildItem Env: | ForEach-Object { $cantripEnvironment[$_.Name] = $_.Value }
    $cantripJson = $cantripEnvironment | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($env:${CAPTURE_ENVIRONMENT_NAME}, $cantripJson, (New-Object System.Text.UTF8Encoding($false)))
  }
} catch {
  Write-Error $_
  $cantripExit = 1
}
exit $cantripExit`;
  }
  return `__cantrip_capture_environment() {
  __cantrip_status=$?
  trap - EXIT
  if [ "$__cantrip_status" -eq 0 ]; then
    env -0 > "$${CAPTURE_ENVIRONMENT_NAME}"
  fi
  exit "$__cantrip_status"
}
trap __cantrip_capture_environment EXIT
${command}`;
}

async function resolveEnvironmentFiles(
  targetRoot: string,
  files: string[],
): Promise<Record<string, string>> {
  const root = await realpath(targetRoot);
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const relativePath of files) {
    const candidate = path.join(root, ...relativePath.split("/"));
    let metadata;
    try {
      metadata = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunConfigurationEnvironmentResolutionError(
          "environment-file-missing",
          `Environment file ${relativePath} does not exist in the target worktree.`,
          true,
        );
      }
      throw error;
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_ENVIRONMENT_FILE_BYTES
    ) {
      throw new RunConfigurationEnvironmentResolutionError(
        "environment-file-unsafe",
        `Environment file ${relativePath} must be a bounded real file inside the target worktree.`,
        false,
      );
    }
    const canonical = await realpath(candidate);
    if (!pathIsAtOrInside(root, canonical)) {
      throw new RunConfigurationEnvironmentResolutionError(
        "environment-file-escape",
        `Environment file ${relativePath} resolves outside the target worktree.`,
        false,
      );
    }
    let contents: Buffer;
    let size: number;
    try {
      ({ contents, size } = await readBoundedRegularFile(
        candidate,
        MAX_ENVIRONMENT_FILE_BYTES,
      ));
    } catch {
      throw new RunConfigurationEnvironmentResolutionError(
        "environment-file-unsafe",
        `Environment file ${relativePath} changed or became unreadable while it was inspected.`,
        true,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_ENVIRONMENT_FILES_TOTAL_BYTES) {
      throw new RunConfigurationEnvironmentResolutionError(
        "environment-files-too-large",
        "The declared environment files exceed the combined size limit.",
        false,
      );
    }
    if (contents.includes(0)) {
      throw new RunConfigurationEnvironmentResolutionError(
        "environment-file-invalid",
        `Environment file ${relativePath} contains a NUL character.`,
        false,
      );
    }
    Object.assign(result, parseDotenv(contents));
  }
  return result;
}

async function materializeCodexEnvironment(
  inspected: InspectedCodexEnvironment,
  input: RunConfigurationEnvironmentResolutionInput,
): Promise<Record<string, string>> {
  if (!inspected.setupCommand) return {};
  const directory = await mkdtemp(
    path.join(tmpdir(), "cantrip-run-environment-"),
  );
  await chmod(directory, 0o700);
  const capturePath = path.join(directory, "environment.capture");
  try {
    await writeFile(capturePath, "", { mode: 0o600 });
    const environment = {
      ...input.baseline,
      CODEX_WORKTREE_PATH: input.targetRoot,
      CANTRIP_PROJECT_ROOT: input.sourceRoot,
      CANTRIP_WORKTREE_PATH: input.targetRoot,
      [CAPTURE_ENVIRONMENT_NAME]: capturePath,
    };
    const invocation = shellCommandInvocation(
      captureWrapper(inspected.setupCommand, input.platform),
      {
        defaultShell: input.defaultShell,
        platform: input.platform,
        targetRoot: input.targetRoot,
      },
    );
    const result = await input.execute(
      {
        ...invocation,
        workingDirectory: input.targetRoot,
      },
      environment,
      MAX_SETUP_DURATION_MS,
    );
    if (result.exitCode !== 0) {
      throw new RunConfigurationEnvironmentResolutionError(
        "codex-environment-setup-failed",
        `The Codex environment setup exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}.`,
        true,
      );
    }
    let capturedContents: Buffer;
    try {
      ({ contents: capturedContents } = await readBoundedRegularFile(
        capturePath,
        MAX_SETUP_CAPTURE_BYTES,
      ));
    } catch {
      throw new RunConfigurationEnvironmentResolutionError(
        "codex-environment-capture-too-large",
        "The Codex environment setup did not produce a bounded environment capture.",
        false,
      );
    }
    const captured =
      input.platform === "win32"
        ? parseWindowsEnvironment(capturedContents)
        : parsePosixEnvironment(capturedContents);
    return boundedEnvironmentDelta(environment, captured);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function resolveRunConfigurationEnvironmentSources(
  input: RunConfigurationEnvironmentResolutionInput,
): Promise<RunConfigurationEnvironmentResolution> {
  const missingSecret = input.environment.secrets.find(
    ({ enabled }) => enabled,
  );
  if (missingSecret) {
    throw new RunConfigurationEnvironmentResolutionError(
      "secret-reference-unavailable",
      `Secret reference ${missingSecret.secret} is unavailable.`,
      true,
    );
  }
  const files = await resolveEnvironmentFiles(
    input.targetRoot,
    input.environment.files,
  );
  if (!input.environment.includeCodexEnvironment) {
    if (input.expectedCodexEnvironmentRevision !== null) {
      throw new RunConfigurationEnvironmentResolutionError(
        "codex-environment-revision-mismatch",
        "The Run generation unexpectedly references a disabled Codex environment.",
        true,
      );
    }
    return {
      codex: {},
      codexEnvironmentRevision: null,
      files,
      secrets: {},
    };
  }
  const inspected = await inspectCodexEnvironment(
    input.sourceRoot,
    input.platform,
  );
  if (!inspected.status.valid) {
    throw new RunConfigurationEnvironmentResolutionError(
      inspected.status.diagnostics[0]?.code ?? "codex-environment-invalid",
      inspected.status.diagnostics[0]?.message ??
        "The Codex environment is invalid.",
      true,
    );
  }
  if (inspected.status.revision !== input.expectedCodexEnvironmentRevision) {
    throw new RunConfigurationEnvironmentResolutionError(
      "codex-environment-revision-mismatch",
      "The Codex environment changed before this generation started.",
      true,
    );
  }
  const codex = await materializeCodexEnvironment(inspected, input);
  const current = await inspectCodexEnvironment(
    input.sourceRoot,
    input.platform,
  );
  if (
    !current.status.valid ||
    current.status.revision !== inspected.status.revision
  ) {
    throw new RunConfigurationEnvironmentResolutionError(
      "codex-environment-revision-mismatch",
      "The Codex environment changed while this generation was materializing.",
      true,
    );
  }
  return {
    codex,
    codexEnvironmentRevision: inspected.status.revision,
    files,
    secrets: {},
  };
}
