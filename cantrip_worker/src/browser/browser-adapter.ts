import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  remoteBrowserClipboardMessageSchema,
  remoteBrowserClientMessageSchema,
  remoteBrowserCursorMessageSchema,
  remoteBrowserServerMessageSchema,
  type RemoteBrowserServerMessage,
  type RemoteSurfaceChannel,
  type RemoteSurfaceConfiguration,
  type RemoteSurfaceViewport,
} from "@cantrip/protocol";

import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceAttachment,
  RemoteSurfacePrivateState,
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
import { workerLogError, workerLogger } from "../logger.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import {
  BrowserNavigationOperationGuard,
  openBrowserNavigationOperation,
  openBrowserPersistentPrivateState,
  protectBrowserLocationOperation,
} from "./browser-private-state.js";
import { CdpClient } from "./cdp-client.js";
import { BrowserCdpSession } from "./browser-session.js";
import { findChromiumExecutable } from "./chromium.js";

interface BrowserAdapterOptions {
  dataDirectory: string;
  executable?: string | null;
  onLaunch?(process: ChildProcess): void;
}

interface NavigationEntry {
  id: number;
  title: string;
  url: string;
}

interface NavigationHistory {
  currentIndex: number;
  entries: NavigationEntry[];
}

interface ScreencastFrame {
  data: string;
  sessionId: number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function profileDirectory(
  dataDirectory: string,
  surfaceId: string,
  profileId: string | null,
): string {
  const identity = profileId ?? surfaceId;
  const digest = createHash("sha256").update(identity).digest("hex");
  return path.join(dataDirectory, "browser", "profiles", digest);
}

function waitForDevtoolsUrl(
  process: ChildProcess,
  timeoutMs = 20_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Chromium remote debugging."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      process.stderr?.off("data", onData);
      process.off("exit", onExit);
      process.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match?.[1]) return;
      cleanup();
      resolve(match[1]);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `Chromium exited before CDP was ready${code === null ? "" : ` (${code})`}.`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    process.stderr?.on("data", onData);
    process.once("exit", onExit);
    process.once("error", onError);
  });
}

