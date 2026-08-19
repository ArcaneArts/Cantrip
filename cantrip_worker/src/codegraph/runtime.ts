import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { workerLogError, workerLogger } from "../logger.js";
import {
  extractCodeGraphArchive,
  type CodeGraphArchiveKind,
} from "./archive.js";

const RELEASE_API =
  "https://api.github.com/repos/colbymchenry/codegraph/releases/latest";
const RELEASE_DOWNLOAD_PREFIX =
  "https://github.com/colbymchenry/codegraph/releases/download/";
const MAX_ARCHIVE_BYTES = 256_000_000;
const MAX_CHECKSUM_BYTES = 1_000_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const PROCESS_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 10 * 60_000;
const CODEGRAPH_ENVIRONMENT = {
  CODEGRAPH_NO_UPDATE_CHECK: "1",
  CODEGRAPH_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
} as const;

export type CodeGraphRuntimeState =
  "checking" | "degraded" | "installing" | "ready" | "unavailable";

export interface CodeGraphRuntimeStatus {
  state: CodeGraphRuntimeState;
  cliAvailable: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  previousVersion: string | null;
  lastCheckedAt: string | null;
  telemetryDisabled: boolean;
  launcherDirectory: string;
  error: string | null;
}

export interface CodeGraphTarget {
  archiveKind: CodeGraphArchiveKind;
  assetName: string;
  executableName: "codegraph" | "codegraph.exe";
  target: string;
}

interface ReleaseAsset {
  digest: string;
  name: string;
  size: number;
  url: string;
}

interface ReleaseInformation {
  asset: ReleaseAsset;
  checksums: ReleaseAsset;
  tag: string;
  version: string;
}

interface ReleaseCache {
  checkedAt: string;
  etag: string | null;
  release: ReleaseInformation;
  schemaVersion: 1;
}

interface CurrentRuntime {
  archiveSha256: string;
  executable: string;
  packageDirectory: string;
  schemaVersion: 1;
  telemetryDisabled: boolean;
  verifiedAt: string;
  version: string;
}

interface ProcessResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface CodeGraphRuntimeOptions {
  architecture?: string;
  dataDirectory: string;
  fetch?: typeof fetch;
  now?: () => Date;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  releaseApiUrl?: string;
}

function safeVersion(value: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(value.trim());
  return match?.[1] ?? null;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = "0.0.0", prerelease = ""] = value.split("-", 2);
    return {
      core: core.split(".").map((part) => Number(part)),
      prerelease,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function codeGraphTargetFor(
  platform: NodeJS.Platform,
  architecture: string,
): CodeGraphTarget {
  const platformName =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "win32"
          : null;
  const architectureName =
    architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : null;
  if (!platformName || !architectureName) {
    throw new Error(
      `CodeGraph does not publish a runtime for ${platform}-${architecture}.`,
    );
  }
  const archiveKind = platformName === "win32" ? "zip" : "tar.gz";
  return {
    archiveKind,
    assetName: `codegraph-${platformName}-${architectureName}.${archiveKind}`,
    executableName: platformName === "win32" ? "codegraph.exe" : "codegraph",
    target: `${platformName}-${architectureName}`,
  };
}

function pathKey(environment: NodeJS.ProcessEnv): string {
  return (
    Object.keys(environment).find(
      (candidate) => candidate.toLowerCase() === "path",
    ) ?? "PATH"
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function atomicWrite(
  file: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, {
    encoding: "utf8",
    mode,
  });
  await rename(temporary, file);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function managedLauncherSource(): string {
  return String.raw`import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const binDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(binDirectory);
const pointerPath = path.join(binDirectory, "current.json");
const blocked = new Set(["install", "uninstall", "upgrade"]);
const command = process.argv[2]?.toLowerCase();
if (command && blocked.has(command)) {
  console.error("CodeGraph is managed by Cantrip. Updates are installed safely during worker startup.");
  process.exit(2);
}
let pointer;
try {
  pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
} catch {
  console.error("CodeGraph is not available on this worker yet. Restart the worker to retry installation.");
  process.exit(1);
}
if (pointer?.schemaVersion !== 1 || pointer?.telemetryDisabled !== true || typeof pointer?.executable !== "string") {
  console.error("CodeGraph is unavailable because its managed runtime did not pass privacy validation.");
  process.exit(1);
}
const executable = path.resolve(root, pointer.executable);
const versionsRoot = path.resolve(root, "versions");
if (!executable.startsWith(versionsRoot + path.sep)) {
  console.error("CodeGraph managed runtime pointer is invalid.");
  process.exit(1);
}
const result = spawnSync(executable, process.argv.slice(2), {
  env: {
    ...process.env,
    CODEGRAPH_NO_UPDATE_CHECK: "1",
    CODEGRAPH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
  },
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;
}

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...CODEGRAPH_ENVIRONMENT },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer | string) =>
      `${current}${String(chunk)}`.slice(-128_000);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CodeGraph command timed out: ${args.join(" ")}`));
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (signal) {
        reject(new Error(`CodeGraph command exited from signal ${signal}.`));
        return;
      }
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseReleaseAsset(value: unknown): ReleaseAsset | null {
  const candidate = value as {
    browser_download_url?: unknown;
    digest?: unknown;
    name?: unknown;
    size?: unknown;
  };
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.browser_download_url !== "string" ||
    !candidate.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX) ||
    typeof candidate.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(candidate.digest) ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size as number) < 1
  ) {
    return null;
  }
  return {
    digest: candidate.digest.slice("sha256:".length),
    name: candidate.name,
    size: candidate.size as number,
    url: candidate.browser_download_url,
  };
}

