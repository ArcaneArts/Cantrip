import type { WorkerCommand } from "@cantrip/protocol";
import type { RemoteSurfaceManager } from "../remote-surface-manager.js";
import type { ManagedDesktopRemoteSurfaceAdapter } from "../desktop/desktop-adapter.js";

export type SurfaceCommand = Extract<
  WorkerCommand,
  {
    type:
      | "surface.attach"
      | "surface.detach"
      | "surface.configure"
      | "surface.suspend"
      | "surface.resume"
      | "surface.close"
      | "surface.desktop.probe"
      | "surface.desktop.targets"
      | "surface.desktop.os-prepare";
  }
>;
export interface SurfaceCommandDependencies {
  prepareOsDesktop?: (
    command: Extract<WorkerCommand, { type: "surface.desktop.os-prepare" }>,
  ) => Promise<unknown>;
  remoteSurfaces: Pick<
    RemoteSurfaceManager,
    "attach" | "detach" | "configure" | "suspend" | "resume" | "close"
  >;
  desktopAdapter: Pick<ManagedDesktopRemoteSurfaceAdapter, "probe" | "targets">;
}

// Services are owned by the worker entry point; this handler only executes commands.
export async function handleSurfaceCommand(
  command: SurfaceCommand,
  dependencies: SurfaceCommandDependencies,
): Promise<unknown> {
  const { remoteSurfaces, desktopAdapter } = dependencies;
  switch (command.type) {
    case "surface.desktop.os-prepare":
      if (!dependencies.prepareOsDesktop)
        throw new Error("Linux desktop preparation is unavailable.");
      return dependencies.prepareOsDesktop(command);
    case "surface.attach":
      return remoteSurfaces.attach(command);
    case "surface.detach":
      await remoteSurfaces.detach(command.surfaceId, command.attachmentId);
      return { accepted: true };
    case "surface.configure":
      await remoteSurfaces.configure(command);
      return { accepted: true };
    case "surface.suspend":
      await remoteSurfaces.suspend(command.surfaceId);
      return { accepted: true };
    case "surface.resume":
      await remoteSurfaces.resume(command.surfaceId);
      return { accepted: true };
    case "surface.close":
      await remoteSurfaces.close(command.surfaceId);
      return { accepted: true };
    case "surface.desktop.probe":
      return desktopAdapter.probe();
    case "surface.desktop.targets":
      return desktopAdapter.targets(command);
  }
}
