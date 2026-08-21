import {
  clearSensitiveBytes,
  encryptAttachmentChunk,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import type { ClientSessionContext } from "./client-session";
import { ClientEncryptionService } from "./client-encryption";
import {
  openAttachmentDownload,
  openAttachmentOpaqueSummary,
  protectAttachmentUpload,
} from "./attachment-encryption";

const ownerId = "owner-attachment";
const serverId = "server-attachment";
const chatId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";

function session(): ClientSessionContext {
  return { serverId, user: { id: ownerId } } as ClientSessionContext;
}

function readyService() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 1,
  });
  return service;
}

describe("attachment client encryption adapter", () => {
  it("keeps metadata and bytes opaque across upload and download", async () => {
    const service = readyService();
    const options = { service, session };
    const bytes = new TextEncoder().encode("SENTINEL attachment body");
    const upload = await protectAttachmentUpload(
      {
        attachmentId,
        operationId: "33333333-3333-4333-8333-333333333333",
        chatId,
        bytes,
        fileName: "SENTINEL private.txt",
        mimeType: "text/plain",
        kind: "text",
        source: "paste",
        previewText: "SENTINEL preview",
      },
      options,
    );
    expect(JSON.stringify(upload)).not.toContain("SENTINEL");

    const createdAt = "2026-08-20T12:00:00.000Z";
    const opaqueSummary = {
      id: attachmentId,
      chatId,
      sizeBytes: bytes.byteLength,
      status: "ready" as const,
      protectedMetadata: upload.protectedMetadata,
      createdAt,
    };
    await expect(
      openAttachmentOpaqueSummary(opaqueSummary, options),
    ).resolves.toMatchObject({
      fileName: "SENTINEL private.txt",
      previewText: "SENTINEL preview",
    });

    const operationId = "44444444-4444-4444-8444-444444444444";
    const componentKey = service.componentKey({
      component: "attachment-content",
      identity: { ownerId, serverId },
      keyRevision: 1,
    });
    const chunk = await encryptAttachmentChunk({
      ownerId,
      chatId,
      attachmentId,
      operationId,
      direction: "download",
      sequence: 0,
      eof: true,
      keyRevision: 1,
      componentKey,
      plaintext: bytes,
    });
    clearSensitiveBytes(componentKey);
    await expect(
      openAttachmentDownload(
        {
          id: attachmentId,
          chatId,
          fileName: "SENTINEL private.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.byteLength,
          kind: "text",
          source: "paste",
          status: "ready",
          previewText: "SENTINEL preview",
          createdAt,
        },
        {
          attachmentId,
          operationId,
          sizeBytes: bytes.byteLength,
          protectedMetadata: upload.protectedMetadata,
          chunks: [chunk],
        },
        options,
      ),
    ).resolves.toEqual(bytes);
  });
});
