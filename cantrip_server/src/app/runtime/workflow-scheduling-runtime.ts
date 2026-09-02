import { randomUUID } from "node:crypto";

import {
  protectedWorkflowTriggerPrepareResultSchema,
  workflowTriggerDeliveryWireResultSchema,
  workflowTriggerProvenanceSchema,
} from "@cantrip/protocol/workflows";
import type { WorkflowContentOpaque } from "@cantrip/protocol/workflow-content";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import {
  WorkflowTriggerConflictError,
  type WorkflowScheduleDispatchLease,
  type WorkflowTriggerClaim,
} from "../../db/workflow-triggers.js";
import type { OperationalMetrics } from "../../operations/metrics.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type {
  WorkflowExecutor,
  WorkflowRunLiveChange,
} from "../../workflows/executor.js";
import { triggerDeliveryIdempotencyKey } from "../../workflows/trigger-helpers.js";
import { WORKFLOW_SCHEDULE_POLL_MS } from "../shared/constants.js";
import { ScheduleDispatchLeaseLostError } from "../shared/errors.js";

type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;
type PublishWorkflowRunChange = (
  change: Omit<WorkflowRunLiveChange, "ownerId"> & { ownerId?: string },
) => void;

export interface WorkflowSchedulingRuntimeDependencies {
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  operationalMetrics: OperationalMetrics;
  publishWorkflowRunChange: PublishWorkflowRunChange;
  publishWorkflowTriggerChange: (triggerId: string, projectId: string) => void;
  repository: ServerRepository;
  runAsOwner: OwnerRunner;
  schedulerLeaseTtlMs: number;
  serverInstanceId: string;
  workflowExecutor: WorkflowExecutor;
}

