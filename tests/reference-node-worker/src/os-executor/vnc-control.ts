import { randomUUID } from "node:crypto";
import type { CantripOsExecution } from "@cantrip/protocol";
import type { CuaServiceLease } from "../computer-use/service.js";
import type { OsCuaServices } from "./computer-use.js";
import type { OsServiceStream } from "./service-stream.js";

type Identity = {
  serverId: string;
  osExecution: CantripOsExecution;
  attachmentId: string;
  grantId: string;
};
type Descriptor = {
  generation: string;
  remote_generation: string;
  desktop_generation?: string;
};
interface Control {
  identity: Identity;
  descriptor: Descriptor;
  lease: CuaServiceLease;
  owner: string;
  stream: OsServiceStream;
  work: Promise<void> | null;
}

/** VNC is another human controller of the same assigned desktop. Cleanup
 * uncertainty retains its control lease; it never grants agent input early. */
export class OsVncControls {
  private readonly controls = new Map<OsServiceStream, Control>();
  constructor(
    private readonly services?: () => Pick<OsCuaServices, "acquireExecution">,
    private readonly observe?: (identity: Identity) => Promise<Descriptor>,
  ) {}

  private key(identity: Identity) {
    const s = identity.osExecution.scope;
    return JSON.stringify([
      identity.serverId,
      s.ownerId,
      s.workerId,
      s.instanceId,
      s.workspaceId,
    ]);
  }
  async reconcile(identity: Identity, descriptor: Descriptor) {
    for (const control of this.controls.values()) {
      if (
        !control.stream.destroyed ||
        this.key(control.identity) !== this.key(identity)
      )
        continue;
      if (this.changed(control.descriptor, descriptor)) {
        // A verified replacement cannot receive input through the old helper.
        await control.lease.service.close();
        await this.release(control, true);
      } else await this.finish(control);
    }
  }
  async acquire(
    identity: Identity,
    descriptor: Descriptor,
    signal: AbortSignal,
  ) {
    if (!this.services || !descriptor.desktop_generation)
      throw new Error(
        "The captured Linux desktop has no computer-use control service.",
      );
    const lease = await this.services().acquireExecution(
      identity.serverId,
      identity.osExecution,
      signal,
      descriptor.desktop_generation,
    );
    const owner = `vnc:${randomUUID()}`;
    try {
      await lease.service.takeControl(owner);
      signal.throwIfAborted();
    } catch (error) {
      if (lease.service.control.owner === owner)
        lease.service.returnControl(owner);
      await lease.release().catch(() => {});
      throw error;
    }
    return { lease, owner };
  }
  bind(
    identity: Identity,
    descriptor: Descriptor,
    hold: { lease: CuaServiceLease; owner: string },
    stream: OsServiceStream,
  ) {
    const control: Control = {
      identity,
      descriptor,
      ...hold,
      stream,
      work: null,
    };
    this.controls.set(stream, control);
    stream.once("close", () => void this.finish(control).catch(() => {}));
  }
  async abandon(hold: { lease: CuaServiceLease; owner: string }) {
    if (hold.lease.service.control.owner === hold.owner)
      hold.lease.service.returnControl(hold.owner);
    await hold.lease.release();
  }
  async retireAttachment(identity: Identity) {
    await Promise.all(
      [...this.controls.values()]
        .filter(
          (c) =>
            c.identity.attachmentId === identity.attachmentId &&
            c.identity.grantId === identity.grantId,
        )
        .map((c) => this.finish(c)),
    );
  }
  async retire(stream: OsServiceStream) {
    const control = this.controls.get(stream);
    if (control) await this.finish(control);
  }
  private finish(control: Control) {
    if (control.work) return control.work;
    const work = (async () => {
      try {
        await control.stream.confirmRetired();
      } catch (error) {
        // A fresh, placement-verified descriptor can prove the old manager or
        // desktop was fenced even when its service-close receipt is unavailable.
        const current = await this.observe?.(control.identity).catch(
          () => undefined,
        );
        if (!current || !this.changed(control.descriptor, current)) throw error;
        await control.lease.service.close();
        await this.release(control, true);
        return;
      }
      await this.release(control, false);
    })();
    control.work = work;
    void work.catch(() => {
      if (control.work === work) control.work = null;
    });
    return work;
  }
  private changed(before: Descriptor, after: Descriptor) {
    return (
      before.generation !== after.generation ||
      before.remote_generation !== after.remote_generation ||
      before.desktop_generation !== after.desktop_generation
    );
  }
  private async release(control: Control, replaced: boolean) {
    if (control.lease.service.control.owner === control.owner)
      control.lease.service.returnControl(control.owner);
    // Old package cleanup is already fenced when a replacement was observed.
    try {
      await control.lease.release();
    } catch (error) {
      if (!replaced) throw error;
    }
    this.controls.delete(control.stream);
  }
}
