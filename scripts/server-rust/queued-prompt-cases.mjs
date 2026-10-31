import assert from "node:assert/strict";
import {
  queuedPromptCreateSchema,
  queuedPromptOpaqueContentSchema,
} from "../../packages/protocol/dist/index.js";
import {
  retainedPrompt,
  promptId,
  deferredAttachment,
} from "./native-settlement-fixtures.mjs";
import { literal, json, stamp } from "./project-target-state.mjs";
import { runEncryptedPromptCases } from "./queued-prompt-encrypted-cases.mjs";
import { runVisiblePromptCases } from "./queued-prompt-visible-cases.mjs";
import { runPromptMutationCases } from "./queued-prompt-mutation-cases.mjs";
export async function runQueuedPromptCases(h) {
  const { observe, reset, snapshot, seed, owner } = h;
  await seed(
    `INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('queue-model',${literal(owner)},'Queue model',${literal(stamp)},${literal(stamp)}),('queue-model-two',${literal(owner)},'Second queue model',${literal(stamp)},${literal(stamp)}) ON CONFLICT DO NOTHING`,
  );
  const call = (action, name, input = {}, options = {}) =>
    observe(
      name,
      (i) => ({
        action,
        chat: "chat",
        ...(typeof input === "function" ? input(i) : input),
      }),
      { op: "native-command-prompt-run", shape: "raw", ...options },
    );
  const encrypted = (extra = {}) => {
    const prompt = { ...retainedPrompt(), ...extra };
    const pendingMessage = {
      ...prompt.pendingMessage,
      classification: {
        ...prompt.pendingMessage.classification,
        ...prompt.classification,
      },
    };
    for (const field of ["reasoningEffort"]) {
      if (Object.hasOwn(prompt, field)) pendingMessage[field] = prompt[field];
    }
    return queuedPromptOpaqueContentSchema.parse({ ...prompt, pendingMessage });
  };
  const visible = (extra = {}) =>
    queuedPromptCreateSchema.parse({
      text: "Legacy fixture",
      idempotencyKey: "legacy-key",
      ...extra,
    });
  const create = (name, content = encrypted(), extra = {}, options = {}) =>
    call("create-encrypted", name, { content, ...extra }, options);
  async function unchanged(name, fn) {
    const before = await snapshot("before " + name);
    const result = await fn();
    assert.deepEqual(await snapshot("prompt unchanged " + name), before);
    return result;
  }
  const helpers = {
    ...h,
    call,
    encrypted,
    visible,
    create,
    unchanged,
    promptId,
    deferredAttachment,
    literal,
    json,
    stamp,
  };
  await runEncryptedPromptCases(helpers);
  await runVisiblePromptCases(helpers);
  await runPromptMutationCases(helpers);
  await reset();
  await create("encrypted prompt persists before actual reopen");
  await h.reopen("queued prompts process restart persistence");
  for (const result of await call(
    "get-encrypted",
    "read encrypted prompt after process restart",
    { prompt: promptId },
  ))
    assert.equal(result.id, promptId);
}
