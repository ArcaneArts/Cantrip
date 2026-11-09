import { describe, expect, it } from "vitest";

import {
  CHAT_RELOCATION_JOB_HISTORY_LIMIT,
  ChatRelocationJobRepository,
} from "../src/db/chat-relocation-jobs.js";
import {
  PROJECT_REPLICA_JOB_HISTORY_LIMIT,
  ProjectReplicaJobRepository,
} from "../src/db/project-replica-jobs.js";

interface QueryMock {
  from(...args: unknown[]): QueryMock;
  innerJoin(...args: unknown[]): QueryMock;
  limit(value: number): Promise<unknown[]>;
  orderBy(...args: unknown[]): QueryMock;
  where(...args: unknown[]): QueryMock;
}

function queryMock(rows: unknown[], limits: number[]): QueryMock {
  const query: QueryMock = {
    from: () => query,
    innerJoin: () => query,
    limit: async (value) => {
      limits.push(value);
      return rows;
    },
    orderBy: () => query,
    where: () => query,
  };
  return query;
}

describe("durable job history bounds", () => {
  it("bounds project replica job history after the ownership lookup", async () => {
    const limits: number[] = [];
    const results = [[{ id: "project-one" }], []];
    const repository = new ProjectReplicaJobRepository({
      select: () => queryMock(results.shift() ?? [], limits),
    } as never);

    await expect(repository.list("owner-one", "project-one")).resolves.toEqual(
      [],
    );
    expect(limits).toEqual([1, PROJECT_REPLICA_JOB_HISTORY_LIMIT]);
  });

  it("bounds chat relocation history", async () => {
    const limits: number[] = [];
    const repository = new ChatRelocationJobRepository({
      select: () => queryMock([], limits),
    } as never);

    await expect(repository.list("owner-one", "chat-one")).resolves.toEqual([]);
    expect(limits).toEqual([CHAT_RELOCATION_JOB_HISTORY_LIMIT]);
  });
});
