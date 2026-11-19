import assert from "node:assert/strict";
import { decisionInputSchema } from "../../packages/protocol/dist/index.js";
import { modelOperationProvider } from "../server-rust/model-operation-provider.mjs";
import { modelOperationClient } from "./model-operation-smoke-client.mjs";

const state = { privateState: "decision fixture state 🧭" };
const image = { type: "image", url: "data:image/png;base64,AA==" };
const questions = [
  {
    type: "predicate",
    id: "is-ready",
    criteria: { true: "ready", false: "waiting" },
  },
  {
    type: "choice",
    id: "next-step",
    choices: [{ id: "continue" }, { id: "stop" }],
  },
  { type: "score", id: "rating", levels: [{ id: "low" }, { id: "high" }] },
];

const nativeAnswers = {
  rating: { type: "score", score: 0.75, probabilities: { 1: 0.75, 0: 0.25 } },
  "next-step": {
    type: "choice",
    choice: "continue",
    probabilities: { stop: 0.2, continue: 0.8 },
  },
  "is-ready": { type: "noul", noul: 0.75 },
};

function verifyAnswerOrder(value, model, adapter) {
  assert.equal(value.adapter, adapter);
  assert.equal(value.modelId, model.id);
  assert.deepEqual(
    value.answers.map(({ id }) => id),
    questions.map(({ id }) => id),
  );
  assert.deepEqual(value.answers[2].probabilities, [
    { id: "low", probability: 0.25 },
    { id: "high", probability: 0.75 },
  ]);
  assert.equal(value.answers[2].score, 0.75);
}

