import assert from "node:assert/strict";
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
    for (const [index, { name, args, error, verify }] of steps.entries()) {
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
