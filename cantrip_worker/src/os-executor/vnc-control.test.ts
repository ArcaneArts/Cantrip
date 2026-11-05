import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CantripOsExecution } from "@cantrip/protocol";
import { CantripCuaService } from "../computer-use/service.js";
import { OsVncControls } from "./vnc-control.js";
import type { OsServiceStream } from "./service-stream.js";

const services: CantripCuaService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});
const identity = {
  serverId: "server",
  attachmentId: "attachment",
  grantId: "grant",
  osExecution: {
    scope: {
      ownerId: "owner",
      workerId: "worker",
      instanceId: "instance",
      workspaceId: "workspace",
    },
  } as CantripOsExecution,
};
const descriptor = {
  generation: "runtime",
  remote_generation: "remote",
  desktop_generation: "a".repeat(64),
};
function setup(observe?: ConstructorParameters<typeof OsVncControls>[1]) {
  const launch = vi.fn(() => {
    throw new Error("Unit control ownership must not launch a helper.");
  });
  const service = new CantripCuaService({
    workerId: "worker",
    allowMonitorInput: true,
    launch,
  });
  services.push(service);
  const release = vi.fn(async () => {});
  const controls = new OsVncControls(
    () => ({
      acquireExecution: async () => ({
        service,
        release,
        desktopGeneration: descriptor.desktop_generation,
      }),
    }),
    observe,
  );
  const stream = Object.assign(new PassThrough(), {
    confirmRetired: vi.fn(async () => {}),
  }) as unknown as OsServiceStream & {
    confirmRetired: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  return { launch, service, release, controls, stream };
}

describe("external VNC control retirement", () => {
  it("keeps agent control blocked after an unconfirmed close, then releases only after confirmed retry", async () => {
    const f = setup(),
      hold = await f.controls.acquire(
        identity,
        descriptor,
        new AbortController().signal,
      );
    f.controls.bind(identity, descriptor, hold, f.stream);
    f.stream.confirmRetired.mockRejectedValue(
      new Error("Guest cleanup unconfirmed"),
    );
    f.stream.destroy();
    await expect(f.controls.retire(f.stream)).rejects.toThrow(
      "Guest cleanup unconfirmed",
    );
    expect(f.service.control.owner).toBe(hold.owner);
    expect(f.release).not.toHaveBeenCalled();
    await expect(f.service.takeControl("another-viewer")).rejects.toMatchObject(
      { code: "ownership-mismatch" },
    );
    await f.controls.retireAttachment({ ...identity, grantId: "old-grant" });
    expect(f.service.control.owner).toBe(hold.owner);
    f.stream.confirmRetired.mockResolvedValue(undefined);
    await f.controls.retireAttachment(identity);
    expect(f.service.control.owner).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();
    await f.controls.retireAttachment(identity);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("closes the old helper before releasing a verified replacement epoch, without requiring stale guest cleanup", async () => {
    const f = setup(),
      hold = await f.controls.acquire(
        identity,
        descriptor,
        new AbortController().signal,
      );
    f.controls.bind(identity, descriptor, hold, f.stream);
    f.stream.confirmRetired.mockRejectedValue(
      new Error("Old remote generation"),
    );
    f.release.mockRejectedValue(new Error("Old native connection is retired"));
    f.stream.destroy();
    await expect(f.controls.retire(f.stream)).rejects.toThrow(
      "Old remote generation",
    );
    await f.controls.reconcile(identity, {
      ...descriptor,
      remote_generation: "replacement",
    });
    expect(f.service.status().state).toBe("closed");
    expect(f.service.control.owner).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it.each(["same", "unreachable", "replacement"])(
    "uses an actual replacement observation to recover failed cleanup: %s",
    async (outcome) => {
      const observe = vi.fn(async () => {
        if (outcome === "unreachable") throw new Error("Offline");
        return {
          ...descriptor,
          remote_generation:
            outcome === "replacement"
              ? "new-manager"
              : descriptor.remote_generation,
        };
      });
      const f = setup(observe),
        hold = await f.controls.acquire(
          identity,
          descriptor,
          new AbortController().signal,
        );
      f.controls.bind(identity, descriptor, hold, f.stream);
      f.stream.confirmRetired.mockRejectedValue(
        new Error("Cleanup unconfirmed"),
      );
      f.stream.destroy();
      if (outcome === "replacement") {
        await f.controls.retire(f.stream);
        expect(f.service.status().state).toBe("closed");
        expect(f.service.control.owner).toBeNull();
        expect(f.release).toHaveBeenCalledOnce();
      } else {
        await expect(f.controls.retire(f.stream)).rejects.toThrow(
          "Cleanup unconfirmed",
        );
        expect(f.service.control.owner).toBe(hold.owner);
        expect(f.release).not.toHaveBeenCalled();
      }
      expect(observe).toHaveBeenCalledWith(identity);
      expect(f.launch).not.toHaveBeenCalled();
    },
  );
  it("cannot return another controller's lease during late cleanup", async () => {
    const f = setup(),
      hold = await f.controls.acquire(
        identity,
        descriptor,
        new AbortController().signal,
      );
    f.controls.bind(identity, descriptor, hold, f.stream);
    f.service.returnControl(hold.owner);
    await f.service.takeControl("replacement-viewer");
    f.stream.destroy();
    await f.controls.retire(f.stream);
    expect(f.service.control.owner).toBe("replacement-viewer");
    expect(f.release).toHaveBeenCalledOnce();
  });
});
