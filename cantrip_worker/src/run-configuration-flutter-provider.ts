import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  RUN_CONFIGURATION_FILE_SCHEMA,
  runConfigurationFlutterDocumentSchema,
  runConfigurationProviderCapabilitySchema,
  type RunConfigurationDiagnostic,
  type RunConfigurationEnvironment,
  type RunConfigurationFlutterDocument,
  type RunConfigurationPlatform,
} from "@cantrip/protocol/run-configuration-definitions";
import type { RunConfigurationFlutterDevice } from "@cantrip/protocol/run-configuration-operations";

import {
  findRunConfigurationExecutable,
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
import { RunConfigurationProcessTreeController } from "./run-configuration-process-tree.js";

const MAX_DISCOVERY_DIRECTORIES = 1_024;
const MAX_DISCOVERY_DEPTH = 10;
const MAX_DISCOVERY_PACKAGES = 256;
const MAX_DISCOVERY_SOURCES = 512;
const MAX_DISCOVERY_CANDIDATES = 128;
const MAX_PUBSPEC_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_FLUTTER_DEVICES = 256;
const MAX_FLUTTER_DEVICE_OUTPUT_BYTES = 256 * 1024;
const FLUTTER_DEVICE_TIMEOUT_MS = 15_000;
const SUPPORTED_PROVIDER_TASKS = new Map([
  ["clean", ["clean"]],
  ["gen-l10n", ["gen-l10n"]],
  ["pub get", ["pub", "get"]],
]);
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

type FlutterPlatformOverride = NonNullable<
  RunConfigurationFlutterDocument["platformOverrides"]["win32"]
>;

interface ResolvedFlutterConfiguration {
  arguments: string[];
  commandOverride: string | null;
  environment: RunConfigurationEnvironment;
  options: RunConfigurationFlutterDocument["options"];
  workingDirectory: string;
}

interface ScannedFlutterSource {
  relativePath: string;
}

interface ScannedPubspec {
  defaultFlavor: string | null;
  directory: string;
  flutter: boolean;
  name: string | null;
}

interface FlutterPackage {
  defaultFlavor: string | null;
  directory: string;
  entrypoints: string[];
  name: string;
}

interface FlutterToolOutcome {
  exitCode: number;
  stdout: string;
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

function flutterPackageName(pubspec: string): string | null {
  const match = pubspec.match(
    /^(?:\uFEFF)?name\s*:\s*(?:"([a-z_][a-z0-9_]*)"|'([a-z_][a-z0-9_]*)'|([a-z_][a-z0-9_]*))\s*(?:#.*)?$/mu,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isFlutterPubspec(pubspec: string): boolean {
  return /^[ \t]+sdk\s*:\s*flutter\s*(?:#.*)?$/mu.test(pubspec);
}

function flutterDefaultFlavor(pubspec: string): string | null {
  let inFlutterSection = false;
  for (const line of pubspec.split(/\r?\n/u)) {
    if (/^flutter\s*:\s*(?:#.*)?$/u.test(line)) {
      inFlutterSection = true;
      continue;
    }
    if (!inFlutterSection) continue;
    if (/^(?:\s*|\s*#.*)$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;
    const match = line.match(
      /^\s+default-flavor\s*:\s*(?:"([A-Za-z0-9_.-]+)"|'([A-Za-z0-9_.-]+)'|([A-Za-z0-9_.-]+))\s*(?:#.*)?$/u,
    );
    if (match) return match[1] ?? match[2] ?? match[3] ?? null;
  }
  return null;
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

function isLikelyFlutterEntrypoint(relativePath: string): boolean {
  return /^lib\/main(?:[_.-][A-Za-z0-9_.-]+)?\.dart$/u.test(relativePath);
}

async function scanPackages(
  context: RunConfigurationProviderContext,
): Promise<FlutterPackage[]> {
  const root = await realpath(context.targetRoot);
  const queue = [{ absolute: root, directory: ".", depth: 0 }];
  const pubspecs: ScannedPubspec[] = [];
  const sources: ScannedFlutterSource[] = [];
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
          defaultFlavor: flutterDefaultFlavor(pubspec),
          directory: current.directory,
          flutter: isFlutterPubspec(pubspec),
          name: flutterPackageName(pubspec),
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
          sources.push({ relativePath });
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
  return pubspecs.flatMap((pubspec): FlutterPackage[] => {
    if (!pubspec.flutter || !pubspec.name) return [];
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
      .filter(isLikelyFlutterEntrypoint)
      .sort();
    return [
      {
        defaultFlavor: pubspec.defaultFlavor,
        directory: pubspec.directory,
        entrypoints,
        name: pubspec.name,
      },
    ];
  });
}

function baseDocument(input: {
  id: string;
  name: string;
}): Omit<RunConfigurationFlutterDocument, "target"> {
  return {
    schema: RUN_CONFIGURATION_FILE_SCHEMA,
    version: 1,
    id: input.id,
    name: input.name,
    provider: "flutter",
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
      sdkHome: null,
      deviceId: null,
      flavor: null,
      mode: "debug",
      dartDefines: [],
      dartDefineFiles: [],
      usePub: true,
    },
    stop: { gracePeriodMs: 3_000 },
  };
}

function mergeEnvironment(
  base: RunConfigurationEnvironment,
  override: FlutterPlatformOverride["environment"],
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

function overriddenNullable<T>(
  override: object | undefined,
  key: string,
  overrideValue: T | null | undefined,
  baseValue: T | null,
): T | null {
  return override && Object.hasOwn(override, key)
    ? (overrideValue ?? null)
    : baseValue;
}

function resolveConfiguration(
  document: RunConfigurationFlutterDocument,
  platform: RunConfigurationPlatform,
): ResolvedFlutterConfiguration {
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
      sdkHome: overriddenNullable(
        override?.options,
        "sdkHome",
        override?.options?.sdkHome,
        document.options.sdkHome,
      ),
      deviceId: overriddenNullable(
        override?.options,
        "deviceId",
        override?.options?.deviceId,
        document.options.deviceId,
      ),
      flavor: overriddenNullable(
        override?.options,
        "flavor",
        override?.options?.flavor,
        document.options.flavor,
      ),
      mode: override?.options?.mode ?? document.options.mode,
      dartDefines:
        override?.options?.dartDefines ?? document.options.dartDefines,
      dartDefineFiles:
        override?.options?.dartDefineFiles ?? document.options.dartDefineFiles,
      usePub: override?.options?.usePub ?? document.options.usePub,
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

function flutterExecutablePath(
  sdkHome: string,
  platform: RunConfigurationPlatform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(
    sdkHome,
    "bin",
    platform === "win32" ? "flutter.bat" : "flutter",
  );
}

function systemFlutterExecutable(platform: RunConfigurationPlatform): string {
  return platform === "win32" ? "flutter.bat" : "flutter";
}

function displayExecutable(
  resolved: ResolvedFlutterConfiguration,
  platform: RunConfigurationPlatform,
): string {
  return resolved.options.sdkHome
    ? flutterExecutablePath(resolved.options.sdkHome, platform)
    : "flutter";
}

function flutterArguments(
  document: RunConfigurationFlutterDocument,
  resolved: ResolvedFlutterConfiguration,
): string[] {
  return [
    "run",
    `--${resolved.options.mode}`,
    `--target=${document.target.path}`,
    ...(resolved.options.deviceId
      ? [`--device-id=${resolved.options.deviceId}`]
      : []),
    ...(resolved.options.flavor ? [`--flavor=${resolved.options.flavor}`] : []),
    ...resolved.options.dartDefines.map(
      ({ name, value }) => `--dart-define=${name}=${value}`,
    ),
    ...resolved.options.dartDefineFiles.map(
      (file) => `--dart-define-from-file=${file}`,
    ),
    resolved.options.usePub ? "--pub" : "--no-pub",
    ...resolved.arguments.map((value) => `--dart-entrypoint-args=${value}`),
  ];
}

function effectiveCommand(
  document: RunConfigurationFlutterDocument,
  resolved: ResolvedFlutterConfiguration,
  platform: RunConfigurationPlatform,
): string {
  return resolved.commandOverride !== null
    ? renderCommandOverride(
        resolved.commandOverride,
        resolved.arguments,
        platform,
      )
    : renderCommand(
        displayExecutable(resolved, platform),
        flutterArguments(document, resolved),
        platform,
      );
}

async function canonicalFlutterExecutable(
  sdkHome: string,
  platform: RunConfigurationPlatform,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(sdkHome)) {
    throw new Error(
      "The selected Flutter SDK home must be an absolute path for the target platform.",
    );
  }
  const canonicalHome = await realpath(sdkHome);
  const homeMetadata = await lstat(canonicalHome);
  if (!homeMetadata.isDirectory()) {
    throw new Error("The selected Flutter SDK home is not a directory.");
  }
  const executable = await realpath(
    flutterExecutablePath(canonicalHome, platform),
  );
  const metadata = await lstat(executable);
  if (
    !metadata.isFile() ||
    (platform !== "win32" && (metadata.mode & 0o111) === 0)
  ) {
    throw new Error(
      "The selected Flutter SDK home does not contain a Flutter executable.",
    );
  }
  return executable;
}

async function readPackageAtWorkingDirectory(
  context: RunConfigurationProviderContext,
  workingDirectory: string,
): Promise<{ defaultFlavor: string | null; name: string }> {
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
  const name = flutterPackageName(pubspec);
  if (!name) {
    throw new Error("pubspec.yaml does not declare a valid package name.");
  }
  if (!isFlutterPubspec(pubspec)) {
    throw new Error(
      "pubspec.yaml does not declare the Flutter SDK dependency.",
    );
  }
  return { defaultFlavor: flutterDefaultFlavor(pubspec), name };
}

function pathFromWorkingDirectory(
  workingDirectory: string,
  relativePath: string,
): string {
  return portableJoin(workingDirectory, relativePath);
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

function boundedFlutterToolOutcome(input: {
  arguments: string[];
  context: RunConfigurationProviderContext;
  executable: string;
  workingDirectory: string;
}): Promise<FlutterToolOutcome> {
  return new Promise((resolve, reject) => {
    const processTree = new RunConfigurationProcessTreeController({
      platform: input.context.platform,
    });
    const child = spawn(input.executable, input.arguments, {
      cwd: input.workingDirectory,
      detached: input.context.platform !== "win32",
      env: {
        ...input.context.environment,
        CI: "true",
        FLUTTER_SUPPRESS_ANALYTICS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    const finish = (error?: Error, exitCode = 1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    };
    const terminate = async (error: Error): Promise<void> => {
      if (settled || terminating) return;
      terminating = true;
      try {
        if (child.pid === undefined) {
          child.kill("SIGKILL");
        } else {
          await processTree.signal(
            {
              kill: (signal) =>
                child.kill(signal as NodeJS.Signals | undefined),
              pid: child.pid,
            },
            true,
          );
        }
      } finally {
        finish(error);
      }
    };
    const append = (
      destination: Buffer[] | null,
      chunk: Buffer | string,
    ): void => {
      if (settled || terminating) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > MAX_FLUTTER_DEVICE_OUTPUT_BYTES) {
        void terminate(
          new Error("Flutter device output exceeded the validation limit."),
        );
        return;
      }
      destination?.push(value);
    };
    const timeout = setTimeout(() => {
      void terminate(
        new Error(
          `Flutter device inspection timed out after ${FLUTTER_DEVICE_TIMEOUT_MS}ms.`,
        ),
      );
    }, FLUTTER_DEVICE_TIMEOUT_MS);
    timeout.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => append(null, chunk));
    child.once("error", (error) => {
      if (!terminating) finish(error);
    });
    child.once("exit", (code, signal) => {
      if (terminating) return;
      finish(
        signal
          ? new Error(`Flutter device inspection exited from ${signal}.`)
          : undefined,
        code ?? 1,
      );
    });
  });
}

function boundedDeviceText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new Error("Flutter returned an invalid device record.");
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 256 ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error("Flutter returned an invalid device record.");
  }
  return normalized;
}

function parseFlutterDevices(stdout: string): RunConfigurationFlutterDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Flutter returned malformed device output.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_FLUTTER_DEVICES) {
    throw new Error("Flutter returned an invalid device inventory.");
  }
  const devices: RunConfigurationFlutterDevice[] = [];
  const ids = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Flutter returned an invalid device record.");
    }
    const record = value as Record<string, unknown>;
    const id = boundedDeviceText(record.id) ?? "";
    const name = boundedDeviceText(record.name) ?? "";
    const targetPlatform = boundedDeviceText(record.targetPlatform) ?? null;
    if (id.length === 0 || name.length === 0) {
      throw new Error("Flutter returned an invalid device record.");
    }
    if (
      record.isSupported !== undefined &&
      typeof record.isSupported !== "boolean"
    ) {
      throw new Error("Flutter returned an invalid device record.");
    }
    if (record.emulator !== undefined && typeof record.emulator !== "boolean") {
      throw new Error("Flutter returned an invalid device record.");
    }
    const normalizedId = id.toLocaleLowerCase("en-US");
    if (ids.has(normalizedId)) {
      throw new Error("Flutter returned duplicate device identifiers.");
    }
    ids.add(normalizedId);
    devices.push({
      id,
      name,
      supported: record.isSupported !== false,
      emulator: record.emulator === true,
      targetPlatform,
    });
  }
  return devices.sort(
    (left, right) =>
      Number(right.supported) - Number(left.supported) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

async function inspectFlutterDevices(input: {
  context: RunConfigurationProviderContext;
  executable: string;
  workingDirectory: string;
}): Promise<RunConfigurationFlutterDevice[]> {
  const invocation = await materializedToolInvocation(
    input.executable,
    ["devices", "--machine"],
    input.context,
  );
  const outcome = await boundedFlutterToolOutcome({
    arguments: invocation.arguments,
    context: input.context,
    executable: invocation.executable,
    workingDirectory: input.workingDirectory,
  });
  if (outcome.exitCode !== 0) {
    throw new Error("Flutter device inspection failed.");
  }
  return parseFlutterDevices(outcome.stdout);
}

function flutterDeviceSummary(
  devices: RunConfigurationFlutterDevice[],
): string {
  const supported = devices.filter((device) => device.supported);
  if (supported.length === 0) return "No supported devices were reported.";
  const display = (value: string): string =>
    value.length <= 80 ? value : `${value.slice(0, 79)}…`;
  const visible = supported
    .slice(0, 5)
    .map(({ id, name }) => `${display(name)} (${display(id)})`);
  const remaining = supported.length - visible.length;
  return `Available devices: ${visible.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}.`;
}

function flutterDeviceDiagnostic(input: {
  deviceId: string;
  devices: RunConfigurationFlutterDevice[];
}): RunConfigurationDiagnostic | null {
  const selected = input.deviceId.toLocaleLowerCase("en-US");
  const matches = input.devices.filter(
    ({ id, name }) =>
      id.toLocaleLowerCase("en-US") === selected ||
      name.toLocaleLowerCase("en-US") === selected,
  );
  if (matches.some(({ supported }) => supported)) return null;
  if (matches.length > 0) {
    return runConfigurationProviderDiagnostic(
      "flutter-device-unsupported",
      `The selected Flutter device ${JSON.stringify(input.deviceId)} is connected but Flutter reports it unsupported for this launch. Choose another device or update the project and SDK.`,
      "options.deviceId",
    );
  }
  return runConfigurationProviderDiagnostic(
    "flutter-device-unavailable",
    `The selected Flutter device ${JSON.stringify(input.deviceId)} is not available on the target worker. ${flutterDeviceSummary(input.devices)}`,
    "options.deviceId",
  );
}

export async function inspectFlutterRunConfigurationDevices(
  document: RunConfigurationFlutterDocument,
  context: RunConfigurationProviderContext,
): Promise<{
  devices: RunConfigurationFlutterDevice[];
  diagnostics: RunConfigurationDiagnostic[];
}> {
  if (context.allowToolInspection !== true || !context.environment) {
    return {
      devices: [],
      diagnostics: [
        runConfigurationProviderDiagnostic(
          "flutter-device-inspection-not-authorized",
          "Flutter device inspection requires an explicit authorized worker operation.",
          "options.deviceId",
        ),
      ],
    };
  }
  const parsed = runConfigurationFlutterDocumentSchema.parse(document);
  const resolved = resolveConfiguration(parsed, context.platform);
  let workingDirectory: string;
  try {
    workingDirectory = await resolveRealDirectory(
      context.targetRoot,
      resolved.workingDirectory,
    );
  } catch (error) {
    return {
      devices: [],
      diagnostics: [
        runConfigurationProviderDiagnostic(
          "working-directory-invalid",
          error instanceof Error ? error.message : String(error),
          "workingDirectory",
        ),
      ],
    };
  }
  let executable: string | null = null;
  if (resolved.options.sdkHome) {
    try {
      executable = await canonicalFlutterExecutable(
        resolved.options.sdkHome,
        context.platform,
      );
    } catch (error) {
      return {
        devices: [],
        diagnostics: [
          runConfigurationProviderDiagnostic(
            "flutter-sdk-invalid",
            error instanceof Error ? error.message : String(error),
            "options.sdkHome",
          ),
        ],
      };
    }
  } else {
    executable = await findRunConfigurationExecutable(
      systemFlutterExecutable(context.platform),
      context,
    );
    if (!executable) {
      const diagnostic = await runConfigurationExecutableDiagnostic(
        systemFlutterExecutable(context.platform),
        context,
        "options.sdkHome",
      );
      return { devices: [], diagnostics: diagnostic ? [diagnostic] : [] };
    }
  }
  try {
    return {
      devices: await inspectFlutterDevices({
        context,
        executable,
        workingDirectory,
      }),
      diagnostics: [],
    };
  } catch {
    return {
      devices: [],
      diagnostics: [
        runConfigurationProviderDiagnostic(
          "flutter-device-inspection-failed",
          "Flutter device inspection could not complete safely. Verify the selected SDK and connected-device tooling, then retry.",
          "options.deviceId",
        ),
      ],
    };
  }
}

function providerTaskArguments(task: string): string[] {
  const arguments_ = SUPPORTED_PROVIDER_TASKS.get(task);
  if (!arguments_) {
    throw new Error(
      "Flutter provider tasks must be one of: clean, gen-l10n, or pub get.",
    );
  }
  return arguments_;
}

async function materializeBeforeLaunch(
  document: RunConfigurationFlutterDocument,
  context: RunConfigurationProviderContext,
  resolved: ResolvedFlutterConfiguration,
  flutterExecutable: string,
): Promise<MaterializedRunCommand[]> {
  const commands: MaterializedRunCommand[] = [];
  const workingDirectory = await resolveRealDirectory(
    context.targetRoot,
    resolved.workingDirectory,
  );
  for (const step of document.beforeLaunch) {
    if (step.kind === "providerTask") {
      commands.push({
        ...(await materializedToolInvocation(
          flutterExecutable,
          providerTaskArguments(step.task),
          context,
        )),
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
  package_: FlutterPackage,
  entrypoint: string,
): "high" | "medium" {
  return package_.entrypoints.length === 1 || entrypoint === "lib/main.dart"
    ? "high"
    : "medium";
}

function candidateName(package_: FlutterPackage, entrypoint: string): string {
  const fileName =
    entrypoint
      .split("/")
      .at(-1)
      ?.replace(/\.dart$/u, "") ?? "entrypoint";
  const flavor = package_.defaultFlavor ? ` (${package_.defaultFlavor})` : "";
  return `Flutter ${package_.name}: ${fileName}${flavor}`.slice(0, 200);
}

export const flutterRunConfigurationProvider: RunConfigurationProvider<RunConfigurationFlutterDocument> =
  {
    capability: runConfigurationProviderCapabilitySchema.parse({
      provider: "flutter",
      label: "Flutter",
      icon: "smartphone",
      available: true,
      supportsDiscovery: true,
      supportsCommandOverride: true,
      supportsBeforeLaunch: true,
      supportsPlatformOverrides: true,
    }),

    createDefault({ id, name }) {
      return runConfigurationFlutterDocumentSchema.parse({
        ...baseDocument({ id, name }),
        target: { kind: "entrypoint", path: "lib/main.dart" },
      });
    },

    async discover(
      context,
    ): Promise<
      RunConfigurationProviderCandidate<RunConfigurationFlutterDocument>[]
    > {
      const candidates: RunConfigurationProviderCandidate<RunConfigurationFlutterDocument>[] =
        [];
      for (const package_ of await scanPackages(context)) {
        for (const entrypoint of package_.entrypoints) {
          if (candidates.length >= MAX_DISCOVERY_CANDIDATES) break;
          const confidence = candidateConfidence(package_, entrypoint);
          const document = baseDocument({
            id: randomUUID(),
            name: candidateName(package_, entrypoint),
          });
          candidates.push({
            confidence,
            reason:
              entrypoint === "lib/main.dart"
                ? `${package_.name} has the conventional Flutter entrypoint ${entrypoint}.`
                : package_.entrypoints.length === 1
                  ? `${entrypoint} is the only likely Flutter entrypoint discovered in ${package_.name}.`
                  : `${entrypoint} declares a top-level main function in ${package_.name}.`,
            document: runConfigurationFlutterDocumentSchema.parse({
              ...document,
              workingDirectory: package_.directory,
              target: { kind: "entrypoint", path: entrypoint },
              options: {
                ...document.options,
                flavor: package_.defaultFlavor,
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
      const parsed = runConfigurationFlutterDocumentSchema.parse(document);
      return effectiveCommand(
        parsed,
        resolveConfiguration(parsed, platform),
        platform,
      );
    },

    async validate(document, context) {
      const parsed = runConfigurationFlutterDocumentSchema.parse(document);
      const resolved = resolveConfiguration(parsed, context.platform);
      const diagnostics: RunConfigurationDiagnostic[] = [];
      let flutterExecutable: string | null = null;
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
        (resolved.commandOverride === null || hasProviderTask) &&
        diagnostics.every(({ code }) => code !== "working-directory-invalid")
      ) {
        try {
          await readPackageAtWorkingDirectory(
            context,
            resolved.workingDirectory,
          );
        } catch (error) {
          diagnostics.push(
            runConfigurationProviderDiagnostic(
              "flutter-package-invalid",
              error instanceof Error ? error.message : String(error),
              "workingDirectory",
            ),
          );
        }
        if (resolved.options.sdkHome) {
          try {
            flutterExecutable = await canonicalFlutterExecutable(
              resolved.options.sdkHome,
              context.platform,
            );
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "flutter-sdk-invalid",
                error instanceof Error ? error.message : String(error),
                "options.sdkHome",
              ),
            );
          }
        } else {
          flutterExecutable = await findRunConfigurationExecutable(
            systemFlutterExecutable(context.platform),
            context,
          );
          if (!flutterExecutable) {
            const diagnostic = await runConfigurationExecutableDiagnostic(
              systemFlutterExecutable(context.platform),
              context,
              "options.sdkHome",
            );
            if (diagnostic) diagnostics.push(diagnostic);
          }
        }
      }
      if (resolved.commandOverride === null) {
        if (
          diagnostics.every(({ code }) => code !== "working-directory-invalid")
        ) {
          try {
            await validateRealScript(
              context.targetRoot,
              pathFromWorkingDirectory(
                resolved.workingDirectory,
                parsed.target.path,
              ),
            );
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "flutter-entrypoint-invalid",
                error instanceof Error ? error.message : String(error),
                "target.path",
              ),
            );
          }
          for (
            let index = 0;
            index < resolved.options.dartDefineFiles.length;
            index += 1
          ) {
            try {
              await validateRealScript(
                context.targetRoot,
                pathFromWorkingDirectory(
                  resolved.workingDirectory,
                  resolved.options.dartDefineFiles[index]!,
                ),
              );
            } catch (error) {
              diagnostics.push(
                runConfigurationProviderDiagnostic(
                  "flutter-dart-define-file-invalid",
                  error instanceof Error ? error.message : String(error),
                  `options.dartDefineFiles[${index}]`,
                ),
              );
            }
          }
        }
      }
      if (
        resolved.commandOverride === null &&
        resolved.options.deviceId &&
        context.allowToolInspection === true &&
        context.environment &&
        flutterExecutable &&
        workingDirectory &&
        diagnostics.every(({ severity }) => severity !== "error")
      ) {
        const inspection = await inspectFlutterRunConfigurationDevices(
          parsed,
          context,
        );
        diagnostics.push(...inspection.diagnostics);
        const diagnostic = flutterDeviceDiagnostic({
          deviceId: resolved.options.deviceId,
          devices: inspection.devices,
        });
        if (diagnostic && inspection.diagnostics.length === 0) {
          diagnostics.push(diagnostic);
        }
      }
      for (let index = 0; index < parsed.beforeLaunch.length; index += 1) {
        const step = parsed.beforeLaunch[index]!;
        if (step.kind === "providerTask") {
          try {
            providerTaskArguments(step.task);
          } catch (error) {
            diagnostics.push(
              runConfigurationProviderDiagnostic(
                "flutter-provider-task-invalid",
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
      const parsed = runConfigurationFlutterDocumentSchema.parse(document);
      const diagnostics = await this.validate(parsed, context);
      if (diagnostics.length > 0) {
        throw new Error(diagnostics.map(({ message }) => message).join(" "));
      }
      const resolved = resolveConfiguration(parsed, context.platform);
      const workingDirectory = await resolveRealDirectory(
        context.targetRoot,
        resolved.workingDirectory,
      );
      const needsFlutterExecutable =
        resolved.commandOverride === null ||
        parsed.beforeLaunch.some(({ kind }) => kind === "providerTask");
      const flutterExecutable =
        needsFlutterExecutable && resolved.options.sdkHome
          ? await canonicalFlutterExecutable(
              resolved.options.sdkHome,
              context.platform,
            )
          : systemFlutterExecutable(context.platform);
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
        const invocation = await materializedToolInvocation(
          flutterExecutable,
          flutterArguments(parsed, resolved),
          context,
        );
        executable = invocation.executable;
        arguments_ = invocation.arguments;
      }
      return {
        executable,
        arguments: arguments_,
        workingDirectory,
        beforeLaunch: await materializeBeforeLaunch(
          parsed,
          context,
          resolved,
          flutterExecutable,
        ),
        effectiveCommand: effectiveCommand(parsed, resolved, context.platform),
        environment: resolved.environment,
      };
    },
  };
