import assert from "node:assert/strict";
import {
  protectNativeCommandContent,
  openNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";
import { settingsChat as chatId } from "./native-settings-http-fixture.mjs";

const key = (value) =>
  value?.algorithm === "AES-256-GCM"
    ? JSON.stringify([
        value.version,
        value.algorithm,
        value.keyRevision,
        value.nonce,
        value.ciphertext,
      ])
    : null;

export function nativeRecoveryHttpContent(h, result) {
  const started = Date.now();
  const envelopes = new Map(),
    digests = new Map();
  const privateText = "Private suspended native input 日本語 🌳";
  async function protect(operationId, direction, name, fields = {}) {
    const context = { chatId, operationId, direction };
    const content = { ...fields, privateText };
    const value = await protectNativeCommandContent({
      service: h.encryption,
      context,
      content,
    });
    envelopes.set(key(value.envelope), { ...value, context, content, name });
    digests.set(value.digest, "<verified native digest:" + name + ">");
    return { payloadDigest: value.digest, protectedPayload: value.envelope };
  }
  async function prove(value) {
    if (Array.isArray(value)) {
      for (const item of value) await prove(item);
    } else if (value && typeof value === "object") {
      if (key(value)) {
        const expected = envelopes.get(key(value));
        assert.ok(expected, "only original endpoint ciphertext is stored");
        assert.deepEqual(value, expected.envelope);
        assert.deepEqual(
          await openNativeCommandContent({
            service: h.encryption,
            context: expected.context,
            envelope: value,
          }),
          expected.content,
        );
        result.cryptoProofs++;
      } else {
        for (const item of Object.values(value)) await prove(item);
      }
    }
  }
  function canonical(value, field = "") {
    if (Array.isArray(value))
      return value.map((item) => canonical(item, field));
    if (value && typeof value === "object") {
      const expected = envelopes.get(key(value));
      if (expected) return "<verified native envelope:" + expected.name + ">";
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v, k)]),
      );
    }
    if (
      typeof value === "string" &&
      field.endsWith("_at") &&
      /^\d{4}-/.test(value)
    ) {
      const at = Date.parse(value);
      assert.ok(
        Number.isFinite(at) && at >= started && at <= Date.now() + 1000,
      );
      return "<validated native write clock>";
    }
    return digests.get(value) ?? value;
  }
  function finish() {
    const publicValues = JSON.stringify([...h.fixture.records.values()]);
    const diagnostics = JSON.stringify([
      h.diagnostics(),
      ...result.serverExits,
    ]);
    assert.equal(publicValues.includes(privateText), false);
    assert.equal(diagnostics.includes(privateText), false);
  }
  return { protect, prove, canonical, finish };
}
