import os from "node:os";

import {
  remoteDesktopClientMessageSchema,
  remoteDesktopProbeResultSchema,
  remoteDesktopServerMessageSchema,
  type RemoteDesktopClientMessage,
  type RemoteDesktopProbeResult,
  type RemoteDesktopTarget,
  type RemoteDesktopTargetInventory,
  type RemoteSurfaceConfiguration,
  type RemoteSurfaceViewport,
  type DesktopStreamSettings,
} from "@cantrip/protocol";
import type {
  RemoteSurfaceAdapter,
  RemoteSurfaceAttachment,
  RemoteSurfaceSession,
} from "../remote-surface-manager.js";
import {
  assertComputerUseResult,
  computerUseResultObject,
  createDesktopAutomationClient,
  desktopClipboardText,
  desktopDisplaySize,
  desktopImageBytes,
  type DesktopAutomationClient,
  type DesktopAutomationClientFactory,
  type DesktopInputTargetOptions,
} from "./automation-client.js";
import {
  desktopShortcut,
  desktopTargetMatches,
  desktopTargetName,
} from "./desktop-input.js";
import {
  AdaptiveDesktopStreamTuner,
  createNativeDesktopFramePipeline,
  desktopApplicationAvailable,
  launchDesktopApplication,
  listNativeDesktopTargets,
  type DesktopDisplaySize,
  type DesktopRawFrame,
  type NativeDesktopFramePipeline,
} from "./desktop-frame-source.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CAPTURE_WIDTH = 1_920;
const APPLICATION_LAUNCH_TIMEOUT_MS = 12_000;
const APPLICATION_POLL_INTERVAL_MS = 250;
const DEFAULT_STREAM_SETTINGS: DesktopStreamSettings = {
  targetFps: 30,
  quality: "adaptive",
};

type DisplaySize = DesktopDisplaySize;

export type { DesktopAutomationClient } from "./automation-client.js";
export type DesktopFramePipelineFactory = (
  target?: RemoteDesktopTarget,
) => Promise<NativeDesktopFramePipeline>;
export type DesktopTargetInventoryFactory =
  () => Promise<RemoteDesktopTargetInventory>;
