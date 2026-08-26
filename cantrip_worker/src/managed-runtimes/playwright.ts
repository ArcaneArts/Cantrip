import type { ChildProcess } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  managedWebRuntimeStatusSchema,
  type ManagedWebRuntimeStatus,
} from "@cantrip/protocol";

import { normalizedPublicHttpUrl } from "../web/safe-fetch.js";
import { BrowserNetworkProxy } from "./browser-proxy.js";
import { ManagedRuntimeInstaller } from "./runtime.js";
import {
  managedRuntimeManifestUrl,
  managedRuntimePublicKeys,
} from "./trust.js";

const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const IDLE_BROWSER_MS = 5 * 60_000;
const MAX_CONTEXTS = 4;
const MAX_WAITERS = 16;
const MAX_RENDERED_HTML_BYTES = 10_000_000;

interface InstallerLike {
  prepare(): Promise<ManagedWebRuntimeStatus>;
  rollback(): Promise<ManagedWebRuntimeStatus>;
  runtimeDirectory(): string | null;
  status(): ManagedWebRuntimeStatus;
}

interface PlaywrightPage {
  content(): Promise<string>;
  goto(
    url: string,
    options: { timeout: number; waitUntil: "domcontentloaded" },
  ): Promise<unknown>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  title(): Promise<string>;
  url(): string;
}

interface PlaywrightContext {
  close(): Promise<void>;
  newPage(): Promise<PlaywrightPage>;
  route(
    pattern: string,
    handler: (route: PlaywrightRoute) => Promise<void>,
  ): Promise<void>;
}

interface PlaywrightRoute {
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
  request(): {
    isNavigationRequest(): boolean;
    method(): string;
    resourceType(): string;
    url(): string;
  };
}

interface PlaywrightBrowser {
  close(): Promise<void>;
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
}

interface PlaywrightBrowserServer {
  close(): Promise<void>;
  process(): ChildProcess;
  wsEndpoint(): string;
}

interface PlaywrightModule {
  chromium: {
    connect(endpoint: string): Promise<PlaywrightBrowser>;
    launchServer(
      options: Record<string, unknown>,
    ): Promise<PlaywrightBrowserServer>;
  };
}

type PlaywrightLoader = (runtimeDirectory: string) => Promise<PlaywrightModule>;

export interface PlaywrightRuntimeManagerOptions {
  dataDirectory: string;
  fetch?: typeof fetch;
  installer?: InstallerLike;
  loadPlaywright?: PlaywrightLoader;
  manifestUrl?: string;
  now?: () => Date;
  proxyFactory?: () => BrowserNetworkProxy;
  publicKeys?: Readonly<Record<string, string | Buffer>>;
  updateIntervalMs?: number;
}

export interface RenderedPage {
  html: string;
  title: string;
  url: string;
}

class ContextSlots {
  #active = 0;
  readonly #waiting: Array<(release: () => void) => void> = [];

  async acquire(): Promise<() => void> {
    if (this.#active < MAX_CONTEXTS) {
      this.#active += 1;
      return this.#release();
    }
    if (this.#waiting.length >= MAX_WAITERS)
      throw new Error("Managed browser context queue is full.");
    return await new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next(this.#release());
      else this.#active -= 1;
    };
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("Managed browser state path is not a private directory.");
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

async function requireRegularFile(
  root: string,
  relative: string,
): Promise<void> {
  const candidate = path.join(root, ...relative.split("/"));
  const entry = await lstat(candidate);
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(
      `Playwright inventory entry is not a regular file: ${relative}`,
    );
  const relation = path.relative(
    await realpath(root),
    await realpath(candidate),
  );
  if (relation.startsWith("..") || path.isAbsolute(relation))
    throw new Error(
      `Playwright inventory entry escapes the runtime: ${relative}`,
    );
}

async function findExecutable(runtimeDirectory: string): Promise<string> {
  const names =
    process.platform === "win32"
      ? new Set(["chrome-headless-shell.exe", "headless_shell.exe"])
      : new Set(["chrome-headless-shell", "headless_shell"]);
  const matches: string[] = [];
  await visit(path.join(runtimeDirectory, "browsers"));
  if (matches.length !== 1)
    throw new Error(
      `Expected one managed headless Chromium executable, found ${matches.length}.`,
    );
  return matches[0]!;

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && names.has(entry.name)) matches.push(candidate);
    }
  }
}