export async function verifyDecisions(ports) {
  const { eventually } = ports;
  const upstream = await modelOperationProvider();
  try {
    const client = await modelOperationClient(
      ports,
      upstream,
      "Decision fixture provider",
    );
    const modelFor = (adapter, options) =>
      client.model("decision", {
        name: `Decision fixture ${adapter}`,
        modelName: "owned-decision-model",
        adapter,
        options,
      });
    const make = (model, content) =>
      client.make(
        "decision",
        model,
        decisionInputSchema.parse(content),
        state.privateState,
      );
    const openai = await modelFor("openai-decisions", {});
    upstream.reply("decision");
    const first = await make(openai, { state, questions, media: [image] });
    const output = await first.run();
    assert.equal(output.status, "succeeded", JSON.stringify(output.error));
    verifyAnswerOrder(output.value, openai, "openai-decisions");
    assert.equal(output.value.answers[0].probability, 0.75);
    assert.equal(output.value.answers[1].choice, "continue");
    assert.equal(output.value.actualProvider, "owned-provider");
    assert.deepEqual(output.value.usage, {
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
      cost: null,
    });
    assert.deepEqual(upstream.requests[0].body.input[0].content, [
      { type: "input_json", data: state },
      { type: "input_image", image_url: image.url },
    ]);
    assert.equal(
      upstream.requests[0].body.questions[0].instructions,
      "True: ready\nFalse: waiting",
    );
    await client.usage(first.operationId, (receipt) => {
      assert.equal(receipt?.succeededRequests, 1);
      assert.equal(receipt.operation, "decision");
      assert.equal(receipt.observedTotalTokens, 10);
      assert.equal(receipt.metrics.cachedInputTokens.observed, 2);
      assert.equal(receipt.metrics.cacheWriteInputTokens.observed, 1);
      assert.equal(receipt.metrics.reasoningOutputTokens.observed, 1);
    });
    assert.equal((await first.run()).error?.code, "invalid-request");
    assert.equal(upstream.requests.length, 1);

    const system = await modelFor("system-one", { typesafeImages: true });
    const typedQuestions = [
      {
        ...questions[0],
        instructions: "Criterion",
        instructionImages: [image],
      },
      ...questions.slice(1),
    ];
    upstream.reply("decision", {
      path: "/v1/systemone",
      response: {
        answers: {
          ...nativeAnswers,
          "is-ready": { type: "refusal", refusal: "Unable to assess" },
          "next-step": {
            type: "error",
            error: { message: "Question unavailable" },
          },
        },
      },
    });
    const native = await (
      await make(system, { state, questions: typedQuestions, media: [image] })
    ).run();
    assert.equal(native.status, "succeeded", JSON.stringify(native.error));
    verifyAnswerOrder(native.value, system, "system-one");
    assert.equal(native.value.status, "partial");
    assert.equal(native.value.answers[0].reason, "Unable to assess");
    assert.deepEqual(native.value.answers[1].error, {
      message: "Question unavailable",
    });
    const systemRequest = upstream.requests[1];
    assert.equal(systemRequest.typesafeImages, "true");
    const [nativeState, sharedImage] = systemRequest.body.state;
    assert.deepEqual(nativeState, state);
    const [instruction, questionImage] =
      systemRequest.body.questions["is-ready"].instructions.split("\n");
    assert.equal(instruction, "Criterion");
    assert.match(sharedImage, /^cantrip-image-[a-f0-9-]{36}$/);
    assert.match(questionImage, /^cantrip-image-[a-f0-9-]{36}$/);
    assert.notEqual(sharedImage, questionImage);
    for (const reference of [sharedImage, questionImage]) {
      assert.deepEqual(systemRequest.body.assets[reference], {
        type: "image",
        format: "png",
        data_base64: "AA==",
      });
    }

    const router = await modelFor("openrouter-decisions", {
      providerRouting: { allow_fallbacks: false },
    });
    const audio = { type: "audio", url: "data:audio/x-wav;base64,AA==" };
    upstream.reply("decision", {
      path: "/alpha/decisions",
      response: { answers: nativeAnswers },
    });
    const gateway = await (
      await make(router, { state, questions: typedQuestions, media: [audio] })
    ).run();
    assert.equal(gateway.status, "succeeded", JSON.stringify(gateway.error));
    verifyAnswerOrder(gateway.value, router, "openrouter-decisions");
    assert.equal(gateway.value.answers[0].probability, 0.75);
    assert.deepEqual(upstream.requests[2].body.state, [
      state,
      { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
    ]);
    assert.deepEqual(
      upstream.requests[2].body.questions["is-ready"].instructions[1],
      {
        type: "image_url",
        image_url: { url: image.url },
      },
    );
    assert.deepEqual(upstream.requests[2].body.provider, {
      allow_fallbacks: false,
    });

    upstream.reply("decision", { malformed: true });
    const malformed = await make(openai, { state, questions });
    assert.equal((await malformed.run()).error?.code, "invalid-response");
    await client.usage(malformed.operationId, (receipt) => {
      assert.equal(receipt?.failedRequests, 1);
      assert.equal(receipt.observedTotalTokens, 10);
    });

    const priorRequests = upstream.requests.length;
    const duplicates = await client.make(
      "decision",
      openai,
      { state, questions: [questions[0], questions[0]] },
      state.privateState,
    );
    assert.equal((await duplicates.run()).error?.code, "invalid-request");
    assert.equal(upstream.requests.length, priorRequests);

    const held = upstream.reply("decision", { hold: true });
    const cancelled = await make(openai, { state, questions });
    const running = cancelled.run();
    running.catch(() => {});
    try {
      await eventually(
        () => held,
        (plan) => assert.ok(plan.entered),
      );
      assert.equal((await cancelled.cancel()).cancelled, true);
      assert.equal((await running).error?.code, "cancelled");
      await eventually(
        () => held.entry,
        (entry) => {
          assert.equal(entry.closed, true);
          assert.equal(entry.completed, false);
        },
      );
      await client.usage(cancelled.operationId, (receipt) => {
        assert.equal(receipt?.cancelledRequests, 1);
      });
    } finally {
      held.release();
      await running.catch(() => {});
    }
    assert.deepEqual(upstream.failures, []);
  } finally {
    await upstream.close();
  }
}
