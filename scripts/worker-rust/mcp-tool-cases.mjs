import assert from "node:assert/strict";
import { modelFunctions } from "../server-rust/task-model-provider.mjs";

export function managedMcpClient({
  model,
  profile,
  call,
  eventually,
  encryptedTurn,
  chatUrl,
  chatId,
  projectUrl,
}) {
  const tools = (request) =>
    modelFunctions([
      ...request.input.tools,
      ...request.input.input
        .filter((item) => item.type === "tool_search_output")
        .flatMap((item) => item.tools),
    ]);
  return async function invoke(name, args, error) {
    model.reply({ toolSearch: { query: name } });
    const invocation = model.reply({ hold: true });
    const answer = model.reply({ text: `Finished the ${name} fixture.` });
    try {
      await call(
        "POST",
        chatUrl + "/turns",
        202,
        await encryptedTurn(`Call ${name} once.`, profile.id),
      );
      await eventually(
        () => invocation.request,
        (request) => assert.ok(request, "The Codex tool search must finish."),
      );
      const tool = tools(invocation.request).find(
        ({ name: found }) => found === name || found.endsWith("__" + name),
      );
      assert.ok(tool, `Codex can discover ${name} in the managed attachment.`);
      invocation.calls = [{ ...tool, arguments: args }];
      invocation.release();
      await eventually(
        () => answer.request,
        (request) => assert.equal(request?.completed, true),
      );
      const raw = answer.request.input.input
        .filter((item) => item.type === "function_call_output")
        .at(-1)?.output;
      const output =
        typeof raw === "string" ? raw : raw?.map(({ text }) => text).join("\n");
      assert.ok(output, JSON.stringify(answer.request.input.input));
      await eventually(
        () => call("GET", projectUrl + "/chats", 200),
        (chats) =>
          assert.equal(
            chats.find((chat) => chat.id === chatId)?.status,
            "idle",
          ),
      );
      if (error) {
        assert.match(output, error);
        return;
      }
      const boundary = "\nOutput:\n";
      assert.ok(output.includes(boundary), output);
      return JSON.parse(
        output.slice(output.indexOf(boundary) + boundary.length),
      );
    } finally {
      invocation.release();
    }
  };
}
