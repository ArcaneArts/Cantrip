import {
  cuaCapabilitiesSchema,
  cuaInventorySchema,
  cuaSessionResultSchema,
  cuaSnapshotSchema,
  type ComputerUseAction,
  type CuaCapabilities,
  type CuaCursorAppearance,
  type CuaPoint,
  type CuaSession,
  type CuaSnapshot,
  type CuaTarget,
} from "@cantrip/protocol/computer-use";
import type { CuaPreviewLease } from "@cantrip/protocol/computer-use-preview";
import type { ComputerUseClient } from "@/lib/computer-use-client";

export interface PreviewState {
  phase: "idle" | "connected" | "stopped" | "disposed";
  busy: boolean;
  stopping: boolean;
  lease: CuaPreviewLease | null;
  capabilities: CuaCapabilities | null;
  targets: CuaTarget[];
  session: CuaSession | null;
  observation: { url: string; metadata: CuaSnapshot } | null;
  error: { code: string; message: string } | null;
}

const initial = (): PreviewState => ({
  phase: "idle",
  busy: false,
  stopping: false,
  lease: null,
  capabilities: null,
  targets: [],
  session: null,
  observation: null,
  error: null,
});

/** One mounted observer. Closing it releases pixels and requests, not another
 * observer's shared native session. Only explicit Stop revokes the chat lease. */
export class ComputerUsePreviewController {
  private state = initial();
  private listeners = new Set<() => void>();
  private flight: AbortController | null = null;
  private stopFlight: AbortController | null = null;
  private disposed = false;
  constructor(
    private readonly client: ComputerUseClient,
    private readonly images = {
      create: (bytes: Uint8Array) =>
        URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        ),
      revoke: (url: string) => URL.revokeObjectURL(url),
    },
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Partial<PreviewState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private clearImage() {
    if (this.state.observation) this.images.revoke(this.state.observation.url);
    this.update({ observation: null });
  }
  private async run(work: (signal: AbortSignal) => Promise<void>) {
    if (this.disposed || this.flight || this.stopFlight) return;
    const flight = new AbortController();
    this.flight = flight;
    this.update({ busy: true, error: null });
    try {
      await work(flight.signal);
    } catch (error) {
      if (!flight.signal.aborted && !this.disposed) {
        this.update({
          error: {
            code:
              error instanceof PreviewOperationError
                ? error.code
                : "request-failed",
            message:
              error instanceof Error
                ? error.message
                : "Computer use request failed.",
          },
        });
      }
    } finally {
      if (this.flight === flight) {
        this.flight = null;
        this.update({ busy: false });
      }
    }
  }
  private assertActive(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.disposed) throw new Error("Computer use preview is closed.");
  }
  private async action(action: ComputerUseAction, signal: AbortSignal) {
    this.assertActive(signal);
    const lease = this.state.lease;
    if (!lease) throw new Error("Connect the computer use preview first.");
    const result = await this.client.operation(lease, action, signal);
    try {
      this.assertActive(signal);
      if (result.content.status === "error") {
        throw new PreviewOperationError(
          result.content.code,
          result.content.message,
        );
      }
      if (result.content.operation !== action.operation) {
        throw new Error("Computer use returned a mismatched operation.");
      }
      if (action.operation === "observation.snapshot") {
        const metadata = cuaSnapshotSchema.parse(result.content.data);
        if (!result.bytes)
          throw new Error("Computer use returned no snapshot pixels.");
        const url = this.images.create(result.bytes);
        this.clearImage();
        this.update({
          session: metadata.session,
          observation: { url, metadata },
        });
      } else if (action.operation === "capabilities.get") {
        this.update({
          capabilities: cuaCapabilitiesSchema.parse(result.content.data),
        });
      } else if (action.operation === "targets.list") {
        this.update({
          targets: cuaInventorySchema.parse(result.content.data).targets,
        });
      } else if (action.operation === "session.close") {
        this.clearImage();
        this.update({ session: null });
      } else {
        const { session } = cuaSessionResultSchema.parse(result.content.data);
        this.update({ session });
      }
    } finally {
      result.bytes?.fill(0);
    }
  }
  connect = () =>
    this.run(async (signal) => {
      if (!this.state.lease) {
        const lease = await this.client.open(signal);
        this.assertActive(signal);
        this.update({ lease, phase: "connected" });
      }
      await this.action({ operation: "capabilities.get" }, signal);
      // Report actual target-list failures, not a guessed OS or heartbeat gate.
      await this.action({ operation: "targets.list" }, signal);
    });
  refreshTargets = () =>
    this.run((signal) => this.action({ operation: "targets.list" }, signal));
  selectTarget = (target: CuaTarget) =>
    this.run(async (signal) => {
      this.clearImage();
      await this.action(
        {
          operation: "session.open",
          targetId: target.id,
          targetGeneration: target.generation,
        },
        signal,
      );
      await this.capture(signal);
    });
  private targetAction() {
    const session = this.state.session;
    if (!session?.target)
      throw new Error("Select a computer use target first.");
    return {
      sessionId: session.binding.sessionId,
      targetId: session.target.id,
      targetGeneration: session.target.generation,
    };
  }
  private capture(signal: AbortSignal) {
    return this.action(
      { operation: "observation.snapshot", ...this.targetAction() },
      signal,
    );
  }
  snapshot = () => this.run((signal) => this.capture(signal));
  configure = (appearance: CuaCursorAppearance) =>
    this.run(async (signal) => {
      this.clearImage();
      await this.action(
        { operation: "cursor.configure", ...this.targetAction(), appearance },
        signal,
      );
      await this.capture(signal);
    });
  move = (position: CuaPoint) =>
    this.run(async (signal) => {
      this.clearImage();
      await this.action(
        { operation: "cursor.move", ...this.targetAction(), position },
        signal,
      );
      await this.capture(signal);
    });
  detach = () =>
    this.run(async (signal) => {
      const session = this.state.session;
      if (!session) return;
      this.clearImage();
      await this.action(
        { operation: "target.detach", sessionId: session.binding.sessionId },
        signal,
      );
    });
  stop = async () => {
    if (this.disposed || this.stopFlight) return;
    const lease = this.state.lease;
    this.flight?.abort();
    this.flight = null;
    this.clearImage();
    this.update({
      phase: "stopped",
      busy: false,
      session: null,
      targets: [],
      error: null,
    });
    if (!lease) return;
    const flight = new AbortController();
    this.stopFlight = flight;
    this.update({ stopping: true });
    try {
      await this.client.stop(lease, flight.signal);
      if (!this.disposed) this.update({ lease: null });
    } catch (error) {
      if (!flight.signal.aborted && !this.disposed)
        this.update({
          error: {
            code: "stop-failed",
            message:
              error instanceof Error
                ? error.message
                : "Stop could not reach the worker. Try Stop again.",
          },
        });
    } finally {
      if (this.stopFlight === flight) {
        this.stopFlight = null;
        if (!this.disposed) this.update({ stopping: false });
      }
    }
  };
  encryptionUnavailable = () => {
    if (this.disposed) return;
    this.flight?.abort();
    this.flight = null;
    this.clearImage();
    this.update({
      phase: "stopped",
      busy: false,
      session: null,
      targets: [],
      error: {
        code: "encryption-unavailable",
        message:
          "Encryption changed. Stop remains available. Unlock encryption and reopen the preview to continue.",
      },
    });
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.flight?.abort();
    this.stopFlight?.abort();
    this.flight = null;
    this.stopFlight = null;
    this.clearImage();
    this.update({ ...initial(), phase: "disposed" });
    this.client.dispose();
    this.listeners.clear();
  };
}

class PreviewOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
