import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  managedWebRuntimeCapabilitiesSchema,
  managedWebRuntimeStatusSchema,
  unavailableManagedWebRuntimeCapabilities,
  type ManagedWebRuntimeCapabilities,
  type ManagedWebRuntimeAction,
  type ManagedWebRuntimeStatus,
} from "@cantrip/protocol";

import { spawnGuardedProcess } from "../code/process-guard.js";
import {
  ManagedRuntimeInstaller,
  publicManagedWebRuntimeStatus,
} from "./runtime.js";
import {
  managedRuntimeManifestUrl,
  managedRuntimePublicKeys,
} from "./trust.js";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 3_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const MAX_DIAGNOSTIC_CHARACTERS = 8_000;
const MAX_FAILURES_BEFORE_DEGRADED = 5;
const STABLE_PROCESS_MS = 5 * 60_000;

interface InstallerLike {
  clearCache(): Promise<ManagedWebRuntimeStatus>;
  prepare(): Promise<ManagedWebRuntimeStatus>;
  reinstall(): Promise<ManagedWebRuntimeStatus>;
  rollback(): Promise<ManagedWebRuntimeStatus>;
  runtimeDirectory(): string | null;
  status(): ManagedWebRuntimeStatus;
}

export interface SearxngRuntimeManagerOptions {
  dataDirectory: string;
  fetch?: typeof fetch;
  installer?: InstallerLike;
  manifestUrl?: string;
  now?: () => Date;
  publicKeys?: Readonly<Record<string, string | Buffer>>;
  restartBaseMs?: number;
  spawn?: typeof spawnGuardedProcess;
  updateIntervalMs?: number;
}

export interface SearxngEndpoint {
  origin: string;
  version: string;
}

function pythonExecutable(runtimeDirectory: string): string {
  return process.platform === "win32"
    ? path.join(runtimeDirectory, "python", "python.exe")
    : path.join(runtimeDirectory, "python", "bin", "python3.13");
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("SearXNG state path is not a private directory.");
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function requireRegularFile(
  root: string,
  relative: string,
): Promise<void> {
  const candidate = path.join(root, ...relative.split("/"));
  const entry = await lstat(candidate);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(
      `SearXNG inventory entry is not a regular file: ${relative}`,
    );
  }
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(candidate);
  const relation = path.relative(resolvedRoot, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`SearXNG inventory entry escapes the runtime: ${relative}`);
  }
}

