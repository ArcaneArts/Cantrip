import { ManagedNativeQueueUncertainError } from "../managed-native-queue-client.js";
import { CantripServerRequestError } from "../cli-client.js";
import type {
  ManagedNativeGatewayIdentity,
  NativeRpcFrame,
} from "./managed-native-gateway.js";

export const managedNativeQueueMethods = [
  "thread/queue/list",
  "thread/queue/add",
  "thread/queue/update",
  "thread/queue/delete",
  "thread/queue/reorder",
  "thread/queue/start",
] as const;
export type ManagedNativeQueueMethod =
  (typeof managedNativeQueueMethods)[number];
const methods: ReadonlySet<string> = new Set(managedNativeQueueMethods);
export const isManagedNativeQueueMethod = (
  method: string,
): method is ManagedNativeQueueMethod => methods.has(method);

export interface ManagedNativeQueueRequest {
  method: ManagedNativeQueueMethod;
  params: NativeRpcFrame;
  identity: Readonly<ManagedNativeGatewayIdentity>;
  connectionId: string;
  /** Cancels this view's wait; it never rolls back or replays a committed mutation. */
  signal: AbortSignal;
  /** Exact live gateway/runtime incarnation, rechecked after asynchronous protection. */
  assertCurrent(): void;
}
export interface ManagedNativeQueueChange {
  threadId: string;
  revision: string;
}
export interface ManagedNativeQueueGateway {
  /** Queue admission and mutation settlement are one canonical server transaction. */
  execute(request: ManagedNativeQueueRequest): Promise<NativeRpcFrame>;
  subscribe(listener: (change: ManagedNativeQueueChange) => void): () => void;
}

import { createHash } from "node:crypto";
import type {
  EncryptedQueuedPrompt,
  ManagedQueueMutation,
  ManagedQueueSnapshot,
  ManagedQueueMutationResult,
  NativeCommandAdmission,
  NativeCommandSession,
} from "@cantrip/protocol";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import { ManagedNativeQueueClient } from "../managed-native-queue-client.js";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../native-command-content.js";
import {
  managedNativeCommandIntent,
  type ManagedNativePolicyContext,
} from "./managed-native-policy.js";

export interface ManagedNativeQueuedSubmission extends NativeRpcFrame {
  id: string;
  input: unknown[];
  clientUserMessageId: string;
  managed: NativeRpcFrame & {
    frozen: boolean;
    mode: string;
    action: "plain" | "literal" | "parseSlash" | "runShell";
  };
}
export interface ManagedNativeQueuePromptInput {
  request: ManagedNativeQueueRequest;
  id: string;
  existing?: EncryptedQueuedPrompt;
}
export type ManagedNativeQueuePreparedPrompt = Pick<
  Extract<ManagedQueueMutation, { kind: "add" }>,
  "prompt" | "attachments"
>;
export interface ManagedNativeQueueOptions {
  identity: ManagedNativeGatewayIdentity;
  client: Pick<
    ManagedNativeQueueClient,
    "read" | "lookup" | "mutate" | "startReceipt"
  >;
  encryption: Pick<
    WorkerEncryptionService,
    "componentKey" | "ownerId" | "serverIdentity"
  >;
  policy: ManagedNativePolicyContext;
  currentActivationGeneration(): string | null;
  preparePrompt(
    input: ManagedNativeQueuePromptInput,
  ): Promise<ManagedNativeQueuePreparedPrompt>;
  openPrompt(
    prompt: EncryptedQueuedPrompt,
  ): Promise<ManagedNativeQueuedSubmission>;
}
const record = (value: unknown): value is NativeRpcFrame =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.length || value.length > 255)
    throw new Error(`Managed queue ${name} is required.`);
  return value;
};
const revisionNumber = (value: unknown): number => {
  const result =
    typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)
      ? Number(value)
      : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid canonical queue revision.");
  return result;
};

