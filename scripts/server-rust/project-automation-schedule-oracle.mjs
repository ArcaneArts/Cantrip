// Development oracle only. The final server evaluates schedules in Rust.
import { readFileSync } from "node:fs";
import {
  projectAutomationScheduleSchema,
  firstProjectAutomationRunAt,
  nextProjectAutomationRunAt,
} from "../../packages/protocol/src/automations.ts";
import { projectAutomationScheduleCases } from "./project-automation-schedule-cases.mjs";

const corpus = process.argv.includes("--cases");
const input = corpus
  ? projectAutomationScheduleCases()
  : JSON.parse(readFileSync(0, "utf8"));
const results = input.map(({ schedule, afterMs, first = false }) => {
  const parsed = projectAutomationScheduleSchema.safeParse(schedule);
  if (!parsed.success) return { valid: false, issues: parsed.error.issues };
  try {
    const result = (
      first ? firstProjectAutomationRunAt : nextProjectAutomationRunAt
    )(parsed.data, new Date(afterMs));
    return {
      valid: true,
      schedule: parsed.data,
      nextMs: result?.getTime() ?? null,
    };
  } catch (error) {
    return { valid: true, error: { name: error.name, message: error.message } };
  }
});
process.stdout.write(
  JSON.stringify(
    corpus
      ? {
          cases: input,
          results,
          runtime: {
            node: process.version,
            platform: process.platform,
            icu: process.versions.icu,
            tz: process.versions.tz,
          },
        }
      : results,
  ),
);
