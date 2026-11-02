// Public model HTTP boundary for the real Cantrip Codex executable. The browser,
// worker entrypoint, native RPC, encrypted operations and repositories stay real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

export async function taskModelProvider() {
  const replies = [],
    requests = [],
    failures = [],
    sockets = new Set();
  // Use the bundled runtime's normal model metadata against this local provider.
  const model = "gpt-5.5";
  let nextResponse = 0;
  const send = (response, event) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const input = text ? JSON.parse(text) : null;
      const record = {
        method: request.method,
        path: request.url,
        input,
        completed: false,
      };
      requests.push(record);
      const pathname = new URL(request.url, "http://fixture.invalid").pathname;
      if (
        request.method === "GET" &&
        ["/v1/models", "/models"].includes(pathname)
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: model,
                object: "model",
                created: 0,
                owned_by: "acceptance",
              },
            ],
          }),
        );
        record.completed = true;
        return;
      }
      assert.equal(request.method, "POST");
      assert.ok(
        ["/v1/responses", "/responses"].includes(pathname),
        "actual Responses endpoint",
      );
      assert.equal(input.model, model);
      assert.equal(input.stream, true);
      const plan = replies.shift();
      assert.ok(
        plan,
        "the real runtime requested an unscripted model response",
      );
      plan.request = record;
      plan.entered = true;
      if (plan.status) {
        response.writeHead(plan.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: plan.error ?? "Controlled model failure",
              type: "server_error",
            },
          }),
        );
        record.completed = true;
        return;
      }
      const id = `task-fixture-response-${nextResponse++}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      send(response, { type: "response.created", response: { id } });
      if (plan.text !== undefined) {
        const item = {
          type: "message",
          role: "assistant",
          id: `${id}-message`,
          content: [{ type: "output_text", text: plan.text }],
        };
        send(response, {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, content: [] },
        });
        send(response, {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: plan.text,
        });
        if (plan.gate) await plan.gate;
        send(response, {
          type: "response.output_item.done",
          output_index: 0,
          item,
        });
      }
      for (const [index, call] of (plan.calls ?? []).entries()) {
        send(response, {
          type: "response.output_item.done",
          output_index: index + (plan.text === undefined ? 0 : 1),
          item: {
            type: "function_call",
            id: `${id}-function-${index}`,
            call_id: `${id}-call-${index}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
            ...(call.namespace ? { namespace: call.namespace } : {}),
          },
        });
      }
      send(response, {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 100,
            input_tokens_details: null,
            output_tokens: 20,
            output_tokens_details: null,
            total_tokens: 120,
          },
        },
      });
      response.end();
      record.completed = true;
    } catch (error) {
      failures.push(error.message);
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Acceptance model boundary failed",
            type: "server_error",
          },
        }),
      );
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const admitted = [];
  return {
    model,
    requests,
    failures,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    reply(value) {
      const plan = { ...value, entered: false, request: null };
      if (value.hold) {
        let release;
        plan.gate = new Promise((resolve) => {
          release = resolve;
        });
        plan.release = release;
      }
      admitted.push(plan);
      replies.push(plan);
      return plan;
    },
    async close() {
      for (const plan of admitted) plan.release?.();
      const closed = once(server, "close");
      server.close();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
