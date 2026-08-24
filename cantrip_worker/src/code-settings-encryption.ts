import { randomUUID } from "node:crypto";

import {
  codeSettingsContentContext,
  codeSettingsPayloadSchema,
  codeSettingsUploadSchema,
  type CodeSettingsJsonObject,
  type CodeSettingsStoredProfile,
  type CodeSettingsUpload,
} from "@cantrip/protocol/code-settings";

import {
  openWorkerEndpointContent,
  protectWorkerEndpointContent,
} from "./endpoint-content-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";

export async function openWorkerCodeSettings(input: {
  profile: CodeSettingsStoredProfile;
  service: WorkerEncryptionService;
}): Promise<CodeSettingsJsonObject> {
  const { profile } = input;
  const payload = await openWorkerEndpointContent({
    context: codeSettingsContentContext({
      operationId: profile.record.operationId,
      profileId: profile.profileId,
      revision: profile.record.revision,
      serverId: input.service.serverIdentity(),
    }),
    opaque: profile.record.protectedContent,
    schema: codeSettingsPayloadSchema,
    service: input.service,
  });
  return payload.settings;
}

export async function protectWorkerCodeSettings(input: {
  expectedRevision: number | null;
  profileId: string;
  service: WorkerEncryptionService;
  settings: CodeSettingsJsonObject;
}): Promise<CodeSettingsUpload> {
  const operationId = randomUUID();
  const revision =
    input.expectedRevision === null ? 1 : input.expectedRevision + 1;
  const payload = codeSettingsPayloadSchema.parse({
    formatVersion: 1,
    settings: input.settings,
  });
  return codeSettingsUploadSchema.parse({
    expectedRevision: input.expectedRevision,
    record: {
      operationId,
      revision,
      protectedContent: await protectWorkerEndpointContent({
        context: codeSettingsContentContext({
          operationId,
          profileId: input.profileId,
          revision,
          serverId: input.service.serverIdentity(),
        }),
        content: payload,
        schema: codeSettingsPayloadSchema,
        service: input.service,
      }),
    },
  });
}
