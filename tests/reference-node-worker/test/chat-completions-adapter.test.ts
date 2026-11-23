import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startChatCompletionsAdapter } from "../src/codex/chat-completions-adapter.js";
import {
  chatCompletionsRequest,
  responsesMessages,
} from "../src/codex/chat-completions-request.js";
import { chatCompletionEvents } from "../src/codex/chat-completions-stream.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
  apiKey: string | null = null,
) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  const adapter = await startChatCompletionsAdapter({
    id: "instance",
    name: "MLX",
    kind: "mlx-lm",
    baseUrl: `http://127.0.0.1:${address.port}/proxy/v1`,
    apiKey,
  });
  cleanup.push(() => adapter.close());
  return adapter;
}
function infer(
  adapter: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return fetch(`${adapter.baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adapter.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "same-model",
      input: "Hello",
      stream: false,
      ...body,
    }),
    signal,
  });
}
function packet(delta: unknown, finish_reason: string | null = null) {
  return { choices: [{ index: 0, delta, finish_reason }] };
}
function send(response: ServerResponse, events: unknown[], done = true) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events)
    response.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  response.end(done ? "data: [DONE]\r\n\r\n" : "");
}

describe("Responses history translation", () => {
  it("preserves instructions, reasoning, adjacent parallel calls, call IDs and tool results", () => {
    const messages = responsesMessages(
      [
        {
          role: "developer",
          content: [{ type: "input_text", text: "Developer" }],
        },
        { role: "user", content: "User" },
        {
          type: "reasoning",
          summary: [],
          content: [{ type: "reasoning_text", text: "Thinking" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Working" }],
        },
        ...["a", "b"].map((id) => ({
          type: "function_call",
          call_id: id,
          name: "exec_command",
          arguments: `{"cmd":"${id}"}`,
        })),
        { type: "function_call_output", call_id: "a", output: "Result A" },
        {
          type: "function_call_output",
          call_id: "b",
          output: [{ type: "input_text", text: "Result B" }],
        },
      ],
      "Instructions",
    );
    expect(messages).toEqual([
      { role: "system", content: "Instructions" },
      { role: "system", content: "Developer" },
      { role: "user", content: "User" },
      {
        role: "assistant",
        content: "Working",
        reasoning_content: "Thinking",
        reasoning: "Thinking",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"a"}' },
          },
          {
            id: "b",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"b"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "Result A" },
      { role: "tool", tool_call_id: "b", content: "Result B" },
    ]);
  });
  it("translates image URLs explicitly and rejects unsupported content instead of dropping it", () => {
    expect(
      responsesMessages([
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:image/png;base64,AA",
              detail: "low",
            },
          ],
        },
      ])[0]?.content,
    ).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA", detail: "low" },
      },
    ]);
    for (const item of [
      { type: "custom_tool_call", input: "patch" },
      { type: "reasoning", encrypted_content: "private" },
      { role: "user", content: [{ type: "input_file", file_id: "private" }] },
    ])
      expect(() => responsesMessages([item])).toThrow();
    expect(() =>
      chatCompletionsRequest({
        model: "m",
        input: [],
        tools: [{ type: "custom", name: "apply_patch" }],
      }),
    ).toThrow("JSON function tools");
    expect(
      chatCompletionsRequest({
        model: "m",
        input: [],
        reasoning: { effort: "high" },
      }).body.chat_template_kwargs,
    ).toEqual({ reasoning_effort: "high", enable_thinking: true });
    expect(() =>
      chatCompletionsRequest({
        model: "m",
        input: [],
        previous_response_id: "unknown-history",
      }),
    ).toThrow("Unsupported Responses request field");
  });
  it("preserves and enforces structured output and required function choices after inference", () => {
    const request = chatCompletionsRequest({
      model: "m",
      input: "Question",
      text: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
    });
    expect(JSON.stringify(request.body.messages)).toContain(
      '"ok"'.replaceAll('"', '\\"'),
    );
    expect(() => request.validateOutput('{"ok":true}', [])).not.toThrow();
    expect(() => request.validateOutput('{"ok":"wrong"}', [])).toThrow(
      "output schema",
    );
    const required = chatCompletionsRequest({
      model: "m",
      input: [],
      tool_choice: { type: "function", name: "run" },
    });
    expect(() => required.validateOutput("", [])).toThrow("required function");
    expect(() => required.validateOutput("", [{ name: "run" }])).not.toThrow();
  });
});

describe("worker-owned Chat Completions adapter", () => {
  it("reads fragmented UTF-8/CRLF framing and preserves supplied usage and reasoning", async () => {
    const adapter = await fixture((_request, response) =>
      send(response, [
        packet({ reasoning: "Think" }),
        packet({ content: "Héllo" }),
        packet({}, "stop"),
        {
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 5 },
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        },
      ]),
    );
    const response = await infer(adapter, { stream: true });
    const events = [];
    for await (const event of chatCompletionEvents(response.body!))
      events.push(event);
    expect(
      events.find((event) => event.type === "response.reasoning_text.delta")
        ?.delta,
    ).toBe("Think");
    expect(
      events.find((event) => event.type === "response.output_text.delta")
        ?.delta,
    ).toBe("Héllo");
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    });
    const encoded = new TextEncoder().encode(
      'data: {"text":"é"}\r\n\r\ndata: [DONE]\n\n',
    );
    let offset = 0;
    const bytes = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < encoded.length)
          controller.enqueue(encoded.slice(offset, ++offset));
        else controller.close();
      },
    });
    const decoded = [];
    for await (const event of chatCompletionEvents(bytes)) decoded.push(event);
    expect(decoded).toEqual([{ text: "é" }]);
  });
  it("isolates same-model instances, optional credentials, and reverse-proxy paths", async () => {
    const observed: Array<{ url?: string; key?: string; model: string }> = [];
    const handler = async (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      observed.push({
        url: request.url,
        key: request.headers.authorization,
        model: body.model,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: request.headers.authorization
                  ? "Authenticated"
                  : "Keyless",
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    };
    const a = await fixture(handler, "instance-a-key"),
      b = await fixture(handler);
    const [first, second] = await Promise.all([
      infer(a).then((r) => r.json()),
      infer(b).then((r) => r.json()),
    ]);
    expect(first.output[0].content[0].text).toBe("Authenticated");
    expect(second.output[0].content[0].text).toBe("Keyless");
    expect(observed).toEqual(
      expect.arrayContaining([
        {
          url: "/proxy/v1/chat/completions",
          key: "Bearer instance-a-key",
          model: "same-model",
        },
        {
          url: "/proxy/v1/chat/completions",
          key: undefined,
          model: "same-model",
        },
      ]),
    );
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(JSON.stringify(observed)).not.toContain(a.apiKey);
    const denied = await fetch(`${a.baseUrl}/responses`, {
      method: "POST",
      body: "{}",
    });
    expect(denied.status).toBe(401);
    expect(observed).toHaveLength(2);
  });
  it.each([401, 404, 429, 500])(
    "returns HTTP %s without private backend diagnostics or credential reflection",
    async (status) => {
      const adapter = await fixture(
        (_request, response) =>
          response.writeHead(status).end("private-response-and-key"),
        "private-key",
      );
      const response = await infer(adapter);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).toContain(`HTTP ${status}`);
      expect(text).not.toContain("private");
    },
  );
  it.each(["error", "truncated", "partial-tool"])(
    "does not report completion or execute tools after a %s stream",
    async (mode) => {
      let requests = 0;
      const adapter = await fixture((_request, response) => {
        requests++;
        const events =
          mode === "partial-tool"
            ? [
                packet({
                  tool_calls: [
                    {
                      index: 0,
                      id: "a",
                      type: "function",
                      function: { name: "run", arguments: '{"incomplete":' },
                    },
                  ],
                }),
                packet({}, "length"),
              ]
            : [
                packet({ content: "Partial" }),
                ...(mode === "error"
                  ? [{ error: { message: "private-response" } }]
                  : []),
              ];
        send(response, events, mode !== "truncated");
      });
      const text = await (await infer(adapter, { stream: true })).text();
      expect(text).toContain("response.failed");
      expect(text).not.toContain("response.completed");
      expect(text).not.toContain("response.output_item.done");
      expect(text).not.toContain("private-response");
      expect(requests).toBe(1);
    },
  );
  it.each(["client-cancel", "adapter-close"])(
    "aborts upstream inference on %s",
    async (mode) => {
      let upstreamClosed = false;
      const adapter = await fixture((_request, response) => {
        response.on("close", () => {
          upstreamClosed = true;
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify(packet({ content: "Started" }))}\n\n`,
        );
      });
      const controller = new AbortController();
      const response = await infer(
        adapter,
        { stream: true },
        controller.signal,
      );
      const reader = response.body!.getReader();
      await reader.read();
      if (mode === "client-cancel") controller.abort();
      else adapter.close();
      await reader.cancel().catch(() => undefined);
      await expect.poll(() => upstreamClosed, { timeout: 3000 }).toBe(true);
    },
  );
});
