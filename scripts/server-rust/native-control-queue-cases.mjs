import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.ts";
import { protectChatTurn } from "../../cantrip_worker/src/chat-message-encryption.ts";
import {
  decryptQueuedPromptProtectedContent,
  decryptChatMessageProtectedContent,
} from "../../packages/crypto/dist/index.js";
import { componentKey } from "./native-settings-http-fixture.mjs";
import { nativeControlContexts } from "./native-control-http-state.mjs";
import { literal } from "./project-target-state.mjs";
import { eventually } from "./full-worker.mjs";

const envelopeKey = (value) =>
  value && typeof value === "object" && value.algorithm === "AES-256-GCM"
    ? JSON.stringify([
        value.version,
        value.algorithm,
        value.keyRevision,
        value.nonce,
        value.ciphertext,
      ])
    : null;
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const queryManifest = JSON.parse(
  await readFile(
    new URL(
      "../../cantrip_server_rs/contracts/queued-prompt-queries.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function nativeControlQueueCases(h, result) {
  const envelopes = new Map(),
    identities = new Map(),
    digests = new Map(),
    versions = new Map();
  const texts = new Set();
  let nextHold;
  Object.assign(result, {
    cryptoProofs: 0,
    expectedCryptoFailures: 0,
    queuePreparations: [],
    rawQueuePreparations: [],
    rawDigestBindings: [],
    queueStates: [],
    rawQueueStates: [],
    rawQueueIdentityBindings: [],
    rawSqlErrorBindings: [],
  });
  const codecs = new Map(
    nativeControlContexts.map((p) => [
      p.chat,
      createManagedQueueInputCodec({
        encryption: h.encryption,
        chatId: p.chat,
        defaults: () => ({
          mode: "default",
          modelId: "inventory-provider-model-1",
          reasoningEffort: null,
          worktreeId: p.name === "project" ? p.placement : null,
        }),
      }),
    ]),
  );
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const envelope = envelopes.get(envelopeKey(value));
      if (envelope) return envelope;
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, canonical(v)]),
      );
    }
    return identities.get(value) ?? digests.get(value) ?? value;
  }
  function remember(value, label) {
    const key = envelopeKey(value);
    assert.ok(key);
    if (!envelopes.has(key))
      envelopes.set(key, "<verified queue envelope:" + label + ">");
  }
  async function prove(value, label) {
    if (Array.isArray(value)) {
      for (const child of value) await prove(child, label);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (value.pendingMessage && value.protectedContent) {
      const expected = versions.get(
        value.id + ":" + value.protectedContent.envelope.nonce,
      );
      assert.ok(
        expected,
        "queue display was sealed by the actual worker codec",
      );
      const codec = codecs.get(expected.chat);
      const display = await decryptQueuedPromptProtectedContent({
        ownerId: h.owner,
        promptId: value.id,
        keyRevision: value.protectedContent.keyRevision,
        componentKey: new Uint8Array(componentKey),
        encrypted: value.protectedContent,
        publicClassification: value.classification,
      });
      assert.equal(display.text, expected.text);
      const message = value.pendingMessage;
      const pending = await decryptChatMessageProtectedContent({
        ownerId: h.owner,
        messageId: message.id,
        keyRevision: message.protectedContent.keyRevision,
        componentKey: new Uint8Array(componentKey),
        encrypted: message.protectedContent,
        publicClassification: message.classification,
      });
      assert.deepEqual(pending.content, [
        { type: "text", text: expected.text },
      ]);
      const native = await codec.openNativeInput({
        promptId: value.id,
        payload: value.protectedNativeInput,
        text: expected.text,
        attachmentIds: [],
      });
      assert.deepEqual(native.input, [
        { type: "text", text: expected.text, text_elements: [] },
      ]);
      assert.equal(native.retainedGui, true);
      assert.equal(native.action, "literal");
      assert.equal(native.executionMethod, "turn/start");
      result.cryptoProofs += 3;
      remember(value.protectedContent.envelope, expected.label + ":display");
      remember(message.protectedContent.envelope, expected.label + ":message");
      remember(value.protectedNativeInput, label + ":native");
    }
    for (const child of Object.values(value)) await prove(child, label);
  }
  async function make(p, version) {
    const text = `private-native-queue-${p.name}-${version} 🍄`;
    texts.add(text);
    const messageId =
      p.name === "project"
        ? "66666666-6666-4666-8666-666666666661"
        : "66666666-6666-4666-8666-666666666662";
    const turn = await protectChatTurn({
      service: h.encryption,
      text,
      idempotencyKey: p.name + "-retained-message",
      messageId,
      promptId: "55555555-5555-4555-8555-555555555555",
      mode: "default",
      modelId: "inventory-provider-model-1",
      reasoningEffort: null,
    });
    const value = await codecs.get(p.chat).retainGuiPrompt({
      pendingMessage: turn.message,
      attachments: [],
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: "cantrip:" + messageId,
    });
    const prompt = { ...value.prompt, frozen: true };
    // Independently bind the worker's stable UUID to this actual server/chat/message.
    const bytes = createHash("sha256")
      .update(
        JSON.stringify(["cantrip:deferred-gui", h.serverId, p.chat, messageId]),
      )
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex"),
      expectedId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    assert.equal(prompt.id, expectedId);
    identities.set(prompt.id, "<verified retained queue id:" + p.name + ">");
    identities.set(
      `gui-queue:add:${p.chat}:${prompt.id}`,
      "<verified queue add:" + p.name + ">",
    );
    result.rawQueueIdentityBindings.push({
      serverId: h.serverId,
      chatId: p.chat,
      messageId,
      promptId: prompt.id,
      expectedId,
    });
    versions.set(prompt.id + ":" + prompt.protectedContent.envelope.nonce, {
      chat: p.chat,
      text,
      label: p.name + ":" + version,
    });
    await prove(prompt, p.name + ":" + version + ":original");
    return prompt;
  }
  async function prepare(command) {
    assert.equal(command.type, "chat.queue.prepare");
    assert.ok(codecs.has(command.chatId));
    assert.deepEqual(command.attachments, []);
    result.commands.push(h.fixture.normalize(command));
    const normalized = await codecs
      .get(command.chatId)
      .normalizePrompt(command.prompt);
    assert.notDeepEqual(
      normalized.protectedNativeInput,
      command.prompt.protectedNativeInput,
      "actual worker reseals native input",
    );
    assert.deepEqual(
      normalized.protectedContent,
      command.prompt.protectedContent,
    );
    assert.deepEqual(normalized.pendingMessage, command.prompt.pendingMessage);
    const label = "normalization:" + result.queuePreparations.length;
    await prove(normalized, label);
    result.rawQueuePreparations.push({
      request: structuredClone(command),
      response: structuredClone(normalized),
    });
    result.queuePreparations.push({
      chatId: command.chatId,
      resealedNativeInput: true,
      retainedDisplayAndPendingMessage: true,
    });
    if (nextHold) {
      const held = nextHold;
      nextHold = undefined;
      held.requested = true;
      await held.promise;
    }
    return normalized;
  }
  async function verifyDigest(p, operationId, mutation, required = true) {
    const [row] = await h.fixture.sql(
      [],
      [
        `SELECT (SELECT to_jsonb(n) FROM native_commands n WHERE operation_id=${literal(operationId)})::text result`,
      ],
    );
    if (!required && row === null) return;
    assert.ok(row, "actual durable queue receipt");
    const expected = sha(mutation);
    assert.equal(
      row.payload_digest,
      expected,
      "receipt binds the original GUI mutation, before worker resealing",
    );
    result.rawDigestBindings.push({ operationId, mutation, expected, row });
    digests.set(
      expected,
      "<verified original queue mutation digest:" +
        operationId.replace(
          `gui-queue:add:${p.chat}:` + mutation.prompt.id,
          p.name + ":add",
        ) +
        ">",
    );
  }
  function queueQuery(p) {
    return `SELECT jsonb_build_object('prompts',COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM queued_prompts q WHERE q.chat_id=${literal(p.chat)}),'[]'::jsonb),'revision',(SELECT revision FROM managed_queue_states WHERE chat_id=${literal(p.chat)}),'operations',COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.operation_id) FROM native_commands n WHERE n.chat_id=${literal(p.chat)} AND n.method LIKE 'thread/queue/%'),'[]'::jsonb)) result`;
  }
  function sqlClocks(value) {
    if (Array.isArray(value)) return value.map(sqlClocks);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => {
          if (v !== null && /_at$/.test(key)) {
            const time = new Date(v);
            assert.ok(Number.isFinite(time.valueOf()), key + " SQL timestamp");
            return [key, h.fixture.normalize(time.toISOString(), "updatedAt")];
          }
          return [key, sqlClocks(v)];
        }),
      );
    return value;
  }
  async function snapshot(p, label) {
    const [state] = await h.fixture.sql(
      [],
      [queueQuery(p).replace(" result", "::text result")],
    );
    for (const prompt of state.prompts) {
      assert.equal(
        prompt.text,
        null,
        "durable queue rows retain opaque content",
      );
      await prove(prompt.opaque_content, p.name + ":SQL:" + label);
    }
    result.rawQueueStates.push({ label, context: p.name, state });
    result.queueStates.push({
      label,
      context: p.name,
      state: h.fixture.normalize(canonical(sqlClocks(state))),
    });
    return state;
  }
  function verifySqlFailure(response, p, startedAt) {
    const prompt = result.rawQueuePreparations.at(-1).response;
    assert.equal(
      prompt.id,
      result.rawQueueIdentityBindings.find((value) => value.chatId === p.chat)
        .promptId,
    );
    const parameters = [
      JSON.stringify(prompt),
      prompt.classification.mode,
      "[]",
      prompt.reasoningEffort,
      prompt.customSubagentModel,
      prompt.subagentModelId,
      prompt.subagentReasoningEffort,
      prompt.worktreeId,
      prompt.frozen,
    ];
    const prefix = `Failed query: ${queryManifest.replace}\nparams: ${parameters.join(",")},`;
    const suffix = `,${prompt.id},${h.owner}`;
    assert.equal(
      response.error.startsWith(prefix),
      true,
      "public SQL diagnostic retains the exact actual normalized worker envelope and ORM fields",
    );
    assert.equal(
      response.error.endsWith(suffix),
      true,
      "SQL diagnostic owner and prompt parameters",
    );
    const at = response.error.slice(prefix.length, -suffix.length),
      time = new Date(at);
    assert.equal(time.toISOString(), at);
    assert.ok(
      time.valueOf() >= startedAt && time.valueOf() <= Date.now(),
      "SQL diagnostic carries the actual request's update clock",
    );
    assert.equal(response.error, prefix + at + suffix);
    result.rawSqlErrorBindings.push({
      context: p.name,
      error: response.error,
      query: queryManifest.replace,
      parameters: [...parameters, at, prompt.id, h.owner],
      requestStartedAt: startedAt,
      verifiedAt: Date.now(),
    });
    const compared = [
      JSON.stringify(h.fixture.normalize(canonical(prompt))),
      ...parameters.slice(1),
      "<verified request update clock>",
      canonical(prompt.id),
      h.fixture.normalize(h.owner),
    ];
    const observation = result.observations.at(-1);
    assert.equal(
      observation.name,
      p.name + " queue SQL failure after worker normalization",
    );
    observation.body.error = `Failed query: ${queryManifest.replace}\nparams: ${compared.join(",")}`;
  }
  async function run(profile) {
    for (const p of nativeControlContexts) {
      await h.fixture.sql([
        `UPDATE chats SET model_id='inventory-provider-model-1' WHERE id=${literal(p.chat)}`,
      ]);
      const base = `/api/chats/${p.chat}/queue`,
        first = await make(p, "original");
      const visit = async (label, method, route, options = {}) => {
        const value = await h.visit(
          p.name + " queue " + label,
          method,
          route,
          options,
        );
        await prove(value, p.name + ":HTTP:" + label);
        return value;
      };
      const added = await visit("add frozen retained input", "POST", base, {
        status: 201,
        json: first,
      });
      assert.equal(added.frozen, true);
      assert.equal(added.id, first.id);
      await verifyDigest(p, `gui-queue:add:${p.chat}:${first.id}`, {
        kind: "add",
        prompt: first,
        attachments: [],
      });
      const replacement = await make(p, "edited"),
        route = `/api/queued-prompts/${first.id}`;
      const update = {
        prompt: replacement,
        expectedItemRevision: added.revision,
        operationId: p.name + "-queue-prepare-edit",
      };
      const original = (input) => ({
        kind: "update",
        id: first.id,
        expectedItemRevision: input.expectedItemRevision,
        prompt: input.prompt,
        attachments: [],
      });
      const before = result.queuePreparations.length;
      if (profile !== "none")
        await visit("CSRF before normalization", "PATCH", route, {
          json: update,
          csrf: false,
          status: 403,
        });
      if (profile === "accounts")
        await visit("foreign owner cannot normalize", "PATCH", route, {
          json: update,
          client: "other",
          status: 404,
        });
      await visit("revision required before normalization", "PATCH", route, {
        json: { prompt: replacement },
        status: 409,
      });
      assert.equal(result.queuePreparations.length, before);
      const edited = await visit(
        "actual native input preparation",
        "PATCH",
        route,
        { json: update },
      );
      assert.equal(edited.revision, added.revision + 1);
      assert.equal(result.queuePreparations.length, before + 1);
      assert.deepEqual(
        edited.protectedNativeInput,
        result.rawQueuePreparations.at(-1).response.protectedNativeInput,
      );
      await verifyDigest(p, update.operationId, original(update));
      assert.deepEqual(
        await visit("exact replay avoids resealing", "PATCH", route, {
          json: update,
        }),
        edited,
      );
      assert.equal(result.queuePreparations.length, before + 1);
      await snapshot(p, "normalized input and immutable replay");

      const stale = { ...update, operationId: p.name + "-queue-prepare-stale" };
      await visit("stale revision cannot replace input", "PATCH", route, {
        json: stale,
        status: 409,
      });
      await verifyDigest(p, stale.operationId, original(stale));
      const stable = await snapshot(p, "stale edit preserves accepted input");
      assert.equal(stable.prompts[0].revision, edited.revision);
      assert.deepEqual(
        stable.prompts[0].opaque_content.protectedNativeInput,
        edited.protectedNativeInput,
      );

      const damaged = structuredClone(replacement),
        bytes = Buffer.from(damaged.protectedNativeInput.ciphertext, "base64");
      bytes[0] ^= 1;
      damaged.protectedNativeInput.ciphertext = bytes.toString("base64url");
      await assert.rejects(codecs.get(p.chat).normalizePrompt(damaged));
      result.expectedCryptoFailures++;
      envelopes.set(
        envelopeKey(damaged.protectedNativeInput),
        "<verified rejected tampered native input:" + p.name + ">",
      );
      const corrupt = {
        prompt: damaged,
        expectedItemRevision: edited.revision,
        operationId: p.name + "-queue-prepare-corrupt",
      };
      await visit("real worker rejects tampered native input", "PATCH", route, {
        json: corrupt,
        status: 409,
      });
      assert.deepEqual(
        await snapshot(
          p,
          "tampered input leaves all durable queue authority unchanged",
        ),
        stable,
      );

      const third = await make(p, "transaction-retry");
      const retry = {
        prompt: third,
        expectedItemRevision: edited.revision,
        operationId: p.name + "-queue-prepare-sql-retry",
      };
      await h.fixture.sql([
        "CREATE FUNCTION native_queue_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native-queue-transaction-rejection'; END $$",
        "CREATE TRIGGER native_queue_reject BEFORE UPDATE ON queued_prompts FOR EACH ROW EXECUTE FUNCTION native_queue_reject()",
      ]);
      const failureStartedAt = Date.now();
      const sqlFailure = await visit(
        "SQL failure after worker normalization",
        "PATCH",
        route,
        {
          json: retry,
          status: 409,
        },
      );
      verifySqlFailure(sqlFailure, p, failureStartedAt);
      assert.deepEqual(
        await snapshot(
          p,
          "SQL rejection rolls back prompt, receipt and queue revision",
        ),
        stable,
      );
      await h.fixture.sql([
        "DROP TRIGGER native_queue_reject ON queued_prompts",
        "DROP FUNCTION native_queue_reject()",
      ]);
      const retried = await visit(
        "retry same operation after SQL rollback",
        "PATCH",
        route,
        { json: retry },
      );
      assert.equal(retried.revision, edited.revision + 1);
      await verifyDigest(p, retry.operationId, original(retry));
      await snapshot(p, "normalized retry persists exact worker envelope");

      // Two real HTTP mutations race while the first worker response is held.
      const heldPrompt = await make(p, "held-edit"),
        winnerPrompt = await make(p, "concurrent-winner");
      let release;
      const held = {
        requested: false,
        promise: new Promise((resolve) => (release = resolve)),
        release: () => release(),
      };
      nextHold = held;
      const heldInput = {
        prompt: heldPrompt,
        expectedItemRevision: retried.revision,
        operationId: p.name + "-queue-prepare-held",
      };
      const pending = visit(
        "held normalization loses revision race",
        "PATCH",
        route,
        { json: heldInput, status: 409 },
      );
      try {
        await eventually(
          () => held.requested,
          (value) => assert.equal(value, true),
          15000,
        );
        const winnerInput = {
          prompt: winnerPrompt,
          expectedItemRevision: retried.revision,
          operationId: p.name + "-queue-prepare-winner",
        };
        const winner = await visit(
          "concurrent normalized edit wins",
          "PATCH",
          route,
          { json: winnerInput },
        );
        assert.equal(winner.revision, retried.revision + 1);
        await verifyDigest(p, winnerInput.operationId, original(winnerInput));
        held.release();
        await pending;
        await verifyDigest(p, heldInput.operationId, original(heldInput));
        const final = await snapshot(
          p,
          "late normalization cannot overwrite the accepted concurrent edit",
        );
        assert.equal(final.prompts[0].revision, winner.revision);
        assert.deepEqual(
          final.prompts[0].opaque_content.protectedNativeInput,
          winner.protectedNativeInput,
        );
      } finally {
        held.release();
        nextHold = undefined;
      }
    }
  }
  function finish() {
    for (const text of texts)
      assert.equal(
        JSON.stringify([
          ...h.fixture.records.values(),
          h.live.history,
          h.diagnostics(),
          result.rawQueueStates,
          result.rawDurable,
        ]).includes(text),
        false,
        "native queue plaintext remains at endpoints",
      );
  }
  return { prepare, run, canonical, finish, queueQuery };
}
