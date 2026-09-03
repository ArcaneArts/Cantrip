import { randomUUID } from "node:crypto";

import {
  agentInteractionRequestSchema,
  encryptedAgentInteractionRequestSchema,
} from "@cantrip/protocol";
import type {
  AgentInteractionRequest,
  AgentInteractionRequestCreate,
  AgentInteractionRequestPayload,
  AgentInteractionRequestQuery,
  AgentInteractionRequestWire,
  AgentInteractionResolutionCreate,
  AgentInteractionResponse,
  EncryptedAgentInteractionRequest,
  EncryptedAgentInteractionRequestCreate,
  EncryptedAgentInteractionResolutionCreate,
} from "@cantrip/protocol";
import { and, desc, eq, lte } from "drizzle-orm";

import * as schema from "../schema.js";
import {
  firstOrThrow,
  toISOString,
  type RepositoryDatabase,
} from "./database.js";

export class AgentInteractionConflictError extends Error {}

interface AgentInteractionRepositoryCollaborators {
  expireAgentInteractionRequests(
    now?: Date,
  ): Promise<AgentInteractionRequestWire[]>;
  getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequestWire | null>;
}

function agentInteractionRequestBase(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): Omit<AgentInteractionRequest, "payload" | "response"> {
  return {
    id: request.id,
    requestKey: request.requestKey,
    projectId: request.projectId,
    provenance: {
      chatId: request.chatId,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      executionLaneId: request.executionLaneId,
      workerId: request.workerId,
    },
    status: request.status,
    resolvedByUserId: request.resolvedByUserId,
    expiresAt: request.expiresAt ? toISOString(request.expiresAt) : null,
    resolvedAt: request.resolvedAt ? toISOString(request.resolvedAt) : null,
    createdAt: toISOString(request.createdAt),
    updatedAt: toISOString(request.updatedAt),
  } as Omit<AgentInteractionRequest, "payload" | "response">;
}

function toAgentInteractionRequestWire(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequestWire {
  const base = agentInteractionRequestBase(request);
  if (request.protectedPayload) {
    if (request.payload || request.response) {
      throw new Error("An interaction row mixes visible and protected data.");
    }
    return encryptedAgentInteractionRequestSchema.parse({
      ...base,
      classification: { kind: request.kind },
      protectedPayload: request.protectedPayload,
      protectedResponse: request.protectedResponse,
    });
  }
  if (!request.payload || request.protectedResponse) {
    throw new Error("An interaction row has incomplete protected data.");
  }
  return agentInteractionRequestSchema.parse({
    ...base,
    payload: request.payload,
    response: request.response,
  });
}

function toAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): AgentInteractionRequest {
  return agentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
}

function toEncryptedAgentInteractionRequest(
  request: typeof schema.agentInteractionRequests.$inferSelect,
): EncryptedAgentInteractionRequest {
  return encryptedAgentInteractionRequestSchema.parse(
    toAgentInteractionRequestWire(request),
  );
}

function agentInteractionResponseForStorage(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): AgentInteractionResponse {
  if (payload.kind !== "userInput" || response.kind !== "userInput") {
    return response;
  }
  const secretQuestionIds = new Set(
    payload.questions
      .filter((question) => question.isSecret)
      .map((question) => question.id),
  );
  return {
    ...response,
    answers: Object.fromEntries(
      Object.entries(response.answers).map(([questionId, answer]) => [
        questionId,
        secretQuestionIds.has(questionId)
          ? { answers: ["[redacted]"] }
          : answer,
      ]),
    ),
  };
}

function validateAgentInteractionResponse(
  payload: AgentInteractionRequestPayload,
  response: AgentInteractionResponse,
): void {
  if (payload.kind !== response.kind) {
    throw new AgentInteractionConflictError(
      "Response kind does not match the pending request.",
    );
  }
  if (payload.kind === "commandExecution") {
    if (response.kind !== "commandExecution") return;
    if (
      payload.availableDecisions &&
      !payload.availableDecisions.includes(response.decision)
    ) {
      throw new AgentInteractionConflictError(
        "Command response is not one of the available decisions.",
      );
    }
    if (
      response.decision === "acceptWithExecpolicyAmendment" &&
      !response.execpolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "An execpolicy amendment is required for this decision.",
      );
    }
    if (
      response.decision === "applyNetworkPolicyAmendment" &&
      !response.networkPolicyAmendment
    ) {
      throw new AgentInteractionConflictError(
        "A network policy amendment is required for this decision.",
      );
    }
  }
  if (payload.kind === "userInput") {
    if (response.kind !== "userInput") return;
    const questionIds = new Set(
      payload.questions.map((question) => question.id),
    );
    const answerIds = Object.keys(response.answers);
    if (
      answerIds.length !== questionIds.size ||
      answerIds.some((questionId) => !questionIds.has(questionId))
    ) {
      throw new AgentInteractionConflictError(
        "User input responses must answer each requested question exactly once.",
      );
    }
  }
  if (payload.kind === "permissions") {
    if (response.kind !== "permissions") return;
    if (
      !jsonPermissionSubset(response.permissions, payload.requestedPermissions)
    ) {
      throw new AgentInteractionConflictError(
        "Granted permissions must be a subset of the requested permissions.",
      );
    }
  }
}

