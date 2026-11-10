import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  encryptTaskProtectedContent,
  decryptTaskProtectedContent,
  encryptTaskMessageProtectedContent,
  decryptTaskMessageProtectedContent,
  encryptTaskPlanningRoundProtectedContent,
  decryptTaskPlanningRoundProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { componentKey } from "./native-settings-http-fixture.mjs";
import { taskContent, taskTimestamp } from "./task-wire-fixtures.mjs";

const fingerprint = (v) =>
  v?.algorithm === "AES-256-GCM"
    ? JSON.stringify([
        v.version,
        v.algorithm,
        v.keyRevision,
        v.nonce,
        v.ciphertext,
      ])
    : null;

export function nativeRecoveryGoalContent(h, result, chatId) {
  const started = Date.now();
  const marker = "Private original Task Goal and response 日本語 🌳";
  const envelopes = new Map(),
    identities = new Map();
  async function task(
    state = "implementing",
    ordinal = 1,
    extra = {
      hasPlan: true,
      hasFinalPlan: true,
      hasGoalPrompt: true,
    },
    name = "original Task",
  ) {
    const classification = taskContent(state, ordinal, extra).classification;
    const content = {
      version: 1,
      classification,
      briefMarkdown: marker,
      planMarkdown: classification.hasPlan ? marker : null,
      currentQuestions: [],
      currentAnswers: [],
      additionalDirection: "",
      finalPlanMarkdown: classification.hasFinalPlan ? marker : null,
      goalPrompt: classification.hasGoalPrompt ? marker : null,
      lastError: classification.lastError
        ? { ...classification.lastError, message: marker }
        : null,
    };
    const frame = await encryptTaskProtectedContent({
      ownerId: h.owner,
      chatId,
      keyRevision: 1,
      componentKey: new Uint8Array(componentKey),
      content,
    });
    envelopes.set(fingerprint(frame.envelope), {
      kind: "task",
      id: chatId,
      frame,
      content,
      name,
    });
    return { classification, protectedContent: frame };
  }
  async function round(id, classification, name) {
    const content = {
      version: 1,
      classification,
      inputBriefMarkdown: marker,
      inputPlanMarkdown: null,
      inputQuestions: [],
      inputAnswers: [],
      additionalDirection: "",
      outputPlanMarkdown: classification.hasOutputPlan ? marker : null,
      outputQuestions: [],
      outputGoalPrompt: classification.hasOutputGoalPrompt ? marker : null,
      error: classification.error
        ? { ...classification.error, message: marker }
        : null,
    };
    const frame = await encryptTaskPlanningRoundProtectedContent({
      ownerId: h.owner,
      roundId: id,
      keyRevision: 1,
      componentKey: new Uint8Array(componentKey),
      content,
    });
    envelopes.set(fingerprint(frame.envelope), {
      kind: "round",
      id,
      frame,
      content,
      name,
    });
    return { classification, protectedContent: frame };
  }
  async function message(
    id,
    role,
    idempotencyKey,
    name,
    text = marker,
    mode = "goal",
  ) {
    const classification = { role, mode, attachmentIds: [] };
    const content = {
      version: 1,
      classification,
      content: [{ type: "text", text }],
    };
    const frame = await encryptTaskMessageProtectedContent({
      ownerId: h.owner,
      messageId: id,
      keyRevision: 1,
      componentKey: new Uint8Array(componentKey),
      content,
    });
    envelopes.set(fingerprint(frame.envelope), {
      kind: "message",
      id,
      frame,
      content,
      name,
    });
    return {
      id,
      classification,
      protectedContent: frame,
      reasoningEffort: null,
      idempotencyKey,
    };
  }
  async function prove(value) {
    if (Array.isArray(value)) {
      for (const item of value) await prove(item);
    } else if (value && typeof value === "object") {
      if (fingerprint(value)) {
        const expected = envelopes.get(fingerprint(value));
        assert.ok(
          expected,
          "stored Goal content is original endpoint ciphertext",
        );
        assert.deepEqual(value, expected.frame.envelope);
        const common = {
          ownerId: h.owner,
          keyRevision: 1,
          componentKey: new Uint8Array(componentKey),
          encrypted: expected.frame,
          publicClassification: expected.content.classification,
        };
        const opened =
          expected.kind === "task"
            ? await decryptTaskProtectedContent({
                ...common,
                chatId: expected.id,
              })
            : expected.kind === "round"
              ? await decryptTaskPlanningRoundProtectedContent({
                  ...common,
                  roundId: expected.id,
                })
              : await decryptTaskMessageProtectedContent({
                  ...common,
                  messageId: expected.id,
                });
        assert.deepEqual(opened, expected.content);
        result.cryptoProofs++;
      } else {
        for (const item of Object.values(value)) await prove(item);
      }
    }
  }
  function identity(actual, label) {
    assert.equal(typeof actual, "string");
    assert.equal(identities.has(actual), false);
    identities.set(actual, label);
  }
  function canonical(value, field = "") {
    if (Array.isArray(value))
      return value.map((item) => canonical(item, field));
    if (value && typeof value === "object") {
      const expected = envelopes.get(fingerprint(value));
      if (expected) return "<verified Goal envelope:" + expected.name + ">";
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
      if (at === Date.parse(taskTimestamp))
        return "<original client timestamp>";
      if (at === Date.parse("2099-01-01T00:00:00.000Z"))
        return "<original fixture lease expiry>";
      assert.ok(
        Number.isFinite(at) && at >= started && at <= Date.now() + 1000,
        field,
      );
      return "<validated Goal write clock>";
    }
    return identities.get(value) ?? value;
  }
  function noteDigest(note) {
    return createHash("sha256").update(JSON.stringify(note)).digest("hex");
  }
  function finish() {
    for (const text of [marker, encodeURIComponent(marker)]) {
      assert.equal(
        JSON.stringify([...h.fixture.records.values()]).includes(text),
        false,
      );
      assert.equal(
        JSON.stringify([h.diagnostics(), ...result.serverExits]).includes(text),
        false,
      );
    }
  }
  return {
    task,
    round,
    message,
    prove,
    identity,
    canonical,
    noteDigest,
    finish,
  };
}
