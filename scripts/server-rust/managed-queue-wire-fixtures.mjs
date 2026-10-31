import { nativeCommandWireFixtures } from "./native-command-wire-fixtures.mjs";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export function managedQueueWireFixtures(timestamp) {
  const native = nativeCommandWireFixtures(timestamp),
    admission = native.nativeCommandAdmissionSchema[0],
    receipt = native.nativeCommandReceiptSchema[0];
  const read = { workerId: "worker", session: admission.session },
    prompt = retainedPrompt();
  const item = {
    ...prompt,
    chatId: "chat",
    revision: 0,
    state: "pending",
    attachments: [],
    position: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const claim = {
    id: "claim",
    chatId: "chat",
    promptId: prompt.id,
    promptRevision: 0,
    status: "claimed",
    operationId: null,
    operationGeneration: null,
    nativeTurnId: null,
    createdAt: timestamp,
  };
  const snapshot = {
    revision: 0,
    paused: false,
    items: [],
    claims: [],
    pendingImports: [],
  };
  const mutation = { kind: "add", prompt, attachments: [] };
  return {
    managedQueueClaimSchema: [
      claim,
      {
        ...claim,
        awaitingGoal: true,
        goalEpoch: "epoch",
        goalOperationId: "goal",
        goalOperationGeneration: "generation",
        requestOperationId: "request",
        status: "uncertain",
      },
    ],
    managedQueueReadSchema: [read],
    managedQueueSnapshotSchema: [
      snapshot,
      {
        ...snapshot,
        items: [item],
        claims: [claim],
        pendingImports: [
          {
            importId: "import",
            nativeItemId: "native",
            status: "pending",
            prompt: item,
          },
        ],
      },
    ],
    managedQueueMutationSchema: [
      mutation,
      { ...mutation, kind: "update", id: prompt.id, expectedItemRevision: 0 },
      { kind: "delete", id: prompt.id, expectedItemRevision: 0 },
      { kind: "reorder", ids: [prompt.id] },
      { kind: "start" },
      { kind: "start", id: prompt.id },
    ],
    managedQueueMutateSchema: [{ admission, expectedRevision: 0, mutation }],
    managedQueueMutationResultSchema: [
      { ...snapshot, receipt },
      { ...snapshot, receipt, acceptedItem: item, claim },
    ],
    managedQueueStartReceiptSchema: [{ ...read, claimId: "claim" }],
    managedQueueStartReceiptResultSchema: [
      {
        claim,
        receipt,
        protectedResult: admission.protectedPayload,
        resultDigest: "a".repeat(64),
      },
    ],
    managedQueueImportSchema: [
      { ...read, runnerGeneration: "runner", items: [] },
      {
        ...read,
        runnerGeneration: "runner",
        items: [
          {
            nativeItemId: "native",
            sourceDigest: "b".repeat(64),
            protectedSource: admission.protectedPayload,
            prompt,
            attachments: [],
          },
        ],
      },
    ],
    managedQueueImportAckSchema: [
      {
        ...read,
        runnerGeneration: "runner",
        importId: "import",
        sourceDigest: "b".repeat(64),
        receipt: { deleted: true, conflict: false },
      },
    ],
    managedQueueImportResultSchema: [
      { ...snapshot, imports: [] },
      {
        ...snapshot,
        imports: [
          {
            importId: "import",
            nativeItemId: "native",
            sourceDigest: "b".repeat(64),
            protectedSource: admission.protectedPayload,
            nativeDeleteOperationId: "queue-delete:import",
            promptId: prompt.id,
            status: "uncertain",
          },
        ],
      },
    ],
    managedQueueLookupSchema: [{ admission }],
    managedQueueLookupResultSchema: [
      { found: false },
      { found: true, ...snapshot, receipt },
    ],
  };
}
