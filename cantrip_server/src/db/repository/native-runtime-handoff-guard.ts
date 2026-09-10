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
  nativeEpoch?: string | null,
  access: "write" | "attach" = "write",
): Promise<void> {
  // Attachment is a preserving, admitted view operation. During publication it
  // may target only the actual canonical binding; it cannot start execution or
  // select the prepared-but-uncommitted destination. Retirement still applies.
  let currentAttachment = false;
  if (access === "attach" && runtimeGeneration) {
    const [settings] = await database
      .select({ state: schema.nativeSettingsStates.state })
      .from(schema.nativeSettingsStates)
      .where(eq(schema.nativeSettingsStates.chatId, chatId));
    currentAttachment =
      settings?.state.binding?.runtimeGeneration === runtimeGeneration;
  }
  const [row] = await database
    .select({ phase: schema.nativeRuntimeHandoffs.phase })
    .from(schema.nativeRuntimeHandoffs)
    .where(
      and(
        eq(schema.nativeRuntimeHandoffs.chatId, chatId),
        or(
          currentAttachment
            ? undefined
            : inArray(schema.nativeRuntimeHandoffs.phase, activePhases),
          runtimeGeneration
            ? sql`${schema.nativeRuntimeHandoffs.retiredRuntimeGenerations} @> ${JSON.stringify([runtimeGeneration])}::jsonb`
            : undefined,
          runtimeGeneration && nativeEpoch
            ? sql`${schema.nativeRuntimeHandoffs.retiredNativeEpochs} @> ${JSON.stringify([{ runtimeGeneration, nativeEpoch }])}::jsonb`
            : undefined,
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
