import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveCuaBinary } from "./binary.js";
import { waitBeforeCuaSend } from "./cancellation.js";
import { CuaProcessError } from "./errors.js";
import {
  CuaJavascriptContexts,
  type CuaJavascriptOptions,
} from "./javascript.js";
import { launchCuaTransport, type CuaTransport } from "./transport.js";
import {
  CUA_REQUIRED_OPERATIONS,
  cuaScopeSchema,
  cuaTargetReferenceSchema,
  cuaCursorAppearanceSchema,
  cuaPointSchema,
  cuaCapabilitiesSchema,
  cuaInventorySchema,
  cuaIdSchema,
  cuaSessionResultSchema,
  cuaSnapshotSchema,
  cuaControlsResultSchema,
  cuaInputResultSchema,
  type CuaControlsResult,
  type CuaInputResult,
  type CuaBinding,
  type CuaCapabilities,
  type CuaCursorAppearance,
  type CuaPoint,
  type CuaScope,
  type CuaSession,
  type CuaSnapshot,
  type CuaTargetReference,
} from "./types.js";

export class CuaServiceError extends Error {
  constructor(
    readonly code:
      | "ownership-mismatch"
      | "session-not-found"
      | "stale-target"
      | "disconnected"
      | "unavailable"
      | "closed"
      | "capacity",
  ) {
    super(
      {
        "ownership-mismatch":
          "CUA belongs to another worker or execution context.",
        "session-not-found":
          "CUA session is no longer active; explicitly attach a new session.",
        "stale-target":
          "The selected CUA target changed; attach the current target.",
        disconnected: "The worker lost its authorized server connection.",
        unavailable:
          "CUA helper failed; restart the worker after correcting the reported failure.",
        closed: "CUA worker service is closed.",
        capacity: "CUA operation or session capacity reached.",
      }[code],
    );
    this.name = "CuaServiceError";
  }
}

interface Runtime {
  transport: CuaTransport;
  generation: number;
  capabilities: CuaCapabilities | null;
}
interface SessionRecord {
  scope: CuaScope;
  binding: CuaBinding;
  runtime: Runtime;
  state: CuaSession | null;
  controller: AbortController;
  queue: Promise<void>;
}
interface PendingOperation {
  scope: CuaScope;
  controller: AbortController;
}
export interface CantripCuaServiceOptions {
  workerId: string;
  binary?: string;
  /** Explicit fake selection is for tests/QA only; never an automatic fallback. */
  args?: string[];
  launch?: typeof launchCuaTransport;
}

/** Sole worker owner. Callers supply an already-authorized, server-derived scope.
 * This pass deliberately exposes no network/MCP entry point or permission bypass.
 * Constructor/status/idle shutdown do not launch or inspect the native helper. */
export class CantripCuaService {
  private runtime: Runtime | null = null;
  private opening: Promise<Runtime> | null = null;
  private generation = 0;
  private crashes = 0;
  private terminal = false;
  private stopped = false;
  private connected = true;
  private closing: Promise<void> | null = null;
  private sessions = new Map<string, SessionRecord>();
  private pending = new Set<PendingOperation>();
  private cleanup = new Set<Promise<void>>();
  private lastFailure: string | null = null;
  private readonly javascript: CuaJavascriptContexts;

  constructor(private readonly options: CantripCuaServiceOptions) {
    this.javascript = new CuaJavascriptContexts(this, {
      runtime: async (signal) => {
        const runtime = await waitBeforeCuaSend(this.ensureRuntime(), signal);
        this.assertActive(signal);
        if (this.runtime !== runtime)
          throw new CuaProcessError("process-exited", "not-sent");
        return runtime;
      },
      cleanup: (work) => this.background(work),
      protocolFailure: (runtime) => this.protocolFailure(runtime),
    });
  }

  status() {
    return {
      state: this.stopped
        ? "closed"
        : this.terminal
          ? "failed"
          : this.opening
            ? "starting"
            : this.runtime
              ? "running"
              : this.crashes
                ? "restart-available"
                : "idle",
      processGeneration: this.generation,
      sessions: this.sessions.size,
      connected: this.connected,
      lastFailure: this.lastFailure,
    } as const;
  }