async function connectToActiveBrowser(
  userDataDirectory: string,
): Promise<CdpClient | null> {
  try {
    const [portLine, pathLine] = (
      await readFile(path.join(userDataDirectory, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    const port = Number(portLine);
    if (
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !pathLine?.startsWith("/devtools/browser/")
    ) {
      return null;
    }
    return await CdpClient.connect(`ws://127.0.0.1:${port}${pathLine}`, 1_000);
  } catch {
    return null;
  }
}

function launchChromium(
  executable: string,
  userDataDirectory: string,
  viewport: RemoteSurfaceViewport,
): ChildProcess {
  return spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDirectory}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-features=Translate",
      `--window-size=${viewport.width},${viewport.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

class BrowserRemoteSurfaceSession implements RemoteSurfaceSession {
  configuration: Extract<RemoteSurfaceConfiguration, { kind: "browser" }>;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  readonly #client: CdpClient;
  readonly #cdp: BrowserCdpSession;
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #onCrash: (error: Error) => void;
  readonly #process: ChildProcess | null;
  readonly #surfaceId: string;
  readonly #targetId: string;
  readonly #ownerId: string;
  readonly #serverId: string;
  readonly #surfacePrivateState: WorkerEncryptionService;
  #closed = false;
  #currentUrl: string;
  #cursor = "default";
  #lastCursorProbeAt = 0;
  #loading = true;
  #navigationOperation: string | null = null;
  #navigationStartedAtMs: number | null = null;
  #stateRevision: number;
  #stateRefresh: Promise<void> | null = null;
  readonly #navigationOperations = new BrowserNavigationOperationGuard();

  private constructor(options: {
    client: CdpClient;
    cdp: BrowserCdpSession;
    configuration: Extract<RemoteSurfaceConfiguration, { kind: "browser" }>;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    onCrash(error: Error): void;
    process: ChildProcess | null;
    initialUrl: string;
    ownerId: string;
    serverId: string;
    stateRevision: number;
    surfacePrivateState: WorkerEncryptionService;
    surfaceId: string;
    targetId: string;
  }) {
    this.#client = options.client;
    this.#cdp = options.cdp;
    this.configuration = options.configuration;
    this.#currentUrl = options.initialUrl;
    this.#emit = options.emit;
    this.#onCrash = options.onCrash;
    this.#process = options.process;
    this.#surfaceId = options.surfaceId;
    this.#ownerId = options.ownerId;
    this.#serverId = options.serverId;
    this.#stateRevision = options.stateRevision;
    this.#surfacePrivateState = options.surfacePrivateState;
    this.#targetId = options.targetId;
    this.#client.onClose((error) => {
      if (!this.#closed) this.#onCrash(error);
    });
    this.#process?.once("exit", (code, signal) => {
      if (this.#closed) return;
      this.#onCrash(
        new Error(
          `Chromium exited unexpectedly${signal ? ` (${signal})` : code === null ? "" : ` (${code})`}.`,
        ),
      );
    });
  }

  get currentUrl(): string {
    return this.#currentUrl;
  }

  get cdpSession(): BrowserCdpSession {
    return this.#cdp;
  }

  static async open(options: {
    configuration: Extract<RemoteSurfaceConfiguration, { kind: "browser" }>;
    dataDirectory: string;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    initialUrl: string;
    onCrash(error: Error): void;
    onLaunch?(process: ChildProcess): void;
    ownerId: string;
    serverId: string;
    stateRevision: number;
    surfacePrivateState: WorkerEncryptionService;
    surfaceId: string;
    viewport: RemoteSurfaceViewport;
  }): Promise<BrowserRemoteSurfaceSession> {
    const userDataDirectory = profileDirectory(
      options.dataDirectory,
      options.surfaceId,
      options.configuration.profileId,
    );
    await mkdir(userDataDirectory, { recursive: true });
    let process: ChildProcess | null = null;
    let client = await connectToActiveBrowser(userDataDirectory);
    try {
      if (!client) {
        process = launchChromium(
          options.executable,
          userDataDirectory,
          options.viewport,
        );
        options.onLaunch?.(process);
        client = await CdpClient.connect(await waitForDevtoolsUrl(process));
      }
      const { targetId } = await client.request<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      const { sessionId } = await client.request<{ sessionId: string }>(
        "Target.attachToTarget",
        { flatten: true, targetId },
      );
      const cdp = new BrowserCdpSession(client, sessionId);
      const session = new BrowserRemoteSurfaceSession({
        client,
        cdp,
        configuration: options.configuration,
        emit: options.emit,
        onCrash: options.onCrash,
        process,
        initialUrl: options.initialUrl,
        ownerId: options.ownerId,
        serverId: options.serverId,
        stateRevision: options.stateRevision,
        surfacePrivateState: options.surfacePrivateState,
        surfaceId: options.surfaceId,
        targetId,
      });
      await session.initialize(options.viewport);
      return session;
    } catch (error) {
      client?.close();
      if (process?.exitCode === null) process.kill();
      throw error;
    }
  }

  async attach(attachment: RemoteSurfaceAttachment): Promise<void> {
    this.#attachments.set(attachment.id, attachment);
    await this.configureViewport(attachment.viewport);
    await this.publishState(attachment.id);
    try {
      await this.captureFrame(attachment.id);
    } catch (error) {
      workerLogger.rateLimited(
        `browser-initial-frame-unavailable:${this.#surfaceId}`,
        "warn",
        "Initial browser frame was unavailable",
        {
          event: "browser.frame.capture-failed",
          subsystem: "browser",
          operation: "capture-initial-frame",
          reasonCode: "initial-frame-unavailable",
          status: "degraded",
          surfaceId: this.#surfaceId,
          error: workerLogError(error),
        },
      );
    }
  }

  async detach(attachmentId: string): Promise<void> {
    this.#attachments.delete(attachmentId);
  }

  async applyConfiguration(
    configuration: RemoteSurfaceConfiguration,
    initialUrl: string,
    stateRevision: number,
  ): Promise<void> {
    if (configuration.kind !== "browser") {
      throw new Error("Browser configuration kind cannot change.");
    }
    this.configuration = configuration;
    this.#stateRevision = stateRevision;
    if (this.#currentUrl === initialUrl) return;
    this.startNavigation("configuration");
    this.#loading = true;
    await this.publishState();
    try {
      await this.command("Page.navigate", { url: initialUrl });
    } catch (error) {
      this.failNavigation(error);
      throw error;
    }
  }

  async handleFrame(
    attachmentId: string,
    channel: Parameters<RemoteSurfaceSession["handleFrame"]>[1],
    payload: Uint8Array,
  ): Promise<void> {
    if (channel !== "control" || !this.#attachments.has(attachmentId)) return;
    const message = remoteBrowserClientMessageSchema.parse(
      JSON.parse(decoder.decode(payload)),
    );
    if (message.type === "navigate") {
      const privateState = await openBrowserNavigationOperation({
        operationId: message.operationId,
        ownerId: this.#ownerId,
        serverId: this.#serverId,
        service: this.#surfacePrivateState,
        stateProtection: message.stateProtection,
        surfaceId: this.#surfaceId,
      });
      this.#navigationOperations.accept({
        expectedRevision: this.#stateRevision,
        operationId: message.operationId,
        revision: privateState.revision,
      });
      this.startNavigation("navigate");
      this.#loading = true;
      await this.publishState();
      try {
        await this.command("Page.navigate", { url: privateState.url });
      } catch (error) {
        this.failNavigation(error);
        throw error;
      }
    } else if (message.type === "history") {
      const history = await this.navigationHistory();
      const destination = history.entries[history.currentIndex + message.delta];
      if (destination) {
        this.startNavigation("history");
        this.#loading = true;
        try {
          await this.command("Page.navigateToHistoryEntry", {
            entryId: destination.id,
          });
        } catch (error) {
          this.failNavigation(error);
          throw error;
        }
      }
    } else if (message.type === "reload") {
      this.startNavigation("reload");
      this.#loading = true;
      try {
        await this.command("Page.reload");
      } catch (error) {
        this.failNavigation(error);
        throw error;
      }
    } else if (message.type === "stop") {
      await this.command("Page.stopLoading");
      this.#loading = false;
      await this.publishState();
    } else if (message.type === "viewport") {
      const attachment = this.#attachments.get(attachmentId);
      if (attachment) attachment.viewport = message.viewport;
      await this.configureViewport(message.viewport);
    } else if (message.type === "pointer") {
      await this.pointer(message);
      if (
        message.event === "move" &&
        Date.now() - this.#lastCursorProbeAt >= 50
      ) {
        this.#lastCursorProbeAt = Date.now();
        void this.publishCursor(message.x, message.y).catch(() => undefined);
      }
    } else if (message.type === "key") {
      await this.key(message);
    } else if (message.type === "touch") {
      await this.touch(message);
    } else if (message.type === "clipboard") {
      await this.clipboard(attachmentId, message);
    } else {
      await this.command("Page.bringToFront");
    }
  }

  async suspend(): Promise<void> {
    await this.command("Page.stopScreencast").catch(() => undefined);
  }

  async resume(): Promise<void> {
    const viewport = this.#attachments.values().next().value?.viewport;
    if (viewport) await this.configureViewport(viewport);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#client
      .request("Target.closeTarget", { targetId: this.#targetId })
      .catch(() => undefined);
    if (!this.#process) {
      await Promise.race([
        this.#client.request("Browser.close").catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    this.#client.close();
    if (this.#process?.exitCode === null) this.#process.kill();
    this.#attachments.clear();
  }

  private async initialize(viewport: RemoteSurfaceViewport): Promise<void> {
    this.#cdp.on("Page.screencastFrame", (params) => {
      const frame = params as ScreencastFrame;
      const payload = Buffer.from(frame.data, "base64");
      for (const attachmentId of this.#attachments.keys()) {
        this.#emit(attachmentId, "frame", payload);
      }
      void this.command("Page.screencastFrameAck", {
        sessionId: frame.sessionId,
      }).catch(() => undefined);
    });
    this.#cdp.on("Page.frameStartedLoading", () => {
      this.#loading = true;
      void this.publishState().catch(() => undefined);
    });
    this.#cdp.on("Page.frameStoppedLoading", () => {
      this.#loading = false;
      this.completeNavigation();
      void this.publishState().catch(() => undefined);
      void this.captureFrame().catch(() => undefined);
    });
    for (const event of [
      "Page.frameNavigated",
      "Page.navigatedWithinDocument",
      "Page.loadEventFired",
    ]) {
      this.#cdp.on(event, () => {
        void this.publishState().catch(() => undefined);
        if (event === "Page.loadEventFired") {
          void this.captureFrame().catch(() => undefined);
        }
      });
    }
    await Promise.all([
      this.command("Page.enable"),
      this.command("Runtime.enable"),
      this.command("Page.setLifecycleEventsEnabled", { enabled: true }),
    ]);
    await this.configureViewport(viewport);
    this.startNavigation("initial");
    await this.command("Page.navigate", { url: this.#currentUrl });
  }

  private startNavigation(operation: string): void {
    this.#navigationOperation = operation;
    this.#navigationStartedAtMs = Date.now();
    workerLogger.event("debug", "Browser navigation started", {
      event: "browser.navigation.started",
      subsystem: "browser",
      operation,
      status: "started",
      surfaceId: this.#surfaceId,
    });
  }

  private completeNavigation(): void {
    if (!this.#navigationOperation || this.#navigationStartedAtMs === null)
      return;
    workerLogger.event("info", "Browser navigation completed", {
      event: "browser.navigation.completed",
      subsystem: "browser",
      operation: this.#navigationOperation,
      status: "completed",
      surfaceId: this.#surfaceId,
      durationMs: Date.now() - this.#navigationStartedAtMs,
    });
    this.#navigationOperation = null;
    this.#navigationStartedAtMs = null;
  }

  private failNavigation(_error: unknown): void {
    workerLogger.event("warn", "Browser navigation failed", {
      event: "browser.navigation.failed",
      subsystem: "browser",
      operation: this.#navigationOperation ?? "navigate",
      reasonCode: "cdp-command-failed",
      status: "failed",
      surfaceId: this.#surfaceId,
      durationMs:
        this.#navigationStartedAtMs === null
          ? undefined
          : Date.now() - this.#navigationStartedAtMs,
    });
    this.#navigationOperation = null;
    this.#navigationStartedAtMs = null;
  }

  private command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.#cdp.command<T>(method, params);
  }

  private async configureViewport(
    viewport: RemoteSurfaceViewport,
  ): Promise<void> {
    await Promise.all([
      this.command("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.devicePixelRatio,
        mobile: false,
      }),
      this.command("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 10,
      }),
    ]);
    await this.command("Page.stopScreencast").catch(() => undefined);
    await this.command("Page.startScreencast", {
      format: "jpeg",
      quality: 78,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
  }

  private async navigationHistory(): Promise<NavigationHistory> {
    return this.command<NavigationHistory>("Page.getNavigationHistory");
  }

  private async publishState(onlyAttachmentId?: string): Promise<void> {
    if (this.#stateRefresh) {
      await this.#stateRefresh;
      if (!onlyAttachmentId) return;
    }
    this.#stateRefresh = (async () => {
      const history = await this.navigationHistory();
      const entry = history.entries[history.currentIndex];
      if (!entry) return;
      this.#currentUrl = entry.url;
      const operationId = randomUUID();
      const state: RemoteBrowserServerMessage =
        remoteBrowserServerMessageSchema.parse({
          type: "browser-state",
          operationId,
          stateProtection: await protectBrowserLocationOperation({
            operationId,
            ownerId: this.#ownerId,
            revision: this.#stateRevision,
            serverId: this.#serverId,
            service: this.#surfacePrivateState,
            surfaceId: this.#surfaceId,
            url: entry.url,
          }),
          title: entry.title,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
          loading: this.#loading,
        });
      const payload = encoder.encode(JSON.stringify(state));
      const recipients = onlyAttachmentId
        ? [onlyAttachmentId]
        : [...this.#attachments.keys()];
      for (const attachmentId of recipients) {
        if (this.#attachments.has(attachmentId)) {
          this.#emit(attachmentId, "control", payload);
        }
      }
    })().finally(() => {
      this.#stateRefresh = null;
    });
    await this.#stateRefresh;
  }

  private async captureFrame(onlyAttachmentId?: string): Promise<void> {
    const screenshot = await this.#cdp.captureScreenshot();
    const payload = Buffer.from(screenshot.data, "base64");
    const recipients = onlyAttachmentId
      ? [onlyAttachmentId]
      : [...this.#attachments.keys()];
    for (const attachmentId of recipients) {
      if (this.#attachments.has(attachmentId)) {
        this.#emit(attachmentId, "frame", payload);
      }
    }
  }

  private pointer(
    message: Extract<
      ReturnType<typeof remoteBrowserClientMessageSchema.parse>,
      { type: "pointer" }
    >,
  ): Promise<unknown> {
    const type =
      message.event === "move"
        ? "mouseMoved"
        : message.event === "down"
          ? "mousePressed"
          : message.event === "up"
            ? "mouseReleased"
            : "mouseWheel";
    return this.command("Input.dispatchMouseEvent", {
      type,
      x: message.x,
      y: message.y,
      button: message.button,
      buttons: message.buttons,
      clickCount: message.clickCount,
      deltaX: message.deltaX,
      deltaY: message.deltaY,
      modifiers: message.modifiers,
      pointerType: "mouse",
    });
  }

  private async publishCursor(x: number, y: number): Promise<void> {
    const cursor = await this.#cdp.evaluate<string>(
      `(() => { const node = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)}); return node ? getComputedStyle(node).cursor : "default"; })()`,
    );
    if (!cursor || cursor === this.#cursor) return;
    let message = remoteBrowserCursorMessageSchema.safeParse({
      type: "browser-cursor",
      cursor,
    });
    if (!message.success) {
      message = remoteBrowserCursorMessageSchema.safeParse({
        type: "browser-cursor",
        cursor: "default",
      });
    }
    if (!message.success || message.data.cursor === this.#cursor) return;
    this.#cursor = message.data.cursor;
    const payload = encoder.encode(JSON.stringify(message.data));
    for (const attachmentId of this.#attachments.keys()) {
      this.#emit(attachmentId, "cursor", payload);
    }
  }

  private touch(
    message: Extract<
      ReturnType<typeof remoteBrowserClientMessageSchema.parse>,
      { type: "touch" }
    >,
  ): Promise<unknown> {
    return this.command("Input.dispatchTouchEvent", {
      type:
        message.event === "start"
          ? "touchStart"
          : message.event === "move"
            ? "touchMove"
            : message.event === "cancel"
              ? "touchCancel"
              : "touchEnd",
      touchPoints: message.points.map((point) => ({
        x: point.x,
        y: point.y,
        radiusX: point.radiusX,
        radiusY: point.radiusY,
        force: point.force,
        id: point.id,
      })),
      modifiers: message.modifiers,
    });
  }

  private async clipboard(
    attachmentId: string,
    message: Extract<
      ReturnType<typeof remoteBrowserClientMessageSchema.parse>,
      { type: "clipboard" }
    >,
  ): Promise<void> {
    if (message.operation === "paste-text") {
      if (message.text) {
        await this.command("Input.insertText", { text: message.text });
      }
      return;
    }
    const text =
      (await this.#cdp.evaluate<string>(
        "String(globalThis.getSelection?.() ?? '')",
      )) ?? "";
    this.#emit(
      attachmentId,
      "clipboard",
      encoder.encode(
        JSON.stringify(
          remoteBrowserClipboardMessageSchema.parse({
            type: "browser-clipboard",
            operation: "copy-selection",
            text,
          }),
        ),
      ),
    );
  }

  private async key(
    message: Extract<
      ReturnType<typeof remoteBrowserClientMessageSchema.parse>,
      { type: "key" }
    >,
  ): Promise<void> {
    const printable = message.text && message.event === "down";
    await this.command("Input.dispatchKeyEvent", {
      type:
        message.event === "up" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
      key: message.key,
      code: message.code,
      text: printable ? message.text : undefined,
      unmodifiedText: printable ? message.text : undefined,
      modifiers: message.modifiers,
    });
  }
}

