import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { NativeCommandError } from "./native-command-errors.js";
const activePhases = ["preparing", "prepared", "committed"];

/** Must run under the same chat lock as native admission/dispatch. A committed
 * source generation remains retired even if the user later returns to its account. */
export async function assertNativeRuntimeWritable(
  database: RepositoryDatabase,
  chatId: string,
  runtimeGeneration?: string | null,
): Promise<void> {
  const [row] = await database
    .select({ phase: schema.nativeRuntimeHandoffs.phase })
    .from(schema.nativeRuntimeHandoffs)
    .where(
      and(
        eq(schema.nativeRuntimeHandoffs.chatId, chatId),
        or(
          inArray(schema.nativeRuntimeHandoffs.phase, activePhases),
          runtimeGeneration
            ? and(
                inArray(schema.nativeRuntimeHandoffs.phase, [
                  "committed",
                  "completed",
                ]),
                sql`${schema.nativeRuntimeHandoffs.source}->>'runtimeGeneration' = ${runtimeGeneration}`,
              )
            : undefined,
        ),
      ),
    )
    .limit(1);
  if (row)
    throw new NativeCommandError(
      activePhases.includes(row.phase)
        ? "native-runtime-handoff-pending"
        : "native-runtime-retired",
    );
}
