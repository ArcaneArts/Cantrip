import {
  cuaAgentObservationSchema,
  cuaAgentSourcesSchema,
  cuaCapabilitiesSchema,
  cuaInventorySchema,
  cuaSessionResultSchema,
  cuaSnapshotSchema,
  type ComputerUseAction,
  type CuaAgentSource,
  type CuaImage,
  type CuaCapabilities,
  type CuaCursorAppearance,
  type CuaPoint,
  type CuaSession,
  type CuaSnapshot,
  type CuaTarget,
} from "@cantrip/protocol/computer-use";
import type { CuaPreviewLease } from "@cantrip/protocol/computer-use-preview";
import type { ComputerUseClient } from "@/lib/computer-use-client";
import type { ComputerUseCursorPreferences } from "@/lib/computer-use-cursor-preferences";

export interface PreviewState {
  mode: "manual" | "agent";
  sources: CuaAgentSource[];
  sourceId: string | null;
  agentSource: CuaAgentSource | null;
  phase: "idle" | "connected" | "stopped" | "disposed";
  busy: boolean;
  stopping: boolean;
  lease: CuaPreviewLease | null;
  capabilities: CuaCapabilities | null;
  targets: CuaTarget[];
  targetsTruncated: boolean;
  targetPage: {
    after: string | null;
    nextCursor: string | null;
    previous: (string | null)[];
  };
  session: CuaSession | null;
  observation: {
    url: string;
    metadata: CuaSnapshot;
    nativeImage?: CuaImage;
  } | null;
  error: { code: string; message: string } | null;
  preferenceMessage: string | null;
}

const initial = (): PreviewState => ({
  mode: "manual",
  sources: [],
  sourceId: null,
  agentSource: null,
  phase: "idle",
  busy: false,
  stopping: false,
  lease: null,
  capabilities: null,
  targets: [],
  targetsTruncated: false,
  targetPage: { after: null, nextCursor: null, previous: [] },
  session: null,
  observation: null,
  error: null,
  preferenceMessage: null,
});

/** One mounted observer. Closing it releases pixels and requests, not another
 * observer's shared native session. Only explicit Stop revokes the chat lease. */
