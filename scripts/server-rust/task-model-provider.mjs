// Public model HTTP boundary for the real Cantrip Codex executable. The browser,
// worker entrypoint, native RPC, encrypted operations and repositories stay real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";

export function modelFunctions(tools, namespace) {
  return (tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? modelFunctions(tool.tools, tool.name)
      : tool.type === "function"
        ? [{ name: tool.name, namespace }]
        : [],
  );
}

export async function taskModelProvider({
  allowMcpDiscoveryProbe = false,
  observeStreams = false,
  expectedApiKey,
  chatgptAccounts,
  tls,
  modelMetadata = {},
  additionalModels = [],
} = {}) {
  const replies = [],
    requests = [],
    failures = [],
    discoveryProbes = [],
    accountQuotaReads = new Set(),
    sockets = new Set();
  // Use the bundled runtime's normal model metadata against this local provider.
  const model = "gpt-5.5";
  const models = [{ ...modelMetadata, id: model }, ...additionalModels];
  let nextResponse = 0;
  const send = (response, event) =>
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const handleRequest = async (request, response) => {
    const pathname = new URL(request.url, "http://fixture.invalid").pathname;
    try {
      if (chatgptAccounts) {
        if (
          pathname.startsWith("/backend-api/plugins/") ||
          pathname.startsWith("/backend-api/ps/plugins/") ||
          [
            "/backend-api/ps/mcp",
            "/backend-api/wham/rate-limit-reset-credits",
            "/backend-api/wham/settings/user",
          ].includes(pathname)
        ) {
          response.writeHead(404).end();
          return;
        }
        if (pathname === "/backend-api/codex/analytics-events/events") {
          response.writeHead(204).end();
          return;
        }
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const text = (
        request.headers["content-encoding"] === "zstd"
          ? zstdDecompressSync(body)
          : body
      ).toString();
      const input = text ? JSON.parse(text) : null;
      const record = {
        method: request.method,
        path: request.url,
        input,
        completed: false,
      };
      if (observeStreams) {
        record.closed = false;
        response.once("close", () => {
          record.closed = true;
          record.closedBeforeCompletion = !record.completed;
        });
      }
      if (chatgptAccounts && pathname.startsWith("/backend-api/")) {
        const account = request.headers["chatgpt-account-id"];
        assert.ok(
          chatgptAccounts.includes(account),
          "Disposable ChatGPT account",
        );
        const bearer = request.headers.authorization?.split(".")[1] ?? "";
        const claims = JSON.parse(Buffer.from(bearer, "base64url").toString());
        assert.ok(claims.sub === account, "Bearer matches the account");
        record.account = account;
        if (
          request.method === "GET" &&
          pathname === "/backend-api/wham/accounts/check"
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              accounts: [
                {
                  id: account,
                  name: account,
                  plan_type: "pro",
                  workspace_backend_origin: "NO_CONSTRAINT",
                  account_routing_override: "NO_CONSTRAINT",
                },
              ],
            }),
          );
          return;
        }
        if (
          request.method === "GET" &&
          pathname === "/backend-api/wham/usage"
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ plan_type: "pro", rate_limit: null }));
          accountQuotaReads.add(account);
          record.completed = true;
          return;
        }
        if (
          request.method === "GET" &&
          pathname === "/backend-api/codex/models"
        ) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ models: [] }));
          record.completed = true;
          return;
        }
      }
      if (
        allowMcpDiscoveryProbe &&
        request.method === "POST" &&
        ["/mcp", "/"].includes(pathname) &&
        request.headers["user-agent"] === "Cantrip-MCP-Discovery/1.0"
      ) {
        assert.deepEqual(input, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: input.params.protocolVersion,
            capabilities: {},
            clientInfo: { name: "cantrip-mcp-discovery", version: "1.0.0" },
          },
        });
        assert.equal(typeof input.params.protocolVersion, "string");
        discoveryProbes.push(record);
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: "This fixture serves model responses." }),
        );
        record.completed = true;
        return;
      }
      if (expectedApiKey !== undefined)
        assert.equal(request.headers.authorization, "Bearer " + expectedApiKey);
      requests.push(record);
      if (
        request.method === "GET" &&
        ["/v1/models", "/models"].includes(pathname)
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: models.map((descriptor) => ({
              object: "model",
              created: 0,
              owned_by: "acceptance",
              ...descriptor,
            })),
          }),
        );
        record.completed = true;
        return;
      }
      assert.equal(request.method, "POST");
      assert.ok(
        [
          "/v1/responses",
          "/responses",
          "/backend-api/codex/responses",
        ].includes(pathname),
        "actual Responses endpoint",
      );
      assert.ok(
        models.some(({ id }) => input.model === id),
        `Unexpected model ${input.model}`,
      );
      assert.equal(input.stream, true);
      let plan = replies[0];
      // A possible extra Goal continuation belongs to that conversation. If it
      // never runs, it must not consume the next Task's scripted quota failure.
      while (plan?.onlyFor && !plan.onlyFor(record)) {
        plan.skipped = true;
        replies.shift();
        plan = replies[0];
      }
      assert.ok(
        plan,
        "the real runtime requested an unscripted model response",
      );
      if (!plan.repeat) replies.shift();
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
      const id = plan.responseId ?? `task-fixture-response-${nextResponse++}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        ...plan.headers,
      });
      send(response, { type: "response.created", response: { id } });
      if (plan.failure) {
        send(response, {
          type: "response.failed",
          response: { id, status: "failed", error: plan.failure },
        });
        response.end();
        record.completed = true;
        return;
      }
      // Paused tool responses can choose their output after inspecting the request.
      if (plan.text === undefined && plan.gate) await plan.gate;
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
      if (plan.toolSearch) {
        send(response, {
          type: "response.output_item.done",
          item: {
            type: "tool_search_call",
            call_id: `${id}-search`,
            execution: "client",
            arguments: plan.toolSearch,
          },
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
      failures.push(
        chatgptAccounts
          ? `${request.method} ${pathname}: ${error.message}`
          : error.message,
      );
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
  };
  const server = tls
    ? createHttpsServer(tls, handleRequest)
    : createServer(handleRequest);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  if (chatgptAccounts) {
    // Exercise the native HTTP quota path. Codex uses its normal HTTP fallback
    // when the Responses WebSocket is unavailable at this endpoint.
    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    });
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const admitted = [];
  return {
    model,
    requests,
    failures,
    discoveryProbes,
    accountQuotaReads,
    baseUrl: `${tls ? "https" : "http"}://127.0.0.1:${server.address().port}/v1`,
    reply(value) {
      const plan = { ...value, entered: false, request: null };
      if (value.repeat) {
        plan.discard = () => {
          const index = replies.indexOf(plan);
          if (index >= 0) replies.splice(index, 1);
        };
      }
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
