import { z } from "zod";

// Operational categories only. Provider messages and Task content stay encrypted.
export const taskFailureKindSchema = z.enum([
  "timeout",
  "capacity",
  "rate-limit",
  "connection",
  "runtime",
  "needs-input",
  "configuration",
  "usage-limit",
  "budget-limit",
]);
export const taskAutomaticRetrySchema = z
  .object({
    status: z.enum(["scheduled", "retrying", "latched", "manual"]),
    failureKind: taskFailureKindSchema,
    nextAttemptAt: z.iso.datetime().nullable(),
    recentAttempts: z.number().int().min(0).max(5),
  })
  .strict()
  .superRefine((retry, context) => {
    if ((retry.status === "scheduled") !== (retry.nextAttemptAt !== null))
      context.addIssue({
        code: "custom",
        path: ["nextAttemptAt"],
        message: "Only scheduled retries have a next-attempt deadline.",
      });
  });
export type TaskFailureKind = z.infer<typeof taskFailureKindSchema>;
export type TaskAutomaticRetry = z.infer<typeof taskAutomaticRetrySchema>;

/** Classify actual failures into bounded public metadata, never provider text. */
export function taskFailureKindForError(error: unknown): TaskFailureKind {
  const value = error as {
    code?: unknown;
    reasonCode?: unknown;
    name?: unknown;
    message?: unknown;
    failure?: { code?: unknown; retryable?: unknown };
  } | null;
  if (value?.name === "ModelConfigurationResolutionError") {
    if (value.failure?.code === "worker-offline") return "connection";
    return value.failure?.retryable === true ? "runtime" : "configuration";
  }
  const text = [
    value?.code,
    value?.reasonCode,
    value?.name,
    value?.message,
    typeof error === "string" ? error : null,
  ]
    .filter((part) => typeof part === "string")
    .join(" ");
  const explicit = text.match(
    /(?:task-goal-start-|implementation-|task-)(timeout|capacity|rate-limit|connection|runtime|needs-input|configuration|usage-limit|budget-limit)\b/u,
  )?.[1];
  if (explicit) return taskFailureKindSchema.parse(explicit);
  if (/budget.?limit|token budget/i.test(text)) return "budget-limit";
  if (/usage.?limit|insufficient.quota|quota.exceeded/i.test(text))
    return "usage-limit";
  if (/goal-blocked|needs.?input|user.?input.?required/i.test(text))
    return "needs-input";
  if (
    /unauth|forbidden|permission.denied|invalid.api.key|model.*not.found|no.*models?.*config|route.*no.longer.available/i.test(
      text,
    )
  )
    return "configuration";
  if (/timeout|timed.?out|deadline/i.test(text)) return "timeout";
  if (
    /server.?overloaded|at.capacity|over.capacity|\b503\b|overloaded|task-capacity/i.test(
      text,
    )
  )
    return "capacity";
  if (/rate.?limit|too.many.requests|\b429\b/i.test(text)) return "rate-limit";
  if (
    /offline|disconnect|connection|econn|socket|network|fetch.failed/i.test(
      text,
    )
  )
    return "connection";
  return "runtime";
}
