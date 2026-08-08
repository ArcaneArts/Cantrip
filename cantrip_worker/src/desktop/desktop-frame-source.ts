import type { DesktopStreamSettings } from "@cantrip/protocol";

export interface DesktopDisplaySize {
  height: number;
  width: number;
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
  capture(): Promise<DesktopRawFrame>;
  encode(
    frame: DesktopRawFrame,
    options: DesktopFrameEncoding,
  ): Promise<Uint8Array>;
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

export async function createNativeDesktopFramePipeline(): Promise<NativeDesktopFramePipeline> {
  const [{ Monitor }, sharpModule] = await Promise.all([
    import("node-screenshots"),
    import("sharp"),
  ]);
  const monitors = Monitor.all();
  const monitor =
    monitors.find((candidate) => candidate.isPrimary()) ?? monitors[0];
  if (!monitor) throw new Error("No graphical display is available.");
  const sharp = sharpModule.default;
  return {
    backend: "native",
    display: { width: monitor.width(), height: monitor.height() },
    async capture() {
      const image = await monitor.captureImage();
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
