import {
  CUA_CHUNK_BYTES,
  CUA_CONTROL_BYTES,
  CUA_MAX_CHUNKS,
  computerUseActionSchema,
  computerUseChunkEventSchema,
  computerUseOperationSchema,
  computerUseRequestSchema,
  computerUseResponseSchema,
  computerUseResultContentSchema,
  type ComputerUseAction,
  type ComputerUseChunkEvent,
  type ComputerUseOperation,
  type ComputerUseRequest,
  type ComputerUseResponse,
  type ComputerUseResultContent,
} from "@cantrip/protocol/computer-use";
import {
  endpointContentContextSchema,
  endpointContentOpaqueSchema,
  type EndpointContentContext,
  type EndpointContentOpaque,
} from "@cantrip/protocol/endpoint-content";
import { sha256 } from "@noble/hashes/sha2.js";

import { clearSensitiveBytes } from "./bytes.js";
import { CantripDecryptionError } from "./payload.js";

export interface ComputerUseContentContext {
  serverId: string;
  workerId: string;
  chatId: string;
  operationId: string;
  operation: ComputerUseOperation;
  previewLeaseId?: string;
}

/** Seal borrows plaintext until its promise settles; it must not retain it. */
export type ComputerUseSeal = (
  context: EndpointContentContext,
  plaintext: Uint8Array,
) => Promise<EndpointContentOpaque>;
/** Open transfers ownership of its plaintext buffer to this codec for clearing. */
export type ComputerUseOpen = (
  context: EndpointContentContext,
  opaque: EndpointContentOpaque,
) => Promise<Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_IMAGE_BYTES = CUA_CHUNK_BYTES * CUA_MAX_CHUNKS;

function contextFor(
  context: ComputerUseContentContext,
  direction: "request" | "response" | "event",
  sequence = 0,
): EndpointContentContext {
  const previewLeaseId = computerUseRequestSchema.shape.previewLeaseId.parse(
    context.previewLeaseId,
  );
  return endpointContentContextSchema.parse({
    domain: "client-control-content",
    serverId: context.serverId,
    workerId: context.workerId,
    // Preview leases are worker-owned random identities. Binding them here
    // prevents a relay from moving an old action/result onto a new lifetime.
    scopeId: previewLeaseId
      ? JSON.stringify(["cua-preview-v1", context.chatId, previewLeaseId])
      : context.chatId,
    operationId: context.operationId,
    operation: computerUseOperationSchema.parse(context.operation),
    direction,
    sequence,
  });
}

function failure(): never {
  throw new CantripDecryptionError();
}

function checkedOpaque(input: unknown): EndpointContentOpaque {
  const opaque = endpointContentOpaqueSchema.parse(input);
  if (
    opaque.domain !== "client-control-content" ||
    opaque.keyRevision !== opaque.envelope.keyRevision
  )
    failure();
  return opaque;
}

