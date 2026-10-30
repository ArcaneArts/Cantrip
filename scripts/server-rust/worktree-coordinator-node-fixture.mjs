import { ProjectWorktreeCoordinator } from "../../cantrip_server/src/worktrees/coordinator.ts";
export async function worktreeCoordinatorFixture(database, request, execute) {
  const trace = [],
    replies = [...request.replies];
  const worker = {
    isConnected: () => false,
    request: async (worker, command) => {
      trace.push({ worker, command });
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected worker request");
      if (reply.sql) await execute(reply.sql);
      if (reply.error) throw new Error(reply.error);
      return reply.value;
    },
  };
  const coordinator = new ProjectWorktreeCoordinator(
    database.repository,
    worker,
    (project) => trace.push({ changed: project }),
  );
  try {
    const value =
      request.action === "create"
        ? await coordinator.create(
            request.owner,
            request.project,
            request.input,
          )
        : request.action === "reconcile"
          ? await coordinator.reconcile(request.owner, request.project)
          : await coordinator.checkoutPullRequest(
              request.owner,
              request.project,
              request.sourceWorktreeId,
              request.repository,
              request.number,
            );
    return { value, trace };
  } catch (error) {
    return { error: error.failure ?? { message: error.message }, trace };
  }
}
