// The caller owns a disposable migrated database. Date adaptation reproduces
// the actual typed repository inputs; persistence is the unchanged writer.
import { runtimeTelemetryFixture } from "./gui-runtime-telemetry-node-fixture.mjs";
export async function guiTelemetryFixture(repository, input) {
  if (input.action.startsWith("runtime-"))
    return runtimeTelemetryFixture(repository, input);
  const record = { ...input.record };
  for (const key of [
    "startedAt",
    "firstActivityAt",
    "firstVisibleResponseAt",
    "completedAt",
    "finalizedAt",
  ])
    if (typeof record[key] === "string") record[key] = new Date(record[key]);
  if (input.action === "behavior")
    await repository.recordModelBehaviorObservation(input.owner, record);
  else if (input.action === "usage")
    await repository.recordTokenUsage(input.owner, record);
  else throw new Error("Unknown GUI telemetry fixture operation");
  return null;
}