function parseRelease(
  value: unknown,
  target: CodeGraphTarget,
): ReleaseInformation {
  const candidate = value as {
    assets?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
  };
  const version =
    typeof candidate.tag_name === "string"
      ? safeVersion(candidate.tag_name)
      : null;
  if (
    !version ||
    candidate.draft !== false ||
    candidate.prerelease !== false ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error("GitHub returned an invalid stable CodeGraph release.");
  }
  const assets = candidate.assets
    .map(parseReleaseAsset)
    .filter((asset) => asset !== null);
  const asset = assets.find((entry) => entry.name === target.assetName);
  const checksums = assets.find((entry) => entry.name === "SHA256SUMS");
  if (!asset || !checksums) {
    throw new Error(
      `CodeGraph release ${candidate.tag_name} is missing ${target.assetName} or SHA256SUMS.`,
    );
  }
  if (asset.size > MAX_ARCHIVE_BYTES || checksums.size > MAX_CHECKSUM_BYTES) {
    throw new Error("CodeGraph release assets exceed their download limits.");
  }
  return {
    asset,
    checksums,
    tag: String(candidate.tag_name),
    version,
  };
}

function parseCurrent(value: unknown): CurrentRuntime | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CurrentRuntime>;
  return candidate.schemaVersion === 1 &&
    typeof candidate.archiveSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(candidate.archiveSha256) &&
    typeof candidate.executable === "string" &&
    candidate.executable.length > 0 &&
    !path.isAbsolute(candidate.executable) &&
    typeof candidate.packageDirectory === "string" &&
    candidate.packageDirectory.length > 0 &&
    !path.isAbsolute(candidate.packageDirectory) &&
    candidate.telemetryDisabled === true &&
    typeof candidate.verifiedAt === "string" &&
    safeVersion(candidate.version ?? "") !== null
    ? (candidate as CurrentRuntime)
    : null;
}

function parseReleaseCache(
  value: unknown,
  target: CodeGraphTarget,
): ReleaseCache | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ReleaseCache>;
  const release = candidate.release as Partial<ReleaseInformation> | undefined;
  const validAsset = (
    asset: Partial<ReleaseAsset> | undefined,
    expectedName: string,
    maximumBytes: number,
  ): asset is ReleaseAsset =>
    asset?.name === expectedName &&
    typeof asset.url === "string" &&
    asset.url.startsWith(RELEASE_DOWNLOAD_PREFIX) &&
    typeof asset.digest === "string" &&
    /^[0-9a-f]{64}$/u.test(asset.digest) &&
    Number.isSafeInteger(asset.size) &&
    (asset.size ?? 0) > 0 &&
    (asset.size ?? 0) <= maximumBytes;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.checkedAt !== "string" ||
    (candidate.etag !== null && typeof candidate.etag !== "string") ||
    !release ||
    typeof release.tag !== "string" ||
    typeof release.version !== "string" ||
    safeVersion(release.tag) !== release.version ||
    !validAsset(release.asset, target.assetName, MAX_ARCHIVE_BYTES) ||
    !validAsset(release.checksums, "SHA256SUMS", MAX_CHECKSUM_BYTES)
  ) {
    return null;
  }
  return candidate as ReleaseCache;
}

