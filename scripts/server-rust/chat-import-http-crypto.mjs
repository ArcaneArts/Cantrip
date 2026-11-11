import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  openWorkerAttachment,
  openWorkerAttachments,
  openWorkerAttachmentChunk,
  openWorkerAttachmentMetadata,
  protectWorkerAttachmentChunk,
  protectWorkerAttachmentMetadata,
} from "../../cantrip_worker/src/attachment-encryption.ts";
import { protectChatMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import { chatAttachmentSummarySchema } from "../../packages/protocol/dist/attachment-content.js";

const fileBytes = Uint8Array.from({ length: 300001 }, (_, n) => n % 251);
const fileDigest = createHash("sha256").update(fileBytes).digest("hex");

export function importEndpointCrypto(owner) {
  const verified = new Map();
  const counts = {
    messages: 0,
    metadata: 0,
    chunks: 0,
    rejectedChunks: 0,
    failedBindings: 0,
  };
  const service = {
    ownerId: () => owner,
    componentKey(component) {
      if (component === "chat-content")
        return { key: new Uint8Array(32).fill(41), keyRevision: 2 };
      assert.equal(component, "attachment-content");
      return { key: new Uint8Array(32).fill(73), keyRevision: 3 };
    },
  };

  function remember(envelope, kind, id, detail) {
    assert.ok(!verified.has(envelope.nonce));
    verified.set(envelope.nonce, { envelope, kind, id, detail });
  }

  function verify(envelope, kind, id) {
    const entry = verified.get(envelope.nonce);
    assert.ok(entry, "The ciphertext was produced and opened by the fixture");
    assert.equal(entry.kind, kind);
    assert.equal(entry.id, id);
    assert.deepEqual(entry.envelope, envelope);
    return entry.detail;
  }

  const openMessage = (protectedContent, id, classification, ownerId = owner) =>
    decryptChatMessageProtectedContent({
      ownerId,
      messageId: id,
      keyRevision: service.componentKey("chat-content").keyRevision,
      componentKey: service.componentKey("chat-content").key,
      encrypted: protectedContent,
      publicClassification: classification,
    });

  async function protectMessages(command) {
    const openedAttachments = new Map(
      (await openWorkerAttachments(command.attachments, service)).map(
        (attachment) => [attachment.id, attachment],
      ),
    );
    for (const attachment of command.attachments)
      verify(
        attachment.protectedMetadata.envelope,
        "attachment metadata",
        attachment.id,
      );
    return Promise.all(
      command.messages.map(async (message) => {
        const hydrated = {
          ...message,
          content: message.content.map((item) => {
            if (item.type !== "attachment") return item;
            return {
              ...item,
              attachment: chatAttachmentSummarySchema.parse(
                openedAttachments.get(item.attachment.id),
              ),
            };
          }),
        };
        const protectedMessage = await protectChatMessage({
          id: message.id,
          message: hydrated,
          service,
        });
        const { id, classification, protectedContent } = protectedMessage;
        const opened = await openMessage(protectedContent, id, classification);
        assert.deepEqual(opened.content, hydrated.content);
        if (counts.failedBindings === 0) {
          // Reserve the check before awaiting other messages in this batch.
          counts.failedBindings = 2;
          await assert.rejects(() =>
            openMessage(
              protectedContent,
              id,
              classification,
              "foreign-import-owner",
            ),
          );
          await assert.rejects(() =>
            openMessage(protectedContent, "other-message", classification),
          );
        }
        counts.messages++;
        remember(protectedContent.envelope, "chat message", id, {
          classification,
          content: opened.content,
        });
        return protectedMessage;
      }),
    );
  }

  async function protectMetadata(chatId, attachmentId, index, status) {
    const metadata = {
      version: 1,
      fileName: "imported-private-" + index + ".bin",
      mimeType: "application/octet-stream",
      kind: "file",
      source: "file",
      previewText: null,
      sha256: index === 0 ? fileDigest : "0".repeat(64),
      error: status === "available" ? null : "Original attachment " + status,
    };
    const scope = { chatId, attachmentId, service };
    const protectedMetadata = await protectWorkerAttachmentMetadata({
      ...scope,
      content: metadata,
    });
    assert.deepEqual(
      await openWorkerAttachmentMetadata({ ...scope, protectedMetadata }),
      metadata,
    );
    counts.metadata++;
    remember(
      protectedMetadata.envelope,
      "attachment metadata",
      attachmentId,
      metadata,
    );
    return protectedMetadata;
  }

  async function protectChunk(command, count, eof) {
    const scope = {
      chatId: command.chatId,
      attachmentId: command.targetAttachmentId,
      operationId: command.operationId,
      direction: "relay",
      service,
    };
    const bytes = fileBytes.slice(command.offset, command.offset + count);
    assert.equal(bytes.length, count);
    const chunk = await protectWorkerAttachmentChunk({
      ...scope,
      bytes,
      sequence: command.sequence,
      eof,
    });
    assert.deepEqual(
      await openWorkerAttachmentChunk({ ...scope, chunk }),
      bytes,
    );
    remember(chunk.envelope, "attachment chunk", scope.attachmentId, {
      offset: command.offset,
      operationId: command.operationId,
    });
    return chunk;
  }

  function tamperChunk(chunk) {
    const { nonce, ciphertext } = chunk.envelope;
    const altered = {
      ...chunk.envelope,
      ciphertext:
        (ciphertext.startsWith("A") ? "B" : "A") + ciphertext.slice(1),
    };
    verified.get(nonce).tampered = altered;
    return { ...chunk, envelope: altered };
  }

  async function openChunk(command) {
    const { chunk, chatId, attachmentId, operationId, direction } = command;
    assert.equal(direction, "relay");
    const scope = {
      chatId,
      attachmentId,
      operationId,
      direction,
      chunk,
      service,
    };
    const entry = verified.get(chunk.envelope.nonce);
    assert.ok(entry);
    if (entry.tampered) {
      assert.deepEqual(chunk.envelope, entry.tampered);
      try {
        await openWorkerAttachmentChunk(scope);
      } catch (error) {
        assert.equal(error.name, "CantripDecryptionError");
        counts.rejectedChunks++;
        entry.authenticationRejected = true;
        throw error;
      }
      assert.fail("A modified ciphertext reached the attachment receiver");
    }
    const expected = verify(chunk.envelope, "attachment chunk", attachmentId);
    assert.equal(expected.operationId, operationId);
    const bytes = await openWorkerAttachmentChunk(scope);
    assert.deepEqual(
      bytes,
      fileBytes.slice(expected.offset, expected.offset + chunk.plaintextBytes),
    );
    counts.chunks++;
    return bytes;
  }

  function verifyMessage(message) {
    const { id, protectedContent } = message;
    const classification = message.classification ?? {
      role: message.role,
      mode: message.mode,
      attachmentIds: message.attachmentIds,
    };
    const expected = verify(protectedContent.envelope, "chat message", id);
    assert.deepEqual(classification, expected.classification);
    return expected;
  }

  async function reopenMessage(message) {
    const expected = verifyMessage(message);
    const opened = await openMessage(
      message.protectedContent,
      message.id,
      expected.classification,
    );
    assert.deepEqual(opened.content, expected.content);
    return opened.content;
  }

  async function reopenAttachment(attachment) {
    const expected = verify(
      attachment.protectedMetadata.envelope,
      "attachment metadata",
      attachment.id,
    );
    const opened = await openWorkerAttachment(attachment, service);
    assert.equal(opened.sha256, expected.sha256);
    assert.equal(opened.fileName, expected.fileName);
    assert.equal(opened.previewText, expected.error);
    return opened;
  }

  function envelopeLabel(value) {
    const entry = verified.get(value.nonce);
    if (!entry) return undefined;
    if (value.ciphertext === entry.tampered?.ciphertext) {
      assert.ok(entry.authenticationRejected);
      assert.deepEqual(value, entry.tampered);
      return "<rejected import attachment chunk>";
    }
    assert.deepEqual(value, entry.envelope);
    return `<verified import ${entry.kind}>`;
  }

  return {
    counts,
    fileDigest,
    protectMessages,
    protectMetadata,
    protectChunk,
    openChunk,
    tamperChunk,
    openMetadata: (command) =>
      openWorkerAttachmentMetadata({ ...command, service }),
    verifyMessage,
    reopenMessage,
    reopenAttachment,
    verify,
    envelopeLabel,
  };
}
