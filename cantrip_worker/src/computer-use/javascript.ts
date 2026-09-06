import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { waitBeforeCuaSend } from "./cancellation.js";
import { CuaNativeError, CuaProcessError } from "./errors.js";
import type { CantripCuaService } from "./service.js";
import type { CuaTransport } from "./transport.js";
import {
  cuaCursorAppearanceSchema,
  cuaInputCommandSchema,
  cuaIdSchema,
  cuaPointSchema,
  cuaTargetReferenceSchema,
  type CuaBinding,
  type CuaCapabilities,
  type CuaImage,
  type CuaScope,
  type CuaSession,
  type CuaSnapshot,
  type CuaTargetReference,
  type CuaInputReceipt,
} from "./types.js";

export const CUA_JAVASCRIPT_MAX_CONTEXTS = 4;
export const CUA_JAVASCRIPT_MAX_SOURCE_BYTES = 32 * 1024;
export const CUA_JAVASCRIPT_MAX_OUTPUT_BYTES = 32 * 1024;
export const CUA_JAVASCRIPT_MAX_IMAGES = 2;
export const CUA_JAVASCRIPT_MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Script arguments contain no session, account, worker, or execution authority. */
export const cuaJavascriptActionSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("perform"),
    command: cuaInputCommandSchema,
  }),
  z.strictObject({
    operation: z.literal("wait"),
    ms: z.number().int().min(0).max(10000),
  }),
  z.strictObject({ operation: z.literal("state") }),
  z.strictObject({
    operation: z.literal("targets"),
    after: cuaIdSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("attach"),
    target: cuaTargetReferenceSchema,
  }),
  z.strictObject({
    operation: z.literal("controls"),
    point: cuaPointSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("click"),
    point: cuaPointSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("backgroundClick"),
    point: cuaPointSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("processClick"),
    point: cuaPointSchema.optional(),
  }),
  z.strictObject({
    operation: z.literal("globalClick"),
    point: cuaPointSchema,
  }),
  z.strictObject({ operation: z.literal("press"), reference: cuaIdSchema }),
  z.strictObject({ operation: z.literal("snapshot") }),
  z.strictObject({ operation: z.literal("cursor") }),
  z.strictObject({
    operation: z.literal("configureCursor"),
    appearance: cuaCursorAppearanceSchema,
  }),
  z.strictObject({ operation: z.literal("moveCursor"), point: cuaPointSchema }),
  z.strictObject({ operation: z.literal("detach") }),
]);
export type CuaJavascriptAction = z.infer<typeof cuaJavascriptActionSchema>;
export interface CuaJavascriptOperationOutcome {
  action: CuaJavascriptAction;
  session: CuaSession | null;
  target: CuaTargetReference | null;
  image: CuaImage | null;
  startedAtMs: number;
  completedAtMs: number;
  error: unknown;
  failed: boolean;
  input?: CuaInputReceipt | null;
  cancelled: boolean;
}

export interface CuaJavascriptOptions {
  /** Actual runtime turn lifetime, not the transient MCP HTTP request signal. */
  executionSignal: AbortSignal;
  signal?: AbortSignal;
  /** Trusted coordinator budget, including durable permission waits. */
  wallTimeoutMs?: number;
  /** Trusted worker policy callback; run before EVERY observation or mutation. */
  authorize: (
    action: CuaJavascriptAction,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Synchronous metadata-only queue hook. Native work never waits on logging. */
  onOperation?: (outcome: CuaJavascriptOperationOutcome) => void;
}
export interface CuaJavascriptResult {
  value: unknown;
  /** Validated PNGs stay in the worker; QuickJS receives bounded metadata only. */
  images: CuaSnapshot[];
}
export interface CuaJavascriptRuntime {
  generation: number;
  transport: CuaTransport;
  capabilities: CuaCapabilities | null;
}
export interface CuaJavascriptDriver {
  runtime: (signal: AbortSignal) => Promise<CuaJavascriptRuntime>;
  cleanup: (work: Promise<void>) => void;
  protocolFailure: (runtime: CuaJavascriptRuntime) => never;
}
interface Context {
  scope: CuaScope;
  identity: string;
  binding: CuaBinding;
  executionSignal: AbortSignal;
  controller: AbortController;
  runtime: CuaJavascriptRuntime | null;
  sessionId: string | null;
  busy: boolean;
  retiring: Promise<void> | null;
}
interface Lifetime {
  scope: CuaScope;
  executionSignal: AbortSignal;
  release: () => void;
}

/** Subordinate to CantripCuaService. No launch, network, MCP, or policy owner. */
export class CuaJavascriptContexts {
  private contexts = new Map<string, Context>();
  private revoked = new WeakSet<AbortSignal>();
  private identities = new WeakMap<AbortSignal, string>();
  // Reset/error frees the engine, not its authority registration. Otherwise
  // Stop between reset and the next call could silently restore permission.
  private lifetimes = new Map<string, Lifetime>();
  private retiring = new Map<Promise<void>, string>();