export class CodeGraphRuntimeManager {
  readonly #architecture: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  readonly #processExecPath: string;
  readonly #releaseApiUrl: string;
  readonly #root: string;
  readonly #target: CodeGraphTarget;
  #current: CurrentRuntime | null = null;
  #status: CodeGraphRuntimeStatus;
  #updatePromise: Promise<CodeGraphRuntimeStatus> | null = null;

  constructor(options: CodeGraphRuntimeOptions) {
    this.#architecture = options.architecture ?? process.arch;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#processExecPath = options.processExecPath ?? process.execPath;
    this.#releaseApiUrl = options.releaseApiUrl ?? RELEASE_API;
    this.#root = path.join(options.dataDirectory, "tools", "codegraph");
    this.#target = codeGraphTargetFor(this.#platform, this.#architecture);
    this.#status = {
      state: "unavailable",
      cliAvailable: false,
      installedVersion: null,
      latestVersion: null,
      previousVersion: null,
      lastCheckedAt: null,
      telemetryDisabled: false,
      launcherDirectory: path.join(this.#root, "bin"),
      error: null,
    };
  }

  get root(): string {
    return this.#root;
  }

  status(): CodeGraphRuntimeStatus {
    return { ...this.#status };
  }

  childEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    const key = pathKey(environment);
    const entries = (environment[key] ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const launcherDirectory = this.#status.launcherDirectory;
    return {
      ...CODEGRAPH_ENVIRONMENT,
      [key]: entries.includes(launcherDirectory)
        ? entries.join(path.delimiter)
        : [launcherDirectory, ...entries].join(path.delimiter),
    };
  }

  publishEnvironment(): void {
    for (const [key, value] of Object.entries(this.childEnvironment())) {
      process.env[key] = value;
    }
  }

  async prepare(): Promise<CodeGraphRuntimeStatus> {
    await Promise.all([
      mkdir(path.join(this.#root, "bin"), { recursive: true }),
      mkdir(path.join(this.#root, "downloads"), { recursive: true }),
      mkdir(path.join(this.#root, "staging"), { recursive: true }),
      mkdir(path.join(this.#root, "versions"), { recursive: true }),
    ]);
    await this.#writeLaunchers();
    this.#current = await this.#loadCurrent();
    if (this.#current) {
      try {
        await this.#disableTelemetry(this.#executableFor(this.#current));
        this.#current = {
          ...this.#current,
          telemetryDisabled: true,
          verifiedAt: this.#now().toISOString(),
        };
        await atomicWriteJson(this.#currentPath(), this.#current);
        this.#status = {
          ...this.#status,
          state: "ready",
          cliAvailable: true,
          installedVersion: this.#current.version,
          telemetryDisabled: true,
          error: null,
        };
      } catch (error) {
        await atomicWriteJson(this.#currentPath(), {
          ...this.#current,
          telemetryDisabled: false,
        }).catch(() => undefined);
        this.#status = {
          ...this.#status,
          state: "unavailable",
          cliAvailable: false,
          installedVersion: this.#current.version,
          telemetryDisabled: false,
          error: `Could not disable CodeGraph telemetry: ${workerLogError(error).message}`,
        };
      }
      void this.updateNow();
      return this.status();
    }
    return this.updateNow();
  }

  async updateNow(): Promise<CodeGraphRuntimeStatus> {
    if (this.#updatePromise) return this.#updatePromise;
    this.#updatePromise = this.#performUpdate()
      .catch((error: unknown) => {
        const message = workerLogError(error).message;
        this.#status = {
          ...this.#status,
          state: this.#status.cliAvailable ? "degraded" : "unavailable",
          error: message,
        };
        workerLogger.event(
          this.#status.cliAvailable ? "warn" : "error",
          "CodeGraph managed runtime update failed",
          {
            event: "codegraph.runtime.update-failed",
            subsystem: "codegraph",
            operation: "update-runtime",
            reasonCode: "update-failed",
            status: this.#status.state,
            target: this.#target.target,
            error: workerLogError(error),
          },
        );
        return this.status();
      })
      .finally(() => {
        this.#updatePromise = null;
      });
    return this.#updatePromise;
  }

  async waitForUpdate(): Promise<CodeGraphRuntimeStatus> {
    return this.#updatePromise ? this.#updatePromise : this.status();
  }

  async #performUpdate(): Promise<CodeGraphRuntimeStatus> {
    this.#status = { ...this.#status, state: "checking", error: null };
    workerLogger.event("info", "Checking for a CodeGraph runtime update", {
      event: "codegraph.runtime.check-started",
      subsystem: "codegraph",
      operation: "check-release",
      status: "started",
      target: this.#target.target,
    });
    return this.#withUpdateLock(async () => {
      this.#current = await this.#loadCurrent();
      const release = await this.#latestRelease();
      this.#status = {
        ...this.#status,
        latestVersion: release.version,
        lastCheckedAt: this.#now().toISOString(),
      };
      if (
        this.#current &&
        compareVersions(this.#current.version, release.version) >= 0
      ) {
        await this.#disableTelemetry(this.#executableFor(this.#current));
        this.#current = {
          ...this.#current,
          telemetryDisabled: true,
          verifiedAt: this.#now().toISOString(),
        };
        await atomicWriteJson(this.#currentPath(), this.#current);
        this.#status = {
          ...this.#status,
          state: "ready",
          cliAvailable: true,
          installedVersion: this.#current.version,
          telemetryDisabled: true,
          error: null,
        };
        workerLogger.event("info", "CodeGraph managed runtime is current", {
          event: "codegraph.runtime.current",
          subsystem: "codegraph",
          operation: "check-release",
          status: "completed",
          target: this.#target.target,
          version: this.#current.version,
        });
        return this.status();
      }
      this.#status = { ...this.#status, state: "installing" };
      const installed = await this.#installRelease(release);
      const previous = this.#current;
      await atomicWriteJson(this.#currentPath(), installed);
      this.#current = installed;
      await this.#pruneVersions(
        new Set(
          [installed.packageDirectory, previous?.packageDirectory].filter(
            (entry): entry is string => Boolean(entry),
          ),
        ),
      ).catch((error: unknown) => {
        workerLogger.event("warn", "Could not prune old CodeGraph runtimes", {
          event: "codegraph.runtime.prune-failed",
          subsystem: "codegraph",
          operation: "prune-runtimes",
          reasonCode: "cleanup-failed",
          status: "degraded",
          error: workerLogError(error),
        });
      });
      this.#status = {
        ...this.#status,
        state: "ready",
        cliAvailable: true,
        installedVersion: installed.version,
        previousVersion: previous?.version ?? null,
        telemetryDisabled: true,
        error: null,
      };
      workerLogger.event("info", "CodeGraph managed runtime installed", {
        event: "codegraph.runtime.installed",
        subsystem: "codegraph",
        operation: "install-runtime",
        status: "completed",
        target: this.#target.target,
        version: installed.version,
        previousVersion: previous?.version ?? null,
      });
      return this.status();
    });
  }

  async #latestRelease(): Promise<ReleaseInformation> {
    const cachePath = path.join(this.#root, "release-cache.json");
    const cached = parseReleaseCache(
      await readJsonFile<unknown>(cachePath),
      this.#target,
    );
    const response = await this.#fetch(this.#releaseApiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
        "user-agent": "Cantrip-Worker-CodeGraph-Manager",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    const checkedAt = this.#now().toISOString();
    if (response.status === 304 && cached?.schemaVersion === 1) {
      await atomicWriteJson(cachePath, { ...cached, checkedAt });
      return cached.release;
    }
    if (!response.ok) {
      throw new Error(
        `GitHub CodeGraph release check failed with HTTP ${response.status}.`,
      );
    }
    const release = parseRelease(await response.json(), this.#target);
    const cache: ReleaseCache = {
      schemaVersion: 1,
      checkedAt,
      etag: response.headers.get("etag"),
      release,
    };
    await atomicWriteJson(cachePath, cache);
    return release;
  }

  async #installRelease(release: ReleaseInformation): Promise<CurrentRuntime> {
    const identifier = randomUUID();
    const archivePath = path.join(
      this.#root,
      "downloads",
      `${identifier}.${this.#target.archiveKind}`,
    );
    const checksumPath = path.join(
      this.#root,
      "downloads",
      `${identifier}.SHA256SUMS`,
    );
    const staging = path.join(this.#root, "staging", identifier);
    try {
      const [archiveSha256] = await Promise.all([
        this.#download(release.asset, archivePath, MAX_ARCHIVE_BYTES),
        this.#download(release.checksums, checksumPath, MAX_CHECKSUM_BYTES),
      ]);
      const checksumText = await readFile(checksumPath, "utf8");
      const expected = this.#checksumFor(checksumText, release.asset.name);
      if (!constantTimeEqual(archiveSha256, expected)) {
        throw new Error(
          `CodeGraph ${release.asset.name} does not match its signed release checksum list.`,
        );
      }
      const extracted = path.join(staging, "payload");
      await extractCodeGraphArchive(
        archivePath,
        this.#target.archiveKind,
        extracted,
      );
      const stagedExecutable = await this.#findExecutable(extracted);
      if (this.#platform !== "win32") await chmod(stagedExecutable, 0o700);
      await this.#verifyVersion(stagedExecutable, release.version);
      await this.#disableTelemetry(stagedExecutable);
      const packageBase = `${release.version}-${archiveSha256.slice(0, 12)}`;
      let packageDirectory = packageBase;
      try {
        await access(path.join(this.#root, "versions", packageDirectory));
        packageDirectory = `${packageBase}-${identifier.slice(0, 8)}`;
      } catch {
        // The content-addressed destination is unused.
      }
      const destination = path.join(this.#root, "versions", packageDirectory);
      await rename(extracted, destination);
      const relativeWithinPayload = path.relative(extracted, stagedExecutable);
      const executable = path.join(
        "versions",
        packageDirectory,
        relativeWithinPayload,
      );
      const promotedExecutable = path.join(this.#root, executable);
      await this.#verifyVersion(promotedExecutable, release.version);
      await this.#disableTelemetry(promotedExecutable);
      return {
        schemaVersion: 1,
        archiveSha256,
        executable,
        packageDirectory,
        telemetryDisabled: true,
        verifiedAt: this.#now().toISOString(),
        version: release.version,
      };
    } finally {
      await Promise.all([
        rm(archivePath, { force: true }),
        rm(checksumPath, { force: true }),
        rm(staging, { force: true, recursive: true }),
      ]);
    }
  }

  async #download(
    asset: ReleaseAsset,
    destination: string,
    maximumBytes: number,
  ): Promise<string> {
    if (asset.size > maximumBytes) {
      throw new Error(
        `CodeGraph asset ${asset.name} exceeds its download limit.`,
      );
    }
    const response = await this.#fetch(asset.url, {
      headers: { "user-agent": "Cantrip-Worker-CodeGraph-Manager" },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `CodeGraph asset ${asset.name} failed with HTTP ${response.status}.`,
      );
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
      throw new Error(
        `CodeGraph asset ${asset.name} exceeds its download limit.`,
      );
    }
    const output = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > maximumBytes || size > asset.size) {
          throw new Error(
            `CodeGraph asset ${asset.name} exceeded its declared size.`,
          );
        }
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const written = await output.write(
            bytes,
            offset,
            bytes.length - offset,
          );
          offset += written.bytesWritten;
        }
      }
    } finally {
      await output.close();
    }
    if (size !== asset.size) {
      throw new Error(
        `CodeGraph asset ${asset.name} downloaded ${size} bytes; expected ${asset.size}.`,
      );
    }
    const digest = hash.digest("hex");
    if (!constantTimeEqual(digest, asset.digest)) {
      throw new Error(
        `CodeGraph asset ${asset.name} failed its GitHub digest check.`,
      );
    }
    return digest;
  }