export type DesktopApplicationLauncher = (application: string) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class ManagedDesktopRemoteSurfaceSession implements RemoteSurfaceSession {
  configuration: Extract<RemoteSurfaceConfiguration, { kind: "desktop" }>;
  readonly transport = "websocket" as const;
  readonly #attachments = new Map<string, RemoteSurfaceAttachment>();
  #activeTarget: RemoteDesktopTarget;
  readonly #client: DesktopAutomationClient;
  #display: DisplaySize;
  readonly #emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
  readonly #createFramePipeline: DesktopFramePipelineFactory;
  readonly #launchApplication: DesktopApplicationLauncher;
  readonly #listTargets: DesktopTargetInventoryFactory;
  #framePipeline: NativeDesktopFramePipeline | null;
  readonly #streamSettings: DesktopStreamSettings;
  readonly #tuner: AdaptiveDesktopStreamTuner;
  #captureTimer: ReturnType<typeof setTimeout> | null = null;
  #capturing = false;
  #closed = false;
  #encoding = false;
  #initialized = false;
  #inputTargetError: string | null = null;
  #launchingApplication: string | null = null;
  #framesEmitted = 0;
  #lastEncodedWidth = 0;
  #nextCaptureAt = 0;
  #observedFps = 0;
  #operation = Promise.resolve<unknown>(undefined);
  #pendingFrame: DesktopRawFrame | null = null;
  #pendingTarget: {
    captureError?: unknown;
    launchMissingApplication: boolean;
    requested: RemoteDesktopTarget;
  } | null = null;
  #pipelineRevision = 0;
  #statsWindowStarted = performance.now();
  #suspended = false;
  #switchingTarget = false;
  #targetInventory: RemoteDesktopTargetInventory = {
    monitors: [],
    windows: [],
  };
  #targetMessage: string | null = null;

  constructor(options: {
    client: DesktopAutomationClient;
    configuration: Extract<RemoteSurfaceConfiguration, { kind: "desktop" }>;
    createFramePipeline: DesktopFramePipelineFactory;
    display: DisplaySize;
    emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    framePipeline: NativeDesktopFramePipeline | null;
    launchApplication: DesktopApplicationLauncher;
    listTargets: DesktopTargetInventoryFactory;
    streamSettings: DesktopStreamSettings;
  }) {
    this.#client = options.client;
    this.configuration = options.configuration;
    this.#activeTarget = options.configuration.target;
    this.#createFramePipeline = options.createFramePipeline;
    this.#display = options.display;
    this.#emit = options.emit;
    this.#framePipeline = options.framePipeline;
    this.#launchApplication = options.launchApplication;
    this.#listTargets = options.listTargets;
    this.#streamSettings = options.streamSettings;
    this.#tuner = new AdaptiveDesktopStreamTuner(options.streamSettings);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    await this.switchTarget(this.configuration.target, true);
  }

  async attach(attachment: RemoteSurfaceAttachment): Promise<void> {
    this.#attachments.set(attachment.id, attachment);
    await this.initialize();
    this.publishState(attachment.id, "ready", null);
    await this.refreshTargets(attachment.id);
    this.scheduleCapture(0);
  }

  async updateConfiguration(
    configuration: RemoteSurfaceConfiguration,
  ): Promise<void> {
    if (configuration.kind !== "desktop") {
      throw new Error("Managed desktop configuration kind cannot change.");
    }
    if (
      JSON.stringify(configuration.target) ===
      JSON.stringify(this.configuration.target)
    ) {
      return;
    }
    this.configuration = configuration;
    await this.switchTarget(configuration.target, true);
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
    if (message.type === "refresh-targets") {
      await this.refreshTargets(attachmentId, true);
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
    this.publishState(
      undefined,
      this.#inputTargetError ? "error" : "ready",
      this.#inputTargetError,
    );
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
      this.#switchingTarget ||
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
      this.#capturing ||
      this.#switchingTarget
    )
      return;
    this.#capturing = true;
    const startedAt = performance.now();
    try {
      const pipeline = this.#framePipeline;
      const revision = this.#pipelineRevision;
      if (pipeline) {
        const frame = await pipeline.capture();
        if (
          pipeline === this.#framePipeline &&
          revision === this.#pipelineRevision
        ) {
          this.#display = { width: frame.width, height: frame.height };
          this.queueFrame(frame);
        }
      } else {
        await this.captureCompatibilityFrame();
      }
    } catch (error) {
      if (this.configuration.target.kind === "window") {
        await this.switchTarget(this.configuration.target, true, error);
      } else if (this.#framePipeline) {
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
    const revision = this.#pipelineRevision;
    this.#encoding = true;
    try {
      const encoding = this.#tuner.encoding(this.requestedWidth(), frame.width);
      const payload = await pipeline.encode(frame, encoding);
      if (
        pipeline !== this.#framePipeline ||
        revision !== this.#pipelineRevision
      ) {
        return;
      }
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
      desktopImageBytes(
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
      this.publishState(
        undefined,
        this.#inputTargetError ? "error" : "ready",
        this.#inputTargetError,
      );
    }
  }

  private async refreshTargets(
    attachmentId?: string,
    restoreRequested = false,
  ): Promise<void> {
    try {
      this.#targetInventory = await this.#listTargets();
      if (
        restoreRequested &&
        !desktopTargetMatches(this.configuration.target, this.#activeTarget)
      ) {
        await this.switchTarget(this.configuration.target, true);
        return;
      }
      this.publishTargets(attachmentId);
    } catch (error) {
      this.#targetMessage = `Could not refresh desktop targets: ${errorMessage(error)}`;
      this.publishTargets(attachmentId);
    }
  }

  private async switchTarget(
    requested: RemoteDesktopTarget,
    launchMissingApplication: boolean,
    captureError?: unknown,
  ): Promise<void> {
    if (this.#closed) return;
    if (this.#switchingTarget) {
      this.#pendingTarget = {
        requested,
        launchMissingApplication,
        captureError,
      };
      return;
    }
    this.#switchingTarget = true;
    this.clearCaptureTimer();
    this.#pendingFrame = null;
    try {
      this.#targetInventory = await this.#listTargets();
      if (
        requested.kind === "window" &&
        launchMissingApplication &&
        !desktopApplicationAvailable(
          requested.application,
          this.#targetInventory,
        )
      ) {
        this.#launchingApplication = requested.application;
        this.#targetMessage = `Launching ${requested.application} on the worker…`;
        this.publishState(undefined, "launching", this.#targetMessage);
        this.publishTargets();
        try {
          await this.#launchApplication(requested.application);
          const deadline = Date.now() + APPLICATION_LAUNCH_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await wait(APPLICATION_POLL_INTERVAL_MS);
            this.#targetInventory = await this.#listTargets();
            if (
              desktopApplicationAvailable(
                requested.application,
                this.#targetInventory,
              )
            ) {
              break;
            }
          }
        } catch (error) {
          this.#targetMessage = `Could not launch ${requested.application}: ${errorMessage(error)}`;
        } finally {
          this.#launchingApplication = null;
        }
      }

      const pipeline = await this.#createFramePipeline(requested);
      this.#framePipeline = pipeline;
      this.#pipelineRevision += 1;
      this.#activeTarget = pipeline.target;
      this.#display = pipeline.display;
      this.#lastEncodedWidth = 0;
      this.#inputTargetError = null;
      if (desktopTargetMatches(requested, pipeline.target)) {
        this.#targetMessage = captureError
          ? `Reconnected to ${desktopTargetName(pipeline.target)} after capture stopped.`
          : null;
      } else {
        this.#targetMessage = `${desktopTargetName(requested)} is unavailable; showing ${desktopTargetName(pipeline.target)}.`;
      }
      if (pipeline.target.kind === "window") {
        try {
          await this.focusInputTarget();
        } catch (error) {
          this.#inputTargetError = `Could not focus ${desktopTargetName(pipeline.target)}; remote input is paused: ${errorMessage(error)}`;
        }
      }
      this.publishState(
        undefined,
        this.#inputTargetError ? "error" : "ready",
        this.#inputTargetError ?? this.#targetMessage,
      );
      await this.refreshTargets();
    } catch (error) {
      this.#framePipeline = null;
      this.#pipelineRevision += 1;
      this.#activeTarget = { kind: "monitor", id: null, name: null };
      this.#inputTargetError = null;
      this.#targetMessage = `Desktop target unavailable; showing the default display: ${errorMessage(error)}`;
      this.publishState(undefined, "ready", this.#targetMessage);
      this.publishTargets();
    } finally {
      this.#switchingTarget = false;
      const pending = this.#pendingTarget;
      this.#pendingTarget = null;
      if (pending) {
        await this.switchTarget(
          pending.requested,
          pending.launchMissingApplication,
          pending.captureError,
        );
      } else {
        this.scheduleCapture(0);
      }
    }
  }

  private useCompatibilityBackend(error: unknown): void {
    this.#framePipeline = null;
    this.#pipelineRevision += 1;
    this.#pendingFrame = null;
    this.#activeTarget = { kind: "monitor", id: null, name: null };
    this.#inputTargetError = null;
    this.#targetMessage = `Native capture stopped; showing the default display through compatibility capture: ${errorMessage(error)}`;
    this.publishState(undefined, "ready", this.#targetMessage);
    this.publishTargets();
  }

  private publishTargets(attachmentId?: string): void {
    const payload = encoder.encode(
      JSON.stringify(
        remoteDesktopServerMessageSchema.parse({
          type: "desktop-targets",
          inventory: this.#targetInventory,
          requested: this.configuration.target,
          active: this.#activeTarget,
          launchingApplication: this.#launchingApplication,
          message: this.#targetMessage,
        }),
      ),
    );
    const recipients = attachmentId
      ? [attachmentId]
      : [...this.#attachments.keys()];
    for (const recipient of recipients) {
      if (this.#attachments.has(recipient)) {
        this.#emit(recipient, "control", payload);
      }
    }
  }

  private publishState(
    attachmentId: string | undefined,
    status: "ready" | "launching" | "suspended" | "error",
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
      if (message.event !== "move") await this.focusInputTarget();
      const localX = Math.max(
        0,
        Math.min(this.#display.width - 1, Math.round(message.x)),
      );
      const localY = Math.max(
        0,
        Math.min(this.#display.height - 1, Math.round(message.y)),
      );
      const origin = this.#framePipeline?.origin ?? { x: 0, y: 0 };
      const x = localX + origin.x;
      const y = localY + origin.y;
      const inputTarget = this.inputTargetOptions();
      if (message.event === "move") {
        assertComputerUseResult(
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
        assertComputerUseResult(
          await this.#client.scroll(
            x,
            y,
            direction,
            amount,
            undefined,
            inputTarget,
          ),
          "Scrolling the desktop",
        );
      } else if (message.button === "right" && message.event === "up") {
        assertComputerUseResult(
          await this.#client.rightClick(x, y, undefined, inputTarget),
          "Right-clicking the desktop",
        );
      } else if (message.button === "middle" && message.event === "up") {
        assertComputerUseResult(
          await this.#client.middleClick(x, y, undefined, inputTarget),
          "Middle-clicking the desktop",
        );
      } else if (message.button === "left" && message.event === "down") {
        assertComputerUseResult(
          await this.#client.mouseDown(x, y, undefined, inputTarget),
          "Pressing the desktop pointer",
        );
      } else if (message.button === "left" && message.event === "up") {
        assertComputerUseResult(
          await this.#client.mouseUp(x, y, undefined, inputTarget),
          "Releasing the desktop pointer",
        );
      }
      this.scheduleCapture(0);
      return;
    }
    if (message.type === "key") {
      if (message.event === "up") return;
      await this.focusInputTarget();
      const inputTarget = this.inputTargetOptions();
      if (message.text && (message.modifiers & 7) === 0) {
        assertComputerUseResult(
          await this.#client.type(message.text, undefined, inputTarget),
          "Typing on the desktop",
        );
      } else {
        assertComputerUseResult(
          await this.#client.key(
            desktopShortcut(message),
            undefined,
            inputTarget,
          ),
          "Sending a desktop key",
        );
      }
      this.scheduleCapture(0);
      return;
    }
    if (message.type === "clipboard") {
      await this.focusInputTarget();
      const inputTarget = this.inputTargetOptions();
      if (message.operation === "paste-text") {
        if (message.text) {
          assertComputerUseResult(
            await this.#client.type(message.text, undefined, inputTarget),
            "Pasting on the desktop",
          );
        }
      } else {
        assertComputerUseResult(
          await this.#client.key(
            process.platform === "darwin" ? "command+c" : "ctrl+c",
            undefined,
            inputTarget,
          ),
          "Copying from the desktop",
        );
        await new Promise((resolve) => setTimeout(resolve, 60));
        const text = desktopClipboardText(await this.#client.readClipboard());
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

  private async focusInputTarget(): Promise<void> {
    const pipeline = this.#framePipeline;
    if (!pipeline || pipeline.target.kind !== "window") return;
    try {
      const windowId = Number(pipeline.target.id);
      if (!Number.isSafeInteger(windowId) || windowId < 0) {
        throw new Error("The selected window has an invalid native ID.");
      }
      const result = await this.#client.activateWindow(windowId, 2_000);
      assertComputerUseResult(result, "Focusing the selected window");
      const activation = computerUseResultObject(result);
      if (activation?.activated !== true) {
        const reason =
          typeof activation?.reason === "string"
            ? `: ${activation.reason.replaceAll("_", " ")}`
            : "";
        throw new Error(
          `The operating system refused window activation${reason}.`,
        );
      }
      if (this.#inputTargetError) {
        this.#inputTargetError = null;
        this.publishState(undefined, "ready", this.#targetMessage);
      }
    } catch (error) {
      this.#inputTargetError = `Could not focus ${desktopTargetName(pipeline.target)}; input was not sent: ${errorMessage(error)}`;
      this.publishState(undefined, "error", this.#inputTargetError);
      throw new Error(this.#inputTargetError);
    }
  }

  private inputTargetOptions(): DesktopInputTargetOptions | undefined {
    const target = this.#framePipeline?.target;
    if (!target || target.kind !== "window") return undefined;
    const targetWindowId = Number(target.id);
    if (!Number.isSafeInteger(targetWindowId) || targetWindowId < 0) {
      return undefined;
    }
    return { focusStrategy: "strict", targetWindowId };
  }
}

export class ManagedDesktopRemoteSurfaceAdapter implements RemoteSurfaceAdapter {
  #available = false;
  #client: DesktopAutomationClient | null = null;
  #nativeCaptureAvailable = false;
  #initializationError: string | null = null;

  constructor(
    private readonly createClient: DesktopAutomationClientFactory = createDesktopAutomationClient,
    private readonly createFramePipeline: DesktopFramePipelineFactory = createNativeDesktopFramePipeline,
    private readonly listTargets: DesktopTargetInventoryFactory = listNativeDesktopTargets,
    private readonly launchApplication: DesktopApplicationLauncher = launchDesktopApplication,
  ) {}

  get available(): boolean {
    return this.#available;
  }

  get initializationError(): string | null {
    return this.#initializationError;
  }

  get frameBackend(): "native" | "compatibility" {
    return this.#nativeCaptureAvailable ? "native" : "compatibility";
  }

  async initialize(): Promise<void> {
    if (!(["darwin", "linux", "win32"] as string[]).includes(os.platform())) {
      this.#initializationError = `Managed desktop capture is not supported on ${os.platform()}.`;
      return;
    }
    try {
      desktopDisplaySize(await (await this.client()).getDisplaySize());
      try {
        const pipeline = await this.createFramePipeline();
        if (pipeline.display.width <= 0 || pipeline.display.height <= 0) {
          throw new Error("Native desktop capture returned an invalid size.");
        }
        this.#nativeCaptureAvailable = true;
      } catch {
        this.#nativeCaptureAvailable = false;
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
    // Initialization already verifies both the automation client and a frame
    // backend. Repeating a capture here can block for the operating system's
    // full screen-capture timeout (30 seconds on macOS when permission state is
    // changing), which makes the server reject an otherwise healthy worker.
    // Live capture errors are reported by the attached surface session instead.
    return remoteDesktopProbeResultSchema.parse({
      available: this.#available,
      message: this.#available
        ? null
        : (this.#initializationError ??
          "Managed desktop capture is unavailable."),
    });
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
    const display = desktopDisplaySize(await client.getDisplaySize());
    return new ManagedDesktopRemoteSurfaceSession({
      client,
      configuration: command.configuration,
      createFramePipeline: this.createFramePipeline,
      display,
      emit,
      framePipeline: null,
      launchApplication: this.launchApplication,
      listTargets: this.listTargets,
      streamSettings: command.desktopStream ?? DEFAULT_STREAM_SETTINGS,
    });
  }

  async shutdown(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#nativeCaptureAvailable = false;
    await client?.close().catch(() => undefined);
  }

  private async client(): Promise<DesktopAutomationClient> {
    if (!this.#client) this.#client = await this.createClient();
    return this.#client;
  }
}
