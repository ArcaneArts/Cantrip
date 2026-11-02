import { createRequire } from "node:module";
import { reconcileTaskTurnPlacement } from "../../cantrip_server/src/app/runtime/task-turn-placement.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { sql } = require("drizzle-orm");
export async function turnPlacementFixture(repository, input) {
  if (input.op === "native-command-gui-worktree")
    return repository.updateChatWorktree(
      input.owner,
      input.chat,
      input.input,
      input.expected,
    );
  const calls = [];
  const context =
    input.context ??
    (await repository.getChatExecutionContext(input.owner, input.chat));
  const result = await reconcileTaskTurnPlacement(
    repository,
    {
      isConnected: () => input.connected !== false,
      request: async (worker, command) => {
        calls.push({ worker, command });
        if (input.failRequest)
          throw new Error("Controlled worktree inventory failure");
        if (input.inventorySql)
          await repository.projects.database.execute(
            sql.raw(input.inventorySql),
          );
        return input.inventory;
      },
    },
    input.owner,
    context,
  );
  return { context: result, calls };
}