  constructor(
    private readonly service: CantripCuaService,
    private readonly driver: CuaJavascriptDriver,
  ) {}

  private live(context: Context, signal?: AbortSignal): void {
    if (
      context.controller.signal.aborted ||
      context.executionSignal.aborted ||
      signal?.aborted ||
      this.contexts.get(context.identity) !== context
    )
      throw new CuaProcessError("cancelled", "not-sent");
  }

  private context(scope: CuaScope, executionSignal: AbortSignal): Context {
    if (executionSignal.aborted || this.revoked.has(executionSignal))
      throw new CuaProcessError("cancelled", "not-sent");
    if (scope.threadId === null || scope.turnId === null)
      throw new CuaNativeError("ownership-mismatch");
    const identity = JSON.stringify(scope);
    const previousIdentity = this.identities.get(executionSignal);
    if (previousIdentity !== undefined && previousIdentity !== identity)
      throw new CuaNativeError("ownership-mismatch");
    const previous = this.contexts.get(identity);
    const lifetime = this.lifetimes.get(identity);
    if (lifetime && lifetime.executionSignal !== executionSignal)
      throw new CuaNativeError("ownership-mismatch");
    if (previous) {
      if (previous.executionSignal !== executionSignal)
        throw new CuaNativeError("ownership-mismatch");
      return previous;
    }
    if (this.contexts.size + this.retiring.size >= CUA_JAVASCRIPT_MAX_CONTEXTS)
      throw new CuaProcessError("capacity", "not-sent");
    if (!lifetime && this.lifetimes.size >= 16)
      throw new CuaProcessError("capacity", "not-sent");
    const { serverId: _server, ownerId: _owner, ...execution } = scope;
    const context: Context = {
      scope,
      identity,
      executionSignal,
      binding: { ...execution, sessionId: randomUUID() },
      controller: new AbortController(),
      runtime: null,
      sessionId: null,
      busy: false,
      retiring: null,
    };
    if (!lifetime) {
      const abort = () => this.revoke(identity);
      this.lifetimes.set(identity, {
        scope,
        executionSignal,
        release: () => executionSignal.removeEventListener("abort", abort),
      });
      executionSignal.addEventListener("abort", abort, { once: true });
    }
    this.identities.set(executionSignal, identity);
    this.contexts.set(identity, context);
    // Register before launch or approval: even an inventory-only YOLO context
    // belongs to the execution and must be reached by Stop and revocation.
    return context;
  }

  private dispose(context: Context, revoke: boolean): Promise<void> {
    if (revoke) this.revoke(context.identity);
    if (this.contexts.get(context.identity) !== context)
      return context.retiring ?? Promise.resolve();
    this.contexts.delete(context.identity);
    context.controller.abort();
    if (context.sessionId) {
      try {
        this.service.stopSession(context.scope, context.sessionId);
      } catch {}
      context.sessionId = null;
    }
    const runtime = context.runtime;
    if (runtime && !runtime.transport.closed) {
      const work = runtime.transport
        .request(
          { operation: "javascript.reset", binding: context.binding },
          { lifecycle: true },
        )
        .then((response) => {
          if (
            response.payload.length ||
            !z.strictObject({ reset: z.literal(true) }).safeParse(response.data)
              .success
          )
            this.driver.protocolFailure(runtime);
        });
      const retiring = work.finally(() => this.retiring.delete(retiring));
      context.retiring = retiring;
      this.retiring.set(retiring, context.identity);
      this.driver.cleanup(retiring);
      return retiring;
    }
    return Promise.resolve();
  }

  private revoke(identity: string): void {
    const lifetime = this.lifetimes.get(identity);
    if (lifetime) {
      this.revoked.add(lifetime.executionSignal);
      this.lifetimes.delete(identity);
      lifetime.release();
    }
    const context = this.contexts.get(identity);
    if (context) this.dispose(context, false);
  }

  reset(scope: CuaScope, executionSignal: AbortSignal): Promise<void> {
    const identity = JSON.stringify(scope);
    const lifetime = this.lifetimes.get(identity);
    if (lifetime && lifetime.executionSignal !== executionSignal)
      throw new CuaNativeError("ownership-mismatch");
    const context = this.contexts.get(identity);
    if (!context)
      return Promise.all(
        [...this.retiring]
          .filter(([, owner]) => owner === identity)
          .map(([work]) => work),
      ).then(() => {}); // Never launches or creates an identity.
    if (context.executionSignal !== executionSignal)
      throw new CuaNativeError("ownership-mismatch");
    return this.dispose(context, false);
  }

