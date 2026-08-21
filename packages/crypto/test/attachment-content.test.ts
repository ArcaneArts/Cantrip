import { describe, expect, it } from "vitest";

import {
  CantripDecryptionError,
  decryptAttachmentChunk,
  decryptAttachmentMetadata,
  encryptAttachmentChunk,
  encryptAttachmentMetadata,
  randomBytes,
} from "../src/index.js";

const ownerId = "owner-attachment";
const chatId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const keyRevision = 2;

describe("attachment content encryption", () => {
  it("round-trips metadata and authenticated chunks", async () => {
    const componentKey = randomBytes(32);
    const content = {
      version: 1 as const,
      fileName: "SENTINEL private notes.txt",
      mimeType: "text/plain",
      kind: "text" as const,
      source: "paste" as const,
      previewText: "SENTINEL preview",
      sha256: "a".repeat(64),
      error: null,
    };
    const metadata = await encryptAttachmentMetadata({
      ownerId,
      chatId,
      attachmentId,
      keyRevision,
      componentKey,
      content,
    });
    expect(JSON.stringify(metadata)).not.toContain("SENTINEL");
    await expect(
      decryptAttachmentMetadata({
        ownerId,
        chatId,
        attachmentId,
        keyRevision,
        componentKey,
        encrypted: metadata,
      }),
    ).resolves.toEqual(content);

    const plaintext = new TextEncoder().encode("SENTINEL attachment bytes");
    const chunk = await encryptAttachmentChunk({
      ownerId,
      chatId,
      attachmentId,
      operationId,
      direction: "relay",
      sequence: 0,
      eof: true,
      keyRevision,
      componentKey,
      plaintext,
    });
    expect(JSON.stringify(chunk)).not.toContain("SENTINEL");
    await expect(
      decryptAttachmentChunk({
        ownerId,
        chatId,
        attachmentId,
        operationId,
        direction: "relay",
        sequence: 0,
        keyRevision,
        componentKey,
        encrypted: chunk,
      }),
    ).resolves.toEqual(plaintext);
  });

  it("rejects wrong rows, operations, directions, sequence metadata, and tampering", async () => {
    const componentKey = randomBytes(32);
    const metadata = await encryptAttachmentMetadata({
      ownerId,
      chatId,
      attachmentId,
      keyRevision,
      componentKey,
      content: {
        version: 1,
        fileName: "secret.bin",
        mimeType: "application/octet-stream",
        kind: "file",
        source: "file",
        previewText: null,
        sha256: "b".repeat(64),
        error: null,
      },
    });
    await expect(
      decryptAttachmentMetadata({
        ownerId,
        chatId,
        attachmentId: "44444444-4444-4444-8444-444444444444",
        keyRevision,
        componentKey,
        encrypted: metadata,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);

    const chunk = await encryptAttachmentChunk({
      ownerId,
      chatId,
      attachmentId,
      operationId,
      direction: "relay",
      sequence: 0,
      eof: true,
      keyRevision,
      componentKey,
      plaintext: new Uint8Array([1, 2, 3]),
    });
    const open = (overrides: Record<string, unknown> = {}) =>
      decryptAttachmentChunk({
        ownerId,
        chatId,
        attachmentId,
        operationId,
        direction: "relay",
        sequence: 0,
        keyRevision,
        componentKey,
        encrypted: chunk,
        ...overrides,
      });
    await expect(
      open({ operationId: "55555555-5555-4555-8555-555555555555" }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(open({ direction: "download" })).rejects.toBeInstanceOf(
      CantripDecryptionError,
    );
    await expect(open({ sequence: 1 })).rejects.toBeInstanceOf(
      CantripDecryptionError,
    );
    await expect(
      open({ encrypted: { ...chunk, eof: false } }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
    await expect(
      open({
        encrypted: {
          ...chunk,
          envelope: {
            ...chunk.envelope,
            ciphertext: `${chunk.envelope.ciphertext.startsWith("A") ? "B" : "A"}${chunk.envelope.ciphertext.slice(1)}`,
          },
        },
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
