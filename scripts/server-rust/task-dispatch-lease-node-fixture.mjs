export async function taskDispatchLeaseFixture(repository, input) {
  const options = { ...input.options };
  if (typeof options.now === "string") options.now = new Date(options.now);
  const task = repository.taskDispatch;
  if (input.action === "running") return task.markRunning(input.fence, options);
  if (input.action === "heartbeat") return task.heartbeat(input.fence, options);
  if (input.action === "pause")
    return task.pause(input.fence, input.affinity, options);
  if (input.action === "pause-unstarted")
    return task.pauseUnstarted(input.fence, input.affinity, options);
  if (input.action === "settle")
    return task.settle(input.fence, input.state, options);
  throw new Error("Unknown Task lease fixture action");
}