export async function validateSearxngInventory(
  runtimeDirectory: string,
  expectedVersion: string,
): Promise<void> {
  const required = [
    process.platform === "win32"
      ? "python/python.exe"
      : "python/bin/python3.13",
    "app/searxng/searx/webapp.py",
    "app/searxng/searx/version_frozen.py",
    "config-template/settings.yml",
    "config-template/smoke-settings.yml",
    "launcher/serve.py",
    "licenses/manifest.json",
    "source/manifest.json",
    "sbom.cdx.json",
    "build-info.json",
  ];
  await Promise.all(
    required.map((relative) => requireRegularFile(runtimeDirectory, relative)),
  );
  const info = JSON.parse(
    await readFile(path.join(runtimeDirectory, "build-info.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    info.schemaVersion !== 1 ||
    info.component !== "searxng" ||
    info.version !== expectedVersion
  ) {
    throw new Error(
      "SearXNG build metadata does not match the release manifest.",
    );
  }
}

export async function probeSearxngRuntime(
  runtimeDirectory: string,
  dataDirectory: string,
  fetchImplementation: typeof fetch = fetch,
  spawnImplementation: typeof spawnGuardedProcess = spawnGuardedProcess,
): Promise<void> {
  const probeRoot = path.join(
    dataDirectory,
    "managed-runtimes",
    "searxng",
    "state",
    `probe-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const home = path.join(probeRoot, "home");
  const temporary = path.join(probeRoot, "tmp");
  const cache = path.join(probeRoot, "cache");
  await Promise.all([probeRoot, home, temporary, cache].map(privateDirectory));
  const port = await randomLoopbackPort();
  const template = await readFile(
    path.join(runtimeDirectory, "config-template", "smoke-settings.yml"),
    "utf8",
  );
  const settingsPath = path.join(probeRoot, "settings.yml");
  await writeFile(
    settingsPath,
    renderSearxngSettings(template, port, randomBytes(32).toString("hex")),
    { encoding: "utf8", mode: 0o600 },
  );
  const child = spawnImplementation(
    pythonExecutable(runtimeDirectory),
    [
      "-I",
      path.join(runtimeDirectory, "launcher", "serve.py"),
      "--port",
      String(port),
      "--settings",
      settingsPath,
    ],
    {
      cwd: runtimeDirectory,
      env: isolatedEnvironment(home, temporary, cache),
      ownerPid: process.pid,
      stdin: "ignore",
    },
  );
  let diagnostic = "";
  let childError: Error | null = null;
  child.stdout?.on("data", (chunk) => {
    diagnostic = boundedDiagnostic(diagnostic, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    diagnostic = boundedDiagnostic(diagnostic, chunk);
  });
  child.once("error", (error) => {
    childError = error;
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null) {
        throw new Error(`SearXNG probe exited early. ${diagnostic}`.trim());
      }
      try {
        const response = await fetchImplementation(`${origin}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        ready = response.ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) {
      throw new Error(
        `SearXNG probe readiness timed out. ${diagnostic}`.trim(),
      );
    }
    const query = new URLSearchParams({
      engines: "cantrip offline",
      format: "json",
      q: "managed runtime probe",
    });
    const response = await fetchImplementation(`${origin}/search?${query}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const payload = (await response.json()) as { results?: unknown };
    if (
      !response.ok ||
      !Array.isArray(payload.results) ||
      payload.results.length < 1
    ) {
      throw new Error("SearXNG probe search returned no fixture results.");
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export function renderSearxngSettings(
  template: string,
  port: number,
  secret: string,
): string {
  if (
    (template.match(/__CANTRIP_PORT__/gu) ?? []).length !== 1 ||
    (template.match(/__CANTRIP_SECRET__/gu) ?? []).length !== 1
  ) {
    throw new Error("SearXNG settings template placeholders are invalid.");
  }
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !/^[a-f0-9]{64}$/u.test(secret)
  ) {
    throw new Error("SearXNG settings values are invalid.");
  }
  return template
    .replace("__CANTRIP_PORT__", String(port))
    .replace("__CANTRIP_SECRET__", secret);
}

async function randomLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function boundedDiagnostic(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length <= MAX_DIAGNOSTIC_CHARACTERS
    ? combined
    : combined.slice(-MAX_DIAGNOSTIC_CHARACTERS);
}

function isolatedEnvironment(
  home: string,
  temporary: string,
  cache: string,
): NodeJS.ProcessEnv {
  return {
    PATH: "",
    HOME: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CACHE_HOME: cache,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

export class SearxngRuntimeManager {
  readonly #dataDirectory: string;
  readonly #fetch: typeof fetch;
  readonly #installer: InstallerLike;
  readonly #now: () => Date;
  readonly #restartBaseMs: number;
  readonly #spawn: typeof spawnGuardedProcess;
  readonly #updateIntervalMs: number;
  #activeRequests = 0;
  #child: ChildProcess | null = null;
  #closed = false;
  #diagnostics = "";
  #endpoint: SearxngEndpoint | null = null;
  #failureCount = 0;
  #operation: Promise<void> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #rollbackAttempted = false;
  #runtimeFailure: ManagedWebRuntimeStatus["failure"] = null;
  #spawnError: Error | null = null;
  #stableTimer: ReturnType<typeof setTimeout> | null = null;
  #updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SearxngRuntimeManagerOptions) {
    this.#dataDirectory = options.dataDirectory;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#restartBaseMs = options.restartBaseMs ?? 1_000;
    this.#spawn = options.spawn ?? spawnGuardedProcess;
    this.#updateIntervalMs = options.updateIntervalMs ?? UPDATE_INTERVAL_MS;
    this.#installer =
      options.installer ??
      new ManagedRuntimeInstaller({
        component: "searxng",
        dataDirectory: options.dataDirectory,
        fetch: this.#fetch,
        manifestUrl: options.manifestUrl ?? managedRuntimeManifestUrl,
        publicKeys: options.publicKeys ?? managedRuntimePublicKeys,
        validateInventory: async ({ artifact, runtimeDirectory }) => {
          await validateSearxngInventory(runtimeDirectory, artifact.version);
        },
        probe: async ({ artifact, runtimeDirectory }) => {
          await validateSearxngInventory(runtimeDirectory, artifact.version);
          await probeSearxngRuntime(
            runtimeDirectory,
            options.dataDirectory,
            this.#fetch,
            this.#spawn,
          );
        },
      });
  }

  capabilities(
    staticReading = false,
    browser: ManagedWebRuntimeStatus = unavailableManagedWebRuntimeCapabilities.browser,
  ): ManagedWebRuntimeCapabilities {
    return managedWebRuntimeCapabilitiesSchema.parse({
      ...unavailableManagedWebRuntimeCapabilities,
      search: this.status(),
      browser,
      staticReading,
    });
  }

  status(): ManagedWebRuntimeStatus {
    const installed = this.#installer.status();
    if (!this.#runtimeFailure) return publicManagedWebRuntimeStatus(installed);
    return publicManagedWebRuntimeStatus(
      managedWebRuntimeStatusSchema.parse({
        ...installed,
        state: installed.installedVersion ? "degraded" : "failed",
        progress: null,
        failure: this.#runtimeFailure,
      }),
    );
  }

  prepare(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#operation) return this.#operation;
    this.#operation = this.#reconcile().finally(() => {
      this.#operation = null;
    });
    if (!this.#updateTimer) {
      this.#updateTimer = setInterval(() => {
        if (this.#activeRequests === 0) void this.prepare();
      }, this.#updateIntervalMs);
      this.#updateTimer.unref();
    }
    return this.#operation;
  }

  async action(
    action: ManagedWebRuntimeAction,
  ): Promise<ManagedWebRuntimeStatus> {
    if (action === "clear-profiles")
      throw new Error("The search runtime has no persistent browser profiles.");
    if (this.#activeRequests > 0)
      throw new Error(
        "The search runtime is busy; retry after active searches finish.",
      );
    if (this.#operation) await this.#operation;
    this.#operation = this.#performAction(action).finally(() => {
      this.#operation = null;
    });
    await this.#operation;
    return this.status();
  }

  async endpoint(): Promise<SearxngEndpoint> {
    await this.prepare();
    if (!this.#endpoint || !this.#child) {
      const current = this.status();
      throw new Error(
        `Search runtime is ${current.state}${current.failure ? `: ${current.failure.message}` : "."}`,
      );
    }
    return { ...this.#endpoint };
  }

  async request(
    pathname: string,
    search: URLSearchParams,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const endpoint = await this.endpoint();
    const url = new URL(pathname, endpoint.origin);
    url.search = search.toString();
    this.#activeRequests += 1;
    try {
      const response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok)
        throw new Error(`Search runtime returned HTTP ${response.status}.`);
      return await response.json();
    } finally {
      this.#activeRequests -= 1;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#updateTimer) clearInterval(this.#updateTimer);
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#stableTimer) clearTimeout(this.#stableTimer);
    await this.#stopChild();
  }

  async #reconcile(): Promise<void> {
    const before = this.#installer.runtimeDirectory();
    const status = await this.#installer.prepare();
    if (this.#closed || status.state !== "ready") return;
    const after = this.#installer.runtimeDirectory();
    if (!after) return;
    if (this.#child && before === after && this.#endpoint) return;
    await this.#stopChild();
    await this.#startChild(after, status.installedVersion ?? "unknown");
  }

  async #performAction(action: ManagedWebRuntimeAction): Promise<void> {
    const before = this.#installer.runtimeDirectory();
    if (
      action === "reinstall" ||
      action === "retry" ||
      action === "clear-cache"
    ) {
      await this.#stopChild();
      this.#runtimeFailure = null;
    }
    if (action === "clear-cache") {
      await this.#installer.clearCache();
      const cache = path.join(
        this.#dataDirectory,
        "managed-runtimes",
        "searxng",
        "cache",
      );
      await rm(cache, { recursive: true, force: true });
      await privateDirectory(cache);
    }
    const status =
      action === "reinstall"
        ? await this.#installer.reinstall()
        : await this.#installer.prepare();
    const runtime = this.#installer.runtimeDirectory();
    if (
      status.state === "ready" &&
      runtime &&
      !this.#closed &&
      !(this.#child && this.#endpoint && before === runtime)
    ) {
      await this.#stopChild();
      await this.#startChild(runtime, status.installedVersion ?? "unknown");
    }
  }

  async #startChild(runtimeDirectory: string, version: string): Promise<void> {
    const root = path.join(this.#dataDirectory, "managed-runtimes", "searxng");
    const configDirectory = path.join(root, "config");
    const home = path.join(root, "state", "home");
    const temporary = path.join(root, "state", "tmp");
    const cache = path.join(root, "cache");
    await Promise.all(
      [configDirectory, home, temporary, cache].map(privateDirectory),
    );
    const port = await randomLoopbackPort();
    const template = await readFile(
      path.join(runtimeDirectory, "config-template", "settings.yml"),
      "utf8",
    );
    const settings = renderSearxngSettings(
      template,
      port,
      randomBytes(32).toString("hex"),
    );
    const settingsPath = path.join(configDirectory, "settings.yml");
    await writeFile(settingsPath, settings, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    this.#diagnostics = "";
    this.#spawnError = null;
    const child = this.#spawn(
      pythonExecutable(runtimeDirectory),
      [
        "-I",
        path.join(runtimeDirectory, "launcher", "serve.py"),
        "--port",
        String(port),
        "--settings",
        settingsPath,
      ],
      {
        cwd: runtimeDirectory,
        env: isolatedEnvironment(home, temporary, cache),
        ownerPid: process.pid,
        stdin: "ignore",
      },
    );
    this.#child = child;
    child.stdout?.on("data", (chunk) => {
      this.#diagnostics = boundedDiagnostic(this.#diagnostics, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      this.#diagnostics = boundedDiagnostic(this.#diagnostics, chunk);
    });
    child.once("exit", () => this.#handleExit(child));
    child.once("error", (error) => {
      this.#spawnError = error;
      this.#diagnostics = boundedDiagnostic(this.#diagnostics, error.message);
    });

    const origin = `http://127.0.0.1:${port}`;
    try {
      await this.#waitUntilReady(origin, child);
      this.#endpoint = { origin, version };
      this.#runtimeFailure = null;
      if (this.#stableTimer) clearTimeout(this.#stableTimer);
      this.#stableTimer = setTimeout(() => {
        this.#failureCount = 0;
        this.#rollbackAttempted = false;
        this.#stableTimer = null;
      }, STABLE_PROCESS_MS);
      this.#stableTimer.unref();
    } catch (error) {
      await this.#stopChild();
      this.#recordFailure(error);
      throw error;
    }
  }

  async #waitUntilReady(origin: string, child: ChildProcess): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#spawnError) throw this.#spawnError;
      if (child.exitCode !== null)
        throw new Error(
          `SearXNG exited during startup. ${this.#diagnostics}`.trim(),
        );
      try {
        const response = await this.#fetch(`${origin}/healthz`, {
          signal: AbortSignal.timeout(1_000),
        });
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`SearXNG readiness timed out. ${this.#diagnostics}`.trim());
  }

  #handleExit(child: ChildProcess): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#endpoint = null;
    if (this.#stableTimer) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    if (this.#closed) return;
    this.#recordFailure(
      new Error(`SearXNG stopped unexpectedly. ${this.#diagnostics}`.trim()),
    );
    if (this.#failureCount >= MAX_FAILURES_BEFORE_DEGRADED) return;
    const delay = Math.min(
      60_000,
      this.#restartBaseMs * 2 ** Math.min(this.#failureCount - 1, 6),
    );
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (
        this.#failureCount >= 3 &&
        !this.#rollbackAttempted &&
        this.#installer.status().previousVersion
      ) {
        this.#rollbackAttempted = true;
        void this.#installer
          .rollback()
          .then(async (rolledBack) => {
            const runtimeDirectory = this.#installer.runtimeDirectory();
            if (runtimeDirectory && rolledBack.installedVersion) {
              await this.#startChild(
                runtimeDirectory,
                rolledBack.installedVersion,
              );
            }
          })
          .catch((error) => this.#recordFailure(error));
      } else {
        void this.prepare();
      }
    }, delay);
    this.#restartTimer.unref();
  }

  #recordFailure(error: unknown): void {
    this.#failureCount += 1;
    this.#runtimeFailure = {
      category: "process",
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1_000,
      ),
      retryable: this.#failureCount < MAX_FAILURES_BEFORE_DEGRADED,
      failedAt: this.#now().toISOString(),
    };
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#endpoint = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
