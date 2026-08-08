import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  remoteBrowserClientMessageSchema,
  remoteBrowserServerMessageSchema,
  type RemoteBrowserServerMessage,
  type RemoteSurfaceConfiguration,
  type RemoteSurfaceViewport,
} from "@cantrip/protocol";

import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceAttachment,
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
import { CdpClient } from "./cdp-client.js";
import { findChromiumExecutable } from "./chromium.js";

interface BrowserAdapterOptions {
  dataDirectory: string;
  executable?: string | null;
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
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #process: ChildProcess;
  readonly #sessionId: string;
  readonly #targetId: string;
  #closed = false;
  #loading = true;
  #stateRefresh: Promise<void> | null = null;

  private constructor(options: {
    client: CdpClient;
    configuration: RemoteSurfaceConfiguration;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    process: ChildProcess;
    sessionId: string;
    targetId: string;
  }) {
    this.#client = options.client;
    this.configuration = options.configuration;
    this.#emit = options.emit;
    this.#process = options.process;
    this.#sessionId = options.sessionId;
    this.#targetId = options.targetId;
  }

  static async open(options: {
    configuration: Extract<RemoteSurfaceConfiguration, { kind: "browser" }>;
    dataDirectory: string;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    executable: string;
    surfaceId: string;
    viewport: RemoteSurfaceViewport;
  }): Promise<BrowserRemoteSurfaceSession> {
    const userDataDirectory = profileDirectory(
      options.dataDirectory,
      options.surfaceId,
      options.configuration.profileId,
    );
    await mkdir(userDataDirectory, { recursive: true });
    const process = launchChromium(
      options.executable,
      userDataDirectory,
      options.viewport,
    );
    try {
      const client = await CdpClient.connect(await waitForDevtoolsUrl(process));
      const { targetId } = await client.request<{ targetId: string }>(
        "Target.createTarget",
        { url: "about:blank" },
      );
      const { sessionId } = await client.request<{ sessionId: string }>(
        "Target.attachToTarget",
        { flatten: true, targetId },
      );
      const session = new BrowserRemoteSurfaceSession({
        client,
        configuration: options.configuration,
        emit: options.emit,
        process,
        sessionId,
        targetId,
      });
      await session.initialize(options.viewport);
      return session;
    } catch (error) {
      process.kill();
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
    } else if (message.type === "viewport") {
      const attachment = this.#attachments.get(attachmentId);
      if (attachment) attachment.viewport = message.viewport;
      await this.configureViewport(message.viewport);
    } else if (message.type === "pointer") {
      await this.pointer(message);
    } else if (message.type === "key") {
      await this.key(message);
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
    this.#client.close();
    if (this.#process.exitCode === null) this.#process.kill();
    this.#attachments.clear();
  }

  private async initialize(viewport: RemoteSurfaceViewport): Promise<void> {
    this.#client.on("Page.screencastFrame", (params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      const frame = params as ScreencastFrame;
      const payload = Buffer.from(frame.data, "base64");
      for (const attachmentId of this.#attachments.keys()) {
        this.#emit(attachmentId, "frame", payload);
      }
      void this.command("Page.screencastFrameAck", {
        sessionId: frame.sessionId,
      }).catch(() => undefined);
    });
    this.#client.on("Page.frameStartedLoading", (_params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      this.#loading = true;
      void this.publishState().catch(() => undefined);
    });
    this.#client.on("Page.frameStoppedLoading", (_params, sessionId) => {
      if (sessionId !== this.#sessionId) return;
      this.#loading = false;
      void this.publishState().catch(() => undefined);
      void this.captureFrame().catch(() => undefined);
    });
    for (const event of [
      "Page.frameNavigated",
      "Page.navigatedWithinDocument",
      "Page.loadEventFired",
    ]) {
      this.#client.on(event, (_params, sessionId) => {
        if (sessionId === this.#sessionId) {
          void this.publishState().catch(() => undefined);
          if (event === "Page.loadEventFired") {
            void this.captureFrame().catch(() => undefined);
          }
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
    return this.#client.request<T>(method, params, this.#sessionId);
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
    const screenshot = await this.command<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 78,
        fromSurface: true,
        captureBeyondViewport: false,
      },
    );
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

export class BrowserRemoteSurfaceAdapter implements RemoteSurfaceAdapter {
  readonly executable: string | null;

  constructor(private readonly options: BrowserAdapterOptions) {
    this.executable = options.executable ?? findChromiumExecutable();
  }

  get available(): boolean {
    return Boolean(this.executable);
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
    return BrowserRemoteSurfaceSession.open({
      configuration: command.configuration,
      dataDirectory: this.options.dataDirectory,
      emit,
      executable: this.executable,
      surfaceId: command.surfaceId,
      viewport: command.viewport,
    });
  }
}
