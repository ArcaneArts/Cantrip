import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

const taskQueryFamilies = new Set([
  "task",
  "task-dashboard",
  "project-task-workload",
  "project-task-pause",
]);

/** Live hints must not cancel and restart expensive Task reads. Remember one
 * trailing refresh instead, including hints received during an existing read. */
export class TaskQueryInvalidation {
  private readonly pending = new Map<
    Query,
    { completion: Promise<void>; trailing: Promise<void> | null }
  >();

  constructor(private readonly client: QueryClient) {}

  invalidate(queryKey: QueryKey): Promise<void> {
    if (!taskQueryFamilies.has(String(queryKey[0]))) {
      return this.client.invalidateQueries({ queryKey });
    }
    const queries = this.client.getQueryCache().findAll({ queryKey });
    if (queries.length === 0) {
      return this.client.invalidateQueries({ queryKey });
    }
    return Promise.all(queries.map((query) => this.refresh(query))).then(
      () => undefined,
    );
  }

  private refresh(query: Query): Promise<void> {
    const pending = this.pending.get(query);
    if (pending) {
      pending.trailing ??= pending.completion
        .catch(() => undefined)
        .then(() => {
          this.pending.delete(query);
          return this.refresh(query);
        });
      return pending.trailing;
    }
    const state: { completion: Promise<void>; trailing: Promise<void> | null } =
      {
        completion: Promise.resolve(),
        trailing: null,
      };
    state.completion = Promise.resolve()
      .then(async () => {
        // A read may have started outside this bridge (mount/poll/manual).
        // Wait for it, then fetch a snapshot newer than all preceding hints.
        if (query.state.fetchStatus === "fetching") {
          await query.promise?.catch(() => undefined);
        }
        await this.client.invalidateQueries(
          { queryKey: query.queryKey, exact: true },
          { cancelRefetch: false },
        );
      })
      .finally(() => {
        // Each hint awaits at most its current and trailing read, not the end
        // of a potentially unbounded live stream (notably during recovery).
        if (!state.trailing) this.pending.delete(query);
      });
    this.pending.set(query, state);
    return state.completion;
  }
}
