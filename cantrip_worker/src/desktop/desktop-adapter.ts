import os from "node:os";

import {
  remoteDesktopClientMessageSchema,
  remoteDesktopProbeResultSchema,
  remoteDesktopServerMessageSchema,
  type RemoteDesktopClientMessage,
  type RemoteDesktopProbeResult,
  type RemoteSurfaceConfiguration,
  type RemoteSurfaceViewport,
  type DesktopStreamSettings,
} from "@cantrip/protocol";
import type {
  ComputerUseClient,
  ToolResult,
} from "@zavora-ai/computer-use-mcp/client";

import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceAttachment,
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
import {
  AdaptiveDesktopStreamTuner,
  createNativeDesktopFramePipeline,
  type DesktopDisplaySize,
  type DesktopRawFrame,
  type NativeDesktopFramePipeline,
} from "./desktop-frame-source.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CAPTURE_WIDTH = 1_920;
const DEFAULT_STREAM_SETTINGS: DesktopStreamSettings = {
  targetFps: 30,
  quality: "adaptive",
};

type DisplaySize = DesktopDisplaySize;

export interface DesktopAutomationClient {
  click(x: number, y: number): Promise<ToolResult>;
  close(): Promise<void>;
  doubleClick(x: number, y: number): Promise<ToolResult>;
  getDisplaySize(): Promise<ToolResult>;
  key(combo: string): Promise<ToolResult>;
  middleClick(x: number, y: number): Promise<ToolResult>;
  mouseDown(x: number, y: number): Promise<ToolResult>;
  mouseUp(x: number, y: number): Promise<ToolResult>;
  moveMouse(x: number, y: number): Promise<ToolResult>;
  readClipboard(): Promise<ToolResult>;
  rightClick(x: number, y: number): Promise<ToolResult>;
  screenshot(options: { quality: number; width: number }): Promise<ToolResult>;
  scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<ToolResult>;
  type(text: string): Promise<ToolResult>;
}

export type DesktopAutomationClientFactory =
  () => Promise<DesktopAutomationClient>;
export type DesktopFramePipelineFactory =
  () => Promise<NativeDesktopFramePipeline>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultText(result: ToolResult): string | null {
  return result.content.find((item) => item.type === "text")?.text ?? null;
}

function assertResult(result: ToolResult, operation: string): void {
  if (!result.isError) return;
  throw new Error(resultText(result) ?? `${operation} failed.`);
}