class ResilientBrowserRemoteSurfaceSession implements RemoteSurfaceSession {
  configuration: Extract<RemoteSurfaceConfiguration, { kind: "browser" }>;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  readonly #command: Parameters<RemoteSurfaceAdapter["open"]>[0];
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #executable: string;
  readonly #options: BrowserAdapterOptions;
  readonly #onClose: () => void;
  readonly #ownerId: string;
  readonly #serverId: string;
  readonly #surfacePrivateState: WorkerEncryptionService;
  #closed = false;
  #currentUrl: string;
  #opening: Promise<BrowserRemoteSurfaceSession> | null = null;
  #restartAttempt = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #session: BrowserRemoteSurfaceSession | null = null;
  #sessionStartedAtMs: number | null = null;
  #stateRevision: number;

  private constructor(options: {
    command: Parameters<RemoteSurfaceAdapter["open"]>[0];
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    initialState: { revision: number; url: string };
    onClose(): void;
    options: BrowserAdapterOptions;
    surfacePrivateState: WorkerEncryptionService;
  }) {
    if (options.command.configuration.kind !== "browser") {
      throw new Error("Browser session requires browser configuration.");
    }
    this.#command = options.command;
    this.#emit = options.emit;
    this.#executable = options.executable;
    this.#onClose = options.onClose;
    this.#options = options.options;
    this.configuration = options.command.configuration;
    this.#currentUrl = options.initialState.url;
    this.#stateRevision = options.initialState.revision;
    this.#surfacePrivateState = options.surfacePrivateState;
    this.#ownerId = options.surfacePrivateState.ownerId();
    this.#serverId = options.command.serverId;
  }

