import { createHash } from "node:crypto";
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
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
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
  readonly configuration: RemoteSurfaceConfiguration;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  readonly #client: CdpClient;
  readonly #cdp: BrowserCdpSession;
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #onCrash: (error: Error) => void;
  readonly #process: ChildProcess | null;
  readonly #targetId: string;
  #closed = false;
  #currentUrl: string;
  #cursor = "default";
  #lastCursorProbeAt = 0;
  #loading = true;
  #stateRefresh: Promise<void> | null = null;

  private constructor(options: {
    client: CdpClient;
    cdp: BrowserCdpSession;
    configuration: RemoteSurfaceConfiguration;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    onCrash(error: Error): void;
    process: ChildProcess | null;
    targetId: string;
  }) {
    this.#client = options.client;
    this.#cdp = options.cdp;
    this.configuration = options.configuration;
    this.#currentUrl =
      options.configuration.kind === "browser"
        ? options.configuration.initialUrl
        : "about:blank";
    this.#emit = options.emit;
    this.#onCrash = options.onCrash;
    this.#process = options.process;
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
    onCrash(error: Error): void;
    onLaunch?(process: ChildProcess): void;
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
    await this.captureFrame(attachment.id);
  }

  async detach(attachmentId: string): Promise<void> {
    this.#attachments.delete(attachmentId);
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
      this.#loading = true;
      await this.publishState();
      await this.command("Page.navigate", { url: message.url });
    } else if (message.type === "history") {
      const history = await this.navigationHistory();
      const destination = history.entries[history.currentIndex + message.delta];
      if (destination) {
        this.#loading = true;
        await this.command("Page.navigateToHistoryEntry", {
          entryId: destination.id,
        });
      }
    } else if (message.type === "reload") {
      this.#loading = true;
      await this.command("Page.reload");
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
    await this.command("Page.navigate", {
      url:
        this.configuration.kind === "browser"
          ? this.configuration.initialUrl
          : "about:blank",
    });
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
    await this.command("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.devicePixelRatio,
      mobile: false,
    });
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
      const state: RemoteBrowserServerMessage =
        remoteBrowserServerMessageSchema.parse({
          type: "browser-state",
          url: entry.url,
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
  readonly configuration: Extract<
    RemoteSurfaceConfiguration,
    { kind: "browser" }
  >;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  readonly #command: Parameters<RemoteSurfaceAdapter["open"]>[0];
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #executable: string;
  readonly #options: BrowserAdapterOptions;
  readonly #onClose: () => void;
  #closed = false;
  #currentUrl: string;
  #opening: Promise<BrowserRemoteSurfaceSession> | null = null;
  #restartAttempt = 0;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #session: BrowserRemoteSurfaceSession | null = null;

  private constructor(options: {
    command: Parameters<RemoteSurfaceAdapter["open"]>[0];
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    onClose(): void;
    options: BrowserAdapterOptions;
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
    this.#currentUrl = this.configuration.initialUrl;
  }

  static async open(options: {
    command: Parameters<RemoteSurfaceAdapter["open"]>[0];
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    onClose(): void;
    options: BrowserAdapterOptions;
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

  async handleFrame(
    attachmentId: string,
    channel: Parameters<RemoteSurfaceSession["handleFrame"]>[1],
    payload: Uint8Array,
  ): Promise<void> {
    const session = await this.ensureSession();
    try {
      await session.handleFrame(attachmentId, channel, payload);
    } catch (error) {
      this.handleCrash(
        session,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
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

  private async openSession(): Promise<BrowserRemoteSurfaceSession> {
    let opened: BrowserRemoteSurfaceSession | null = null;
    const session = await BrowserRemoteSurfaceSession.open({
      configuration: {
        ...this.configuration,
        initialUrl: this.#currentUrl,
      },
      dataDirectory: this.#options.dataDirectory,
      emit: (attachmentId, channel, payload) =>
        this.forward(attachmentId, channel, payload),
      executable: this.#executable,
      onCrash: (error) => {
        if (opened) this.handleCrash(opened, error);
      },
      onLaunch: this.#options.onLaunch,
      surfaceId: this.#command.surfaceId,
      viewport: this.#command.viewport,
    });
    opened = session;
    if (this.#closed) {
      await session.close();
      throw new Error("Browser session closed while Chromium was starting.");
    }
    this.#session = session;
    for (const attachment of this.#attachments.values()) {
      await session.attach(attachment);
    }
    this.#restartAttempt = 0;
    this.publishRuntime("ready", null);
    return session;
  }

  private forward(
    attachmentId: string,
    channel: RemoteSurfaceChannel,
    payload: Uint8Array,
  ): boolean {
    if (channel === "control") {
      const state = remoteBrowserServerMessageSchema.safeParse(
        JSON.parse(decoder.decode(payload)),
      );
      if (state.success && state.data.type === "browser-state") {
        this.#currentUrl = state.data.url;
      }
    }
    return this.#emit(attachmentId, channel, payload);
  }

  private handleCrash(
    session: BrowserRemoteSurfaceSession,
    error: Error,
  ): void {
    if (this.#closed || this.#session !== session) return;
    this.#currentUrl = session.currentUrl;
    this.#session = null;
    void session.close().catch(() => undefined);
    this.publishRuntime("recovering", error.message);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.#closed || this.#restartTimer) return;
    const delay = Math.min(250 * 2 ** this.#restartAttempt, 5_000);
    this.#restartAttempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.ensureSession().catch((error: unknown) => {
        this.publishRuntime(
          "recovering",
          error instanceof Error ? error.message : String(error),
        );
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

  constructor(private readonly options: BrowserAdapterOptions) {
    this.executable = options.executable ?? findChromiumExecutable();
  }

  get available(): boolean {
    return Boolean(this.executable);
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
    const existing = this.#sessions.get(command.surfaceId);
    if (existing) return existing;
    const opening = this.#openings.get(command.surfaceId);
    if (opening) return opening;

    let session: ResilientBrowserRemoteSurfaceSession | null = null;
    const next = ResilientBrowserRemoteSurfaceSession.open({
      command,
      emit,
      executable: this.executable,
      onClose: () => {
        if (session && this.#sessions.get(command.surfaceId) === session) {
          this.#sessions.delete(command.surfaceId);
        }
      },
      options: this.options,
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