function structuredObject(result: ToolResult): Record<string, unknown> | null {
  if (result.structuredContent) return result.structuredContent;
  const text = resultText(result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function displaySize(result: ToolResult): DisplaySize {
  assertResult(result, "Reading the desktop size");
  const value = structuredObject(result);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error("The worker returned an invalid desktop size.");
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function imageBytes(result: ToolResult): Uint8Array {
  assertResult(result, "Capturing the desktop");
  const image = result.content.find((item) => item.type === "image");
  if (!image || image.type !== "image") {
    throw new Error(
      resultText(result) ?? "The worker did not return a desktop frame.",
    );
  }
  return Buffer.from(image.data, "base64");
}

function clipboardText(result: ToolResult): string {
  assertResult(result, "Reading the desktop clipboard");
  return resultText(result) ?? "";
}

function modifierNames(modifiers: number): string[] {
  return [
    ...(modifiers & 2 ? ["ctrl"] : []),
    ...(modifiers & 1
      ? [process.platform === "darwin" ? "option" : "alt"]
      : []),
    ...(modifiers & 8 ? ["shift"] : []),
    ...(modifiers & 4
      ? [process.platform === "darwin" ? "command" : "win"]
      : []),
  ];
}

function normalizedKey(key: string): string {
  const names: Record<string, string> = {
    " ": "space",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    Backspace: "backspace",
    Delete: "delete",
    End: "end",
    Enter: "return",
    Escape: "escape",
    Home: "home",
    PageDown: "pagedown",
    PageUp: "pageup",
    Tab: "tab",
  };
  return names[key] ?? key.toLowerCase();
}

function shortcut(
  message: Extract<RemoteDesktopClientMessage, { type: "key" }>,
): string {
  return [...modifierNames(message.modifiers), normalizedKey(message.key)].join(
    "+",
  );
}

async function defaultClientFactory(): Promise<DesktopAutomationClient> {
  const [{ createComputerUseServer }, { connectInProcess }] = await Promise.all(
    [
      import("@zavora-ai/computer-use-mcp"),
      import("@zavora-ai/computer-use-mcp/client"),
    ],
  );
  // Cantrip's authenticated Remote Surface is the approval boundary. The
  // desktop backend must not write a second log containing user input.
  const previousAuditSetting = process.env.COMPUTER_USE_AUDIT_LOG;
  process.env.COMPUTER_USE_AUDIT_LOG = "false";
  try {
    return (await connectInProcess(
      createComputerUseServer({
        elicitApproval: async () => true,
        profile: "full",
      }),
    )) as ComputerUseClient;
  } finally {
    if (previousAuditSetting === undefined) {
      delete process.env.COMPUTER_USE_AUDIT_LOG;
    } else {
      process.env.COMPUTER_USE_AUDIT_LOG = previousAuditSetting;
    }
  }
}

class ManagedDesktopRemoteSurfaceSession implements RemoteSurfaceSession {
  readonly configuration: Extract<
    RemoteSurfaceConfiguration,
    { kind: "desktop" }
  >;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  readonly #client: DesktopAutomationClient;
  readonly #display: DisplaySize;
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  #framePipeline: NativeDesktopFramePipeline | null;
  readonly #streamSettings: DesktopStreamSettings;
  readonly #tuner: AdaptiveDesktopStreamTuner;
  #captureTimer: ReturnType<typeof setTimeout> | null = null;
  #capturing = false;
  #closed = false;
  #encoding = false;
  #framesEmitted = 0;
  #lastEncodedWidth = 0;
  #nextCaptureAt = 0;
  #observedFps = 0;
  #operation = Promise.resolve<unknown>(undefined);
  #pendingFrame: DesktopRawFrame | null = null;
  #statsWindowStarted = performance.now();
  #suspended = false;

  constructor(options: {
    client: DesktopAutomationClient;
    configuration: Extract<RemoteSurfaceConfiguration, { kind: "desktop" }>;
    display: DisplaySize;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    framePipeline: NativeDesktopFramePipeline | null;
    streamSettings: DesktopStreamSettings;
  }) {
    this.#client = options.client;
    this.configuration = options.configuration;
    this.#display = options.display;
    this.#emit = options.emit;
    this.#framePipeline = options.framePipeline;
    this.#streamSettings = options.streamSettings;
    this.#tuner = new AdaptiveDesktopStreamTuner(options.streamSettings);
  }

  attach(attachment: RemoteSurfaceAttachment): void {
    this.#attachments.set(attachment.id, attachment);
    this.publishState(attachment.id, "ready", null);
    this.scheduleCapture(0);
  }

  detach(attachmentId: string): void {
    this.#attachments.delete(attachmentId);
    if (this.#attachments.size === 0) this.clearCaptureTimer();
  }

  async handleFrame(
    attachmentId: string,
    channel: Parameters<RemoteSurfaceSession["handleFrame"]>[1],
    payload: Uint8Array,
  ): Promise<void> {
    if (channel !== "control" || !this.#attachments.has(attachmentId)) return;
    const message = remoteDesktopClientMessageSchema.parse(
      JSON.parse(decoder.decode(payload)),
    );
    if (message.type === "viewport") {
      const attachment = this.#attachments.get(attachmentId);
      if (attachment) attachment.viewport = message.viewport;
      this.scheduleCapture(0);
      return;
    }
    if (message.type === "stream-feedback") {
      this.#tuner.recordFeedback(message);
      return;
    }
    await this.enqueue(() => this.applyInput(attachmentId, message));
  }

  suspend(): void {
    this.#suspended = true;
    this.clearCaptureTimer();
    this.#pendingFrame = null;
    this.#nextCaptureAt = 0;
    this.publishState(undefined, "suspended", null);
  }

  resume(): void {
    this.#suspended = false;
    this.#nextCaptureAt = 0;
    this.publishState(undefined, "ready", null);
    this.scheduleCapture(0);
  }

  close(): void {
    this.#closed = true;
    this.clearCaptureTimer();
    this.#pendingFrame = null;
    this.#attachments.clear();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#operation.then(operation, operation);
    this.#operation = next.catch(() => undefined);
    return next;
  }

  private scheduleCapture(delay = 0): void {
    if (
      this.#closed ||
      this.#suspended ||
      this.#attachments.size === 0 ||
      this.#capturing ||
      this.#captureTimer
    ) {
      return;
    }
    this.#captureTimer = setTimeout(() => {
      this.#captureTimer = null;
      void this.capture();
    }, delay);
  }

  private clearCaptureTimer(): void {
    if (this.#captureTimer) clearTimeout(this.#captureTimer);
    this.#captureTimer = null;
  }

  private async capture(): Promise<void> {
    if (
      this.#closed ||
      this.#suspended ||
      this.#attachments.size === 0 ||
      this.#capturing
    )
      return;
    this.#capturing = true;
    const startedAt = performance.now();
    try {
      if (this.#framePipeline) {
        this.queueFrame(await this.#framePipeline.capture());
      } else {
        await this.captureCompatibilityFrame();
      }
    } catch (error) {
      if (this.#framePipeline) {
        this.useCompatibilityBackend(error);
      } else {
        this.publishState(undefined, "error", errorMessage(error));
      }
    } finally {
      this.#capturing = false;
      const interval = 1_000 / this.#streamSettings.targetFps;
      if (!this.#nextCaptureAt) this.#nextCaptureAt = startedAt;
      this.#nextCaptureAt += interval;
      if (this.#nextCaptureAt < performance.now()) {
        this.#nextCaptureAt = performance.now();
      }
      this.scheduleCapture(
        Math.max(0, Math.round(this.#nextCaptureAt - performance.now())),
      );
    }
  }

  private requestedWidth(): number {
    return Math.min(
      MAX_CAPTURE_WIDTH,
      Math.max(
        640,
        ...[...this.#attachments.values()].map((attachment) =>
          Math.round(
            attachment.viewport.width * attachment.viewport.devicePixelRatio,
          ),
        ),
      ),
    );
  }

  private queueFrame(frame: DesktopRawFrame): void {
    if (this.#closed || this.#suspended) return;
    if (this.#encoding) {
      this.#pendingFrame = frame;
      return;
    }
    void this.encodeFrame(frame);
  }

  private async encodeFrame(frame: DesktopRawFrame): Promise<void> {
    const pipeline = this.#framePipeline;
    if (!pipeline || this.#closed || this.#suspended) return;
    this.#encoding = true;
    try {
      const encoding = this.#tuner.encoding(this.requestedWidth(), frame.width);
      const payload = await pipeline.encode(frame, encoding);
      this.#lastEncodedWidth = encoding.width;
      this.publishFrame(payload);
    } catch (error) {
      this.useCompatibilityBackend(error);
    } finally {
      this.#encoding = false;
      const pending = this.#pendingFrame;
      this.#pendingFrame = null;
      if (pending && !this.#closed && !this.#suspended) {
        void this.encodeFrame(pending);
      }
    }
  }

  private async captureCompatibilityFrame(): Promise<void> {
    const encoding = this.#tuner.encoding(
      this.requestedWidth(),
      this.#display.width,
    );
    const payload = await this.enqueue(async () =>
      imageBytes(
        await this.#client.screenshot({
          quality: encoding.quality,
          width: encoding.width,
        }),
      ),
    );
    this.#lastEncodedWidth = encoding.width;
    this.publishFrame(payload);
  }

  private publishFrame(payload: Uint8Array): void {
    if (this.#closed || this.#suspended) return;
    let accepted = true;
    for (const attachmentId of this.#attachments.keys()) {
      accepted = this.#emit(attachmentId, "frame", payload) && accepted;
    }
    this.#tuner.recordFrame(payload.byteLength, accepted);
    this.#framesEmitted += 1;
    const now = performance.now();
    const elapsed = now - this.#statsWindowStarted;
    if (elapsed >= 1_000) {
      this.#observedFps = (this.#framesEmitted * 1_000) / elapsed;
      this.#framesEmitted = 0;
      this.#statsWindowStarted = now;
      this.publishState(undefined, "ready", null);
    }
  }

  private useCompatibilityBackend(error: unknown): void {
    this.#framePipeline = null;
    this.#pendingFrame = null;
    this.publishState(
      undefined,
      "ready",
      `Native capture stopped; using compatibility capture: ${errorMessage(error)}`,
    );
  }

  private publishState(
    attachmentId: string | undefined,
    status: "ready" | "suspended" | "error",
    message: string | null,
  ): void {
    const payload = encoder.encode(
      JSON.stringify(
        remoteDesktopServerMessageSchema.parse({
          type: "desktop-state",
          width: this.#display.width,
          height: this.#display.height,
          status,
          message: message?.slice(0, 2_048) ?? null,
          stream: {
            backend: this.#framePipeline ? "native" : "compatibility",
            targetFps: this.#streamSettings.targetFps,
            observedFps: this.#observedFps,
            quality: this.#tuner.quality,
            encodedWidth:
              this.#lastEncodedWidth ||
              Math.min(this.#display.width, MAX_CAPTURE_WIDTH),
          },
        }),
      ),
    );
    const recipients = attachmentId
      ? [attachmentId]
      : [...this.#attachments.keys()];
    for (const recipient of recipients) {
      if (this.#attachments.has(recipient))
        this.#emit(recipient, "control", payload);
    }
  }

  private async applyInput(
    attachmentId: string,
    message: Exclude<
      RemoteDesktopClientMessage,
      { type: "stream-feedback" | "viewport" }
    >,
  ): Promise<void> {
    if (message.type === "pointer") {
      const x = Math.max(
        0,
        Math.min(this.#display.width - 1, Math.round(message.x)),
      );
      const y = Math.max(
        0,
        Math.min(this.#display.height - 1, Math.round(message.y)),
      );
      if (message.event === "move") {
        assertResult(
          await this.#client.moveMouse(x, y),
          "Moving the desktop pointer",
        );
      } else if (message.event === "wheel") {
        const horizontal = Math.abs(message.deltaX) > Math.abs(message.deltaY);
        const delta = horizontal ? message.deltaX : message.deltaY;
        const direction = horizontal
          ? delta < 0
            ? "left"
            : "right"
          : delta < 0
            ? "up"
            : "down";
        const amount = Math.max(
          1,
          Math.min(20, Math.ceil(Math.abs(delta) / 40)),
        );
        assertResult(
          await this.#client.scroll(x, y, direction, amount),
          "Scrolling the desktop",
        );
      } else if (message.button === "right" && message.event === "up") {
        assertResult(
          await this.#client.rightClick(x, y),
          "Right-clicking the desktop",
        );
      } else if (message.button === "middle" && message.event === "up") {
        assertResult(
          await this.#client.middleClick(x, y),
          "Middle-clicking the desktop",
        );
      } else if (message.button === "left" && message.event === "down") {
        assertResult(
          await this.#client.mouseDown(x, y),
          "Pressing the desktop pointer",
        );
      } else if (message.button === "left" && message.event === "up") {
        assertResult(
          await this.#client.mouseUp(x, y),
          "Releasing the desktop pointer",
        );
      }
      this.scheduleCapture(0);
      return;
    }
    if (message.type === "key") {
      if (message.event === "up") return;
      if (message.text && (message.modifiers & 7) === 0) {
        assertResult(
          await this.#client.type(message.text),
          "Typing on the desktop",
        );
      } else {
        assertResult(
          await this.#client.key(shortcut(message)),
          "Sending a desktop key",
        );
      }
      this.scheduleCapture(0);
      return;
    }
    if (message.type === "clipboard") {
      if (message.operation === "paste-text") {
        if (message.text) {
          assertResult(
            await this.#client.type(message.text),
            "Pasting on the desktop",
          );
        }
      } else {
        assertResult(
          await this.#client.key(
            process.platform === "darwin" ? "command+c" : "ctrl+c",
          ),
          "Copying from the desktop",
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        const text = clipboardText(await this.#client.readClipboard());
        this.#emit(
          attachmentId,
          "clipboard",
          encoder.encode(
            JSON.stringify(
              remoteDesktopServerMessageSchema.parse({
                type: "desktop-clipboard",
                text,
              }),
            ),
          ),
        );
      }
      this.scheduleCapture(0);
      return;
    }
  }
}

export class ManagedDesktopRemoteSurfaceAdapter implements RemoteSurfaceAdapter {
  #available = false;
  #client: DesktopAutomationClient | null = null;
  #framePipeline: NativeDesktopFramePipeline | null = null;
  #initializationError: string | null = null;

  constructor(
    private readonly createClient: DesktopAutomationClientFactory = defaultClientFactory,
    private readonly createFramePipeline: DesktopFramePipelineFactory = createNativeDesktopFramePipeline,
  ) {}

  get available(): boolean {
    return this.#available;
  }

  get initializationError(): string | null {
    return this.#initializationError;
  }

  get frameBackend(): "native" | "compatibility" {
    return this.#framePipeline ? "native" : "compatibility";
  }

  async initialize(): Promise<void> {
    if (!(["darwin", "linux", "win32"] as string[]).includes(os.platform())) {
      this.#initializationError = `Managed desktop capture is not supported on ${os.platform()}.`;
      return;
    }
    try {
      displaySize(await (await this.client()).getDisplaySize());
      try {
        const pipeline = await this.createFramePipeline();
        const frame = await pipeline.capture();
        await pipeline.encode(frame, {
          quality: 40,
          width: Math.min(320, frame.width),
        });
        this.#framePipeline = pipeline;
      } catch {
        this.#framePipeline = null;
      }
      this.#available = true;
      this.#initializationError = null;
    } catch (error) {
      this.#available = false;
      this.#initializationError = errorMessage(error);
      await this.shutdown();
    }
  }

  async probe(): Promise<RemoteDesktopProbeResult> {
    if (!this.#available) {
      return remoteDesktopProbeResultSchema.parse({
        available: false,
        message:
          this.#initializationError ??
          "Managed desktop capture is unavailable.",
      });
    }
    try {
      if (this.#framePipeline) {
        try {
          const frame = await this.#framePipeline.capture();
          await this.#framePipeline.encode(frame, {
            quality: 40,
            width: Math.min(320, frame.width),
          });
          return remoteDesktopProbeResultSchema.parse({
            available: true,
            message: null,
          });
        } catch {
          this.#framePipeline = null;
        }
      }
      imageBytes(
        await (await this.client()).screenshot({ quality: 60, width: 320 }),
      );
      return remoteDesktopProbeResultSchema.parse({
        available: true,
        message: null,
      });
    } catch (error) {
      return remoteDesktopProbeResultSchema.parse({
        available: false,
        message: errorMessage(error),
      });
    }
  }

  async open(
    command: Parameters<RemoteSurfaceAdapter["open"]>[0],
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1],
  ): Promise<RemoteSurfaceSession> {
    if (command.configuration.kind !== "desktop") {
      throw new Error(
        "Managed desktop adapter requires desktop configuration.",
      );
    }
    if (!this.#available) {
      throw new Error(
        this.#initializationError ?? "Managed desktop capture is unavailable.",
      );
    }
    const client = await this.client();
    const display =
      this.#framePipeline?.display ??
      displaySize(await client.getDisplaySize());
    return new ManagedDesktopRemoteSurfaceSession({
      client,
      configuration: command.configuration,
      display,
      emit,
      framePipeline: this.#framePipeline,
      streamSettings: command.desktopStream ?? DEFAULT_STREAM_SETTINGS,
    });
  }

  async shutdown(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#framePipeline = null;
    await client?.close().catch(() => undefined);
  }

  private async client(): Promise<DesktopAutomationClient> {
    if (!this.#client) this.#client = await this.createClient();
    return this.#client;
  }
}
