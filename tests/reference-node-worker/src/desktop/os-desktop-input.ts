import { randomUUID } from "node:crypto";
import {
  remoteDesktopClientMessageSchema,
  remoteDesktopServerMessageSchema,
  type RemoteDesktopTarget,
} from "@cantrip/protocol";
import type { CantripCuaService } from "../computer-use/service.js";
import type { RemoteSurfaceAdapter } from "../remote-surface-manager.js";
import { DesktopParticipantInput } from "./participant-input.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** One transient human lease per assigned guest service, across all its views. */
export class OsDesktopInput {
  private readonly attached = new Set<string>();
  private readonly epochs = new Map<string, string>();
  private controller: { id: string; leaseId: string; owner: string } | null =
    null;
  private queue = Promise.resolve<unknown>(undefined);
  private readonly input: DesktopParticipantInput;
  private readonly unsubscribe: () => void;
  private width = 1;
  private height = 1;
  private closed = false;
  private suspended = false;
  private closing: Promise<void> | null = null;
  constructor(
    private readonly options: {
      workerId: string;
      surfaceId: string;
      service: CantripCuaService;
      target(): Promise<RemoteDesktopTarget>;
      emit: Parameters<RemoteSurfaceAdapter["open"]>[1];
    },
  ) {
    this.input = new DesktopParticipantInput({
      workerId: options.workerId,
      surfaceId: options.surfaceId,
      participants: options.service.participants,
      allowMonitorInput: true,
      copyModifier: "Control",
      strictCleanup: true,
      state: (id, epoch, message) => {
        if (epoch) this.epochs.set(id, epoch);
        else this.epochs.delete(id);
        this.send(id, { type: "desktop-input", epoch, message });
        this.publish();
      },
      readClipboard: async (participant) => {
        if (!participant.readClipboard)
          throw new Error("Assigned desktop clipboard is unavailable.");
        return participant.readClipboard();
      },
      clipboard: (id, text) =>
        this.send(id, { type: "desktop-clipboard", text }, "clipboard"),
    });
    this.unsubscribe = options.service.subscribeControl(() => this.publish());
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(work);
    this.queue = next;
    return next;
  }
  private send(
    id: string,
    message: unknown,
    channel: "control" | "clipboard" = "control",
  ) {
    if (this.attached.has(id) && !this.closed)
      this.options.emit(
        id,
        channel,
        encoder.encode(
          JSON.stringify(remoteDesktopServerMessageSchema.parse(message)),
        ),
      );
  }
  private owns(id: string) {
    return (
      this.controller?.id === id &&
      this.options.service.control.owner === this.controller.owner
    );
  }
  private publish() {
    const state = this.options.service.control;
    for (const id of this.attached) {
      const own = this.owns(id);
      this.send(id, {
        type: "desktop-control",
        mode: state.owner ? (state.switching ? "switching" : "human") : "agent",
        isController: own,
        leaseId: own ? this.controller!.leaseId : null,
      });
    }
  }
  size(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  attach(id: string) {
    this.attached.add(id);
    this.send(id, {
      type: "desktop-input",
      epoch: null,
      message: "Viewing only. Take control to use this desktop.",
    });
    this.publish();
  }
  private async take(id: string) {
    if (this.closed || this.suspended || !this.attached.has(id)) return;
    if (this.owns(id)) {
      this.publish();
      return;
    }
    const leaseId = randomUUID();
    const controller = {
      id,
      leaseId,
      owner: JSON.stringify([this.options.surfaceId, id, leaseId]),
    };
    if (this.controller)
      throw new Error("Another viewer owns this desktop's control lease.");
    this.controller = controller;
    try {
      await this.options.service.takeControl(controller.owner);
      if (this.closed || this.suspended || !this.attached.has(id)) {
        await this.release();
        return;
      }
      await this.input.attach(id, await this.options.target());
      if (!this.epochs.has(id))
        throw new Error(
          "Human input could not attach. Return control and try a fresh takeover.",
        );
      this.publish();
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  private async release() {
    const controller = this.controller;
    if (!controller) return;
    // Abort queued events and await native held-input cleanup before agent input.
    try {
      await this.input.close();
    } catch (error) {
      await this.options.service.close();
      throw error;
    }
    if (this.options.service.control.owner === controller.owner)
      this.options.service.returnControl(controller.owner);
    if (this.controller === controller) this.controller = null;
    this.publish();
  }
  detach(id: string) {
    this.attached.delete(id);
    this.input.detach(id);
    return this.serial(async () => {
      if (this.controller?.id === id) await this.release();
    });
  }
  async handle(id: string, payload: Uint8Array): Promise<boolean> {
    if (!this.attached.has(id) || this.closed || this.suspended) return true;
    const message = remoteDesktopClientMessageSchema.parse(
      JSON.parse(decoder.decode(payload)),
    );
    if (message.type === "desktop-control") {
      await this.serial(async () => {
        try {
          if (message.operation === "take") await this.take(id);
          else {
            if (!this.owns(id) || this.controller!.leaseId !== message.leaseId)
              throw new Error(
                "The human control lease changed. No input was sent.",
              );
            await this.release();
          }
        } catch (error) {
          this.send(id, {
            type: "desktop-input",
            epoch: this.epochs.get(id) ?? null,
            message:
              error instanceof Error
                ? error.message
                : "Desktop control is unavailable.",
          });
          this.publish();
        }
      });
      return true;
    }
    if (message.type === "viewport") {
      this.publish();
      return false;
    }
    if (message.type === "input-cancel") {
      if (this.owns(id) && this.input.cancel(id, message.inputEpoch)) {
        await this.serial(async () => {
          await this.input.close();
          // New authority has a new epoch. No input is repeated during renewal.
          if (this.owns(id) && this.attached.has(id))
            await this.input.attach(id, await this.options.target());
        });
      }
      return true;
    }
    if (
      message.type === "pointer" ||
      message.type === "key" ||
      message.type === "clipboard"
    ) {
      if (!this.owns(id) || this.options.service.control.switching) {
        this.publish();
        return true;
      }
      void this.input
        .send(id, message, {
          pixelWidth: this.width,
          pixelHeight: this.height,
          logicalWidth: this.width,
          logicalHeight: this.height,
        })
        .catch(() => {});
      return true;
    }
    if (message.type === "focus") return true;
    return false;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.attached.clear();
    this.input.reset();
    this.closing = this.serial(() => this.release()).finally(() =>
      this.unsubscribe(),
    );
    return this.closing;
  }
  suspend() {
    this.suspended = true;
    this.input.reset();
    return this.serial(() => this.release());
  }
  resume() {
    this.suspended = false;
    this.publish();
  }
}
