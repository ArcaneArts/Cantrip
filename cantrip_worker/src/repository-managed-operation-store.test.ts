import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedOperationContext,
  managedOperationIsActive,
  managedOperationRecord,
  RepositoryManagedOperationStore,
} from "./repository-managed-operation-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RepositoryManagedOperationStore", () => {
  it("restores worker-local operation context after restart", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-repository-operation-"),
    );
    temporaryDirectories.push(dataDirectory);
    const scope = {
      ownerId: "owner-1",
      serverId: "https://cantrip.test",
      projectId: "11111111-1111-4111-8111-111111111111",
      worktreeId: "22222222-2222-4222-8222-222222222222",
      workerId: "worker-1",
    };
    const record = managedOperationRecord({
      id: "33333333-3333-4333-8333-333333333333",
      now: "2026-08-20T12:00:00.000Z",
      scope,
      state: {
        type: "merge",
        state: "conflicted",
        originalHead: "1".repeat(40),
        currentHead: "2".repeat(40),
        sourceRef: "feature/private-name",
        sourceRevision: "3".repeat(40),
        targetRef: "refs/heads/main",
        targetRevision: "4".repeat(40),
        pendingCommits: ["3".repeat(40)],
        currentStep: 1,
        totalSteps: 1,
        conflictedPaths: ["private/roadmap.md"],
        output: "private merge output",
        checkpointRef: null,
        status: {
          branch: "main",
          head: "2".repeat(40),
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      },
    });

    await new RepositoryManagedOperationStore(dataDirectory).put(scope, record);
    const restored = await new RepositoryManagedOperationStore(
      dataDirectory,
    ).get(scope);

    expect(restored).toEqual(record);
    expect(managedOperationIsActive(restored)).toBe(true);
    expect(managedOperationContext(restored!)).toMatchObject({
      sourceRef: "feature/private-name",
      targetRef: "refs/heads/main",
    });
  });
});
