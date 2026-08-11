import { spawn } from "node:child_process";

import {
  remoteDesktopTargetInventorySchema,
  type DesktopStreamSettings,
  type RemoteDesktopMonitor,
  type RemoteDesktopTarget,
  type RemoteDesktopTargetInventory,
  type RemoteDesktopWindow,
} from "@cantrip/protocol";

export interface DesktopDisplaySize {
  height: number;
  width: number;
}

export interface DesktopDisplayOrigin {
  x: number;
  y: number;
}

export interface DesktopRawFrame extends DesktopDisplaySize {
  rgba: Uint8Array;
}

export interface DesktopFrameEncoding {
  quality: number;
  width: number;
}

export interface NativeDesktopFramePipeline {
  readonly backend: "native";
  readonly display: DesktopDisplaySize;
  readonly origin: DesktopDisplayOrigin;
  readonly target: RemoteDesktopTarget;
  capture(): Promise<DesktopRawFrame>;
  encode(
    frame: DesktopRawFrame,
    options: DesktopFrameEncoding,
  ): Promise<Uint8Array>;
}

const DEFAULT_DESKTOP_TARGET: RemoteDesktopTarget = {
  kind: "monitor",
  id: null,
  name: null,
};

function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

export function desktopApplicationAvailable(
  application: string,
  inventory: RemoteDesktopTargetInventory,
): boolean {
  return inventory.windows.some((window) =>
    sameText(window.application, application),
  );
}

export function resolveDesktopTarget(
  requested: RemoteDesktopTarget,
  inventory: RemoteDesktopTargetInventory,
): RemoteDesktopMonitor | RemoteDesktopWindow | null {
  if (requested.kind === "window") {
    const applicationWindows = inventory.windows.filter((window) =>
      sameText(window.application, requested.application),
    );
    return (
      (requested.id
        ? applicationWindows.find((window) => window.id === requested.id)
        : undefined) ??
      (requested.title
        ? applicationWindows.find((window) =>
            sameText(window.title, requested.title!),
          )
        : undefined) ??
      applicationWindows[0] ??
      inventory.monitors.find((monitor) => monitor.primary) ??
      inventory.monitors[0] ??
      null
    );
  }
  return (
    (requested.id
      ? inventory.monitors.find((monitor) => monitor.id === requested.id)
      : undefined) ??
    (requested.name
      ? inventory.monitors.find((monitor) =>
          sameText(monitor.name, requested.name!),
        )
      : undefined) ??
    inventory.monitors.find((monitor) => monitor.primary) ??
    inventory.monitors[0] ??
    null
  );
}

interface StreamProfile {
  initialQuality: number;
  maxQuality: number;
  minQuality: number;
  minScale: number;
  targetBitsPerSecond: number;
}

const STREAM_PROFILES: Record<DesktopStreamSettings["quality"], StreamProfile> =
  {
    adaptive: {
      initialQuality: 62,
      maxQuality: 78,
      minQuality: 28,
      minScale: 0.55,
      targetBitsPerSecond: 16_000_000,
    },
    "data-saver": {
      initialQuality: 40,
      maxQuality: 52,
      minQuality: 24,
      minScale: 0.4,
      targetBitsPerSecond: 4_000_000,
    },
    balanced: {
      initialQuality: 58,
      maxQuality: 70,
      minQuality: 34,
      minScale: 0.6,
      targetBitsPerSecond: 10_000_000,
    },
    sharp: {
      initialQuality: 78,
      maxQuality: 86,
      minQuality: 52,
      minScale: 0.8,
      targetBitsPerSecond: 30_000_000,
    },
  };

export class AdaptiveDesktopStreamTuner {
  readonly #profile: StreamProfile;
  readonly #targetFps: number;
  #averageBitsPerSecond = 0;
  #quality: number;
  #scale = 1;

  constructor(settings: DesktopStreamSettings) {
    this.#profile = STREAM_PROFILES[settings.quality];
    this.#targetFps = settings.targetFps;
    this.#quality = this.#profile.initialQuality;
  }

  get quality(): number {
    return this.#quality;
  }