/** Projects the single protected canonical queue into native-shaped operations. */
/** Correlates the first native goal attempt with the acknowledged queue goal mutation, never another attempt. */
export function managedQueueGoalHandoff(
  snapshot: ManagedQueueSnapshot,
  goalEpoch: string | undefined,
): NativeCommandAdmission["goalQueueHandoff"] {
  if (!goalEpoch) return undefined;
  const claim = snapshot.claims.find(
    (candidate) =>
      candidate.awaitingGoal &&
      candidate.goalEpoch === goalEpoch &&
      !candidate.goalOperationId &&
      (candidate.status === "dispatched" || candidate.status === "uncertain"),
  );
  return claim?.operationId && claim.operationGeneration
    ? {
        claimId: claim.id,
        operationId: claim.operationId,
        operationGeneration: claim.operationGeneration,
        goalEpoch,
      }
    : undefined;
}

export class ManagedNativeQueue implements ManagedNativeQueueGateway {
  private readonly listeners = new Set<
    (change: ManagedNativeQueueChange) => void
  >();
  private revision = -1;
  constructor(private readonly options: ManagedNativeQueueOptions) {}

  subscribe(listener: (change: ManagedNativeQueueChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called for canonical server events, including edits originating in another view. */
  publishRevision(change: ManagedNativeQueueChange): void {
    if (change.threadId !== this.options.identity.threadId) return;
    const revision = revisionNumber(change.revision);
    if (revision <= this.revision) return;
    this.revision = revision;
    for (const listener of this.listeners)
      listener({ ...change, revision: String(revision) });
  }

  private observe(snapshot: ManagedQueueSnapshot): void {
    this.publishRevision({
      threadId: this.options.identity.threadId,
      revision: String(snapshot.revision),
    });
  }

  private session(request: ManagedNativeQueueRequest): NativeCommandSession {
    for (const key of Object.keys(
      this.options.identity,
    ) as (keyof ManagedNativeGatewayIdentity)[]) {
      if (request.identity[key] !== this.options.identity[key])
        throw new Error("The managed queue belongs to another native session.");
    }
    if (request.params.threadId !== this.options.identity.threadId)
      throw new Error(
        "The managed queue request targets another native thread.",
      );
    return {
      chatId: request.identity.chatId,
      threadId: request.identity.threadId,
      contextKind: request.identity.contextKind,
      projectId: request.identity.projectId,
      placementId: request.identity.placementId,
      runtimeGeneration: request.identity.runtimeGeneration,
      modelRouteId: request.identity.modelRouteId,
      providerAccountId: request.identity.providerAccountId,
      connectionId: request.connectionId,
    };
  }

  private async open(
    prompt: EncryptedQueuedPrompt,
  ): Promise<ManagedNativeQueuedSubmission> {
    const submission = await this.options.openPrompt(prompt);
    if (
      submission.id !== prompt.id ||
      !Array.isArray(submission.input) ||
      typeof submission.clientUserMessageId !== "string" ||
      !record(submission.managed) ||
      typeof submission.managed.frozen !== "boolean" ||
      typeof submission.managed.mode !== "string" ||
      !["plain", "literal", "parseSlash", "runShell"].includes(
        submission.managed.action,
      )
    )
      throw new Error(
        "The protected canonical queue item has an invalid identity.",
      );
    return submission;
  }

  async execute(request: ManagedNativeQueueRequest): Promise<NativeRpcFrame> {
    request.signal.throwIfAborted();
    request.assertCurrent();
    const session = this.session(request);
    let admission: Omit<NativeCommandAdmission, "workerId"> | null = null;
    let operationId = "";
    if (request.method !== "thread/queue/list") {
      const managed = request.params.managed;
      operationId = nonempty(
        record(managed) ? managed.operationId : undefined,
        "operation ID",
      );
      const frame = { method: request.method, params: request.params };
      const intent = await managedNativeCommandIntent(
        {
          operationId,
          origin: "terminal",
          identity: request.identity,
          connectionId: request.connectionId,
          kind: "mutation",
          method: request.method,
          frame,
        },
        this.options.policy,
      );
      const protectedContent = await protectNativeCommandContent({
        service: this.options.encryption,
        context: { chatId: session.chatId, operationId, direction: "request" },
        content: frame,
      });
      request.signal.throwIfAborted();
      request.assertCurrent();
      admission = {
        operationId,
        origin: "terminal",
        session,
        method: request.method,
        intent,
        expectedActivationGeneration:
          this.options.currentActivationGeneration(),
        protectedPayload: protectedContent.envelope,
        payloadDigest: protectedContent.digest,
      };
      const previous = await this.options.client.lookup(
        { admission },
        request.signal,
      );
      if (previous.found)
        return this.complete(request, session, operationId, previous);
    }
    const snapshot = await this.options.client.read(
      { session },
      request.signal,
    );
    request.assertCurrent();
    this.observe(snapshot);
    if (request.method === "thread/queue/list") {
      let offset = 0;
      if (request.params.cursor != null) {
        if (typeof request.params.cursor !== "string")
          throw new Error("Invalid canonical queue cursor.");
        let cursor: unknown;
        try {
          cursor = JSON.parse(
            Buffer.from(request.params.cursor, "base64url").toString("utf8"),
          );
        } catch {
          throw new Error("Invalid canonical queue cursor.");
        }
        if (
          !record(cursor) ||
          cursor.revision !== snapshot.revision ||
          !Number.isSafeInteger(cursor.offset) ||
          Number(cursor.offset) < 0
        )
          throw new Error(
            "The canonical queue changed; reload its first page.",
          );
        offset = Number(cursor.offset);
      }
      const limit =
        request.params.limit == null
          ? Math.max(1, snapshot.items.length)
          : request.params.limit;
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        (request.params.limit != null && limit > 1000)
      )
        throw new Error("Invalid canonical queue page limit.");
      const selected = snapshot.items.slice(offset, offset + limit);
      const data = await Promise.all(
        selected.map((prompt) => this.open(prompt)),
      );
      request.signal.throwIfAborted();
      const next = offset + selected.length;
      return {
        data,
        nextCursor:
          next < snapshot.items.length
            ? Buffer.from(
                JSON.stringify({ revision: snapshot.revision, offset: next }),
              ).toString("base64url")
            : null,
        managedQueue: {
          revision: String(snapshot.revision),
          paused: snapshot.paused,
          pendingImports: await Promise.all(
            (snapshot.pendingImports ?? []).map(async (pending) => ({
              id: pending.importId,
              nativeItemId: pending.nativeItemId,
              status: pending.status,
              input: (await this.open(pending.prompt)).input,
            })),
          ),
        },
      };
    }

    const expectedRevision =
      request.params.expectedRevision == null
        ? snapshot.revision
        : revisionNumber(request.params.expectedRevision);
    let mutation: ManagedQueueMutation;
    switch (request.method) {
      case "thread/queue/add": {
        if (!Array.isArray(request.params.input))
          throw new Error("Managed queue input must be a native input vector.");
        nonempty(request.params.clientUserMessageId, "client message ID");
        // Item identity is stable even when an uncertain operation is retried
        // from another view. The server still verifies its protected digest.
        const bytes = createHash("sha256")
          .update(
            JSON.stringify([
              request.identity.serverId,
              request.identity.ownerId,
              session.chatId,
              operationId,
            ]),
          )
          .digest()
          .subarray(0, 16);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = bytes.toString("hex");
        const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        const prepared = await this.options.preparePrompt({ request, id });
        if (prepared.prompt.id !== id)
          throw new Error(
            "A canonical queue add changed its stable item identity.",
          );
        mutation = { kind: "add", ...prepared };
        break;
      }
      case "thread/queue/update":
      case "thread/queue/delete": {
        const id = nonempty(request.params.queuedSubmissionId, "item ID");
        const existing = snapshot.items.find((item) => item.id === id);
        if (!existing)
          throw new Error("The canonical queue item no longer exists.");
        if (request.method === "thread/queue/delete")
          mutation = {
            kind: "delete",
            id,
            expectedItemRevision: existing.revision,
          };
        else {
          if (!Array.isArray(request.params.input))
            throw new Error(
              "Managed queue input must be a native input vector.",
            );
          const prepared = await this.options.preparePrompt({
            request,
            id,
            existing,
          });
          if (prepared.prompt.id !== id)
            throw new Error(
              "A canonical queue edit cannot replace its item identity.",
            );
          mutation = {
            kind: "update",
            id,
            expectedItemRevision: existing.revision,
            ...prepared,
          };
        }
        break;
      }
      case "thread/queue/reorder": {
        if (!Array.isArray(request.params.queuedSubmissionIds))
          throw new Error("Managed queue order is required.");
        mutation = {
          kind: "reorder",
          ids: request.params.queuedSubmissionIds.map((id) =>
            nonempty(id, "item ID"),
          ),
        };
        break;
      }
      case "thread/queue/start":
        mutation = {
          kind: "start",
          ...(request.params.queuedSubmissionId == null
            ? {}
            : { id: nonempty(request.params.queuedSubmissionId, "item ID") }),
        };
        break;
      default:
        throw new Error("Unsupported canonical queue method.");
    }
    request.signal.throwIfAborted();
    request.assertCurrent();
    const result = await this.options.client.mutate(
      {
        admission: admission!,
        expectedRevision,
        mutation,
      },
      request.signal,
    );
    return this.complete(request, session, operationId, result);
  }

  private async complete(
    request: ManagedNativeQueueRequest,
    session: NativeCommandSession,
    operationId: string,
    result: ManagedQueueMutationResult,
  ): Promise<NativeRpcFrame> {
    try {
      return await this.completeReceipt(request, session, operationId, result);
    } catch (error) {
      if (
        error instanceof CantripServerRequestError ||
        error instanceof ManagedNativeQueueUncertainError
      )
        throw error;
      if (result.receipt.status === "rejected") throw error;
      throw new ManagedNativeQueueUncertainError(
        error instanceof Error
          ? error.message
          : "The canonical queue acknowledgment is uncertain.",
        error,
      );
    }
  }

  private async completeReceipt(
    request: ManagedNativeQueueRequest,
    session: NativeCommandSession,
    operationId: string,
    result: ManagedQueueMutationResult,
  ): Promise<NativeRpcFrame> {
    this.observe(result);
    if (result.receipt.status !== "applied")
      throw new Error(
        `Canonical queue operation is ${result.receipt.status}; reconcile this operation before retrying.`,
      );
    if (request.method === "thread/queue/start") {
      if (!result.claim)
        throw new Error("Canonical queue start returned no execution claim.");
      const started = await this.options.client.startReceipt(
        { session, claimId: result.claim.id },
        request.signal,
      );
      const content = await openNativeCommandContent({
        service: this.options.encryption,
        context: {
          chatId: session.chatId,
          operationId: started.receipt.operationId,
          direction: "result",
        },
        envelope: started.protectedResult,
      });
      // GUI runTurn persists the actual TurnStartResponse directly; gateway mutations
      // persist its JSON-RPC envelope. Both retain the real native turn identity.
      const actualResult =
        record(content) && !("error" in content)
          ? record(content.result)
            ? content.result
            : started.receipt.method === "turn/start" && record(content.turn)
              ? content
              : null
          : null;
      if (!actualResult)
        throw new Error(
          "The claimed queue action has no successful native acknowledgment.",
        );
      request.signal.throwIfAborted();
      if (started.receipt.method !== "turn/start") {
        if (
          ![
            "thread/shellCommand",
            "thread/settings/update",
            "thread/goal/set",
            "thread/goal/clear",
          ].includes(started.receipt.method) ||
          started.receipt.status !== "applied"
        )
          throw new Error(
            "The claimed queue action has no supported native acknowledgment.",
          );
        return {
          managedAction: {
            operationId,
            executionOperationId: started.receipt.operationId,
            method: started.receipt.method,
            status: "applied",
          },
        };
      }
      // A queue claim cannot substitute for the actual native Turn receipt.
      if (
        !record(actualResult.turn) ||
        typeof actualResult.turn.id !== "string" ||
        actualResult.turn.id !== started.claim.nativeTurnId
      )
        throw new Error(
          "The claimed queue item has no correlated native Turn acknowledgment.",
        );
      return actualResult;
    }
    if (
      request.method === "thread/queue/add" ||
      request.method === "thread/queue/update"
    ) {
      const item = result.acceptedItem;
      if (!item)
        throw new Error(
          "The canonical queue receipt does not contain its accepted item.",
        );
      return { queuedSubmission: await this.open(item) };
    }
    return request.method === "thread/queue/delete" ? { deleted: true } : {};
  }
}
