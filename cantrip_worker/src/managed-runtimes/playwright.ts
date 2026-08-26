import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  type CantripMcpBinding,
  type ManagedWebRuntimeAction,
  type ManagedWebRuntimeStatus,
} from "@cantrip/protocol";

import { normalizedPublicHttpUrl } from "../web/safe-fetch.js";
import { BrowserNetworkProxy } from "./browser-proxy.js";
import {
  ManagedRuntimeInstaller,
  publicManagedWebRuntimeStatus,
} from "./runtime.js";
import {
  managedRuntimeManifestUrl,
  managedRuntimePublicKeys,
} from "./trust.js";

const UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const IDLE_BROWSER_MS = 5 * 60_000;
const MAX_CONTEXTS = 4;
const MAX_WAITERS = 16;
const MAX_RENDERED_HTML_BYTES = 10_000_000;
const SESSION_TTL_MS = 15 * 60_000;
const MAX_SESSION_ELEMENTS = 100;

interface InstallerLike {
  clearCache(): Promise<ManagedWebRuntimeStatus>;
  prepare(): Promise<ManagedWebRuntimeStatus>;
  reinstall(): Promise<ManagedWebRuntimeStatus>;
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
  locator(selector: string): PlaywrightLocator;
  title(): Promise<string>;
  url(): string;
  waitForLoadState(
    state: "domcontentloaded",
    options: { timeout: number },
  ): Promise<void>;
}

