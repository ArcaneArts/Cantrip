import {
  decryptWorkflowContent,
  encryptWorkflowContent,
  randomBytes,
} from "@cantrip/crypto";
import {
  workflowRunProtectedInputSchema,
  workflowTriggerProtectedConfigurationSchema,
  workflowTriggerProtectedDeliverySchema,
  workflowTriggerProtectedInputSchema,
  type ProtectedWorkflowTriggerPrepareRequest,
} from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import { prepareProtectedWorkflowTrigger } from "../src/workflow-execution-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const ownerId = "trigger-worker-owner";
const triggerId = "trigger-1";
const runId = "run-1";
const deliveryId = "delivery-1";

async function fixture(branch: string) {
  const key = randomBytes(32);
  const service = {
    ownerId: () => ownerId,
    componentKey: () => ({ key: new Uint8Array(key), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
  const [protectedConfiguration, protectedBaseInput, protectedDeliveryPayload] =
    await Promise.all([
      encryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-trigger",
          recordId: triggerId,
          field: "content",
        },
        keyRevision: 1,
        componentKey: key,
        content: {
          version: 1,
          type: "git",
          configuration: {
            event: "push",
            branchPattern: "release/*",
            minimumIntervalSeconds: 1,
          },
        },
        schema: workflowTriggerProtectedConfigurationSchema,
      }),
      encryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-trigger",
          recordId: triggerId,
          field: "input",
        },
        keyRevision: 1,
        componentKey: key,
        content: { version: 1, input: { base: "BASE_INPUT_SENTINEL" } },
        schema: workflowTriggerProtectedInputSchema,
      }),
      encryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-delivery",
          recordId: `${triggerId}:${deliveryId}`,
          field: "payload",
        },
        keyRevision: 1,
        componentKey: key,
        content: {
          version: 1,
          type: "git",
          event: "push",
          branch,
          input: { dynamic: "DYNAMIC_INPUT_SENTINEL" },
        },
        schema: workflowTriggerProtectedDeliverySchema,
      }),
    ]);
  const command: ProtectedWorkflowTriggerPrepareRequest = {
    triggerId,
    workflowRunId: runId,
    triggerType: "git",
    publicConfiguration: {
      type: "git",
      event: "push",
      minimumIntervalSeconds: 1,
    },
    protectedConfiguration,
    protectedBaseInput,
    deliveryOperationId: deliveryId,
    protectedDeliveryPayload,
  };
  return { command, key, service };
}

describe("protected workflow trigger preparation", () => {
  it("validates private routing and merges inputs only on the worker", async () => {
    const { command, key, service } = await fixture("refs/heads/release/v1");
    const result = await prepareProtectedWorkflowTrigger({ command, service });
    expect(JSON.stringify(result)).not.toMatch(
      /(?:BASE|DYNAMIC)_INPUT_SENTINEL/u,
    );
    if (result.status !== "accepted") throw new Error("trigger rejected");
    await expect(
      decryptWorkflowContent({
        ownerId,
        context: {
          recordKind: "workflow-run",
          recordId: runId,
          field: "input",
        },
        keyRevision: 1,
        componentKey: key,
        encrypted: result.protectedRunInput,
        schema: workflowRunProtectedInputSchema,
      }),
    ).resolves.toEqual({
      version: 1,
      input: {
        base: "BASE_INPUT_SENTINEL",
        dynamic: "DYNAMIC_INPUT_SENTINEL",
      },
    });
  });

  it("rejects a Git branch that does not match the encrypted pattern", async () => {
    const { command, service } = await fixture("main");
    await expect(
      prepareProtectedWorkflowTrigger({ command, service }),
    ).resolves.toEqual({
      status: "rejected",
      code: "git-branch-mismatch",
    });
  });
});
