import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  decryptInteractionRequestContent,
  encryptInteractionResponseContent,
} from "../../packages/crypto/dist/index.js";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";

export function managedMcpClient(options) {
  return async (name, args, error) => {
    const [result] = await managedMcpTurn(options, [{ name, args, error }]);
    return result;
  };
}

export async function managedMcpTurn(
  {
    model,
    profile,
    call,
    eventually,
    encryptedTurn,
    chatUrl,
    chatId,
    projectUrl,
  },
  steps,
) {
  const read = (plan) =>
    eventually(
      () => plan.request,
      (request) => assert.ok(request, "The native model request must arrive."),
    );
  const planned = steps.map(({ name }) => ({
    search: model.reply({ hold: true, toolSearch: { query: name } }),
    invoke: model.reply({ hold: true }),
  }));
  const answer = model.reply({ hold: true });
  const observed = [];
  try {
    await call(
      "POST",
      chatUrl + "/turns",
      202,
      await encryptedTurn(
        "Run the managed MCP fixture with " +
          steps.map(({ name }) => name).join(", ") +
          ".",
        profile.id,
      ),
    );
    for (const [
      index,
      { name, args, error, verify, afterInvoke },
    ] of steps.entries()) {
      const { search, invoke } = planned[index];
      await read(search);
      search.release();
      const { input } = await read(invoke);
      const tools = modelFunctions([
        ...input.tools,
        ...input.input
          .filter((item) => item.type === "tool_search_output")
          .flatMap((item) => item.tools),
      ]);
      const tool = tools.find(
        ({ name: found }) => found === name || found.endsWith("__" + name),
      );
      assert.ok(
        tool,
        "Codex can discover " + name + " in the managed attachment.",
      );
      invoke.calls = [{ ...tool, arguments: args }];
      invoke.release();
      await afterInvoke?.();
      const next = await read(planned[index + 1]?.search ?? answer);
      const result = toolOutput(next, error);
      await verify?.(result);
      observed.push(result);
    }
    answer.text = "Finished the managed MCP fixture.";
    answer.release();
    await eventually(
      () => answer.request,
      (request) => assert.equal(request?.completed, true),
    );
    await eventually(
      () => call("GET", projectUrl + "/chats", 200),
      (chats) =>
        assert.equal(chats.find((chat) => chat.id === chatId)?.status, "idle"),
    );
    return observed;
  } finally {
    for (const { search, invoke } of planned) {
      search.release();
      invoke.release();
    }
    answer.release();
  }
}

function toolOutput(request, error) {
  const raw = request.input.input
    .filter((item) => item.type === "function_call_output")
    .at(-1)?.output;
  const output =
    typeof raw === "string" ? raw : raw?.map(({ text }) => text).join("\n");
  assert.ok(output, JSON.stringify(request.input.input));
  if (error) {
    assert.match(output, error);
    return;
  }
  const boundary = "\nOutput:\n";
  assert.ok(output.includes(boundary), output);
  return JSON.parse(output.slice(output.indexOf(boundary) + boundary.length));
}

export async function approveManagedMcpTool({
  call,
  eventually,
  chatId,
  ownerId,
  keyRevision,
  interactionKey,
  expectedTool,
}) {
  const [pending] = await eventually(
    () =>
      call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
    (items) => assert.equal(items.length, 1),
  );
  const material = {
    ownerId,
    keyRevision,
    requestKey: pending.requestKey,
    componentKey: interactionKey,
  };
  const classification = pending.classification;
  const { payload } = await decryptInteractionRequestContent({
    ...material,
    encrypted: pending.protectedPayload,
    publicClassification: classification,
  });
  assert.match(JSON.stringify(payload), expectedTool);
  let response;
  if (payload.kind === "mcpElicitation") {
    response = { kind: payload.kind, action: "accept", content: null };
  } else {
    assert.equal(payload.kind, "userInput");
    const [question] = payload.questions;
    assert.ok(question.options.some(({ label }) => label === "Allow"));
    response = {
      kind: payload.kind,
      answers: { [question.id]: { answers: ["Allow"] } },
    };
  }
  const result = await call(
    "POST",
    `/api/agent-requests/${pending.id}/respond`,
    200,
    {
      idempotencyKey: randomUUID(),
      classification,
      protectedResponse: await encryptInteractionResponseContent({
        ...material,
        content: { version: 1, classification, response },
      }),
    },
  );
  assert.equal(result.status, "resolved");
}

export async function managedMcpRpc(data) {
  const dir = path.join(data, "agent-mcp-bindings");
  const [session] = await readdir(dir);
  const connection = JSON.parse(
    await readFile(path.join(dir, session, "connection.json"), "utf8"),
  );
  return async (method, params) => {
    const response = await fetch(
      connection.endpoint + "/v1/mcp/" + connection.bindingId,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + connection.credential,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.ok(reply.result, JSON.stringify(reply));
    return reply.result;
  };
}