interface PlaywrightLocator {
  ariaSnapshot(): Promise<string>;
  click(options: { timeout: number }): Promise<void>;
  count(): Promise<number>;
  fill(value: string, options: { timeout: number }): Promise<void>;
  nth(index: number): PlaywrightLocator;
  press(key: string, options: { timeout: number }): Promise<void>;
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
    launchPersistentContext(
      userDataDirectory: string,
      options: Record<string, unknown>,
    ): Promise<PlaywrightContext>;
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

export interface WebSessionState {
  generation: number;
  persistent: boolean;
  sessionId: string;
  title: string;
  url: string;
}

export interface WebSessionSnapshot extends WebSessionState {
  elements: Array<{ description: string; ref: string }>;
  snapshot: string;
  truncated: boolean;
}

export interface WebSessionOpenOptions {
  beforeNavigation?: (url: URL) => Promise<void>;
  browserTarget?: { projectId: string; surfaceId: string };
  sessionId?: string;
}

interface WebSessionRecord {
  beforeNavigation?: (url: URL) => Promise<void>;
  busy: boolean;
  chatId: string;
  context: PlaywrightContext;
  elements: Map<string, PlaywrightLocator>;
  generation: number;
  lastUsedAt: number;
  ownerId: string;
  page: PlaywrightPage;
  persistent: boolean;
  proxy: BrowserNetworkProxy | null;
  release: () => void;
  snapshotCache: {
    elements: Array<{ description: string; ref: string }>;
    snapshot: string;
  } | null;
}

function opaque(prefix: "wer" | "wss"): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function belongsToSession(
  record: WebSessionRecord,
  binding: CantripMcpBinding,
): boolean {
  return record.ownerId === binding.ownerId && record.chatId === binding.chatId;
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
  #persistentSessions = 0;
  #rollbackAttempted = false;
  #runtimeDirectory: string | null = null;
  #runtimeFailure: ManagedWebRuntimeStatus["failure"] = null;
  readonly #sessions = new Map<string, WebSessionRecord>();
  #sessionTimer: ReturnType<typeof setInterval> | null = null;
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

  async action(
    action: ManagedWebRuntimeAction,
  ): Promise<ManagedWebRuntimeStatus> {
    if (this.#operation) await this.#operation;
    this.#operation = this.#performAction(action).finally(
      () => (this.#operation = null),
    );
    await this.#operation;
    return this.status();
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
      await this.#configureContext(context, beforeNavigation, false);
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

  async openSession(
    binding: CantripMcpBinding,
    urlValue: string,
    options: WebSessionOpenOptions = {},
  ): Promise<WebSessionState> {
    const target = normalizedPublicHttpUrl(urlValue);
    this.#expireSessions();
    if (options.sessionId) {
      const record = this.#session(binding, options.sessionId);
      if (options.browserTarget)
        throw new Error(
          "A resumed web session cannot change its browser profile.",
        );
      this.#claimSession(record);
      try {
        record.beforeNavigation = options.beforeNavigation;
        this.#invalidateSession(record);
        await record.page.goto(target.href, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
        return await this.#sessionState(options.sessionId, record);
      } finally {
        record.busy = false;
      }
    }

    const release = await this.#slots.acquire();
    this.#activeContexts += 1;
    let context: PlaywrightContext | null = null;
    let proxy: BrowserNetworkProxy | null = null;
    let persistent = false;
    try {
      if (options.browserTarget) {
        if (this.#persistentSessions >= 1)
          throw new Error(
            "The managed browser persistent-session limit is reached.",
          );
        const runtime = await this.#readyRuntime();
        const stateRoot = path.join(
          this.#dataDirectory,
          "managed-runtimes",
          "playwright",
          "state",
        );
        await createState(stateRoot);
        const profileKey = createHash("sha256")
          .update(binding.ownerId)
          .update("\0")
          .update(options.browserTarget.projectId)
          .update("\0")
          .update(options.browserTarget.surfaceId)
          .digest("hex");
        const profileDirectory = path.join(stateRoot, "profiles", profileKey);
        await privateDirectory(profileDirectory);
        proxy = this.#proxyFactory();
        const proxyOrigin = await proxy.start();
        const module = await this.#loadPlaywright(runtime);
        context = await module.chromium.launchPersistentContext(
          profileDirectory,
          {
            executablePath: await findExecutable(runtime),
            headless: true,
            chromiumSandbox: true,
            proxy: { server: proxyOrigin, bypass: "" },
            env: browserEnvironment(runtime, stateRoot),
            acceptDownloads: false,
            serviceWorkers: "block",
            userAgent:
              "CantripResearchBot/1.0 (+https://github.com/ArcaneArts/Cantrip)",
          },
        );
        persistent = true;
        this.#persistentSessions += 1;
      } else {
        const browser = await this.#ensureBrowser();
        context = await browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
          userAgent:
            "CantripResearchBot/1.0 (+https://github.com/ArcaneArts/Cantrip)",
        });
      }
      await this.#configureContext(context, options.beforeNavigation, true);
      const page = await context.newPage();
      await page.goto(target.href, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      const sessionId = opaque("wss");
      const record: WebSessionRecord = {
        beforeNavigation: options.beforeNavigation,
        busy: false,
        chatId: binding.chatId,
        context,
        elements: new Map(),
        generation: 1,
        lastUsedAt: this.#now().getTime(),
        ownerId: binding.ownerId,
        page,
        persistent,
        proxy,
        release,
        snapshotCache: null,
      };
      this.#sessions.set(sessionId, record);
      this.#startSessionExpiry();
      this.#runtimeFailure = null;
      return await this.#sessionState(sessionId, record);
    } catch (error) {
      await context?.close().catch(() => undefined);
      await proxy?.close().catch(() => undefined);
      if (persistent) this.#persistentSessions -= 1;
      this.#activeContexts -= 1;
      release();
      this.#recordFailure(error);
      throw error;
    }
  }

  async snapshotSession(
    binding: CantripMcpBinding,
    sessionId: string,
    maxChars: number,
  ): Promise<WebSessionSnapshot> {
    this.#expireSessions();
    const record = this.#session(binding, sessionId);
    this.#claimSession(record);
    try {
      if (!record.snapshotCache) {
        const rawSnapshot = await record.page.locator("body").ariaSnapshot();
        const interactive = record.page.locator(
          "a,button,input,textarea,select,[role=button],[tabindex]",
        );
        const elements: Array<{ description: string; ref: string }> = [];
        const count = Math.min(await interactive.count(), MAX_SESSION_ELEMENTS);
        for (let index = 0; index < count; index += 1) {
          const locator = interactive.nth(index);
          const description =
            (await locator.ariaSnapshot())
              .replace(/\s+/gu, " ")
              .trim()
              .slice(0, 500) || "interactive element";
          const ref = opaque("wer");
          record.elements.set(ref, locator);
          elements.push({ description, ref });
        }
        record.snapshotCache = { elements, snapshot: rawSnapshot };
      }
      record.lastUsedAt = this.#now().getTime();
      const state = await this.#sessionState(sessionId, record);
      return {
        ...state,
        elements: record.snapshotCache.elements,
        snapshot: record.snapshotCache.snapshot.slice(0, maxChars),
        truncated: record.snapshotCache.snapshot.length > maxChars,
      };
    } finally {
      record.busy = false;
    }
  }

  async clickSession(
    binding: CantripMcpBinding,
    sessionId: string,
    elementRef: string,
  ): Promise<WebSessionState> {
    const record = this.#session(binding, sessionId);
    const locator = this.#element(record, elementRef);
    this.#claimSession(record);
    try {
      await locator.click({ timeout: 15_000 });
      await record.page
        .waitForLoadState("domcontentloaded", { timeout: 5_000 })
        .catch(() => undefined);
    } finally {
      this.#invalidateSession(record);
      record.busy = false;
    }
    return await this.#sessionState(sessionId, record);
  }

  async typeSession(
    binding: CantripMcpBinding,
    sessionId: string,
    elementRef: string,
    value: string,
    submit: boolean,
  ): Promise<WebSessionState> {
    const record = this.#session(binding, sessionId);
    const locator = this.#element(record, elementRef);
    this.#claimSession(record);
    try {
      await locator.fill(value, { timeout: 15_000 });
      if (submit) {
        await locator.press("Enter", { timeout: 15_000 });
        await record.page
          .waitForLoadState("domcontentloaded", { timeout: 5_000 })
          .catch(() => undefined);
      }
    } finally {
      this.#invalidateSession(record);
      record.busy = false;
    }
    return await this.#sessionState(sessionId, record);
  }

  async closeSession(
    binding: CantripMcpBinding,
    sessionId: string,
  ): Promise<void> {
    const record = this.#session(binding, sessionId);
    await this.#closeSession(sessionId, record);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#updateTimer) clearInterval(this.#updateTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (this.#sessionTimer) clearInterval(this.#sessionTimer);
    await Promise.all(
      [...this.#sessions].map(([sessionId, record]) =>
        this.#closeSession(sessionId, record),
      ),
    );
    await this.#closeBrowser();
  }

  async #configureContext(
    context: PlaywrightContext,
    beforeNavigation: ((url: URL) => Promise<void>) | undefined,
    interactive: boolean,
  ): Promise<void> {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const value = request.url();
      if (value === "about:blank") return await route.continue();
      if (!/^https?:/u.test(value)) return await route.abort("blockedbyclient");
      if (!interactive && !["GET", "HEAD"].includes(request.method()))
        return await route.abort("blockedbyclient");
      if (
        !interactive &&
        ["websocket", "eventsource"].includes(request.resourceType())
      )
        return await route.abort("blockedbyclient");
      if (
        request.isNavigationRequest() &&
        request.resourceType() === "document"
      )
        await beforeNavigation?.(normalizedPublicHttpUrl(value));
      await route.continue();
    });
  }

  async #readyRuntime(): Promise<string> {
    await this.prepare();
    const runtime =
      this.#runtimeDirectory ?? this.#installer.runtimeDirectory();
    if (!runtime) throw new Error(`Browser runtime is ${this.status().state}.`);
    return runtime;
  }