  private scope(input: CuaScope): CuaScope {
    const scope = cuaScopeSchema.parse(input);
    if (scope.workerId !== this.options.workerId)
      throw new CuaServiceError("ownership-mismatch");
    return scope;
  }
  private assertActive(signal?: AbortSignal) {
    if (this.stopped) throw new CuaServiceError("closed");
    if (!this.connected) throw new CuaServiceError("disconnected");
    if (signal?.aborted) throw new CuaProcessError("cancelled", "not-sent");
  }
  private async track<T>(
    scope: CuaScope,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertActive(signal);
    // Reserve transport slots for out-of-band close/cancellation of all 16
    // sessions, even when ordinary callers saturate the service.
    if (this.pending.size >= 16) throw new CuaServiceError("capacity");
    const operation = { scope, controller: new AbortController() };
    this.pending.add(operation);
    try {
      return await action(
        AbortSignal.any([
          operation.controller.signal,
          ...(signal ? [signal] : []),
        ]),
      );
    } finally {
      this.pending.delete(operation);
    }
  }

  private failRuntime(
    runtime: Runtime,
    error: CuaProcessError,
    restartable = true,
  ) {
    if (this.runtime !== runtime) return;
    this.runtime = null;
    this.lastFailure = error.code;
    this.crashes += 1;
    this.terminal = !restartable || !runtime.capabilities || this.crashes > 1;
    this.javascript.runtimeFailed(runtime);
    for (const record of this.sessions.values()) {
      if (record.runtime === runtime) {
        this.sessions.delete(record.binding.sessionId);
        record.controller.abort();
      }
    }
    // Transport termination is bounded. No operation is replayed and no helper
    // starts here. A fresh authorized request may consume the one restart.
    this.background(runtime.transport.close());
  }
  private background(work: Promise<void>) {
    const safe = work.catch(() => {});
    this.cleanup.add(safe);
    void safe.finally(() => this.cleanup.delete(safe));
  }
  private ensureRuntime(): Promise<Runtime> {
    this.assertActive();
    if (this.opening) return this.opening;
    if (this.runtime) return Promise.resolve(this.runtime);
    if (this.terminal) throw new CuaServiceError("unavailable");
    const generation = ++this.generation;
    let runtime: Runtime | null = null;
    let launchFailure: CuaProcessError | null = null;
    let transport: CuaTransport;
    try {
      transport = (this.options.launch ?? launchCuaTransport)(
        this.options.binary ?? resolveCuaBinary(),
        {
          args: this.options.args,
          onFailure: (error) => {
            if (runtime)
              this.failRuntime(runtime, error, error.code !== "protocol-error");
            else launchFailure = error;
          },
        },
      );
    } catch {
      this.lastFailure = "spawn-failed";
      this.terminal = true;
      throw new CuaProcessError("spawn-failed", "not-sent");
    }
    const created: Runtime = { generation, capabilities: null, transport };
    runtime = created;
    this.runtime = created;
    if (launchFailure) this.failRuntime(created, launchFailure, false);
    const opening = (async () => {
      try {
        const response = await created.transport.request({
          operation: "capabilities.get",
        });
        const capabilities = this.parse(
          created,
          cuaCapabilitiesSchema,
          response.data,
        );
        if (
          response.payload.length ||
          CUA_REQUIRED_OPERATIONS.some(
            (op) => !capabilities.operations.includes(op),
          )
        ) {
          throw new CuaProcessError("protocol-error", "unknown");
        }
        if (this.stopped || this.runtime !== created)
          throw new CuaProcessError("closed", "not-sent");
        created.capabilities = capabilities;
        return created;
      } catch (error) {
        this.failRuntime(
          created,
          error instanceof CuaProcessError
            ? error
            : new CuaProcessError("protocol-error"),
          false,
        );
        throw error;
      } finally {
        this.opening = null;
      }
    })();
    this.opening = opening;
    return opening;
  }
  private parse<T>(runtime: Runtime, schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    const error = new CuaProcessError("protocol-error", "unknown");
    this.failRuntime(runtime, error, false);
    throw error;
  }