function digest(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sealJson(
  context: EndpointContentContext,
  content: unknown,
  seal: ComputerUseSeal,
): Promise<EndpointContentOpaque> {
  const plaintext = encoder.encode(JSON.stringify(content));
  try {
    if (plaintext.byteLength > CUA_CONTROL_BYTES) failure();
    return checkedOpaque(await seal(context, plaintext));
  } finally {
    clearSensitiveBytes(plaintext);
  }
}

async function openJson<T>(
  context: EndpointContentContext,
  opaque: EndpointContentOpaque,
  schema: { parse(value: unknown): T },
  open: ComputerUseOpen,
): Promise<T> {
  const plaintext = await open(context, checkedOpaque(opaque));
  try {
    if (plaintext.byteLength > CUA_CONTROL_BYTES) failure();
    return schema.parse(JSON.parse(decoder.decode(plaintext)));
  } finally {
    clearSensitiveBytes(plaintext);
  }
}

export async function protectComputerUseRequest(input: {
  context: ComputerUseContentContext;
  request: ComputerUseAction;
  seal: ComputerUseSeal;
}): Promise<ComputerUseRequest> {
  const context = { ...input.context };
  const request = computerUseActionSchema.parse(input.request);
  if (request.operation !== context.operation) failure();
  return computerUseRequestSchema.parse({
    operationId: context.operationId,
    operation: request.operation,
    ...(context.previewLeaseId
      ? { previewLeaseId: context.previewLeaseId }
      : {}),
    protectedContent: await sealJson(
      contextFor(context, "request"),
      request,
      input.seal,
    ),
  });
}

export async function openComputerUseRequest(input: {
  context: ComputerUseContentContext;
  opaque: unknown;
  open: ComputerUseOpen;
}): Promise<ComputerUseAction> {
  const context = { ...input.context };
  try {
    const request = computerUseRequestSchema.parse(input.opaque);
    if (
      request.operationId !== context.operationId ||
      request.operation !== context.operation ||
      request.previewLeaseId !== context.previewLeaseId
    )
      failure();
    const action = await openJson(
      contextFor(context, "request"),
      request.protectedContent,
      computerUseActionSchema,
      input.open,
    );
    if (action.operation !== request.operation) failure();
    return action;
  } catch {
    return failure();
  }
}

/**
 * Protect metadata and sequential bounded PNG chunks. The input payload remains
 * caller-owned. A private bounded copy prevents changes across awaited emits
 * from producing a manifest that authenticates different pixels.
 */
export async function protectComputerUseResult(input: {
  context: ComputerUseContentContext;
  result: ComputerUseResultContent;
  payload?: Uint8Array | null;
  seal: ComputerUseSeal;
  emit: (event: ComputerUseChunkEvent) => Promise<void>;
}): Promise<ComputerUseResponse> {
  const context = { ...input.context };
  const result = computerUseResultContentSchema.parse(input.result);
  if (result.operation !== context.operation) failure();
  const supplied = input.payload;
  if (supplied && supplied.byteLength > MAX_IMAGE_BYTES) failure();
  const payload = supplied ? new Uint8Array(supplied) : null;
  try {
    const image =
      result.status === "ok" && "image" in result.data
        ? result.data.image
        : null;
    if (image) {
      if (
        !payload ||
        payload.byteLength !== image.byteCount ||
        digest(payload) !== image.sha256
      )
        failure();
    } else if (payload?.byteLength) failure();

    // Seal the final manifest before emitting pixels so all chunks must use the
    // same encryption revision. Return it only after every emit has completed.
    const response = computerUseResponseSchema.parse({
      operationId: context.operationId,
      protectedContent: await sealJson(
        contextFor(context, "response"),
        result,
        input.seal,
      ),
    });
    if (image && payload) {
      for (
        let sequence = 0;
        sequence < Math.ceil(image.byteCount / CUA_CHUNK_BYTES);
        sequence += 1
      ) {
        const chunk = payload.slice(
          sequence * CUA_CHUNK_BYTES,
          (sequence + 1) * CUA_CHUNK_BYTES,
        );
        try {
          const protectedContent = checkedOpaque(
            await input.seal(contextFor(context, "event", sequence), chunk),
          );
          if (
            protectedContent.keyRevision !==
            response.protectedContent.keyRevision
          )
            failure();
          await input.emit(
            computerUseChunkEventSchema.parse({
              type: "computer-use.snapshot.chunk",
              operationId: context.operationId,
              sequence,
              protectedContent,
            }),
          );
        } finally {
          clearSensitiveBytes(chunk);
        }
      }
    }
    return response;
  } finally {
    if (payload) clearSensitiveBytes(payload);
  }
}

/**
 * Authenticate the final manifest before opening any image chunks. Successful
 * payloads are owned by the caller and must be cleared after use. Every scratch
 * plaintext and any partially assembled image is cleared on failure.
 */
export async function openComputerUseResult(input: {
  context: ComputerUseContentContext;
  opaque: unknown;
  chunks: readonly unknown[];
  open: ComputerUseOpen;
}): Promise<{ result: ComputerUseResultContent; payload: Uint8Array | null }> {
  const context = { ...input.context };
  let payload: Uint8Array | null = null;
  let transferred = false;
  try {
    const response = computerUseResponseSchema.parse(input.opaque);
    if (response.operationId !== context.operationId) failure();
    const result = await openJson(
      contextFor(context, "response"),
      response.protectedContent,
      computerUseResultContentSchema,
      input.open,
    );
    if (result.operation !== context.operation) failure();
    const expectedCount = result.status === "ok" ? result.chunkCount : 0;
    if (
      !Array.isArray(input.chunks) ||
      input.chunks.length !== expectedCount ||
      expectedCount > CUA_MAX_CHUNKS
    )
      failure();
    const chunks = input.chunks.map((value, sequence) => {
      const chunk = computerUseChunkEventSchema.parse(value);
      const opaque = checkedOpaque(chunk.protectedContent);
      if (
        chunk.operationId !== context.operationId ||
        chunk.sequence !== sequence ||
        opaque.keyRevision !== response.protectedContent.keyRevision
      )
        failure();
      return chunk;
    });
    if (result.status === "ok" && "image" in result.data) {
      const image = result.data.image;
      payload = new Uint8Array(image.byteCount);
      for (let sequence = 0; sequence < chunks.length; sequence += 1) {
        const chunk = chunks[sequence]!;
        const plaintext = await input.open(
          contextFor(context, "event", sequence),
          chunk.protectedContent,
        );
        try {
          const offset = sequence * CUA_CHUNK_BYTES;
          if (
            plaintext.byteLength !==
            Math.min(CUA_CHUNK_BYTES, image.byteCount - offset)
          )
            failure();
          payload.set(plaintext, offset);
        } finally {
          clearSensitiveBytes(plaintext);
        }
      }
      if (digest(payload) !== image.sha256) failure();
    }
    transferred = true;
    return { result, payload };
  } catch {
    return failure();
  } finally {
    if (payload && !transferred) clearSensitiveBytes(payload);
  }
}
