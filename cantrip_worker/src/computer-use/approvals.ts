import { createHash, randomUUID } from "node:crypto";
import {
  clearSensitiveBytes,
  encryptInteractionRequestContent,
} from "@cantrip/crypto";
import {
  agentInteractionResponseSchema,
  encryptedAgentInteractionRequestCreateSchema,
  type AgentInteractionAccepted,
  type EncryptedAgentInteractionRequestCreate,
  type WorkerComputerUseApprovalResponseCommand,
} from "@cantrip/protocol";
import {
  cuaScopeSchema,
  cuaTargetReferenceSchema,
  type ComputerUseOperation,
  type CuaScope,
  type CuaTargetReference,
} from "@cantrip/protocol/computer-use";
import { openAgentInteractionResponse } from "../interaction-encryption.js";
import type { WorkerEndpointEncryptionService } from "../endpoint-content-encryption.js";
import {
  computerUsePermissionDecision,
  type CuaPermissionProfile,
} from "./permission-policy.js";

const MAX_PENDING = 32;
const MAX_GRANTS = 64;
const MAX_COMPLETED = 128;
const APPROVAL_LIFETIME_MS = 5 * 60_000;

export class CuaApprovalError extends Error {
  constructor(
    readonly code:
      | "closed"
      | "revoked"
      | "expired"
      | "capacity"
      | "cancelled"
      | "denied"
      | "publication-failed"
      | "invalid-response"
      | "encryption-unavailable"
      | "ownership-mismatch",
  ) {
    super(
      {
        closed: "Computer-use approvals are closed.",
        revoked: "This computer-use approval is no longer active.",
        expired: "This computer-use approval expired.",
        capacity: "Computer-use approval capacity was reached.",
        cancelled: "This computer-use approval call was cancelled.",
        denied: "Computer-use permission was denied.",
        "publication-failed":
          "The computer-use approval could not be published.",
        "invalid-response":
          "The response does not match the requested computer-use permissions.",
        "encryption-unavailable":
          "Computer-use approval encryption is unavailable.",
        "ownership-mismatch":
          "The computer-use approval belongs to another execution context.",
      }[code],
    );
    this.name = "CuaApprovalError";
  }
}

export interface CuaApprovalContext {
  scope: CuaScope;
  projectId: string | null;
  executionLaneId: string | null;
  profile: CuaPermissionProfile;
  /** Owned by the execution coordinator; abort on policy/scope revocation. */
  signal: AbortSignal;
  /** Present only for a genuine client-preview lifetime, never a native turn. */
  previewLeaseId?: string;
}
type PermissionRequest = {
  computerUse: {
    version: 1;
    classes: string[];
    target: CuaTargetReference | null;
  };
};
interface Entry {
  context: CuaApprovalContext;
  key: string;
  requestKey: string;
  permissions: PermissionRequest;
  expiresAt: number;
  request: Promise<EncryptedAgentInteractionRequestCreate>;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  decision: Promise<ApprovalDecision>;
  decide: (decision: ApprovalDecision) => void;
  waiter?: Waiter;
}
type ApprovalDecision = { remaining: number } | CuaApprovalError;
interface AuthorizationInput {
  context: CuaApprovalContext;
  operation: ComputerUseOperation;
  target?: CuaTargetReference | null;
}
interface Waiter {
  context: CuaApprovalContext;
  entry?: Entry;
  cancelled: CuaApprovalError | null;
  cancellation: Promise<CuaApprovalError>;
  cancel: (error: CuaApprovalError) => void;
}
interface Grant {
  context: CuaApprovalContext;
  remaining: number;
}
interface Completed {
  context: CuaApprovalContext;
  responseDigest: string;
}

export interface CuaApprovalManagerOptions {
  workerId: string;
  encryption: WorkerEndpointEncryptionService & { serverIdentity(): string };
  /** Lifecycle owner publishes this through existing durable interactions. */
  onTerminal?: (input: {
    requestKey: string;
    chatId: string;
    status: "expired" | "interrupted";
  }) => void;
  now?: () => number;
}

/** No native work or automatic replay. Preview callers receive the exact
 * protected request and consume its grant on retry. Agent callers can instead
 * await that decision and resume the same suspended action exactly once. */