  cancel(matches: (scope: CuaScope) => boolean): void {
    for (const [identity, lifetime] of this.lifetimes)
      if (matches(lifetime.scope)) this.revoke(identity);
  }
  runtimeFailed(runtime: CuaJavascriptRuntime): void {
    for (const context of this.contexts.values())
      if (context.runtime === runtime) this.dispose(context, false);
  }
  nativeSessionClosed(sessionId: string, revoke: boolean): void {
    for (const context of this.contexts.values())
      if (context.sessionId === sessionId) this.dispose(context, revoke);
  }
  private sessionContext(
    scope: CuaScope,
    executionSignal: AbortSignal,
  ): Context | null {
    const context = this.contexts.get(JSON.stringify(scope));
    if (!context) return null;
    if (context.executionSignal !== executionSignal)
      throw new CuaNativeError("ownership-mismatch");
    this.live(context);
    return context;
  }
  sessionSignal(
    scope: CuaScope,
    executionSignal: AbortSignal,
  ): AbortSignal | null {
    const context = this.sessionContext(scope, executionSignal);
    return context?.sessionId ? context.controller.signal : null;
  }
  session(scope: CuaScope, executionSignal: AbortSignal): CuaSession | null {
    const context = this.sessionContext(scope, executionSignal);
    return context?.sessionId
      ? this.service.state(scope, context.sessionId)
      : null;
  }

  async evaluate(
    scope: CuaScope,
    source: string,
    options: CuaJavascriptOptions,
  ): Promise<CuaJavascriptResult> {
    if (
      typeof source !== "string" ||
      Buffer.byteLength(source) > CUA_JAVASCRIPT_MAX_SOURCE_BYTES
    )
      throw new CuaProcessError("invalid-request", "not-sent");
    const wallTimeoutMs = options.wallTimeoutMs ?? 45_000;
    if (
      !Number.isSafeInteger(wallTimeoutMs) ||
      wallTimeoutMs < 1 ||
      wallTimeoutMs > 345_000
    )
      throw new CuaProcessError("invalid-request", "not-sent");
    if (options.signal?.aborted)
      throw new CuaProcessError("cancelled", "not-sent");
    const context = this.context(scope, options.executionSignal);
    if (context.busy) throw new CuaProcessError("capacity", "not-sent");
    context.busy = true;
    const images: CuaSnapshot[] = [];
    const active = AbortSignal.any([
      context.controller.signal,
      context.executionSignal,
      ...(options.signal ? [options.signal] : []),
    ]);
    try {
      const runtime = await this.driver.runtime(active);
      this.live(context, active);
      if (
        !runtime.capabilities?.javascript ||
        !runtime.capabilities.operations.includes("javascript.evaluate") ||
        !runtime.capabilities.operations.includes("javascript.reset")
      )
        throw new CuaNativeError("unsupported");
      context.runtime = runtime;
      const response = await runtime.transport.request(
        {
          operation: "javascript.evaluate",
          binding: context.binding,
          source,
          wallTimeoutMs,
        },
        {
          signal: active,
          timeoutMs: wallTimeoutMs + 2_000,
          onHostCall: async (input, callSignal) => {
            const signal = AbortSignal.any([active, callSignal]);
            this.live(context, signal);
            const parsed = cuaJavascriptActionSchema.safeParse(input);
            if (!parsed.success) throw new CuaNativeError("invalid-request");
            const action = parsed.data;
            const startedAtMs = Date.now();
            const state = () => {
              try {
                return context.sessionId
                  ? this.service.state(scope, context.sessionId)
                  : null;
              } catch {
                return null;
              }
            };
            const before = options.onOperation ? state() : null;
            let error: unknown;
            let failed = false;
            let inputReceipt: CuaInputReceipt | null = null;
            try {
              // Cancellation wins even if a durable-approval adapter resolves late.
              await waitBeforeCuaSend(
                options.authorize(action, signal),
                signal,
              );
              this.live(context, signal);
              const result = await this.host(context, action, signal, images);
              if (result && typeof result === "object" && "input" in result)
                inputReceipt = result.input as CuaInputReceipt;
              this.live(context, signal);
              return result;
            } catch (caught) {
              failed = true;
              error = caught;
              throw caught;
            } finally {
              options.onOperation?.({
                action,
                input: inputReceipt,
                session: state() ?? before,
                target:
                  action.operation === "attach"
                    ? action.target
                    : action.operation === "detach" && before?.target
                      ? {
                          targetId: before.target.id,
                          targetGeneration: before.target.generation,
                        }
                      : null,
                image:
                  !failed && action.operation === "snapshot"
                    ? (images.at(-1)?.image ?? null)
                    : null,
                startedAtMs,
                completedAtMs: Date.now(),
                error,
                failed,
                cancelled: signal.aborted,
              });
            }
          },
        },
      );
      this.live(context, active);
      const result = z
        .strictObject({ value: z.unknown() })
        .safeParse(response.data);
      if (
        response.payload.length ||
        !result.success ||
        !Object.hasOwn(result.data, "value") ||
        Buffer.byteLength(JSON.stringify(result.data)) >
          CUA_JAVASCRIPT_MAX_OUTPUT_BYTES
      )
        return this.driver.protocolFailure(runtime);
      return { value: result.data.value, images };
    } catch (error) {
      for (const image of images) image.payload.fill(0);
      images.length = 0;
      // Failed/ambiguous scripts are never replayed. Their variables, queued
      // host work and native attachment are disposed together.
      this.dispose(context, false);
      throw error;
    } finally {
      context.busy = false;
    }
  }

