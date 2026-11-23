// Exercise the public API and both Rust services. Only the provider is local.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { embeddingInputSchema } from "../../packages/protocol/dist/index.js";
import { modelOperationProvider } from "../server-rust/model-operation-provider.mjs";
import { modelOperationClient } from "./model-operation-smoke-client.mjs";

export async function verifyEmbeddings(ports) {
  const { eventually } = ports;
  const upstream = await modelOperationProvider();
  try {
    const client = await modelOperationClient(
      ports,
      upstream,
      "Embedding fixture provider",
    );
    const modelName = "owned-embedding-model";
    const model = await client.model("embedding", {
      name: "Embedding fixture model",
      modelName,
      adapter: "openai-embeddings",
      options: { maxBatchSize: 2 },
    });
    const marker = "Private semantic document 🧭";
    const content = ({ n = 1, ...options } = {}) =>
      embeddingInputSchema.parse({
        items: Array.from({ length: n }, (_, index) => ({
          id: `item-${index}`,
          content: [{ type: "text", text: `${marker} ${index}` }],
        })),
        ...options,
      });
    const make = (input) => client.make("embedding", model, input, marker);
    const { usage } = client;

    upstream.reply("embedding");
    upstream.reply("embedding");
    const first = await make(content({ n: 3 }));
    const output = await first.run();
    assert.equal(output.status, "succeeded", JSON.stringify(output.error));
    assert.equal(output.value.batches, 2);
    assert.deepEqual(
      output.value.items.map(({ index, id, values }) => [index, id, values]),
      [
        [0, "item-0", [1, 0.5, -0.25]],
        [1, "item-1", [2, 0.5, -0.25]],
        [2, "item-2", [1, 0.5, -0.25]],
      ],
    );
    assert.deepEqual(output.value.usage, { inputTokens: 10, totalTokens: 10 });
    const { fingerprint, ...space } = output.value.space;
    const canonical = (value) => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`;
      }
      return JSON.stringify(value);
    };
    assert.equal(
      fingerprint,
      createHash("sha256")
        .update(
          canonical({
            identity: space,
            configuration: {
              adapter: "openai-embeddings",
              encoding_format: "float",
              endpoint: upstream.baseUrl + "/embeddings",
              model: modelName,
            },
            mediaFormat: "content-parts",
          }),
        )
        .digest("hex"),
    );
    await usage(first.operationId, (receipt) => {
      assert.equal(receipt?.requests, 2);
      assert.equal(receipt.succeededRequests, 2);
      assert.equal(receipt.metrics.inputTokens.observed, 10);
      assert.equal(receipt.observedTotalTokens, 10);
    });
    const replay = await first.run();
    assert.equal(replay.error?.code, "invalid-request");
    assert.equal(upstream.requests.length, 2);

    upstream.reply("embedding", { unknownUsage: true });
    const pinned = await make(content({ expectedSpace: output.value.space }));
    const pin = await pinned.run();
    assert.equal(pin.value?.space.fingerprint, fingerprint);
    assert.deepEqual(pin.value.usage, { inputTokens: null, totalTokens: null });
    await usage(pinned.operationId, (receipt) => {
      assert.equal(receipt?.status, "completed");
      assert.deepEqual(receipt.metrics.inputTokens, {
        observed: null,
        reportedRequests: 0,
        overflowed: false,
      });
    });

    const held = upstream.reply("embedding", { hold: true });
    const cancelled = await make(content());
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
          assert.ok(entry.closed);
          assert.equal(entry.completed, false);
        },
      );
      await usage(cancelled.operationId, (receipt) => {
        assert.equal(receipt?.status, "cancelled");
        assert.equal(receipt.cancelledRequests, 1);
      });
      assert.equal((await cancelled.run()).error?.code, "cancelled");
    } finally {
      held.release();
      await running.catch(() => {});
    }

    upstream.reply("embedding", { status: 429 });
    const rejected = await make(content());
    const failure = (await rejected.run()).error;
    assert.equal(failure?.code, "provider-error");
    assert.equal(failure.httpStatus, 429);
    assert.ok(!failure.message.includes("Private provider diagnostic"));

    upstream.reply("embedding", { status: 302 });
    const redirected = await make(content());
    assert.deepEqual((await redirected.run()).error, {
      code: "provider-error",
      message: "The embedding provider request failed.",
      httpStatus: null,
    });
    assert.deepEqual(upstream.failures, []);
  } finally {
    await upstream.close();
  }
}