export async function validatePlaywrightInventory(
  runtimeDirectory: string,
  expectedVersion: string,
): Promise<void> {
  await Promise.all(
    [
      "node_modules/playwright-core/index.mjs",
      "node_modules/playwright-core/browsers.json",
      "licenses/manifest.json",
      "source/manifest.json",
      "sbom.cdx.json",
      "build-info.json",
      "certificates/ca-bundle.crt",
      "fontconfig/fonts.conf",
    ].map((relative) => requireRegularFile(runtimeDirectory, relative)),
  );
  await requireRegularFile(
    runtimeDirectory,
    path
      .relative(runtimeDirectory, await findExecutable(runtimeDirectory))
      .split(path.sep)
      .join("/"),
  );
  const info = JSON.parse(
    await readFile(path.join(runtimeDirectory, "build-info.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    info.schemaVersion !== 1 ||
    info.component !== "playwright" ||
    info.version !== expectedVersion ||
    typeof info.chromiumRevision !== "string"
  )
    throw new Error(
      "Playwright build metadata does not match the release manifest.",
    );
}

async function defaultLoader(
  runtimeDirectory: string,
): Promise<PlaywrightModule> {
  return (await import(
    pathToFileURL(
      path.join(
        runtimeDirectory,
        "node_modules",
        "playwright-core",
        "index.mjs",
      ),
    ).href
  )) as PlaywrightModule;
}

function browserEnvironment(
  runtimeDirectory: string,
  stateRoot: string,
): NodeJS.ProcessEnv {
  return {
    PATH: "",
    HOME: path.join(stateRoot, "home"),
    TMPDIR: path.join(stateRoot, "tmp"),
    TEMP: path.join(stateRoot, "tmp"),
    TMP: path.join(stateRoot, "tmp"),
    XDG_CACHE_HOME: path.join(stateRoot, "cache"),
    SSL_CERT_FILE: path.join(runtimeDirectory, "certificates", "ca-bundle.crt"),
    ...(process.platform === "linux"
      ? {
          LD_LIBRARY_PATH: path.join(runtimeDirectory, "libraries"),
          FONTCONFIG_PATH: path.join(runtimeDirectory, "fontconfig"),
        }
      : {}),
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
}

async function createState(stateRoot: string): Promise<void> {
  await Promise.all(
    [stateRoot, "home", "tmp", "cache", "profiles", "downloads", "traces"].map(
      (entry) =>
        privateDirectory(
          entry === stateRoot ? entry : path.join(stateRoot, entry),
        ),
    ),
  );
}

export async function probePlaywrightRuntime(
  runtimeDirectory: string,
  dataDirectory: string,
  loadPlaywright: PlaywrightLoader = defaultLoader,
): Promise<void> {
  const stateRoot = path.join(
    dataDirectory,
    "managed-runtimes",
    "playwright",
    "probe",
  );
  await rm(stateRoot, { recursive: true, force: true });
  await createState(stateRoot);
  const module = await loadPlaywright(runtimeDirectory);
  const server = await module.chromium.launchServer({
    executablePath: await findExecutable(runtimeDirectory),
    headless: true,
    chromiumSandbox: true,
    env: browserEnvironment(runtimeDirectory, stateRoot),
  });
  try {
    if (server.process().spawnargs.includes("--no-sandbox"))
      throw new Error("Managed Chromium disabled its sandbox.");
    const browser = await module.chromium.connect(server.wsEndpoint());
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto("data:text/html,<h1>Cantrip browser ready</h1>", {
          timeout: 10_000,
          waitUntil: "domcontentloaded",
        });
        if (
          !(await page.locator("body").ariaSnapshot()).includes(
            "Cantrip browser ready",
          )
        )
          throw new Error("Managed Chromium accessibility probe failed.");
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
}

export class PlaywrightRuntimeManager {
  readonly #dataDirectory: string;
  readonly #installer: InstallerLike;
  readonly #loadPlaywright: PlaywrightLoader;
  readonly #now: () => Date;
  readonly #proxyFactory: () => BrowserNetworkProxy;
  readonly #slots = new ContextSlots();
  readonly #updateIntervalMs: number;
  #activeContexts = 0;
  #browser: PlaywrightBrowser | null = null;
  #browserServer: PlaywrightBrowserServer | null = null;
  #closed = false;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #operation: Promise<void> | null = null;
  #pendingRuntime: string | null = null;
  #proxy: BrowserNetworkProxy | null = null;
  #rollbackAttempted = false;
  #runtimeDirectory: string | null = null;
  #runtimeFailure: ManagedWebRuntimeStatus["failure"] = null;
  #updateTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PlaywrightRuntimeManagerOptions) {
    this.#dataDirectory = options.dataDirectory;
    this.#loadPlaywright = options.loadPlaywright ?? defaultLoader;
    this.#now = options.now ?? (() => new Date());
    this.#proxyFactory =
      options.proxyFactory ?? (() => new BrowserNetworkProxy());
    this.#updateIntervalMs = options.updateIntervalMs ?? UPDATE_INTERVAL_MS;
    this.#installer =
      options.installer ??
      new ManagedRuntimeInstaller({
        component: "playwright",
        dataDirectory: options.dataDirectory,
        fetch: options.fetch,
        manifestUrl: options.manifestUrl ?? managedRuntimeManifestUrl,
        publicKeys: options.publicKeys ?? managedRuntimePublicKeys,
        validateInventory: async ({ artifact, runtimeDirectory }) =>
          validatePlaywrightInventory(runtimeDirectory, artifact.version),
        probe: async ({ artifact, runtimeDirectory }) => {
          await validatePlaywrightInventory(runtimeDirectory, artifact.version);
          await probePlaywrightRuntime(
            runtimeDirectory,
            options.dataDirectory,
            this.#loadPlaywright,
          );
        },
      });
  }

  status(): ManagedWebRuntimeStatus {
    const installed = this.#installer.status();
    if (!this.#runtimeFailure) return installed;
    return managedWebRuntimeStatusSchema.parse({
      ...installed,
      state: installed.installedVersion ? "degraded" : "failed",
      progress: null,
      failure: this.#runtimeFailure,
    });
  }

  prepare(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#operation) return this.#operation;
    this.#operation = this.#reconcile().finally(() => (this.#operation = null));
    if (!this.#updateTimer) {
      this.#updateTimer = setInterval(
        () => void this.prepare(),
        this.#updateIntervalMs,
      );
      this.#updateTimer.unref();
    }
    return this.#operation;
  }

  async render(
    urlValue: string,
    beforeNavigation?: (url: URL) => Promise<void>,
  ): Promise<RenderedPage> {
    const target = normalizedPublicHttpUrl(urlValue);
    const release = await this.#slots.acquire();
    this.#activeContexts += 1;
    let context: PlaywrightContext | null = null;
    try {
      const browser = await this.#ensureBrowser();
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        userAgent:
          "CantripResearchBot/1.0 (+https://github.com/ArcaneArts/Cantrip)",
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const value = request.url();
        if (value === "about:blank") return await route.continue();
        if (!/^https?:/u.test(value))
          return await route.abort("blockedbyclient");
        if (!["GET", "HEAD"].includes(request.method()))
          return await route.abort("blockedbyclient");
        if (["websocket", "eventsource"].includes(request.resourceType()))
          return await route.abort("blockedbyclient");
        if (
          request.isNavigationRequest() &&
          request.resourceType() === "document"
        )
          await beforeNavigation?.(normalizedPublicHttpUrl(value));
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(target.href, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      const finalUrl = normalizedPublicHttpUrl(page.url()).href;
      const html = await page.content();
      if (Buffer.byteLength(html) > MAX_RENDERED_HTML_BYTES)
        throw new Error("Rendered page exceeds the browser output limit.");
      this.#runtimeFailure = null;
      return {
        html,
        title: (await page.title()).slice(0, 1_000),
        url: finalUrl,
      };
    } catch (error) {
      this.#recordFailure(error);
      throw error;
    } finally {
      await context?.close().catch(() => undefined);
      this.#activeContexts -= 1;
      release();
      await this.#applyPendingRuntime();
      this.#scheduleIdleClose();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#updateTimer) clearInterval(this.#updateTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    await this.#closeBrowser();
  }

  async #reconcile(): Promise<void> {
    const status = await this.#installer.prepare();
    if (this.#closed || status.state !== "ready") return;
    const runtime = this.#installer.runtimeDirectory();
    if (!runtime || runtime === this.#runtimeDirectory) return;
    if (this.#activeContexts > 0) this.#pendingRuntime = runtime;
    else {
      await this.#closeBrowser();
      this.#runtimeDirectory = runtime;
    }
  }

  async #ensureBrowser(): Promise<PlaywrightBrowser> {
    await this.prepare();
    if (this.#browser) return this.#browser;
    const runtime =
      this.#runtimeDirectory ?? this.#installer.runtimeDirectory();
    if (!runtime) throw new Error(`Browser runtime is ${this.status().state}.`);
    try {
      return await this.#launch(runtime);
    } catch (error) {
      if (
        !this.#rollbackAttempted &&
        this.#installer.status().previousVersion
      ) {
        this.#rollbackAttempted = true;
        const status = await this.#installer.rollback();
        const rollbackRuntime = this.#installer.runtimeDirectory();
        if (status.state === "ready" && rollbackRuntime)
          return await this.#launch(rollbackRuntime);
      }
      throw error;
    }
  }

  async #launch(runtime: string): Promise<PlaywrightBrowser> {
    const stateRoot = path.join(
      this.#dataDirectory,
      "managed-runtimes",
      "playwright",
      "state",
    );
    await createState(stateRoot);
    const proxy = this.#proxyFactory();
    const proxyOrigin = await proxy.start();
    const module = await this.#loadPlaywright(runtime);
    let server: PlaywrightBrowserServer | null = null;
    try {
      server = await module.chromium.launchServer({
        executablePath: await findExecutable(runtime),
        headless: true,
        chromiumSandbox: true,
        proxy: { server: proxyOrigin, bypass: "" },
        env: browserEnvironment(runtime, stateRoot),
      });
      if (server.process().spawnargs.includes("--no-sandbox"))
        throw new Error("Managed Chromium disabled its sandbox.");
      const browser = await module.chromium.connect(server.wsEndpoint());
      this.#proxy = proxy;
      this.#browserServer = server;
      this.#browser = browser;
      this.#runtimeDirectory = runtime;
      server.process().once("exit", () => {
        if (this.#browserServer !== server || this.#closed) return;
        this.#browser = null;
        this.#browserServer = null;
        if (this.#proxy === proxy) this.#proxy = null;
        this.#recordFailure(
          new Error("Managed Chromium stopped unexpectedly."),
        );
        void proxy.close();
      });
      return browser;
    } catch (error) {
      await server?.close().catch(() => undefined);
      await proxy.close();
      throw error;
    }
  }

  async #applyPendingRuntime(): Promise<void> {
    if (this.#activeContexts > 0 || !this.#pendingRuntime) return;
    const runtime = this.#pendingRuntime;
    this.#pendingRuntime = null;
    await this.#closeBrowser();
    this.#runtimeDirectory = runtime;
  }

  #scheduleIdleClose(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#activeContexts > 0 || !this.#browser) return;
    this.#idleTimer = setTimeout(
      () => void this.#closeBrowser(),
      IDLE_BROWSER_MS,
    );
    this.#idleTimer.unref();
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    const server = this.#browserServer;
    const proxy = this.#proxy;
    this.#browser = null;
    this.#browserServer = null;
    this.#proxy = null;
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await proxy?.close();
  }

  #recordFailure(error: unknown): void {
    this.#runtimeFailure = {
      category: "process",
      message:
        error instanceof Error
          ? error.message.slice(0, 1_000)
          : "Managed browser failed.",
      retryable: true,
      failedAt: this.#now().toISOString(),
    };
  }
}