  static async open(options: {
    command: Parameters<RemoteSurfaceAdapter["open"]>[0];
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    initialState: { revision: number; url: string };
    onClose(): void;
    options: BrowserAdapterOptions;
    surfacePrivateState: WorkerEncryptionService;
  }): Promise<ResilientBrowserRemoteSurfaceSession> {
    const session = new ResilientBrowserRemoteSurfaceSession(options);
    await session.ensureSession();
    return session;
  }

  async attach(attachment: RemoteSurfaceAttachment): Promise<void> {
    this.#attachments.set(attachment.id, attachment);
    const existing = this.#session;
    const session = await this.ensureSession();
    if (existing === session) await session.attach(attachment);
  }

  async detach(attachmentId: string): Promise<void> {
    this.#attachments.delete(attachmentId);
    await this.#session?.detach(attachmentId);
  }

  async updateConfiguration(
    configuration: RemoteSurfaceConfiguration,
    privateState: RemoteSurfacePrivateState | null,
  ): Promise<void> {
    if (configuration.kind !== "browser") {
      throw new Error("Browser configuration kind cannot change.");
    }
    if (!privateState) {
      throw new Error("Browser surface private state is unavailable.");
    }
    const opened = await openBrowserPersistentPrivateState({
      ownerId: this.#ownerId,
      service: this.#surfacePrivateState,
      state: privateState,
      surfaceId: this.#command.surfaceId,
    });
    this.configuration = configuration;
    this.#stateRevision = opened.revision;
    this.#currentUrl = opened.url;
    const session = this.#session;
    if (session) {
      try {
        await session.applyConfiguration(
          configuration,
          opened.url,
          opened.revision,
        );
      } catch (error) {
        if (this.#session === session) throw error;
        this.#currentUrl = opened.url;
        await this.waitForRecovery();
      }
      this.#currentUrl = this.#session?.currentUrl ?? opened.url;
    } else {
      await this.waitForRecovery();
      this.#currentUrl = this.#session?.currentUrl ?? opened.url;
    }
  }

  async handleFrame(
    attachmentId: string,
    channel: Parameters<RemoteSurfaceSession["handleFrame"]>[1],
    payload: Uint8Array,
  ): Promise<void> {
    const session = await this.ensureSession();
    await session.handleFrame(attachmentId, channel, payload);
  }

  async suspend(): Promise<void> {
    await this.#session?.suspend();
  }

  async resume(): Promise<void> {
    await (await this.ensureSession()).resume();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    const session = this.#session;
    this.#session = null;
    await session?.close();
    workerLogger.event("info", "Browser surface closed", {
      event: "browser.surface.closed",
      subsystem: "browser",
      operation: "close",
      status: "completed",
      surfaceId: this.#command.surfaceId,
      durationMs: this.#sessionStartedAtMs
        ? Date.now() - this.#sessionStartedAtMs
        : undefined,
      counts: { attachments: this.#attachments.size },
    });
    this.#sessionStartedAtMs = null;
    this.#attachments.clear();
    this.#onClose();
  }

  get cdpSession(): BrowserCdpSession | null {
    return this.#session?.cdpSession ?? null;
  }

  private ensureSession(): Promise<BrowserRemoteSurfaceSession> {
    if (this.#closed) {
      return Promise.reject(new Error("Browser session is closed."));
    }
    if (this.#session) return Promise.resolve(this.#session);
    if (this.#opening) return this.#opening;
    this.#opening = this.openSession().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  private async waitForRecovery(
    timeoutMs = 20_000,
  ): Promise<BrowserRemoteSurfaceSession> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#closed && Date.now() < deadline) {
      if (this.#session) return this.#session;
      if (this.#opening) {
        try {
          return await this.#opening;
        } catch {
          this.scheduleRestart();
        }
      } else if (!this.#restartTimer) {
        try {
          return await this.ensureSession();
        } catch {
          this.scheduleRestart();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Browser runtime did not recover in time.");
  }

  private async openSession(): Promise<BrowserRemoteSurfaceSession> {
    const startedAtMs = Date.now();
    const attempt = this.#restartAttempt + 1;
    workerLogger.event("debug", "Browser surface runtime starting", {
      event: "browser.runtime.starting",
      subsystem: "browser",
      operation: "start",
      status: "started",
      surfaceId: this.#command.surfaceId,
      attempt,
      counts: { attachments: this.#attachments.size },
    });
    let opened: BrowserRemoteSurfaceSession | null = null;
    let session: BrowserRemoteSurfaceSession;
    try {
      session = await BrowserRemoteSurfaceSession.open({
        configuration: this.configuration,
        dataDirectory: this.#options.dataDirectory,
        emit: (attachmentId, channel, payload) =>
          this.forward(attachmentId, channel, payload),
        executable: this.#executable,
        initialUrl: this.#currentUrl,
        onCrash: (error) => {
          if (opened) this.handleCrash(opened, error);
        },
        onLaunch: this.#options.onLaunch,
        ownerId: this.#ownerId,
        serverId: this.#serverId,
        stateRevision: this.#stateRevision,
        surfacePrivateState: this.#surfacePrivateState,
        surfaceId: this.#command.surfaceId,
        viewport: this.#command.viewport,
      });
    } catch (error) {
      workerLogger.rateLimited(
        `browser-runtime-start-failed:${this.#command.surfaceId}`,
        "warn",
        "Browser surface runtime failed to start",
        {
          event: "browser.runtime.start-failed",
          subsystem: "browser",
          operation: "start",
          reasonCode: "runtime-unavailable",
          status: "retrying",
          surfaceId: this.#command.surfaceId,
          attempt,
          durationMs: Date.now() - startedAtMs,
        },
      );
      throw error;
    }
    opened = session;
    if (this.#closed) {
      await session.close();
      throw new Error("Browser session closed while Chromium was starting.");
    }
    this.#session = session;
    this.#sessionStartedAtMs = Date.now();
    for (const attachment of this.#attachments.values()) {
      await session.attach(attachment);
    }
    this.#restartAttempt = 0;
    this.publishRuntime("ready", null);
    workerLogger.event("info", "Browser surface runtime ready", {
      event: "browser.runtime.ready",
      subsystem: "browser",
      operation: "start",
      status: "ready",
      surfaceId: this.#command.surfaceId,
      attempt,
      durationMs: Date.now() - startedAtMs,
      counts: { attachments: this.#attachments.size },
    });
    return session;
  }

  private forward(
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): boolean {
    return this.#emit(attachmentId, channel, payload);
  }

  private handleCrash(
    session: BrowserRemoteSurfaceSession,
    _error: Error,
  ): void {
    if (this.#closed || this.#session !== session) return;
    this.#currentUrl = session.currentUrl;
    this.#session = null;
    void session.close().catch(() => undefined);
    this.publishRuntime("recovering", "Browser runtime is reconnecting.");
    workerLogger.event("warn", "Browser surface runtime disconnected", {
      event: "browser.runtime.disconnected",
      subsystem: "browser",
      operation: "recover",
      reasonCode: "runtime-disconnected",
      status: "recovering",
      surfaceId: this.#command.surfaceId,
      durationMs: this.#sessionStartedAtMs
        ? Date.now() - this.#sessionStartedAtMs
        : undefined,
    });
    this.#sessionStartedAtMs = null;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.#closed || this.#restartTimer) return;
    const delay = Math.min(250 * 2 ** this.#restartAttempt, 5_000);
    this.#restartAttempt += 1;
    workerLogger.event("debug", "Browser surface restart scheduled", {
      event: "browser.runtime.restart-scheduled",
      subsystem: "browser",
      operation: "recover",
      status: "retrying",
      surfaceId: this.#command.surfaceId,
      attempt: this.#restartAttempt,
      reconnectDelayMs: delay,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.ensureSession().catch(() => {
        this.publishRuntime("recovering", "Browser runtime is reconnecting.");
        this.scheduleRestart();
      });
    }, delay);
  }

  private publishRuntime(
    status: "ready" | "recovering" | "error",
    message: string | null,
  ): void {
    const payload = encoder.encode(
      JSON.stringify(
        remoteBrowserServerMessageSchema.parse({
          type: "browser-runtime",
          status,
          message,
        }),
      ),
    );
    for (const attachmentId of this.#attachments.keys()) {
      this.#emit(attachmentId, "control", payload);
    }
  }
}

export class BrowserRemoteSurfaceAdapter implements RemoteSurfaceAdapter {
  readonly executable: string | null;
  readonly #openings = new Map<
    string,
    Promise<ResilientBrowserRemoteSurfaceSession>
  >();
  readonly #sessions = new Map<string, ResilientBrowserRemoteSurfaceSession>();
  #surfacePrivateState: WorkerEncryptionService | null = null;

  constructor(private readonly options: BrowserAdapterOptions) {
    this.executable = options.executable ?? findChromiumExecutable();
    workerLogger.event("info", "Browser surface adapter initialized", {
      event: "browser.adapter.initialized",
      subsystem: "browser",
      operation: "initialize",
      status: this.executable ? "available" : "unavailable",
      available: Boolean(this.executable),
    });
  }

  get available(): boolean {
    return Boolean(this.executable);
  }

  setSurfacePrivateStateService(service: WorkerEncryptionService): void {
    this.#surfacePrivateState = service;
  }

  session(surfaceId: string): BrowserCdpSession | null {
    return this.#sessions.get(surfaceId)?.cdpSession ?? null;
  }

  async open(
    command: Parameters<RemoteSurfaceAdapter["open"]>[0],
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1],
  ): Promise<RemoteSurfaceSession> {
    if (command.configuration.kind !== "browser") {
      throw new Error("Browser adapter received a non-browser surface.");
    }
    if (!this.executable) {
      throw new Error(
        "No Chromium browser was found. Set CANTRIP_CHROMIUM_EXECUTABLE.",
      );
    }
    if (
      !this.#surfacePrivateState ||
      !command.stateProtection ||
      !command.stateResource ||
      !command.stateRevision
    ) {
      throw new Error("Browser surface encryption is unavailable.");
    }
    const existing = this.#sessions.get(command.surfaceId);
    if (existing) {
      workerLogger.sampled(
        `browser-surface-reused:${command.surfaceId}`,
        20,
        "debug",
        "Browser surface reused",
        {
          event: "browser.surface.reused",
          subsystem: "browser",
          operation: "open",
          status: "reused",
          surfaceId: command.surfaceId,
        },
      );
      return existing;
    }
    const opening = this.#openings.get(command.surfaceId);
    if (opening) return opening;

    const initialState = await openBrowserPersistentPrivateState({
      ownerId: this.#surfacePrivateState.ownerId(),
      service: this.#surfacePrivateState,
      state: {
        serverId: command.serverId,
        stateProtection: command.stateProtection,
        stateResource: command.stateResource,
        stateRevision: command.stateRevision,
      },
      surfaceId: command.surfaceId,
    });
    let session: ResilientBrowserRemoteSurfaceSession | null = null;
    const next = ResilientBrowserRemoteSurfaceSession.open({
      command,
      emit,
      executable: this.executable,
      initialState,
      onClose: () => {
        if (session && this.#sessions.get(command.surfaceId) === session) {
          this.#sessions.delete(command.surfaceId);
        }
      },
      options: this.options,
      surfacePrivateState: this.#surfacePrivateState,
    }).then((opened) => {
      session = opened;
      this.#sessions.set(command.surfaceId, opened);
      return opened;
    });
    this.#openings.set(command.surfaceId, next);
    try {
      return await next;
    } finally {
      if (this.#openings.get(command.surfaceId) === next) {
        this.#openings.delete(command.surfaceId);
      }
    }
  }
}