/** Owns protected workflow-trigger delivery and durable schedule polling. */
export function createWorkflowSchedulingRuntime({
  app,
  applicationOwnerId,
  bridge,
  operationalMetrics,
  publishWorkflowRunChange,
  publishWorkflowTriggerChange,
  repository,
  runAsOwner,
  schedulerLeaseTtlMs,
  serverInstanceId,
  workflowExecutor,
}: WorkflowSchedulingRuntimeDependencies) {
  const advanceLiveWorkflowSchedule = async (
    triggerId: string,
    projectId: string,
    expected: Date,
    next: Date,
    lastErrorCode: string | null = null,
  ): Promise<boolean> => {
    const advanced = await repository.workflowTriggers.advanceSchedule(
      applicationOwnerId(),
      triggerId,
      expected,
      next,
      lastErrorCode,
    );
    if (advanced) publishWorkflowTriggerChange(triggerId, projectId);
    return advanced;
  };

  const deliverWorkflowTrigger = async ({
    actorId,
    actorType,
    allowOfflineQueue,
    allowedType,
    idempotencyKey,
    preclaimed,
    protectedPayload,
    triggerId,
  }: {
    actorId: string | null;
    actorType: "user" | "api" | "schedule" | "webhook" | "git";
    allowOfflineQueue: boolean;
    allowedType: "api" | "schedule" | "webhook" | "git" | "saved-command";
    idempotencyKey: string;
    preclaimed?: {
      claim: Extract<WorkflowTriggerClaim, { kind: "claimed" | "replay" }>;
      lease: WorkflowScheduleDispatchLease;
    };
    protectedPayload: WorkflowContentOpaque | null;
    triggerId: string;
  }) => {
    const context =
      preclaimed?.claim.context ??
      (await repository.workflowTriggers.getDeliveryContext(
        applicationOwnerId(),
        triggerId,
      ));
    if (!context || context.trigger.type !== allowedType) {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger not found for this delivery route.",
      );
    }
    const source = await repository.getProjectSource(
      applicationOwnerId(),
      context.trigger.projectId,
      { isWorkerAvailable: (workerId) => bridge.isConnected(workerId) },
    );
    if (!source) {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger project source is unavailable.",
      );
    }
    if (!bridge.isConnected(source.workerId)) {
      throw new WorkerUnavailableError("Project worker is offline.");
    }
    const deliveredAt = new Date().toISOString();
    const provenance = preclaimed
      ? preclaimed.claim.delivery.trigger
      : workflowTriggerProvenanceSchema.parse({
          type: context.trigger.type,
          sourceId: context.trigger.id,
          actorType,
          actorId,
          deliveredAt,
          metadata: {},
        });
    const claim =
      preclaimed?.claim ??
      (await repository.workflowTriggers.claimDelivery(
        applicationOwnerId(),
        triggerId,
        idempotencyKey,
        provenance,
        protectedPayload,
      ));
    if (!claim || claim.kind === "disabled") {
      throw new WorkflowTriggerConflictError(
        "Workflow trigger is disabled or unavailable.",
      );
    }
    if (claim.kind === "replay" && claim.delivery.status === "failed") {
      throw new WorkflowTriggerConflictError(
        `Workflow trigger delivery failed (${claim.delivery.errorCode ?? "delivery-failed"}).`,
      );
    }
    if (claim.kind === "replay" && claim.delivery.runId) {
      const existingRun = await repository.workflowRuns.getRun(
        applicationOwnerId(),
        claim.delivery.runId,
      );
      if (existingRun) {
        return workflowTriggerDeliveryWireResultSchema.parse({
          delivery: claim.delivery,
          run: existingRun,
          replayed: true,
        });
      }
    }
    try {
      const runId = randomUUID();
      const prepared = protectedWorkflowTriggerPrepareResultSchema.parse(
        await bridge.request(source.workerId, {
          type: "workflow.trigger.prepare.protected",
          triggerId,
          workflowRunId: runId,
          triggerType: context.trigger.type,
          publicConfiguration: context.trigger.publicConfiguration,
          protectedConfiguration: context.trigger.protectedConfiguration,
          protectedBaseInput: context.trigger.protectedInput,
          deliveryOperationId: claim.delivery.protectedPayload
            ? claim.delivery.idempotencyKey
            : null,
          protectedDeliveryPayload: claim.delivery.protectedPayload,
        }),
      );
      if (prepared.status === "rejected") {
        throw new WorkflowTriggerConflictError(
          `Protected workflow trigger was rejected (${prepared.code}).`,
        );
      }
      const runResult = await repository.workflowRuns.createRun(
        applicationOwnerId(),
        {
          id: runId,
          workflowRevisionId: context.trigger.workflowRevisionId,
          projectId: context.trigger.projectId,
          protectedInput: prepared.protectedRunInput,
          budget: context.trigger.budget,
          permissionManifest: context.trigger.permissionManifest,
          selectedModelRouteId: context.trigger.selectedModelRouteId,
          selectedPermissionProfileId:
            context.trigger.selectedPermissionProfileId,
          trigger: provenance,
          idempotencyKey: triggerDeliveryIdempotencyKey(
            triggerId,
            idempotencyKey,
          ),
        },
      );
      if (!runResult) {
        throw new WorkflowTriggerConflictError(
          "Workflow trigger revision or project is unavailable.",
        );
      }
      const delivery = await repository.workflowTriggers.acceptDelivery(
        applicationOwnerId(),
        claim.delivery.id,
        triggerId,
        runResult.run.run.id,
        preclaimed?.lease,
      );
      if (!delivery) {
        throw new ScheduleDispatchLeaseLostError(
          "The schedule dispatch lease expired before completion.",
        );
      }
      publishWorkflowTriggerChange(triggerId, context.trigger.projectId);
      publishWorkflowRunChange({
        projectId: runResult.run.run.projectId,
        resource: "workflow-run",
        revision: null,
        runId: runResult.run.run.id,
      });
      workflowExecutor.queueRun(runResult.run.run.id, applicationOwnerId());
      return workflowTriggerDeliveryWireResultSchema.parse({
        delivery,
        run: runResult.run,
        replayed: claim.kind === "replay" || !runResult.created,
      });
    } catch (error) {
      if (
        allowOfflineQueue &&
        preclaimed &&
        error instanceof WorkerUnavailableError
      ) {
        throw error;
      }
      const failed = await repository.workflowTriggers.failDelivery(
        applicationOwnerId(),
        claim.delivery.id,
        triggerId,
        "workflow-trigger-delivery-failed",
        preclaimed?.lease,
      );
      if (preclaimed && !failed) {
        throw new ScheduleDispatchLeaseLostError(
          "The schedule dispatch lease expired before failure was recorded.",
        );
      }
      publishWorkflowTriggerChange(triggerId, context.trigger.projectId);
      throw error;
    }
  };

  let scheduleTickRunning = false;
  let activeScheduleTick: Promise<void> | null = null;
  const deliverDueSchedules = async () => {
    if (scheduleTickRunning) return;
    scheduleTickRunning = true;
    const scanStartedAt = performance.now();
    let dispatchFailures = 0;
    let dispatches = 0;
    let dueOccurrences = 0;
    let leaseContentions = 0;
    let leaseRecoveries = 0;
    let maximumLagMs = 0;
    let scanFailed = true;
    try {
      const now = new Date();
      const due = await repository.workflowTriggers.listDueSchedules(now);
      dueOccurrences = due.length;
      for (const candidate of due) {
        const publicConfiguration = candidate.trigger.publicConfiguration;
        if (
          candidate.trigger.type !== "schedule" ||
          publicConfiguration.type !== "schedule" ||
          !candidate.row.nextRunAt
        ) {
          continue;
        }
        const trigger = candidate.trigger;
        const expected = candidate.row.nextRunAt;
        maximumLagMs = Math.max(
          maximumLagMs,
          now.getTime() - expected.getTime(),
        );
        await runAsOwner(trigger.ownerId, async () => {
          const configuration = publicConfiguration;
          const intervalMs = configuration.intervalSeconds * 1_000;
          const provenance = workflowTriggerProvenanceSchema.parse({
            type: "schedule",
            sourceId: trigger.id,
            actorType: "schedule",
            actorId: null,
            deliveredAt: now.toISOString(),
            metadata: {},
          });
          const occurrence =
            await repository.workflowTriggers.claimScheduleOccurrence(
              trigger.ownerId,
              trigger.id,
              expected,
              provenance,
              serverInstanceId,
              schedulerLeaseTtlMs,
              now,
            );
          if (!occurrence) return;
          if (occurrence.kind === "busy") {
            leaseContentions += 1;
            return;
          }
          if (occurrence.kind === "disabled") return;
          if (occurrence.kind === "completed") {
            if (occurrence.delivery.status === "accepted") {
              if (occurrence.delivery.runId) {
                workflowExecutor.queueRun(
                  occurrence.delivery.runId,
                  trigger.ownerId,
                );
              }
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                new Date(Date.now() + intervalMs),
              );
            } else {
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                new Date(Date.now() + Math.min(intervalMs, 30_000)),
                occurrence.delivery.errorCode ?? "schedule-delivery-failed",
              );
            }
            return;
          }
          if (occurrence.lease.fencingToken > 1) leaseRecoveries += 1;
          const failClaimedOccurrence = async (code: string, next: Date) => {
            const failed = await repository.workflowTriggers.failDelivery(
              trigger.ownerId,
              occurrence.claim.delivery.id,
              trigger.id,
              code,
              occurrence.lease,
            );
            if (failed) {
              await advanceLiveWorkflowSchedule(
                trigger.id,
                trigger.projectId,
                expected,
                next,
                code,
              );
            }
          };
          if (
            configuration.catchUpPolicy === "skip" &&
            now.getTime() - expected.getTime() > intervalMs
          ) {
            await failClaimedOccurrence(
              "schedule-overdue-skipped",
              new Date(now.getTime() + intervalMs),
            );
            return;
          }
          const source = await repository.getProjectSource(
            applicationOwnerId(),
            trigger.projectId,
            {
              isWorkerAvailable: (workerId) => bridge.isConnected(workerId),
            },
          );
          if (!source || !bridge.isConnected(source.workerId)) {
            if (configuration.offlinePolicy === "pause") {
              await failClaimedOccurrence(
                "schedule-worker-offline",
                new Date(now.getTime() + Math.min(intervalMs, 30_000)),
              );
            }
            return;
          }
          try {
            await deliverWorkflowTrigger({
              actorId: null,
              actorType: "schedule",
              allowOfflineQueue: configuration.offlinePolicy === "queue",
              allowedType: "schedule",
              idempotencyKey: expected.toISOString(),
              preclaimed: occurrence,
              protectedPayload: null,
              triggerId: trigger.id,
            });
            dispatches += 1;
            await advanceLiveWorkflowSchedule(
              trigger.id,
              trigger.projectId,
              expected,
              new Date(Date.now() + intervalMs),
            );
          } catch (error) {
            if (error instanceof ScheduleDispatchLeaseLostError) {
              app.log.info(
                { workflowTriggerId: trigger.id },
                "Scheduled workflow dispatch lease was fenced",
              );
              return;
            }
            if (
              error instanceof WorkerUnavailableError &&
              configuration.offlinePolicy === "queue"
            ) {
              return;
            }
            dispatchFailures += 1;
            app.log.warn(
              { err: error, workflowTriggerId: trigger.id },
              "Scheduled workflow delivery failed",
            );
            await advanceLiveWorkflowSchedule(
              trigger.id,
              trigger.projectId,
              expected,
              new Date(Date.now() + Math.min(intervalMs, 30_000)),
              "schedule-delivery-failed",
            );
          }
        });
      }
      scanFailed = false;
    } finally {
      scheduleTickRunning = false;
      const durationMs = performance.now() - scanStartedAt;
      operationalMetrics.recordSchedulerScan({
        dispatchFailures,
        dispatches,
        dueOccurrences,
        durationMs,
        failed: scanFailed,
        leaseContentions,
        leaseRecoveries,
        maximumLagMs,
      });
      if (dueOccurrences > 0 || dispatchFailures > 0 || scanFailed) {
        app.log[scanFailed || dispatchFailures > 0 ? "warn" : "info"](
          {
            event: "workflow.schedule.scan_completed",
            subsystem: "workflow-scheduler",
            operation: "scan",
            status: scanFailed
              ? "failed"
              : dispatchFailures > 0
                ? "degraded"
                : "completed",
            durationMs,
            counts: {
              dueOccurrences,
              dispatches,
              dispatchFailures,
              leaseContentions,
              leaseRecoveries,
            },
            maximumLagMs,
          },
          "Workflow schedule scan completed",
        );
      }
    }
  };

  const queueScheduleTick = () => {
    if (activeScheduleTick) return;
    activeScheduleTick = deliverDueSchedules()
      .catch((error) => {
        app.log.error({ err: error }, "Workflow schedule scan failed");
      })
      .finally(() => {
        activeScheduleTick = null;
      });
  };

  const workflowScheduleTimer = setInterval(() => {
    queueScheduleTick();
  }, WORKFLOW_SCHEDULE_POLL_MS);
  workflowScheduleTimer.unref();
  queueScheduleTick();

  return {
    close(): void {
      clearInterval(workflowScheduleTimer);
    },
    deliverWorkflowTrigger,
    async waitForIdle(): Promise<void> {
      await activeScheduleTick;
    },
  };
}
