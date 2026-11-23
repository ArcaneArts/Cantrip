import { and, eq, inArray, not, or, sql } from "drizzle-orm";
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
  access: "write" | "attach" | "control" | "queue" = "write",
  acceptedDispatch?: { operationId: string; operationGeneration: string },
): Promise<void> {
  // Canonical queue edits do not forward native input or claim execution.
  // Attachments and controls may target only the actual canonical binding,
  // never a prepared destination. All retirement fences still apply.
  let allowPending = access === "queue";
  if ((access === "attach" || access === "control") && runtimeGeneration) {
    const [settings] = await database
      .select({ state: schema.nativeSettingsStates.state })
      .from(schema.nativeSettingsStates)
      .where(eq(schema.nativeSettingsStates.chatId, chatId));
    allowPending =
      settings?.state.binding?.runtimeGeneration === runtimeGeneration;
  }
  const [row] = await database
    .select({ phase: schema.nativeRuntimeHandoffs.phase })
    .from(schema.nativeRuntimeHandoffs)
    .where(
      and(
        eq(schema.nativeRuntimeHandoffs.chatId, chatId),
        or(
          // Metadata edits can have no runtime identity after withdrawal. Keep
          // an empty retirement predicate false rather than dropping the OR.
          sql`false`,
          allowPending
            ? undefined
            : and(
                inArray(schema.nativeRuntimeHandoffs.phase, activePhases),
                // A route reservation may lose to its already-admitted input.
                // Let only that exact source commit dispatch; the worker will
                // then decline withdrawal. New inputs remain blocked.
                acceptedDispatch
                  ? not(sql`COALESCE((
                      ${schema.nativeRuntimeHandoffs.phase} = 'preparing'
                      AND ${schema.nativeRuntimeHandoffs.queuedSource}->>'withdrawn' = 'false'
                      AND ${schema.nativeRuntimeHandoffs.queuedSource}->>'operationId' = ${acceptedDispatch.operationId}
                      AND ${schema.nativeRuntimeHandoffs.queuedSource}->>'operationGeneration' = ${acceptedDispatch.operationGeneration}
                    ), false)`)
                  : undefined,
              ),
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
