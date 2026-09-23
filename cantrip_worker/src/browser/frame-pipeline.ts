import type { RemoteSurfaceViewport } from "@cantrip/protocol";

/** One CDP target's capture configuration. Never caches completed screenshots. */
export class BrowserFramePipeline {
  private revision = 0;
  private suspended = false;
  private viewport: RemoteSurfaceViewport | null = null;
  private configured: RemoteSurfaceViewport | null = null;
  private queue: Promise<void> = Promise.resolve();
  private screenshot: Promise<{ data: string }> | null = null;

  constructor(
    private readonly command: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly capture: () => Promise<{ data: string }>,
    private readonly viewportApplied: (
      viewport: RemoteSurfaceViewport,
    ) => void = () => undefined,
  ) {}

  configure(viewport: RemoteSurfaceViewport): Promise<void> {
    this.suspended = false;
    const requested = { ...viewport };
    this.viewport = requested;
    const run = this.queue.then(async () => {
      const current = this.configured;
      if (
        current &&
        current.width === requested.width &&
        current.height === requested.height &&
        current.devicePixelRatio === requested.devicePixelRatio
      )
        return;
      this.invalidateFrames();
      const revision = this.revision;
      this.configured = null;
      await Promise.all([
        this.command("Emulation.setDeviceMetricsOverride", {
          width: requested.width,
          height: requested.height,
          deviceScaleFactor: requested.devicePixelRatio,
          mobile: false,
        }).then(() => this.viewportApplied(requested)),
        this.command("Emulation.setTouchEmulationEnabled", {
          enabled: true,
          maxTouchPoints: 10,
        }),
      ]);
      await this.command("Page.stopScreencast").catch(() => undefined);
      await this.command("Page.startScreencast", {
        format: "jpeg",
        quality: 78,
        maxWidth: requested.width,
        maxHeight: requested.height,
        everyNthFrame: 1,
      });
      if (revision === this.revision) this.configured = requested;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  restart(): Promise<void> {
    if (this.suspended) return Promise.resolve();
    this.configured = null;
    this.invalidateFrames();
    return this.viewport ? this.configure(this.viewport) : Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspended = true;
    this.invalidateFrames();
    this.configured = null;
    const run = this.queue
      .then(() => {
        this.configured = null;
        this.invalidateFrames();
        return this.command("Page.stopScreencast");
      })
      .then(() => undefined);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get generation(): number {
    return this.revision;
  }

  invalidateFrames(): void {
    this.revision += 1;
    this.screenshot = null;
  }

  frame(): Promise<{ data: string }> {
    if (this.screenshot) return this.screenshot;
    const pending = Promise.resolve().then(this.capture);
    this.screenshot = pending;
    void pending
      .finally(() => {
        if (this.screenshot === pending) this.screenshot = null;
      })
      .catch(() => undefined);
    return pending;
  }
}
