import { randomUUID } from "node:crypto";
import type {
  RemoteDesktopTarget,
  RemoteDesktopTargetInventory,
} from "@cantrip/protocol";
import type { WorkerCaptures } from "../computer-use/captures.js";
import type { InteractionBinding } from "../computer-use/participants.js";
import type { CuaTarget } from "../computer-use/types.js";
import type { NativeDesktopFramePipeline } from "./desktop-frame-source.js";

const id = (target: CuaTarget) =>
  target.id.replace(/^macos-(window|display)-/, "");
/** One authorized surface owns its inventory and independent capture leases. */
export class CuaDesktopFrameSource {
  private targets: CuaTarget[] | null = null;
  constructor(
    private readonly captures: Pick<WorkerCaptures, "inventory" | "open">,
    private readonly binding: InteractionBinding,
  ) {}
  async inventory(): Promise<RemoteDesktopTargetInventory> {
    this.targets = await this.captures.inventory(this.binding);
    const geometry = (t: CuaTarget) => ({
      x: Math.round(t.bounds.x),
      y: Math.round(t.bounds.y),
      width: Math.max(1, Math.round(t.bounds.width)),
      height: Math.max(1, Math.round(t.bounds.height)),
    });
    return {
      monitors: this.targets
        .filter((t) => t.kind === "monitor")
        .map((t, i) => ({
          kind: "monitor",
          id: id(t),
          name: t.title || `Display ${i + 1}`,
          ...geometry(t),
          primary: i === 0,
        })),
      windows: this.targets
        .filter((t) => t.kind === "window")
        .map((t) => ({
          kind: "window",
          id: id(t),
          application: t.application || "Application",
          title: t.title || "Untitled window",
          iconKey: null,
          ...geometry(t),
          minimized: t.minimized ?? false,
          focused: t.focused ?? false,
        })),
    };
  }
  async open(
    requested: RemoteDesktopTarget = { kind: "monitor", id: null, name: null },
  ): Promise<NativeDesktopFramePipeline> {
    if (!this.targets) await this.inventory();
    const candidates = this.targets!.filter((t) => t.kind === requested.kind);
    const same = (a: string | null | undefined, b: string) =>
      a?.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
    // Explicit identity never silently substitutes another window or a display.
    const selected = requested.id
      ? candidates.find((t) => id(t) === requested.id)
      : requested.kind === "window"
        ? candidates.find(
            (t) =>
              same(t.application, requested.application) &&
              (!requested.title || same(t.title, requested.title)),
          )
        : candidates.find(
            (t) => !requested.name || same(t.title, requested.name),
          );
    if (!selected) throw new Error("Requested capture target is unavailable.");
    const sharp = (await import("sharp")).default;
    const capture = await this.captures.open(
      { ...this.binding, attachmentId: randomUUID() },
      { targetId: selected.id, targetGeneration: selected.generation },
    );
    let current = capture.initial.target;
    const target: RemoteDesktopTarget =
      current.kind === "window"
        ? {
            kind: "window",
            id: id(current),
            application: current.application || "Application",
            title: current.title,
          }
        : { kind: "monitor", id: id(current), name: current.title };
    return {
      backend: "native",
      target,
      get display() {
        return { width: current.bounds.width, height: current.bounds.height };
      },
      get origin() {
        return { x: current.bounds.x, y: current.bounds.y };
      },
      async capture() {
        const frame = await capture.frame();
        current = frame.target;
        return { png: frame.png, width: frame.width, height: frame.height };
      },
      async encode(frame, options) {
        return (
          "png" in frame
            ? sharp(frame.png)
            : sharp(frame.rgba, {
                raw: { width: frame.width, height: frame.height, channels: 4 },
              })
        )
          .resize({ width: options.width, withoutEnlargement: true })
          .jpeg({
            quality: options.quality,
            chromaSubsampling: "4:2:0",
            progressive: false,
          })
          .toBuffer();
      },
      close: () => capture.close(),
    };
  }
}
