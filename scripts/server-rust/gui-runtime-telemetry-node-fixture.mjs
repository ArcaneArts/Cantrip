import { createModelRoutingRuntime } from "../../cantrip_server/src/app/runtime/model-routing-runtime.ts";
import { makeTurnBehaviorTracker } from "./turn-behavior-node-fixture.mjs";
export async function runtimeTelemetryFixture(repository, input) {
  const publications = [],
    warnings = [];
  const routing = createModelRoutingRuntime({
    repository,
    applicationOwnerId: () => input.owner,
    app: {
      log: {
        warn: (context, message) =>
          warnings.push({
            message,
            sourceKey: context.sourceKey,
            error: Boolean(context.err),
          }),
      },
    },
    publishProjectTokenUsageChange: (ownerId, projectId, completed) =>
      publications.push({ ownerId, projectId, completed }),
  });
  const attribution = { ...input.attribution };
  for (const key of ["startedAt", "completedAt", "finalizedAt"])
    if (typeof attribution[key] === "string")
      attribution[key] = new Date(attribution[key]);
  try {
    if (input.action === "runtime-usage")
      await routing.recordRuntimeTokenUsage(
        input.sourceKey,
        input.execution.projectId,
        input.execution.chatId,
        input.runtime,
        input.usage,
        attribution,
      );
    else if (input.action === "runtime-behavior")
      await routing.recordRuntimeModelBehavior(
        input.sourceKey,
        input.execution,
        input.runtime,
        makeTurnBehaviorTracker(input).tracker,
        attribution,
      );
    else if (input.action === "runtime-resume")
      return routing.runtimeCanResumeContext(input.execution, input.runtime);
    else throw new Error("Unknown runtime telemetry fixture action");
    return { publications, warnings };
  } finally {
    routing.close();
  }
}