  #checksumFor(contents: string, assetName: string): string {
    const matches = contents
      .split(/\r?\n/u)
      .map((line) => /^([0-9a-fA-F]{64})\s+\*?(.+)$/u.exec(line.trim()))
      .filter((match) => match?.[2] === assetName);
    if (matches.length !== 1 || !matches[0]?.[1]) {
      throw new Error(
        `SHA256SUMS does not contain exactly one ${assetName} entry.`,
      );
    }
    return matches[0][1].toLowerCase();
  }

  async #findExecutable(root: string): Promise<string> {
    const matches: string[] = [];
    let entriesVisited = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entriesVisited += 1;
        if (entriesVisited > 100_000) {
          throw new Error("CodeGraph bundle inventory is unexpectedly large.");
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (
          entry.isFile() &&
          entry.name === this.#target.executableName &&
          path.basename(path.dirname(absolute)) === "bin"
        ) {
          matches.push(absolute);
        }
      }
    };
    await visit(root);
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(
        `CodeGraph bundle must contain exactly one bin/${this.#target.executableName}.`,
      );
    }
    return matches[0];
  }

  async #verifyVersion(
    executable: string,
    expectedVersion: string,
  ): Promise<void> {
    await access(executable);
    const result = await runProcess(executable, ["--version"]);
    const reported = safeVersion(`${result.stdout}\n${result.stderr}`.trim());
    if (result.code !== 0 || reported !== expectedVersion) {
      throw new Error(
        `CodeGraph executable reported ${reported ?? "an invalid version"}; expected ${expectedVersion}.`,
      );
    }
  }

  async #disableTelemetry(executable: string): Promise<void> {
    const result = await runProcess(executable, ["telemetry", "off"]);
    if (result.code !== 0) {
      throw new Error(
        `codegraph telemetry off failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
      );
    }
  }

  async #loadCurrent(): Promise<CurrentRuntime | null> {
    const current = parseCurrent(
      await readJsonFile<unknown>(this.#currentPath()),
    );
    if (!current) return null;
    try {
      const executable = this.#executableFor(current);
      await access(executable);
      await this.#verifyVersion(executable, current.version);
      return current;
    } catch {
      return null;
    }
  }

  #executableFor(current: CurrentRuntime): string {
    const executable = path.resolve(this.#root, current.executable);
    const versions = path.resolve(this.#root, "versions");
    const packageRoot = path.resolve(versions, current.packageDirectory);
    if (
      !executable.startsWith(`${packageRoot}${path.sep}`) ||
      !packageRoot.startsWith(`${versions}${path.sep}`)
    ) {
      throw new Error(
        "CodeGraph managed runtime pointer escapes its version directory.",
      );
    }
    return executable;
  }

  #currentPath(): string {
    return path.join(this.#root, "bin", "current.json");
  }

  async #writeLaunchers(): Promise<void> {
    const bin = path.join(this.#root, "bin");
    const launcher = path.join(bin, "launcher.mjs");
    await atomicWrite(launcher, managedLauncherSource(), 0o600);
    const shell = `#!/bin/sh\nexec ${shellQuote(this.#processExecPath)} ${shellQuote(launcher)} "$@"\n`;
    const command = `@echo off\r\n"${this.#processExecPath.replace(/"/gu, '""')}" "${launcher.replace(/"/gu, '""')}" %*\r\n`;
    await Promise.all([
      atomicWrite(path.join(bin, "codegraph"), shell, 0o700),
      atomicWrite(path.join(bin, "codegraph.cmd"), command, 0o600),
    ]);
  }

  async #pruneVersions(keep: Set<string>): Promise<void> {
    const versions = path.join(this.#root, "versions");
    for (const entry of await readdir(versions, { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name)) {
        await rm(path.join(versions, entry.name), {
          force: true,
          recursive: true,
        });
      }
    }
  }

  async #withUpdateLock<T>(action: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.#root, "update.lock");
    const startedAt = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${process.pid}\n${this.#now().toISOString()}\n`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(lockPath);
          if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
            await rm(lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
          throw new Error(
            "Timed out waiting for another CodeGraph runtime update.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}
