import assert from "node:assert/strict";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  decryptQueuedPromptProtectedContent,
  decryptChatMessageProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { componentKey } from "./native-settings-http-fixture.mjs";

const fingerprint = (v) =>
  v && typeof v === "object" && v.algorithm === "AES-256-GCM"
    ? JSON.stringify([
        v.version,
        v.algorithm,
        v.keyRevision,
        v.nonce,
        v.ciphertext,
      ])
    : null;

export function nativeQueueHttpContent(h, result, namespace = "endpoint") {
  const versions = new Map(),
    envelopes = new Map(),
    identities = new Map(),
    privateTexts = new Set();
  const versionKey = (id, nonce) => id + ":" + nonce;
  async function prompt({
    id,
    messageId,
    key,
    text,
    reasoningEffort = null,
    modelId = "queue-model",
  }) {
    const turn = await protectChatTurn({
      service: h.encryption,
      text,
      idempotencyKey: key,
      messageId,
      promptId: id,
      mode: "default",
      modelId,
      reasoningEffort,
    });
    const value = {
      ...turn.queuedPrompt,
      frozen: true,
      nativeAction: "literal",
      executionMethod: "turn/start",
      nativeClientUserMessageId: "cantrip:" + messageId,
      protectedNativeInput: turn.queuedPrompt.protectedContent.envelope,
    };
    versions.set(versionKey(id, value.protectedContent.envelope.nonce), {
      value,
      text,
    });
    for (const envelope of [
      value.protectedContent.envelope,
      value.pendingMessage.protectedContent.envelope,
    ])
      envelopes.set(
        fingerprint(envelope),
        "<verified " + namespace + " envelope:" + envelopes.size + ">",
      );
    privateTexts.add(text);
    return value;
  }
  async function prove(value) {
    if (Array.isArray(value)) {
      for (const item of value) await prove(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.pendingMessage && value.protectedContent) {
      const expected = versions.get(
        versionKey(value.id, value.protectedContent.envelope.nonce),
      );
      assert.ok(
        expected,
        "queue ciphertext was produced by this endpoint fixture",
      );
      assert.deepEqual(
        value.protectedContent,
        expected.value.protectedContent,
        "queue ciphertext is retained byte for byte",
      );
      assert.deepEqual(
        value.pendingMessage.protectedContent,
        expected.value.pendingMessage.protectedContent,
        "future user message ciphertext is retained byte for byte",
      );
      const queued = await decryptQueuedPromptProtectedContent({
        ownerId: h.owner,
        promptId: value.id,
        keyRevision: value.protectedContent.keyRevision,
        componentKey: new Uint8Array(componentKey),
        encrypted: value.protectedContent,
        publicClassification: value.classification,
      });
      assert.equal(queued.text, expected.text);
      const pending = value.pendingMessage;
      const message = await decryptChatMessageProtectedContent({
        ownerId: h.owner,
        messageId: pending.id,
        keyRevision: pending.protectedContent.keyRevision,
        componentKey: new Uint8Array(componentKey),
        encrypted: pending.protectedContent,
        publicClassification: pending.classification,
      });
      assert.deepEqual(message.content, [
        { type: "text", text: expected.text },
      ]);
      result.cryptoProofs += 2;
    }
    for (const child of Object.values(value)) await prove(child);
  }
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const envelope = envelopes.get(fingerprint(value));
      if (envelope) return envelope;
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v)]),
      );
    }
    return identities.get(value) ?? value;
  }
  function identity(actual, label) {
    assert.equal(typeof actual, "string");
    assert.equal(
      identities.has(actual),
      false,
      "distinct queue import identity",
    );
    identities.set(actual, label);
    for (const prefix of ["queue-delete:", "queue-import:"])
      identities.set(prefix + actual, prefix + label);
  }
  async function sdk(name, operation) {
    const value = await operation();
    await prove(value);
    result.workerSdkOperations++;
    result.sdkObservations.push({ name, body: h.fixture.normalize(value) });
    return value;
  }
  function finish() {
    for (const text of privateTexts) {
      assert.equal(
        JSON.stringify([
          ...h.fixture.records.values(),
          h.live.history,
        ]).includes(text),
        false,
        "private queue content stays opaque on HTTP and Live",
      );
      assert.equal(
        JSON.stringify(h.diagnostics()).includes(text),
        false,
        "private queue content stays out of server/transport diagnostics",
      );
    }
    result.observations = canonical(result.observations);
    result.sdkObservations = canonical(result.sdkObservations);
  }
  return { prompt, prove, canonical, identity, sdk, finish };
}