  private async host(
    context: Context,
    action: CuaJavascriptAction,
    signal: AbortSignal,
    images: CuaSnapshot[],
  ): Promise<unknown> {
    const { scope } = context;
    if (action.operation === "targets")
      return this.service.inventory(scope, signal, action.after);
    const state = () =>
      context.sessionId ? this.service.state(scope, context.sessionId) : null;
    if (action.operation === "state") return { session: state() };
    if (action.operation === "wait") {
      await delay(action.ms, undefined, { signal });
      this.live(context, signal);
      return { waitedMs: action.ms };
    }
    if (action.operation === "attach") {
      const session = context.sessionId
        ? await this.service.attach(
            scope,
            context.sessionId,
            action.target,
            signal,
          )
        : await this.service.open(scope, action.target, signal);
      try {
        this.live(context, signal);
      } catch (error) {
        // A native attach may settle immediately before reset wins. Never
        // leave that completed session outside the disposed context's ownership.
        try {
          this.service.stopSession(scope, session.binding.sessionId);
        } catch {}
        throw error;
      }
      context.sessionId = session.binding.sessionId;
      return { session };
    }
    const session = state();
    if (!session) throw new CuaNativeError("session-not-found");
    const sessionId = session.binding.sessionId;
    if (action.operation === "cursor") return session.cursor;
    if (action.operation === "detach")
      return { session: await this.service.detach(scope, sessionId, signal) };
    if (!session.target) throw new CuaNativeError("target-not-found");
    const target = {
      targetId: session.target.id,
      targetGeneration: session.target.generation,
    };
    if (action.operation === "configureCursor")
      return {
        session: await this.service.configure(
          scope,
          sessionId,
          target,
          action.appearance,
          signal,
        ),
      };
    if (action.operation === "moveCursor")
      return {
        session: await this.service.move(
          scope,
          sessionId,
          target,
          action.point,
          signal,
        ),
      };
    if (
      action.operation === "click" ||
      action.operation === "globalClick" ||
      action.operation === "processClick" ||
      action.operation === "backgroundClick"
    )
      return this.service.click(
        scope,
        sessionId,
        target,
        action.point,
        signal,
        action.operation === "globalClick",
        action.operation === "backgroundClick"
          ? "background"
          : action.operation === "processClick"
            ? "process"
            : undefined,
      );
    if (action.operation === "perform")
      return this.service.perform(
        scope,
        sessionId,
        target,
        action.command,
        signal,
      );
    if (action.operation === "controls")
      return this.service.controls(
        scope,
        sessionId,
        target,
        signal,
        action.point,
      );
    if (action.operation === "press")
      return this.service.press(
        scope,
        sessionId,
        target,
        action.reference,
        signal,
      );
    if (images.length >= CUA_JAVASCRIPT_MAX_IMAGES)
      throw new CuaNativeError("capacity");
    const snapshot = await this.service.snapshot(
      scope,
      sessionId,
      target,
      signal,
    );
    try {
      this.live(context, signal);
      if (
        images.reduce((bytes, image) => bytes + image.payload.length, 0) +
          snapshot.payload.length >
        CUA_JAVASCRIPT_MAX_IMAGE_BYTES
      )
        throw new CuaNativeError("capacity");
    } catch (error) {
      snapshot.payload.fill(0);
      throw error;
    }
    images.push(snapshot);
    return {
      session: snapshot.session,
      image: snapshot.image,
      imageIndex: images.length - 1,
    };
  }
}