export class ComputerUsePreviewController {
  private state = initial();
  private listeners = new Set<() => void>();
  private flight: AbortController | null = null;
  private stopFlight: AbortController | null = null;
  private disposed = false;
  private restoredSessionId: string | null = null;
  constructor(
    private readonly client: ComputerUseClient,
    private readonly images = {
      create: (bytes: Uint8Array) =>
        URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        ),
      revoke: (url: string) => URL.revokeObjectURL(url),
    },
    private readonly preferences?: ComputerUseCursorPreferences,
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
        if (this.state.mode === "agent") {
          this.clearImage();
          this.update({ agentSource: null, session: null });
        }
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
  private async action(
    action: ComputerUseAction,
    signal: AbortSignal,
    targetPage: Omit<PreviewState["targetPage"], "nextCursor"> = {
      after: null,
      previous: [],
    },
  ) {
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
      if (action.operation === "agent.sources.list") {
        const { sources } = cuaAgentSourcesSchema.parse(result.content.data);
        const selected = sources.find(
          (source) => source.sourceId === this.state.sourceId,
        );
        // Refreshing a list never fetches pixels implicitly. A newer observation
        // makes the displayed rendition stale until explicitly refreshed.
        if (
          !selected ||
          selected.observationRevision !==
            this.state.agentSource?.observationRevision ||
          selected.cursorRevision !== this.state.agentSource?.cursorRevision
        ) {
          this.clearImage();
          this.update({ session: null, agentSource: null });
        }
        this.update({ sources, sourceId: selected?.sourceId ?? null });
      } else if (action.operation === "agent.observation.get") {
        const metadata = cuaAgentObservationSchema.parse(result.content.data);
        if (
          metadata.source.sourceId !== action.sourceId ||
          action.sourceId !== this.state.sourceId
        )
          throw new Error("Computer use returned a different agent source.");
        if (!result.bytes)
          throw new Error("The agent has no observation pixels available.");
        const url = this.images.create(result.bytes);
        this.clearImage();
        this.update({
          session: metadata.session,
          agentSource: metadata.source,
          sources: this.state.sources.map((source) =>
            source.sourceId === metadata.source.sourceId
              ? metadata.source
              : source,
          ),
          observation: {
            url,
            metadata: { session: metadata.session, image: metadata.image },
            nativeImage: metadata.nativeImage,
          },
        });
      } else if (action.operation === "observation.snapshot") {
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
        const inventory = cuaInventorySchema.parse(result.content.data);
        this.update({
          targets: inventory.targets,
          targetsTruncated: inventory.truncated ?? false,
          targetPage: {
            ...targetPage,
            nextCursor: inventory.nextCursor ?? null,
          },
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
      if (this.state.mode === "agent") {
        await this.action({ operation: "agent.sources.list" }, signal);
        return;
      }
      await this.action({ operation: "capabilities.get" }, signal);
      // Report actual target-list failures, not a guessed OS or heartbeat gate.
      await this.action({ operation: "targets.list" }, signal);
    });
  setMode = (mode: PreviewState["mode"]) => {
    if (this.disposed || this.stopFlight || this.state.mode === mode) return;
    this.flight?.abort();
    this.flight = null;
    this.clearImage();
    this.update({
      mode,
      busy: false,
      session: null,
      sources: [],
      sourceId: null,
      agentSource: null,
      targets: [],
      targetsTruncated: false,
      targetPage: { after: null, nextCursor: null, previous: [] },
      capabilities: null,
      error: null,
    });
  };
  refreshSources = () =>
    this.state.mode === "agent"
      ? this.run((signal) =>
          this.action({ operation: "agent.sources.list" }, signal),
        )
      : Promise.resolve();
  selectSource = (sourceId: string) => {
    if (
      this.disposed ||
      this.stopFlight ||
      this.state.mode !== "agent" ||
      !this.state.sources.some((source) => source.sourceId === sourceId)
    )
      return Promise.resolve();
    this.flight?.abort();
    this.flight = null;
    this.clearImage();
    this.update({ sourceId, agentSource: null, session: null, busy: false });
    return this.refreshObservation();
  };
  refreshObservation = () =>
    this.state.mode === "agent"
      ? this.run(async (signal) => {
          const sourceId = this.state.sourceId;
          if (!sourceId)
            throw new Error("Select an agent observation source first.");
          this.clearImage();
          await this.action(
            { operation: "agent.observation.get", sourceId },
            signal,
          );
        })
      : Promise.resolve();
  private manual(work: (signal: AbortSignal) => Promise<void>) {
    return this.state.mode === "manual" ? this.run(work) : Promise.resolve();
  }
  private loadTargetPage(
    signal: AbortSignal,
    page: Omit<PreviewState["targetPage"], "nextCursor">,
  ) {
    return this.action(
      {
        operation: "targets.list",
        ...(page.after === null ? {} : { after: page.after }),
      },
      signal,
      page,
    );
  }
  refreshTargets = () =>
    this.manual((signal) => this.loadTargetPage(signal, this.state.targetPage));
  firstTargets = () =>
    this.manual((signal) =>
      this.loadTargetPage(signal, { after: null, previous: [] }),
    );
  nextTargets = () =>
    this.manual(async (signal) => {
      const page = this.state.targetPage;
      if (!page.nextCursor) return;
      await this.loadTargetPage(signal, {
        after: page.nextCursor,
        // Retain cursor strings only, never whole inventories. First page stays
        // reachable after older entries fall out of the bounded back history.
        previous: [...page.previous, page.after].slice(-32),
      });
    });
  previousTargets = () =>
    this.manual(async (signal) => {
      const page = this.state.targetPage;
      if (!page.previous.length) return;
      await this.loadTargetPage(signal, {
        after: page.previous.at(-1)!,
        previous: page.previous.slice(0, -1),
      });
    });
  selectTarget = (target: CuaTarget) =>
    this.manual(async (signal) => {
      this.clearImage();
      await this.action(
        {
          operation: "session.open",
          targetId: target.id,
          targetGeneration: target.generation,
        },
        signal,
      );
      await this.restoreAppearance(signal);
      await this.capture(signal);
    });
  private async restoreAppearance(signal: AbortSignal) {
    const sessionId = this.state.session?.binding.sessionId;
    if (!this.preferences || !sessionId || this.restoredSessionId === sessionId)
      return;
    let appearance: CuaCursorAppearance | null;
    try {
      appearance = await this.preferences.load(signal);
      this.assertActive(signal);
    } catch {
      this.assertActive(signal);
      // A settings failure must not block the requested native capture.
      this.update({
        preferenceMessage:
          "Saved appearance could not be loaded. The current session appearance is in use.",
      });
      return;
    }
    if (appearance) {
      // Uses the ordinary permission/Trajectory path. If approval is required,
      // retain restoration pending until an explicit target-selection retry.
      await this.action(
        { operation: "cursor.configure", ...this.targetAction(), appearance },
        signal,
      );
    }
    this.restoredSessionId = sessionId;
    this.update({
      preferenceMessage: appearance ? "Saved appearance restored." : null,
    });
  }
  saveAppearance = () =>
    this.manual(async (signal) => {
      if (!this.preferences || !this.state.session) return;
      await this.preferences.save(this.state.session.cursor.appearance, signal);
      this.assertActive(signal);
      this.update({
        preferenceMessage:
          "Applied appearance saved for future preview sessions.",
      });
    });
  forgetAppearance = () =>
    this.manual(async (signal) => {
      if (!this.preferences) return;
      await this.preferences.save(null, signal);
      this.assertActive(signal);
      this.update({
        preferenceMessage:
          "Saved appearance removed. The current session is unchanged.",
      });
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
  private async capture(signal: AbortSignal) {
    try {
      await this.action(
        { operation: "observation.snapshot", ...this.targetAction() },
        signal,
      );
    } catch (error) {
      // Native, transport, decryption and image failures must not leave stale
      // pixels looking current. An older cancelled flight cannot clear a newer
      // observation; Stop/disposal already owns clearing its display.
      if (!signal.aborted && !this.disposed) this.clearImage();
      throw error;
    }
  }
  snapshot = () => this.manual((signal) => this.capture(signal));
  configure = (appearance: CuaCursorAppearance) =>
    this.manual(async (signal) => {
      this.clearImage();
      await this.action(
        { operation: "cursor.configure", ...this.targetAction(), appearance },
        signal,
      );
      await this.capture(signal);
    });
  move = (position: CuaPoint) =>
    this.manual(async (signal) => {
      this.clearImage();
      await this.action(
        { operation: "cursor.move", ...this.targetAction(), position },
        signal,
      );
      await this.capture(signal);
    });
  detach = () =>
    this.manual(async (signal) => {
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
    this.restoredSessionId = null;
    this.clearImage();
    this.update({
      phase: "stopped",
      busy: false,
      session: null,
      targets: [],
      sources: [],
      sourceId: null,
      agentSource: null,
      targetsTruncated: false,
      targetPage: { after: null, nextCursor: null, previous: [] },
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
      sources: [],
      sourceId: null,
      agentSource: null,
      targetsTruncated: false,
      targetPage: { after: null, nextCursor: null, previous: [] },
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