export class CuaApprovalManager {
  private pending = new Map<string, Entry>();
  private byKey = new Map<string, Entry>();
  private grants = new Map<string, Grant>();
  private completed = new Map<string, Completed>();
  private leases = new WeakMap<AbortSignal, number>();
  private revokedLeases = new WeakSet<AbortSignal>();
  private nextLease = 0;
  private closed = false;
  private waiters = new Set<Waiter>();

  constructor(private readonly options: CuaApprovalManagerOptions) {}

  status() {
    return {
      pending: this.pending.size,
      grants: this.grants.size,
      completed: this.completed.size,
      closed: this.closed,
    };
  }

  contextForResponse(requestKey: string): CuaApprovalContext | null {
    const context =
      this.pending.get(requestKey)?.context ??
      this.completed.get(requestKey)?.context;
    return context
      ? {
          ...context,
          scope: { ...context.scope },
          profile: { ...context.profile },
        }
      : null;
  }

  authorize(input: AuthorizationInput) {
    return this.authorizeRequest(input);
  }

  /** Resume one suspended host call, never replay its enclosing script. The
   * actual execution lifetime and transient call cancellation stay distinct. */
  async authorizeAndWait(
    input: AuthorizationInput & {
      signal?: AbortSignal;
      publish: (
        request: EncryptedAgentInteractionRequestCreate,
      ) => Promise<void>;
    },
  ): Promise<void> {
    this.ensureOpen();
    const context = this.context(input.context);
    // Stop uses existing authenticated ownership, never waiter capacity,
    // publication, or a transient call/turn cancellation gate.
    if (input.operation === "session.close") {
      await this.authorizeRequest({ ...input, context });
      return;
    }
    if (input.signal?.aborted) throw new CuaApprovalError("cancelled");
    if (this.waiters.size >= MAX_PENDING)
      throw new CuaApprovalError("capacity");
    let cancel!: (error: CuaApprovalError) => void;
    const cancellation = new Promise<CuaApprovalError>((resolve) => {
      cancel = resolve;
    });
    const waiter: Waiter = {
      context,
      cancelled: null,
      cancellation,
      cancel: (error) => {
        if (waiter.cancelled) return;
        waiter.cancelled = error;
        cancel(error);
        if (waiter.entry)
          this.remove(
            waiter.entry,
            error.code === "expired" ? "expired" : "interrupted",
          );
      },
    };
    this.waiters.add(waiter);
    const checkCancellation = () => {
      if (waiter.cancelled) throw waiter.cancelled;
    };
    const abortCall = () => waiter.cancel(new CuaApprovalError("cancelled"));
    const abortContext = () => waiter.cancel(new CuaApprovalError("revoked"));
    input.signal?.addEventListener("abort", abortCall, { once: true });
    context.signal.addEventListener("abort", abortContext, { once: true });
    const cancelled = cancellation.then((error) => {
      throw error;
    });
    // Attach the rejection handler before any asynchronous preparation can fail.
    void cancelled.catch(() => {});
    const work: Promise<unknown>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const authorization = this.authorizeRequest(
        { ...input, context },
        waiter,
      );
      work.push(authorization);
      const result = await Promise.race([authorization, cancelled]);
      checkCancellation();
      if (result.status === "allowed") return;
      const entry = waiter.entry!;
      timer = setTimeout(
        () => waiter.cancel(new CuaApprovalError("expired")),
        Math.max(0, entry.expiresAt - this.now()),
      );
      timer.unref();
      const publication = Promise.resolve().then(async () => {
        checkCancellation();
        try {
          await input.publish(result.request);
        } catch {
          throw new CuaApprovalError("publication-failed");
        }
        // A cancelled call returns promptly, but its queued publication may
        // complete later. Place a terminal event after that publication too.
        if (waiter.cancelled && waiter.cancelled.code !== "denied") {
          this.terminal(
            entry,
            waiter.cancelled.code === "expired" ? "expired" : "interrupted",
          );
          throw waiter.cancelled;
        }
      });
      work.push(publication);
      const [, decision] = await Promise.race([
        Promise.all([
          publication,
          entry.decision.then((value) => {
            if (value instanceof CuaApprovalError) throw value;
            return value;
          }),
        ]),
        cancelled,
      ]);
      checkCancellation();
      if (this.revoked(context)) throw new CuaApprovalError("revoked");
      if (entry.expiresAt <= this.now()) throw new CuaApprovalError("expired");
      // The suspended call consumes the first use. Grant visibility begins
      // only after durable publication succeeded, even if answer arrived first.
      if (decision.remaining > 1) {
        if (!this.grants.has(entry.key) && this.grants.size >= MAX_GRANTS)
          throw new CuaApprovalError("capacity");
        this.grants.set(entry.key, {
          context,
          remaining: decision.remaining - 1,
        });
      }
    } catch (error) {
      if (error instanceof CuaApprovalError) waiter.cancel(error);
      else waiter.cancel(new CuaApprovalError("publication-failed"));
      throw waiter.cancelled;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortCall);
      context.signal.removeEventListener("abort", abortContext);
      waiter.entry = undefined;
      if (!waiter.cancelled) this.waiters.delete(waiter);
      // A publisher that ignores cancellation still occupies its bounded slot;
      // repeated cancelled calls cannot accumulate unbounded orphan publishers.
      void Promise.allSettled(work).then(() => this.waiters.delete(waiter));
    }
  }

  private async authorizeRequest(
    input: AuthorizationInput,
    waiter?: Waiter,
  ): Promise<
    | { status: "allowed" }
    | {
        status: "approval-required";
        request: EncryptedAgentInteractionRequestCreate;
      }
  > {
    this.ensureOpen();
    const context = this.context(input.context);
    const decision = computerUsePermissionDecision(
      input.operation,
      context.profile,
    );
    // Stop must still be available for an aborted but correctly owned context.
    if (input.operation === "session.close") return { status: "allowed" };
    if (this.revoked(context)) throw new CuaApprovalError("revoked");
    if (decision.kind === "allow") return { status: "allowed" };
    const target = input.target
      ? cuaTargetReferenceSchema.parse(input.target)
      : null;
    const permissions: PermissionRequest = {
      computerUse: { version: 1, classes: [...decision.classes], target },
    };
    const key = this.key(context, permissions);
    const granted = this.grants.get(key);
    if (granted && !granted.context.signal.aborted) {
      if (--granted.remaining === 0) this.grants.delete(key);
      return { status: "allowed" };
    }
    this.grants.delete(key);
    if (
      [...this.waiters].some(
        (other) =>
          other !== waiter && !other.cancelled && other.entry?.key === key,
      )
    )
      throw new CuaApprovalError("capacity");
    let entry = this.byKey.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.remove(entry, "expired");
      entry = undefined;
    }
    if (!entry) {
      this.prune();
      if (this.pending.size >= MAX_PENDING)
        throw new CuaApprovalError("capacity");
      const requestKey = randomUUID();
      const expiresAt = this.now() + APPROVAL_LIFETIME_MS;
      const abort = () => {
        const current = this.pending.get(requestKey);
        if (current) this.remove(current, "interrupted");
      };
      const timer = setTimeout(() => {
        const current = this.pending.get(requestKey);
        if (current) this.remove(current, "expired");
      }, APPROVAL_LIFETIME_MS);
      timer.unref();
      const request = this.protect(context, requestKey, expiresAt, permissions);
      let decide!: (decision: ApprovalDecision) => void;
      const decision = new Promise<ApprovalDecision>((resolve) => {
        decide = resolve;
      });
      entry = {
        context,
        key,
        requestKey,
        permissions,
        expiresAt,
        request,
        timer,
        abort,
        decision,
        decide,
      };
      this.pending.set(requestKey, entry);
      this.byKey.set(key, entry);
      context.signal.addEventListener("abort", abort, { once: true });
    }
    if (waiter) {
      waiter.entry = entry;
      entry.waiter = waiter;
    }
    try {
      const request = await entry.request;
      if (this.revoked(context) || this.pending.get(entry.requestKey) !== entry)
        throw new CuaApprovalError("revoked");
      if (entry.expiresAt <= this.now()) {
        this.remove(entry, "expired");
        throw new CuaApprovalError("expired");
      }
      return { status: "approval-required", request: structuredClone(request) };
    } catch (error) {
      this.remove(entry, "interrupted");
      if (error instanceof CuaApprovalError) throw error;
      throw new CuaApprovalError("encryption-unavailable");
    }
  }

  async answer(
    command: WorkerComputerUseApprovalResponseCommand,
  ): Promise<AgentInteractionAccepted> {
    this.ensureOpen();
    const entry = this.pending.get(command.requestKey);
    const prior = this.completed.get(command.requestKey);
    const context = entry?.context ?? prior?.context;
    if (!context) throw new CuaApprovalError("revoked");
    this.context(context);
    if (
      command.ownerId !== context.scope.ownerId ||
      command.chatId !== context.scope.chatId ||
      command.executionLaneId !== context.executionLaneId
    )
      throw new CuaApprovalError("ownership-mismatch");
    if (this.revoked(context)) throw new CuaApprovalError("revoked");
    const responseDigest = createHash("sha256")
      .update(JSON.stringify(command.response))
      .digest("hex");
    if (prior) {
      if (prior.responseDigest !== responseDigest)
        throw new CuaApprovalError("invalid-response");
      return { accepted: true };
    }
    if (!entry) throw new CuaApprovalError("revoked");
    if (entry.expiresAt <= this.now()) {
      this.remove(entry, "expired");
      throw new CuaApprovalError("expired");
    }
    let response;
    try {
      response = agentInteractionResponseSchema.parse(
        await openAgentInteractionResponse({
          requestKey: command.requestKey,
          response: command.response,
          service: this.options.encryption,
        }),
      );
    } catch {
      throw new CuaApprovalError("invalid-response");
    }
    if (this.revoked(context)) throw new CuaApprovalError("revoked");
    if (this.pending.get(command.requestKey) !== entry) {
      if (
        this.completed.get(command.requestKey)?.responseDigest ===
        responseDigest
      )
        return { accepted: true };
      throw new CuaApprovalError("revoked");
    }
    if (entry.expiresAt <= this.now()) {
      this.remove(entry, "expired");
      throw new CuaApprovalError("expired");
    }
    if (response.kind !== "permissions" || response.strictAutoReview)
      throw new CuaApprovalError("invalid-response");
    const denied = JSON.stringify(response.permissions) === "{}";
    if (!denied && !samePermissions(response.permissions, entry.permissions))
      throw new CuaApprovalError("invalid-response");
    this.prune();
    if (
      !denied &&
      !this.grants.has(entry.key) &&
      this.grants.size >= MAX_GRANTS
    )
      throw new CuaApprovalError("capacity");
    const remaining =
      response.scope === "turn" && context.scope.turnId === null ? 1 : Infinity;
    if (!denied && !entry.waiter)
      this.grants.set(entry.key, {
        context,
        // An idle preview has no native turn: the UI's turn choice is one use,
        // never a fabricated turn or an indefinite grant.
        remaining,
      });
    entry.decide(denied ? new CuaApprovalError("denied") : { remaining });
    this.remove(entry);
    this.completed.set(command.requestKey, { context, responseDigest });
    while (this.completed.size > MAX_COMPLETED)
      this.completed.delete(this.completed.keys().next().value!);
    return { accepted: true };
  }

  revokeContext(signal: AbortSignal) {
    // Revoke the lifetime even if it has not yet published an approval.
    this.revokedLeases.add(signal);
    this.revoke((context) => context.signal === signal);
  }
  revokeChat(chatId: string) {
    this.revoke((context) => context.scope.chatId === chatId);
  }
  revokeThread(threadId: string) {
    this.revoke((context) => context.scope.threadId === threadId);
  }
  disconnect() {
    this.revoke(() => true);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.disconnect();
  }

  private context(input: CuaApprovalContext): CuaApprovalContext {
    const scope = cuaScopeSchema.parse(input.scope);
    if (
      scope.workerId !== this.options.workerId ||
      scope.ownerId !== this.options.encryption.ownerId() ||
      scope.serverId !== this.options.encryption.serverIdentity()
    )
      throw new CuaApprovalError("ownership-mismatch");
    return { ...input, scope, profile: { ...input.profile } };
  }
  private key(context: CuaApprovalContext, permissions: PermissionRequest) {
    let lease = this.leases.get(context.signal);
    if (lease === undefined) {
      lease = ++this.nextLease;
      this.leases.set(context.signal, lease);
    }
    return JSON.stringify([
      context.scope,
      context.executionLaneId,
      context.profile.selectedId,
      context.profile.effectiveId,
      context.profile.forcedByWorktreePolicy,
      lease,
      permissions,
    ]);
  }
  private async protect(
    context: CuaApprovalContext,
    requestKey: string,
    expiresAt: number,
    permissions: PermissionRequest,
  ) {
    const component = this.options.encryption.componentKey(
      "interaction-content",
    );
    const classification = { kind: "permissions" as const };
    try {
      const protectedPayload = await encryptInteractionRequestContent({
        ownerId: context.scope.ownerId,
        requestKey,
        keyRevision: component.keyRevision,
        componentKey: component.key,
        content: {
          version: 1,
          classification,
          payload: {
            kind: "permissions",
            source: "native-computer-use",
            startedAtMs: this.now(),
            environmentId: null,
            cwd: null,
            reason:
              "Allow Cantrip Computer Use on this agent's worker? No native clicks or keyboard input are included.",
            requestedPermissions: permissions,
          },
        },
      });
      return encryptedAgentInteractionRequestCreateSchema.parse({
        requestKey,
        projectId: context.projectId,
        provenance: {
          owner: "computer-use",
          chatId: context.scope.chatId,
          threadId: context.scope.threadId,
          turnId: context.scope.turnId,
          itemId: null,
          executionLaneId: context.executionLaneId,
          workerId: context.scope.workerId,
        },
        classification,
        protectedPayload,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    } finally {
      clearSensitiveBytes(component.key);
    }
  }
  private remove(entry: Entry, status?: "expired" | "interrupted") {
    if (this.pending.get(entry.requestKey) !== entry) return;
    this.pending.delete(entry.requestKey);
    this.byKey.delete(entry.key);
    clearTimeout(entry.timer);
    entry.context.signal.removeEventListener("abort", entry.abort);
    if (status) {
      const error = new CuaApprovalError(
        status === "expired" ? "expired" : "revoked",
      );
      entry.decide(error);
      entry.waiter?.cancel(error);
      this.terminal(entry, status);
    }
  }
  private terminal(entry: Entry, status: "expired" | "interrupted") {
    try {
      void Promise.resolve(
        this.options.onTerminal?.({
          requestKey: entry.requestKey,
          chatId: entry.context.scope.chatId,
          status,
        }),
      ).catch(() => {});
    } catch {
      /* Observer failures cannot revive authority. */
    }
  }
  private revoke(matches: (context: CuaApprovalContext) => boolean) {
    for (const waiter of this.waiters)
      if (matches(waiter.context)) {
        this.revokedLeases.add(waiter.context.signal);
        waiter.cancel(new CuaApprovalError("revoked"));
      }
    for (const entry of this.pending.values())
      if (matches(entry.context)) {
        this.revokedLeases.add(entry.context.signal);
        this.remove(entry, "interrupted");
      }
    for (const [key, grant] of this.grants)
      if (matches(grant.context)) {
        this.revokedLeases.add(grant.context.signal);
        this.grants.delete(key);
      }
    for (const [key, value] of this.completed)
      if (matches(value.context)) {
        this.revokedLeases.add(value.context.signal);
        this.completed.delete(key);
      }
  }
  private prune() {
    for (const entry of this.pending.values())
      if (entry.expiresAt <= this.now()) this.remove(entry, "expired");
    for (const [key, grant] of this.grants)
      if (grant.context.signal.aborted) this.grants.delete(key);
  }
  private ensureOpen() {
    if (this.closed) throw new CuaApprovalError("closed");
  }
  private revoked(context: CuaApprovalContext) {
    return context.signal.aborted || this.revokedLeases.has(context.signal);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

function samePermissions(value: unknown, expected: PermissionRequest): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "computerUse"
  )
    return false;
  const inner = (value as PermissionRequest).computerUse;
  if (
    !inner ||
    typeof inner !== "object" ||
    Object.keys(inner).sort().join() !== "classes,target,version" ||
    inner.version !== 1 ||
    !Array.isArray(inner.classes)
  )
    return false;
  return (
    JSON.stringify([...inner.classes].sort()) ===
      JSON.stringify([...expected.computerUse.classes].sort()) &&
    (inner.target === null
      ? expected.computerUse.target === null
      : cuaTargetReferenceSchema.safeParse(inner.target).success &&
        expected.computerUse.target !== null &&
        inner.target.targetId === expected.computerUse.target.targetId &&
        inner.target.targetGeneration ===
          expected.computerUse.target.targetGeneration)
  );
}