  #session(binding: CantripMcpBinding, sessionId: string): WebSessionRecord {
    const record = this.#sessions.get(sessionId);
    if (!record || !belongsToSession(record, binding))
      throw new Error("The web session is unavailable for this task.");
    record.lastUsedAt = this.#now().getTime();
    return record;
  }

  #element(record: WebSessionRecord, elementRef: string): PlaywrightLocator {
    const locator = record.elements.get(elementRef);
    if (!locator)
      throw new Error(
        "The web element reference is stale; take a fresh session snapshot.",
      );
    return locator;
  }

  #claimSession(record: WebSessionRecord): void {
    if (record.busy)
      throw new Error("The web session is busy with another operation.");
    record.busy = true;
  }

  #invalidateSession(record: WebSessionRecord): void {
    record.generation += 1;
    record.lastUsedAt = this.#now().getTime();
    record.elements.clear();
    record.snapshotCache = null;
  }

  async #sessionState(
    sessionId: string,
    record: WebSessionRecord,
  ): Promise<WebSessionState> {
    return {
      generation: record.generation,
      persistent: record.persistent,
      sessionId,
      title: (await record.page.title()).slice(0, 1_000),
      url: normalizedPublicHttpUrl(record.page.url()).href,
    };
  }

  #startSessionExpiry(): void {
    if (this.#sessionTimer) return;
    this.#sessionTimer = setInterval(() => this.#expireSessions(), 60_000);
    this.#sessionTimer.unref();
  }

  #expireSessions(): void {
    const expiredBefore = this.#now().getTime() - SESSION_TTL_MS;
    for (const [sessionId, record] of this.#sessions) {
      if (record.lastUsedAt < expiredBefore)
        void this.#closeSession(sessionId, record);
    }
  }

  async #closeSession(
    sessionId: string,
    record: WebSessionRecord,
  ): Promise<void> {
    if (this.#sessions.get(sessionId) !== record) return;
    this.#sessions.delete(sessionId);
    await record.context.close().catch(() => undefined);
    await record.proxy?.close().catch(() => undefined);
    if (record.persistent) this.#persistentSessions -= 1;
    this.#activeContexts -= 1;
    record.release();
    await this.#applyPendingRuntime();
    this.#scheduleIdleClose();
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

  async #performAction(action: ManagedWebRuntimeAction): Promise<void> {
    if (action === "clear-profiles") {
      for (const [sessionId, record] of this.#sessions) {
        if (record.persistent) await this.#closeSession(sessionId, record);
      }
      const profiles = path.join(
        this.#dataDirectory,
        "managed-runtimes",
        "playwright",
        "state",
        "profiles",
      );
      await rm(profiles, { recursive: true, force: true });
      await privateDirectory(profiles);
      return;
    }
    if (
      this.#activeContexts > 0 &&
      ["retry", "reinstall", "clear-cache"].includes(action)
    )
      throw new Error(
        "The browser runtime is busy; retry after active contexts finish.",
      );
    if (["retry", "reinstall", "clear-cache"].includes(action)) {
      await this.#closeBrowser();
      this.#runtimeFailure = null;
    }
    if (action === "clear-cache") {
      await this.#installer.clearCache();
      const stateRoot = path.join(
        this.#dataDirectory,
        "managed-runtimes",
        "playwright",
        "state",
      );
      for (const directory of ["cache", "downloads", "traces"] as const) {
        const target = path.join(stateRoot, directory);
        await rm(target, { recursive: true, force: true });
        await privateDirectory(target);
      }
    }
    const status =
      action === "reinstall"
        ? await this.#installer.reinstall()
        : await this.#installer.prepare();
    const runtime = this.#installer.runtimeDirectory();
    if (
      status.state === "ready" &&
      runtime &&
      runtime !== this.#runtimeDirectory
    ) {
      if (this.#activeContexts > 0) this.#pendingRuntime = runtime;
      else {
        await this.#closeBrowser();
        this.#runtimeDirectory = runtime;
        this.#pendingRuntime = null;
      }
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
        for (const [sessionId, record] of this.#sessions) {
          if (!record.persistent) void this.#closeSession(sessionId, record);
        }
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
