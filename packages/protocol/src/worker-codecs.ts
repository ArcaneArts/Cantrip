import {
  decodeJsonMessage,
  encodeJsonMessage,
  type JsonMessageDecodeResult,
} from "./json-message.js";
import {
  workerRequestEnvelopeSchema,
  workerConnectionEnvelopeSchema,
  type WorkerRequestEnvelope,
  type WorkerConnectionEnvelope,
} from "./worker-transport.js";
import {
  workerServerEnvelopeSchema,
  type WorkerServerEnvelope,
} from "./worker-server-envelopes.js";

export function decodeWorkerRequestEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerRequestEnvelope> {
  return decodeJsonMessage(encoded, workerRequestEnvelopeSchema);
}

export function decodeWorkerConnectionEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerConnectionEnvelope> {
  return decodeJsonMessage(encoded, workerConnectionEnvelopeSchema);
}

export function decodeWorkerServerEnvelope(
  encoded: string,
): JsonMessageDecodeResult<WorkerServerEnvelope> {
  return decodeJsonMessage(encoded, workerServerEnvelopeSchema);
}

export function encodeWorkerRequestEnvelope(
  envelope: WorkerRequestEnvelope,
): string {
  return encodeJsonMessage(envelope, workerRequestEnvelopeSchema);
}

export function encodeWorkerConnectionEnvelope(
  envelope: WorkerConnectionEnvelope,
): string {
  return encodeJsonMessage(envelope, workerConnectionEnvelopeSchema);
}

export function encodeWorkerServerEnvelope(
  envelope: WorkerServerEnvelope,
): string {
  return encodeJsonMessage(envelope, workerServerEnvelopeSchema);
}
