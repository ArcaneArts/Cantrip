// Retain complete Task DTOs/decrypted history while real Agent/Goal work moves
// between production implementations. Native stream/worker assertions remain
// in the existing interruption driver.
import assert from "node:assert/strict";
import { nativeAgentInterruption } from "./native-agent-interruption.mjs";

export function profileAgentInterruption(options) {
  const interrupt = nativeAgentInterruption(options);
  const readTasks = () =>
    options.page.evaluate(async (projectId) => {
      const chats = await import("/src/lib/api/chats.ts");
      const tasks = await import("/src/lib/api/tasks.ts");
      const catalogue = await chats.getChats(projectId);
      const retained = [];
      for (const chat of catalogue
        .filter((c) => c.experience === "task")
        .sort((a, b) => a.id.localeCompare(b.id))) {
        retained.push({
          chat,
          task: await tasks.getTask(chat.id),
          messages: await chats.getMessages(chat.id),
        });
      }
      return retained;
    }, options.projectId);
  return async (input) => {
    const before = await readTasks();
    await interrupt(input);
    const after = await readTasks();
    assert.deepEqual(
      after,
      before,
      "completed Task state and decrypted history survive the implementation/profile switch",
    );
    const record = { phase: input.phase, before, after };
    (options.result.profileRetainedTasks ??= []).push(record);
    if (process.argv.includes("--tasks"))
      assert.ok(
        before.length > 0,
        "the Task product scenario produced retained Task state",
      );
  };
}