  async capabilities(
    input: CuaScope,
    signal?: AbortSignal,
  ): Promise<CuaCapabilities> {
    return this.track(this.scope(input), signal, async (active) => {
      const runtime = await waitBeforeCuaSend(this.ensureRuntime(), active);
      this.assertActive(active);
      if (this.runtime !== runtime)
        throw new CuaProcessError("process-exited", "not-sent");
      return structuredClone(runtime.capabilities!);
    });
  }
  /** Worker-internal only until the managed MCP adapter binds real turn authority.
   * Never hold a native session queue while JS waits for an authorized host call. */
  async evaluateJavascript(
    input: CuaScope,
    source: string,
    options: CuaJavascriptOptions,
  ) {
    this.assertActive(options.executionSignal);
    return this.javascript.evaluate(this.scope(input), source, options);
  }
  resetJavascript(
    input: CuaScope,
    executionSignal: AbortSignal,
  ): Promise<void> {
    return this.javascript.reset(this.scope(input), executionSignal);
  }
  javascriptSession(
    input: CuaScope,
    executionSignal: AbortSignal,
  ): CuaSession | null {
    this.assertActive(executionSignal);
    return this.javascript.session(this.scope(input), executionSignal);
  }
  /** Actual attached JavaScript context lifetime, including native-helper loss.
   * Reading it never creates a context/session or launches the native helper. */
  javascriptSessionSignal(
    input: CuaScope,
    executionSignal: AbortSignal,
  ): AbortSignal | null {
    this.assertActive(executionSignal);
    return this.javascript.sessionSignal(this.scope(input), executionSignal);
  }
  async targets(input: CuaScope, signal?: AbortSignal) {
    return (await this.inventory(input, signal)).targets;
  }
  async inventory(input: CuaScope, signal?: AbortSignal, after?: string) {
    if (after !== undefined) cuaIdSchema.parse(after);
    return this.track(this.scope(input), signal, async (active) => {
      const runtime = await waitBeforeCuaSend(this.ensureRuntime(), active);
      this.assertActive(active);
      const response = await runtime.transport.request(
        {
          operation: "targets.list",
          ...(after === undefined ? {} : { after }),
        },
        { signal: active },
      );
      this.assertActive(active);
      if (this.runtime !== runtime)
        throw new CuaProcessError("process-exited", "unknown");
      if (response.payload.length) return this.protocolFailure(runtime);
      const inventory = this.parse(runtime, cuaInventorySchema, response.data);
      if (
        after !== undefined &&
        inventory.targets.some((target) => target.id <= after)
      )
        return this.protocolFailure(runtime);
      return inventory;
    });
  }
  async open(
    input: CuaScope,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ): Promise<CuaSession> {
    const scope = this.scope(input);
    const reference = cuaTargetReferenceSchema.parse(target);
    return this.track(scope, signal, async (active) => {
      const runtime = await waitBeforeCuaSend(this.ensureRuntime(), active);
      this.assertActive(active);
      if (
        this.sessions.size + this.cleanup.size >=
        runtime.capabilities!.maxSessions
      )
        throw new CuaServiceError("capacity");
      const { serverId: _server, ownerId: _owner, ...execution } = scope;
      const record: SessionRecord = {
        scope,
        runtime,
        binding: { ...execution, sessionId: randomUUID() },
        state: null,
        controller: new AbortController(),
        queue: Promise.resolve(),
      };
      this.sessions.set(record.binding.sessionId, record);
      try {
        return (await this.execute(
          record,
          "target.attach",
          reference,
          active,
        )) as CuaSession;
      } catch (error) {
        this.invalidate(record);
        throw error;
      }
    });
  }
  private record(input: CuaScope, sessionId: string): SessionRecord {
    const scope = this.scope(input);
    const record = this.sessions.get(sessionId);
    if (!record) throw new CuaServiceError("session-not-found");
    if (JSON.stringify(scope) !== JSON.stringify(record.scope))
      throw new CuaServiceError("ownership-mismatch");
    return record;
  }
  state(input: CuaScope, sessionId: string): CuaSession {
    this.assertActive();
    const state = this.record(input, sessionId).state;
    if (!state) throw new CuaServiceError("session-not-found");
    return structuredClone(state);
  }
  private protocolFailure(runtime: Runtime): never {
    const error = new CuaProcessError("protocol-error", "unknown");
    this.failRuntime(runtime, error, false);
    throw error;
  }
  private async execute(
    record: SessionRecord,
    operation: string,
    fields: object,
    signal: AbortSignal,
    snapshot = false,
  ): Promise<CuaSession | CuaSnapshot | CuaControlsResult | CuaInputResult> {
    const active = AbortSignal.any([signal, record.controller.signal]);
    const previous = record.queue;
    const work = (async () => {
      await waitBeforeCuaSend(previous, active);
      this.assertActive(active);
      if (
        operation !== "target.attach" &&
        "targetId" in fields &&
        "targetGeneration" in fields &&
        (record.state?.target?.id !== fields.targetId ||
          record.state?.target?.generation !== fields.targetGeneration)
      ) {
        throw new CuaServiceError("stale-target");
      }
      const response = await record.runtime.transport.request(
        { operation, binding: record.binding, ...fields },
        { signal: active },
      );
      const snapshotData = snapshot
        ? this.parse(record.runtime, cuaSnapshotSchema, response.data)
        : null;
      const extra =
        operation === "controls.inspect"
          ? this.parse(record.runtime, cuaControlsResultSchema, response.data)
          : operation === "input.press" || operation === "input.click"
            ? this.parse(record.runtime, cuaInputResultSchema, response.data)
            : null;
      if (extra && "input" in extra) {
        const receipt = extra.input;
        if (
          receipt.method !==
            (operation === "input.click" ? "coordinate" : "accessibility") ||
          (operation === "input.click" &&
            (!receipt.position ||
              !receipt.globalPosition ||
              !("position" in fields) ||
              JSON.stringify(receipt.position) !==
                JSON.stringify(fields.position)))
        )
          return this.protocolFailure(record.runtime);
      }
      const data =
        extra ??
        snapshotData ??
        this.parse(record.runtime, cuaSessionResultSchema, response.data);
      if (
        Object.entries(record.binding).some(
          ([key, value]) =>
            data.session.binding[key as keyof CuaBinding] !== value,
        )
      ) {
        return this.protocolFailure(record.runtime);
      }
      if (
        ("targetId" in fields &&
          "targetGeneration" in fields &&
          (data.session.target?.id !== fields.targetId ||
            data.session.target?.generation !== fields.targetGeneration)) ||
        (operation === "target.detach" && data.session.target !== null)
      ) {
        return this.protocolFailure(record.runtime);
      }
      if (snapshotData) {
        const { image } = snapshotData;
        const bytes = response.payload;
        if (
          bytes.length !== image.byteCount ||
          bytes.length < 33 ||
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          bytes.readUInt32BE(8) !== 13 ||
          bytes.toString("ascii", 12, 16) !== "IHDR" ||
          bytes.readUInt32BE(16) !== image.width ||
          bytes.readUInt32BE(20) !== image.height ||
          createHash("sha256").update(bytes).digest("hex") !== image.sha256
        ) {
          return this.protocolFailure(record.runtime);
        }
      } else if (response.payload.length)
        return this.protocolFailure(record.runtime);
      // Lifecycle cancellation may race an authoritative response; do not
      // resurrect a revoked handle or publish its protected result.
      if (
        this.sessions.get(record.binding.sessionId) !== record ||
        active.aborted
      ) {
        throw new CuaProcessError("cancelled", "unknown");
      }
      record.state = data.session;
      return snapshotData
        ? { ...structuredClone(snapshotData), payload: response.payload }
        : extra
          ? structuredClone(extra)
          : structuredClone(data.session);
    })();
    record.queue = previous
      .then(() => work)
      .then(
        () => {},
        () => {},
      );
    try {
      return await work;
    } catch (error) {
      if (error instanceof CuaProcessError && error.outcome === "unknown")
        this.invalidate(record);
      throw error;
    }
  }
  private mutate(
    input: CuaScope,
    sessionId: string,
    operation: string,
    fields: object,
    signal?: AbortSignal,
    snapshot = false,
  ) {
    const record = this.record(input, sessionId);
    return this.track(record.scope, signal, (active) =>
      this.execute(record, operation, fields, active, snapshot),
    );
  }
  attach(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "target.attach",
      cuaTargetReferenceSchema.parse(target),
      signal,
    ) as Promise<CuaSession>;
  }
  detach(input: CuaScope, sessionId: string, signal?: AbortSignal) {
    return this.mutate(
      input,
      sessionId,
      "target.detach",
      {},
      signal,
    ) as Promise<CuaSession>;
  }
  configure(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    appearance: CuaCursorAppearance,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "cursor.configure",
      {
        ...cuaTargetReferenceSchema.parse(target),
        appearance: cuaCursorAppearanceSchema.parse(appearance),
      },
      signal,
    ) as Promise<CuaSession>;
  }
  move(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    position: CuaPoint,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "cursor.move",
      {
        ...cuaTargetReferenceSchema.parse(target),
        position: cuaPointSchema.parse(position),
      },
      signal,
    ) as Promise<CuaSession>;
  }
  click(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    position: CuaPoint | undefined,
    signal?: AbortSignal,
    globalInput = false,
  ) {
    return this.mutate(
      input,
      sessionId,
      "input.click",
      {
        ...cuaTargetReferenceSchema.parse(target),
        ...(position === undefined
          ? {}
          : { position: cuaPointSchema.parse(position) }),
        // Always send the selector: older helpers reject it instead of silently
        // executing their legacy global click for a targeted request.
        globalInput,
      },
      signal,
    ) as Promise<CuaInputResult>;
  }
  controls(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "controls.inspect",
      cuaTargetReferenceSchema.parse(target),
      signal,
    ) as Promise<CuaControlsResult>;
  }
  press(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    reference: string,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "input.press",
      {
        ...cuaTargetReferenceSchema.parse(target),
        reference: cuaIdSchema.parse(reference),
      },
      signal,
    ) as Promise<CuaInputResult>;
  }
  snapshot(
    input: CuaScope,
    sessionId: string,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ) {
    return this.mutate(
      input,
      sessionId,
      "observation.snapshot",
      cuaTargetReferenceSchema.parse(target),
      signal,
      true,
    ) as Promise<CuaSnapshot>;
  }
  private invalidate(record: SessionRecord, revokeJavascript = false) {
    if (this.sessions.get(record.binding.sessionId) !== record) return;
    this.sessions.delete(record.binding.sessionId);
    this.javascript.nativeSessionClosed(
      record.binding.sessionId,
      revokeJavascript,
    );
    record.controller.abort();
    if (!record.runtime.transport.closed)
      this.background(
        record.runtime.transport
          .request(
            {
              operation: "session.close",
              binding: record.binding,
            },
            { lifecycle: true },
          )
          .then(() => {}),
      );
  }
  stopSession(input: CuaScope, sessionId: string): void {
    this.invalidate(this.record(input, sessionId), true);
  }
  /** Release one exact owner lifetime. Null task/thread/turn fields are values,
   * not wildcards for the agent executions sharing a preview's chat. */
  cancelScope(input: CuaScope): void {
    const identity = JSON.stringify(this.scope(input));
    const matches = (scope: CuaScope) => JSON.stringify(scope) === identity;
    this.javascript.cancel(matches);
    for (const pending of this.pending)
      if (matches(pending.scope)) pending.controller.abort();
    for (const record of this.sessions.values())
      if (matches(record.scope)) this.invalidate(record);
  }
  /** Local lifecycle control: never waits for approval or a backend response. */
  cancelChat(chatId: string, threadId?: string | null): void {
    const matches = (scope: CuaScope) =>
      scope.chatId === chatId &&
      (threadId == null || scope.threadId === threadId);
    this.javascript.cancel(matches);
    for (const pending of this.pending)
      if (matches(pending.scope)) pending.controller.abort();
    for (const record of this.sessions.values())
      if (matches(record.scope)) this.invalidate(record);
  }
  cancelThread(threadId: string): void {
    this.javascript.cancel((scope) => scope.threadId === threadId);
    for (const pending of this.pending)
      if (pending.scope.threadId === threadId) pending.controller.abort();
    for (const record of this.sessions.values())
      if (record.scope.threadId === threadId) this.invalidate(record);
  }
  disconnect(): void {
    this.connected = false;
    this.javascript.cancel(() => true);
    for (const pending of this.pending) pending.controller.abort();
    for (const record of this.sessions.values()) this.invalidate(record);
  }
  reconnect(): void {
    if (!this.stopped) this.connected = true;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.disconnect();
    const transport = this.runtime?.transport;
    this.runtime = null;
    this.closing = (async () => {
      await transport?.close();
      await this.opening?.catch(() => {});
      await Promise.all(this.cleanup);
    })();
    return this.closing;
  }
}