  encoding(requestedWidth: number, displayWidth: number): DesktopFrameEncoding {
    return {
      quality: this.#quality,
      width: Math.max(
        480,
        Math.min(displayWidth, Math.round(requestedWidth * this.#scale)),
      ),
    };
  }

  recordFrame(byteLength: number, accepted: boolean): void {
    const instantaneous = byteLength * 8 * this.#targetFps;
    this.#averageBitsPerSecond = this.#averageBitsPerSecond
      ? this.#averageBitsPerSecond * 0.8 + instantaneous * 0.2
      : instantaneous;
    if (!accepted) {
      this.decrease(8, 0.12);
      return;
    }
    if (this.#averageBitsPerSecond > this.#profile.targetBitsPerSecond * 1.12) {
      this.decrease(3, 0.05);
    } else if (
      this.#averageBitsPerSecond <
      this.#profile.targetBitsPerSecond * 0.68
    ) {
      this.increase(2, 0.03);
    }
  }

  recordFeedback(input: {
    averageDecodeMs: number;
    droppedFrames: number;
    intervalMs: number;
    receivedFrames: number;
    renderedFrames: number;
  }): void {
    const expectedFrames = Math.max(
      1,
      (input.intervalMs / 1_000) * this.#targetFps,
    );
    const deliveryRatio = input.receivedFrames / expectedFrames;
    const renderRatio = input.receivedFrames
      ? input.renderedFrames / input.receivedFrames
      : 0;
    const decodeBudget = 1_000 / this.#targetFps;
    if (
      deliveryRatio < 0.65 ||
      renderRatio < 0.75 ||
      input.droppedFrames > input.renderedFrames * 0.25 ||
      input.averageDecodeMs > decodeBudget
    ) {
      this.decrease(6, 0.1);
    } else if (
      deliveryRatio > 0.85 &&
      renderRatio > 0.95 &&
      input.averageDecodeMs < decodeBudget * 0.65
    ) {
      this.increase(1, 0.02);
    }
  }

  private decrease(quality: number, scale: number): void {
    if (this.#quality > this.#profile.minQuality) {
      this.#quality = Math.max(
        this.#profile.minQuality,
        this.#quality - quality,
      );
      return;
    }
    this.#scale = Math.max(this.#profile.minScale, this.#scale - scale);
  }

  private increase(quality: number, scale: number): void {
    if (this.#scale < 1) {
      this.#scale = Math.min(1, this.#scale + scale);
      return;
    }
    this.#quality = Math.min(this.#profile.maxQuality, this.#quality + quality);
  }
}

type ScreenshotMonitor = ReturnType<
  (typeof import("node-screenshots"))["Monitor"]["all"]
>[number];
type ScreenshotWindow = ReturnType<
  (typeof import("node-screenshots"))["Window"]["all"]
>[number];

function monitorSummary(monitor: ScreenshotMonitor): RemoteDesktopMonitor {
  return {
    kind: "monitor",
    id: String(monitor.id()),
    name: monitor.name().trim() || `Display ${monitor.id()}`,
    x: Math.round(monitor.x()),
    y: Math.round(monitor.y()),
    width: Math.round(monitor.width()),
    height: Math.round(monitor.height()),
    primary: monitor.isPrimary(),
  };
}

function windowSummary(window: ScreenshotWindow): RemoteDesktopWindow | null {
  const application = window.appName().trim();
  const title = window.title().trim();
  const width = Math.round(window.width());
  const height = Math.round(window.height());
  if (!application || !title || width <= 0 || height <= 0) return null;
  return {
    kind: "window",
    id: String(window.id()),
    application,
    title,
    iconKey: null,
    x: Math.round(window.x()),
    y: Math.round(window.y()),
    width,
    height,
    minimized: window.isMinimized(),
    focused: window.isFocused(),
  };
}

function nativeDesktopTargets(input: {
  monitors: ScreenshotMonitor[];
  windows: ScreenshotWindow[];
}): RemoteDesktopTargetInventory {
  return remoteDesktopTargetInventorySchema.parse({
    monitors: input.monitors
      .filter((monitor) => monitor.width() > 0 && monitor.height() > 0)
      .slice(0, 64)
      .map(monitorSummary),
    windows: input.windows
      .map(windowSummary)
      .filter((window): window is RemoteDesktopWindow => Boolean(window))
      .slice(0, 2_000),
  });
}

export async function listNativeDesktopTargets(): Promise<RemoteDesktopTargetInventory> {
  const { Monitor, Window } = await import("node-screenshots");
  return nativeDesktopTargets({
    monitors: Monitor.all(),
    windows: Window.all(),
  });
}

export async function launchDesktopApplication(
  application: string,
): Promise<void> {
  const launch = (() => {
    if (process.platform === "darwin") {
      return { command: "open", args: ["-a", application], env: process.env };
    }
    if (process.platform === "win32") {
      return {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -FilePath $env:CANTRIP_DESKTOP_APPLICATION",
        ],
        env: { ...process.env, CANTRIP_DESKTOP_APPLICATION: application },
      };
    }
    return { command: application, args: [], env: process.env };
  })();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      env: launch.env,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function createNativeDesktopFramePipeline(
  requested: RemoteDesktopTarget = DEFAULT_DESKTOP_TARGET,
): Promise<NativeDesktopFramePipeline> {
  const [{ Monitor, Window }, sharpModule] = await Promise.all([
    import("node-screenshots"),
    import("sharp"),
  ]);
  const monitors = Monitor.all();
  const windows = requested.kind === "window" ? Window.all() : [];
  const inventory = nativeDesktopTargets({ monitors, windows });
  const resolved = resolveDesktopTarget(requested, inventory);
  if (!resolved) throw new Error("No graphical display is available.");
  const source =
    resolved.kind === "window"
      ? windows.find((window) => String(window.id()) === resolved.id)
      : monitors.find((monitor) => String(monitor.id()) === resolved.id);
  if (!source) throw new Error("The selected desktop target disappeared.");
  const sharp = sharpModule.default;
  const target: RemoteDesktopTarget =
    resolved.kind === "window"
      ? {
          kind: "window",
          id: resolved.id,
          application: resolved.application,
          title: resolved.title,
        }
      : {
          kind: "monitor",
          id: resolved.id,
          name: resolved.name,
        };
  return {
    backend: "native",
    target,
    get display() {
      return { width: source.width(), height: source.height() };
    },
    get origin() {
      return { x: source.x(), y: source.y() };
    },
    async capture() {
      const image = await source.captureImage();
      return {
        width: image.width,
        height: image.height,
        rgba: await image.toRaw(),
      };
    },
    async encode(frame, options) {
      return sharp(frame.rgba, {
        raw: { width: frame.width, height: frame.height, channels: 4 },
      })
        .resize({ width: options.width, withoutEnlargement: true })
        .jpeg({
          quality: options.quality,
          chromaSubsampling: "4:2:0",
          progressive: false,
        })
        .toBuffer();
    },
  };
}
