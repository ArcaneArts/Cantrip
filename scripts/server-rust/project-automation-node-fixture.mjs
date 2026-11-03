export async function projectAutomationFixture(repository, input) {
  const r = repository.projectAutomations;
  switch (input.op) {
    case "automation-create":
      return r.create(input.owner, input.project, input.input);
    case "automation-list":
      return r.list(input.owner, input.project);
    case "automation-list-worker":
      return r.listForWorker(input.owner, input.worker);
    case "automation-get":
      return r.get(input.owner, input.automationId);
    case "automation-update":
      return r.update(input.owner, input.automationId, input.input);
    case "automation-delete":
      return r.delete(input.owner, input.automationId);
    case "automation-claim":
      return r.claimDue(
        input.owner,
        input.worker,
        input.automationId,
        input.input,
        input.instance,
        input.ttlMs,
        new Date(input.now),
      );
    case "automation-finish":
      return r.finishDispatch(
        {
          ...input.lease,
          scheduledFor: new Date(input.lease.scheduledFor),
          nextRunAt: input.lease.nextRunAt
            ? new Date(input.lease.nextRunAt)
            : null,
        },
        input.status,
        input.error ?? null,
        new Date(input.now),
      );
    default:
      throw new Error("Unknown automation fixture operation");
  }
}
