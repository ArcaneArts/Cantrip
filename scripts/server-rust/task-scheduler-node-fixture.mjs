import {
  TaskDispatchConflictError,
  TaskDispatchNotFoundError,
  taskDispatchSchedulerPlan,
} from "../../cantrip_server/src/db/task-dispatch.ts";
export async function taskSchedulerFixture(repository, input) {
  const task = repository.taskDispatch,
    trace = [],
    options = { ...input.options };
  if (typeof options.now === "string") options.now = new Date(options.now);
  async function resolve(value) {
    trace.push(value);
    if (input.failEligibility)
      throw new Error("Controlled Task eligibility failure");
    const cycle = value.cycle ?? value;
    return (
      input.resolutions?.find(
        (r) =>
          (r.chat === undefined || r.chat === cycle.chatId) &&
          (r.worker === undefined || r.worker === value.taskWorker?.id),
      )?.result ?? input.resolution
    );
  }
  try {
    let value;
    switch (input.action) {
      case "get":
        value = await task.get(input.owner, input.cycle);
        break;
      case "list":
        value = await task.list(input.owner);
        break;
      case "owners":
        value = await task.listSchedulerOwners();
        break;
      case "plan":
        value = taskDispatchSchedulerPlan(input.schedulerOwner);
        break;
      case "enqueue":
        value = await task.enqueue(
          input.owner,
          input.chat,
          input.operation,
          input.kind,
          input.rowVersion,
        );
        break;
      case "claim":
        value = await task.claimNext(
          input.owner,
          input.leaseOwner,
          resolve,
          options,
        );
        break;
      case "resume":
        value = await task.resumeNextPaused(
          input.owner,
          input.leaseOwner,
          resolve,
          options,
        );
        break;
      case "recover":
        value = await task.recoverStartedGoal(
          input.owner,
          input.expected,
          input.leaseOwner,
          options.now,
          options,
        );
        break;
      case "requeue":
        value = await task.requeueExpiredLeases(input.owner, options.now);
        break;
      case "expire":
        value = await task.expireStartedLeases(input.owner, options.now);
        break;
      case "defer":
        value = await task.deferForCapacity(input.fence, options.now);
        break;
      case "running":
        value = await task.markRunning(input.fence, options);
        break;
      case "heartbeat":
        value = await task.heartbeat(input.fence, options);
        break;
      case "pause":
        value = await task.pause(input.fence, input.affinity, options);
        break;
      case "pause-unstarted":
        value = await task.pauseUnstarted(input.fence, input.affinity, options);
        break;
      case "settle":
        value = await task.settle(input.fence, input.state, options);
        break;
      default:
        throw new Error("Unknown Task scheduler fixture action");
    }
    return { value, trace };
  } catch (error) {
    if (
      !(error instanceof TaskDispatchConflictError) &&
      !(error instanceof TaskDispatchNotFoundError)
    )
      throw error;
    return {
      error: {
        kind:
          error instanceof TaskDispatchNotFoundError ? "not-found" : "conflict",
        code: error.code ?? null,
        message: error.message,
      },
      trace,
    };
  }
}
