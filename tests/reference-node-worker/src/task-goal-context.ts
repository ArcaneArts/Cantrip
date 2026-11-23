import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TASK_NATIVE_GOAL_OBJECTIVE_LIMIT } from "@cantrip/protocol/tasks";

/** Like the native TUI's goal attachments, this survives context compaction and
 * resume without putting an entire implementation plan in the native objective. */
export async function materializeTaskGoalContext(input: {
  chatId: string;
  threadId: string;
  codexHome: string;
  objective: string;
  implementationContext: string;
}): Promise<string> {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        input.chatId,
        input.threadId,
        input.implementationContext,
      ]),
    )
    .digest("hex");
  const directory = path.join(
    input.codexHome,
    "attachments",
    `task-goal-${hash}`,
  );
  const file = path.join(directory, "implementation-plan.md");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, input.implementationContext, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(file, "utf8")) !== input.implementationContext) {
      throw new Error("The saved Task implementation context has changed.");
    }
  }
  const reference = `Read the complete approved Task implementation plan at ${JSON.stringify(file)} before making changes and after context compaction. Finish and validate every acceptance criterion, not just the first milestone.`;
  const withDirection = `${input.objective.trim()}\n\n${reference}`;
  // Old finalized Tasks contain the whole plan in objective. Its complete text
  // remains in the immutable context file; retry does not truncate or re-plan it.
  const objective =
    Array.from(withDirection).length <= TASK_NATIVE_GOAL_OBJECTIVE_LIMIT
      ? withDirection
      : reference;
  if (Array.from(objective).length > TASK_NATIVE_GOAL_OBJECTIVE_LIMIT) {
    throw new Error(
      "The Task plan reference exceeds the native Goal objective limit.",
    );
  }
  return objective;
}
