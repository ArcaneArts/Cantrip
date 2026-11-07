// Controlled public provider HTTP only. Encryption, admission, cancellation,
// worker transport and usage collection execute in the full production stack.
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function modelOperationProvider() {
  const apiKey = "owned-model-operation-key-private";
  const requests = [],
    failures = [],
    plans = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && path === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    const entry = {
      method: request.method,
      path,
      completed: false,
      closed: false,
    };
    requests.push(entry);
    response.on("close", () => {
      entry.closed = true;
    });
    response.on("finish", () => {
      entry.completed = true;
    });
    try {
      assert.equal(request.method, "POST");
      assert.ok(["/v1/embeddings", "/v1/decisions"].includes(path));
      assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
      entry.authenticated = true;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      entry.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const plan = plans.shift();
      assert.ok(plan, "Unexpected provider inference request");
      assert.equal(
        path,
        plan.operation === "embedding" ? "/v1/embeddings" : "/v1/decisions",
      );
      plan.entry = entry;
      plan.entered = true;
      if (plan.hold) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write(" ");
        await Promise.race([
          plan.gate,
          new Promise((resolve) => response.once("close", resolve)),
        ]);
        if (response.destroyed) return;
      }
      response.statusCode = plan.status ?? 200;
      if (!response.headersSent)
        response.setHeader("content-type", "application/json");
      const usage = plan.unknownUsage
        ? {}
        : {
            usage:
              plan.operation === "embedding"
                ? { prompt_tokens: 5, total_tokens: 5 }
                : {
                    input_tokens: 7,
                    output_tokens: 3,
                    total_tokens: 10,
                    input_tokens_details: {
                      cached_tokens: 2,
                      cache_write_tokens: 1,
                    },
                    output_tokens_details: { reasoning_tokens: 1 },
                  },
          };
      const body = plan.status
        ? { error: { message: "Private provider diagnostic" } }
        : plan.operation === "embedding"
          ? {
              model: "owned-embedding-model",
              data: entry.body.input
                .map((_, index) => ({
                  index,
                  embedding: [index + 1, 0.5, -0.25],
                }))
                .reverse(),
              ...usage,
            }
          : {
              model: "owned-decision-model",
              provider: "owned-provider",
              answers: plan.malformed
                ? []
                : entry.body.questions
                    .map((question) => ({
                      name: question.name,
                      type: question.type,
                      ...(question.type === "predicate"
                        ? { probability: 0.75 }
                        : question.type === "choice"
                          ? {
                              choice: "continue",
                              confidence: 0.8,
                              probabilities: [
                                { value: "continue", probability: 0.8 },
                                { value: "stop", probability: 0.2 },
                              ],
                            }
                          : {
                              score: 0.75,
                              probabilities: [
                                { value: 0, probability: 0.25 },
                                { value: 1, probability: 0.75 },
                              ],
                            }),
                    }))
                    .reverse(),
              ...usage,
            };
      response.end(JSON.stringify(body));
    } catch (error) {
      entry.failure = error.message;
      failures.push({ message: error.message, stack: error.stack });
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "Owned provider assertion failed" }),
      );
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    apiKey,
    requests,
    failures,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    reply(operation, options = {}) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const plan = { operation, ...options, gate, release, entered: false };
      plans.push(plan);
      return plan;
    },
    async close() {
      for (const plan of plans) plan.release();
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
