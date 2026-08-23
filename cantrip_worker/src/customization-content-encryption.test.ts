import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deriveComponentKey,
  generateAccountMasterKey,
  wrapComponentKeyForWorker,
} from "@cantrip/crypto";
import {
  customizationContentResultSchema,
  skillSettingsFileRequestSchema,
  skillSettingsMutationResultSchema,
  type EncryptionKeyGrant,
  type EncryptionPrincipal,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  CustomizationContentReplayGuard,
  openWorkerCustomizationRequest,
  protectWorkerCustomizationResponse,
} from "./customization-content-encryption.js";
import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
} from "./endpoint-content-encryption.js";
import { WorkerEncryptionService } from "./worker-encryption.js";

const ownerId = "owner-customization-content";
const serverId = "https://cantrip.test";
const workerId = "worker-a";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((entry) => rm(entry, { recursive: true })),
  );
});

async function service() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-customization-content-"),
  );
  directories.push(dataDirectory);
  const worker = await WorkerEncryptionService.open({
    dataDirectory,
    serverUrl: serverId,
    workerId,
  });
  const registration = worker.registration();
  const now = "2026-08-22T12:00:00.000Z";
  const principal: EncryptionPrincipal = {
    id: registration.principalId,
    ownerId,
    kind: "worker",
    workerId,
    label: "Customization worker",
    publicKey: registration.publicKey,
    state: "approved",
    revision: 1,
    approvedAt: now,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const componentKey = deriveComponentKey({
    accountMasterKey: generateAccountMasterKey(),
    ownerId,
    component: "customization-content",
    keyRevision: 1,
  });
  const grant: EncryptionKeyGrant = {
    id: crypto.randomUUID(),
    ownerId,
    principalId: principal.id,
    component: "customization-content",
    keyRevision: 1,
    wrappedKey: await wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component: "customization-content",
      componentKey,
      keyRevision: 1,
      workerPublicKey: principal.publicKey,
    }),
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now,
  };
  await worker.acceptBootstrap({ ownerId, principal, grants: [grant] });
  return worker;
}

function context(input: {
  operationId: string;
  direction: "request" | "response";
}) {
  return {
    domain: "customization-content" as const,
    serverId,
    workerId,
    scopeId: JSON.stringify([workerId, "project-a", null, "provider-a"]),
    operationId: input.operationId,
    operation: "skills.settings.write",
    direction: input.direction,
    sequence: 0,
  };
}

describe("customization content encryption", () => {
  it("round-trips private request and response content without relay-visible fields", async () => {
    const worker = await service();
    const scope = {
      workerId,
      projectId: "project-a",
      chatId: null,
      providerId: "provider-a",
    };
    const operationId = crypto.randomUUID();
    const request = skillSettingsFileRequestSchema.parse({
      workerId,
      providerId: "provider-a",
      projectId: "project-a",
      skillId: "project:cHJpdmF0ZS1za2lsbA",
      file: "secrets/PRIVATE.md",
    });
    const opaqueRequest = await protectWorkerEndpointContent({
      context: context({ operationId, direction: "request" }),
      content: request,
      schema: skillSettingsFileRequestSchema,
      service: worker,
    });
    await expect(
      openWorkerCustomizationRequest({
        serverId,
        workerId,
        scope,
        operationId,
        operation: "skills.settings.write",
        opaque: opaqueRequest,
        schema: skillSettingsFileRequestSchema,
        service: worker,
      }),
    ).resolves.toEqual(request);
    expect(JSON.stringify(opaqueRequest)).not.toContain("PRIVATE.md");

    const changed = skillSettingsMutationResultSchema.parse({
      changed: true,
      recoveryPath: "/private/recovery/skill",
    });
    const response = await protectWorkerCustomizationResponse({
      serverId,
      workerId,
      scope,
      operationId,
      operation: "skills.settings.write",
      schema: skillSettingsMutationResultSchema,
      service: worker,
      execute: () => changed,
    });
    expect(JSON.stringify(response)).not.toContain("/private/recovery/skill");
    await expect(
      openWorkerEndpointContent({
        context: context({ operationId, direction: "response" }),
        opaque: response.protectedResponse,
        schema: customizationContentResultSchema,
        service: worker,
      }),
    ).resolves.toEqual({ status: "succeeded", value: changed });
  });

  it("rejects duplicate mutating operation identifiers", () => {
    const guard = new CustomizationContentReplayGuard();
    const input = {
      serverId,
      workerId,
      scope: {
        workerId,
        projectId: "project-a",
        chatId: null,
        providerId: "provider-a",
      },
      operationId: crypto.randomUUID(),
      operation: "skills.settings.delete" as const,
    };
    guard.reserve(input);
    expect(() => guard.reserve(input)).toThrow(/already completed/u);
  });
});