function jsonPermissionSubset(granted: unknown, requested: unknown): boolean {
  if (Array.isArray(granted)) {
    if (!Array.isArray(requested)) return false;
    return granted.every((candidate) =>
      requested.some(
        (allowed) => JSON.stringify(candidate) === JSON.stringify(allowed),
      ),
    );
  }
  if (granted && typeof granted === "object") {
    if (
      !requested ||
      typeof requested !== "object" ||
      Array.isArray(requested)
    ) {
      return false;
    }
    const requestedRecord = requested as Record<string, unknown>;
    return Object.entries(granted).every(
      ([key, value]) =>
        key in requestedRecord &&
        jsonPermissionSubset(value, requestedRecord[key]),
    );
  }
  return Object.is(granted, requested);
}

export class AgentInteractionRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: AgentInteractionRepositoryCollaborators,
  ) {}

  private async resolveAgentInteractionOwner(input: {
    projectId: string | null;
    provenance: { chatId: string | null; workerId: string };
  }): Promise<string> {
    if (input.provenance.chatId) {
      const rows = await this.database
        .select({ ownerId: schema.chats.ownerId })
        .from(schema.chats)
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, input.provenance.workerId),
            eq(schema.workers.ownerId, schema.chats.ownerId),
          ),
        )
        .where(eq(schema.chats.id, input.provenance.chatId))
        .limit(1);
      if (rows[0]) return rows[0].ownerId;
    } else if (input.projectId) {
      const rows = await this.database
        .select({ ownerId: schema.projects.ownerId })
        .from(schema.projects)
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, input.provenance.workerId),
            eq(schema.workers.ownerId, schema.projects.ownerId),
          ),
        )
        .where(eq(schema.projects.id, input.projectId))
        .limit(1);
      if (rows[0]) return rows[0].ownerId;
    }
    throw new AgentInteractionConflictError(
      "Interaction worker does not belong to the owning Chat or project.",
    );
  }

  async recordAgentInteractionRequest(
    input: AgentInteractionRequestCreate,
  ): Promise<AgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
        throw new AgentInteractionConflictError(
          "Interaction provenance does not match the project chat.",
        );
      }
    }

    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const expiredAtCreation = expiresAt !== null && expiresAt <= now;
    const rows = await this.database
      .insert(schema.agentInteractionRequests)
      .values({
        id: randomUUID(),
        requestKey: input.requestKey,
        ownerId,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        kind: input.payload.kind,
        status: expiredAtCreation ? "expired" : "pending",
        payload: input.payload,
        expiresAt,
        resolvedAt: expiredAtCreation ? now : null,
      })
      .onConflictDoNothing({
        target: schema.agentInteractionRequests.requestKey,
      })
      .returning();
    const inserted = Boolean(rows[0]);
    let request = rows[0];
    if (!request) {
      const existing = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.requestKey, input.requestKey))
        .limit(1);
      request = firstOrThrow(existing, "reading an interaction request");
    }
    const normalized = toAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.payload) !== JSON.stringify(input.payload) ||
        normalized.expiresAt !== (expiresAt?.toISOString() ?? null))
    ) {
      throw new AgentInteractionConflictError(
        "Interaction request key was reused with different request data.",
      );
    }
    if (input.provenance.chatId && request.status === "pending") {
      await this.database
        .update(schema.chats)
        .set({ status: "waiting-for-approval", updatedAt: new Date() })
        .where(eq(schema.chats.id, input.provenance.chatId));
    }
    return normalized;
  }

  async recordEncryptedAgentInteractionRequest(
    input: EncryptedAgentInteractionRequestCreate,
  ): Promise<EncryptedAgentInteractionRequest> {
    const ownerId = await this.resolveAgentInteractionOwner(input);
    if (input.provenance.chatId) {
      const chats = await this.database
        .select({ id: schema.chats.id, projectId: schema.chats.projectId })
        .from(schema.chats)
        .where(
          and(
            eq(schema.chats.id, input.provenance.chatId),
            eq(schema.chats.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!chats[0] || chats[0].projectId !== input.projectId) {
        throw new AgentInteractionConflictError(
          "Interaction provenance does not match the project chat.",
        );
      }
    }

    const now = new Date();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const expiredAtCreation = expiresAt !== null && expiresAt <= now;
    const rows = await this.database
      .insert(schema.agentInteractionRequests)
      .values({
        id: randomUUID(),
        requestKey: input.requestKey,
        ownerId,
        projectId: input.projectId,
        chatId: input.provenance.chatId,
        workerId: input.provenance.workerId,
        executionLaneId: input.provenance.executionLaneId,
        threadId: input.provenance.threadId,
        turnId: input.provenance.turnId,
        itemId: input.provenance.itemId,
        kind: input.classification.kind,
        status: expiredAtCreation ? "expired" : "pending",
        protectedPayload: input.protectedPayload,
        expiresAt,
        resolvedAt: expiredAtCreation ? now : null,
      })
      .onConflictDoNothing({
        target: schema.agentInteractionRequests.requestKey,
      })
      .returning();
    const inserted = Boolean(rows[0]);
    let request = rows[0];
    if (!request) {
      const existing = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.requestKey, input.requestKey))
        .limit(1);
      request = firstOrThrow(
        existing,
        "reading a protected interaction request",
      );
    }
    const normalized = toEncryptedAgentInteractionRequest(request);
    if (
      !inserted &&
      (normalized.projectId !== input.projectId ||
        JSON.stringify(normalized.provenance) !==
          JSON.stringify(input.provenance) ||
        JSON.stringify(normalized.classification) !==
          JSON.stringify(input.classification) ||
        JSON.stringify(normalized.protectedPayload) !==
          JSON.stringify(input.protectedPayload) ||
        normalized.expiresAt !== (expiresAt?.toISOString() ?? null))
    ) {
      throw new AgentInteractionConflictError(
        "Interaction request key was reused with different request data.",
      );
    }
    if (input.provenance.chatId && request.status === "pending") {
      await this.database
        .update(schema.chats)
        .set({ status: "waiting-for-approval", updatedAt: new Date() })
        .where(eq(schema.chats.id, input.provenance.chatId));
    }
    return normalized;
  }

  async listAgentInteractionRequests(
    ownerId: string,
    query: AgentInteractionRequestQuery,
  ): Promise<AgentInteractionRequestWire[]> {
    await this.collaborators.expireAgentInteractionRequests();
    const conditions = [eq(schema.agentInteractionRequests.ownerId, ownerId)];
    if (query.chatId) {
      conditions.push(eq(schema.agentInteractionRequests.chatId, query.chatId));
    }
    if (query.status) {
      conditions.push(eq(schema.agentInteractionRequests.status, query.status));
    }
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(and(...conditions))
      .orderBy(desc(schema.agentInteractionRequests.createdAt))
      .limit(query.limit);
    return rows.map(({ request }) => toAgentInteractionRequestWire(request));
  }

  async getAgentInteractionRequest(
    ownerId: string,
    requestId: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async getAgentInteractionRequestByKey(
    ownerId: string,
    requestKey: string,
  ): Promise<AgentInteractionRequestWire | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const rows = await this.database
      .select({ request: schema.agentInteractionRequests })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return rows[0] ? toAgentInteractionRequestWire(rows[0].request) : null;
  }

  async resolveAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const existing = await this.collaborators.getAgentInteractionRequest(
      ownerId,
      requestId,
    );
    if (!existing) return null;
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
    validateAgentInteractionResponse(existing.payload, input.response);
    const storedResponse = agentInteractionResponseForStorage(
      existing.payload,
      input.response,
    );
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(rows, "reading a resolved interaction request");
      if (
        row.resolutionIdempotencyKey === input.idempotencyKey &&
        JSON.stringify(row.response) === JSON.stringify(storedResponse)
      ) {
        return toAgentInteractionRequest(row);
      }
      throw new AgentInteractionConflictError(
        `Interaction request is already ${existing.status}.`,
      );
    }

    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({
        status: "resolved",
        response: storedResponse,
        resolutionIdempotencyKey: input.idempotencyKey,
        resolvedByUserId: ownerId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new AgentInteractionConflictError(
        "Interaction request was resolved concurrently.",
      );
    }
    if (rows[0].chatId) {
      await this.restoreChatAfterInteractions(rows[0].chatId);
    }
    return toAgentInteractionRequest(rows[0]);
  }

  async validateAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: AgentInteractionResolutionCreate,
  ): Promise<AgentInteractionRequest | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const existing = await this.collaborators.getAgentInteractionRequest(
      ownerId,
      requestId,
    );
    if (!existing) return null;
    if (!("payload" in existing)) {
      throw new AgentInteractionConflictError(
        "Protected interaction requests require a protected response.",
      );
    }
    validateAgentInteractionResponse(existing.payload, input.response);
    return existing;
  }

  async resolveEncryptedAgentInteractionRequest(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const existing = await this.collaborators.getAgentInteractionRequest(
      ownerId,
      requestId,
    );
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    if (existing.status !== "pending") {
      const rows = await this.database
        .select()
        .from(schema.agentInteractionRequests)
        .where(eq(schema.agentInteractionRequests.id, requestId))
        .limit(1);
      const row = firstOrThrow(
        rows,
        "reading a resolved protected interaction request",
      );
      if (row.resolutionIdempotencyKey === input.idempotencyKey) {
        return toEncryptedAgentInteractionRequest(row);
      }
      throw new AgentInteractionConflictError(
        `Interaction request is already ${existing.status}.`,
      );
    }

    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({
        status: "resolved",
        protectedResponse: input.protectedResponse,
        resolutionIdempotencyKey: input.idempotencyKey,
        resolvedByUserId: ownerId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.agentInteractionRequests.id, requestId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) {
      throw new AgentInteractionConflictError(
        "Interaction request was resolved concurrently.",
      );
    }
    if (rows[0].chatId) {
      await this.restoreChatAfterInteractions(rows[0].chatId);
    }
    return toEncryptedAgentInteractionRequest(rows[0]);
  }

  async validateEncryptedAgentInteractionResolution(
    ownerId: string,
    requestId: string,
    input: EncryptedAgentInteractionResolutionCreate,
  ): Promise<EncryptedAgentInteractionRequest | null> {
    await this.collaborators.expireAgentInteractionRequests();
    const existing = await this.collaborators.getAgentInteractionRequest(
      ownerId,
      requestId,
    );
    if (!existing) return null;
    if (!("protectedPayload" in existing)) {
      throw new AgentInteractionConflictError(
        "Visible interaction requests require a visible response.",
      );
    }
    if (existing.classification.kind !== input.classification.kind) {
      throw new AgentInteractionConflictError(
        "Response kind does not match the pending request.",
      );
    }
    return existing;
  }

  async expireAgentInteractionRequests(
    now = new Date(),
  ): Promise<AgentInteractionRequestWire[]> {
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "expired", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.status, "pending"),
          lte(schema.agentInteractionRequests.expiresAt, now),
        ),
      )
      .returning();
    const chatIds = new Set(
      rows.flatMap((request) => (request.chatId ? [request.chatId] : [])),
    );
    for (const chatId of chatIds) {
      await this.restoreChatAfterInteractions(chatId);
    }
    return rows.map(toAgentInteractionRequestWire);
  }

  async interruptAgentInteractionRequests(
    chatId: string,
  ): Promise<AgentInteractionRequestWire[]> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status: "interrupted", resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    return rows.map(toAgentInteractionRequestWire);
  }

  async terminalizeAgentInteractionRequestFromWorker(
    requestKey: string,
    chatId: string,
    workerId: string,
    status: "expired" | "interrupted",
  ): Promise<AgentInteractionRequestWire | null> {
    const now = new Date();
    const rows = await this.database
      .update(schema.agentInteractionRequests)
      .set({ status, resolvedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.agentInteractionRequests.requestKey, requestKey),
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.workerId, workerId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .returning();
    if (!rows[0]) return null;
    await this.restoreChatAfterInteractions(chatId);
    return toAgentInteractionRequestWire(rows[0]);
  }

  private async restoreChatAfterInteractions(chatId: string): Promise<void> {
    const pending = await this.database
      .select({ id: schema.agentInteractionRequests.id })
      .from(schema.agentInteractionRequests)
      .where(
        and(
          eq(schema.agentInteractionRequests.chatId, chatId),
          eq(schema.agentInteractionRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (pending[0]) return;
    await this.database
      .update(schema.chats)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          eq(schema.chats.id, chatId),
          eq(schema.chats.status, "waiting-for-approval"),
        ),
      );
  }
}
