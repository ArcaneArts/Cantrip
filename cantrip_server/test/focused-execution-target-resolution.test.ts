import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import {
  protectedBrowserFields,
  protectedChatFields,
  protectedExplorerFields,
  protectedProjectFields,
  protectedTerminalFields,
} from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const projectId = "focused-target-project";
const projectSourceId = "focused-target-source";
const workerId = "focused-target-worker";
const worktreeId = "focused-target-worktree";
const explorerId = "focused-target-explorer";
const browserId = "focused-target-browser";

async function setup(terminalCount: number) {
  const queries: string[] = [];
  const client = new PGlite();
  const database = drizzle(client, {
    schema,
    logger: {
      logQuery(query) {
        queries.push(query);
      },
    },
  });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 59) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await database.insert(schema.workers).values({
    id: workerId,
    ownerId: LOCAL_USER_ID,
    name: "Focused target worker",
    platform: "linux",
    architecture: "x64",
    startedAt: new Date(),
    lastSeenAt: new Date(),
  });
  await database.insert(schema.projects).values({
    id: projectId,
    ownerId: LOCAL_USER_ID,
    protectedLabel: protectedProjectFields(projectId).nameProtection,
    githubRepositoryBlindIndex: "focused-target-repository",
  });
  await database.insert(schema.projectSources).values({
    id: projectSourceId,
    projectId,
    workerId,
    absolutePath: "/focused/project",
    displayPath: "/focused/project",
  });
  await database.insert(schema.projectWorktrees).values({
    id: worktreeId,
    projectSourceId,
    workerId,
    name: "Focused target primary",
    absolutePath: "/focused/project",
    displayPath: "/focused/project",
    isPrimary: true,
    isDefault: true,
    origin: "clone",
    lifecycleState: "ready",
    branch: "main",
    head: "1".repeat(40),
  });
  const explorer = protectedExplorerFields(explorerId);
  await database.insert(schema.explorers).values({
    id: explorer.id,
    projectId,
    protectedLabel: explorer.titleProtection,
    protectedState: explorer.stateProtection,
    activeWorkerId: workerId,
    worktreeId,
  });
  const browser = protectedBrowserFields(browserId);
  await database.insert(schema.browsers).values({
    id: browser.id,
    projectId,
    protectedLabel: browser.titleProtection,
    protectedState: browser.stateProtection,
  });
  await database.insert(schema.remoteSurfaces).values({
    id: browser.id,
    projectId,
    workerId,
    kind: "browser",
    protectedLabel: browser.titleProtection,
    protectedState: browser.stateProtection,
    stateRevision: 1,
    configuration: { kind: "browser", profileId: null },
  });
  const template = protectedTerminalFields("focused-target-template");
  await database.insert(schema.terminals).values({
    id: template.id,
    projectId,
    protectedLabel: template.titleProtection,
    protectedState: template.stateProtection,
    activeWorkerId: workerId,
    worktreeId,
  });
  await client.exec(
    [
      "insert into terminals (",
      "  id, project_id, kind, protected_label, protected_state, position,",
      "  status, active_worker_id, worktree_id, service_enabled, created_at, updated_at",
      ")",
      "select",
      "  'terminal-' || lpad(value::text, 4, '0'),",
      "  template.project_id, template.kind, template.protected_label,",
      "  template.protected_state, value, template.status,",
      "  template.active_worker_id, template.worktree_id,",
      "  template.service_enabled, now(), now()",
      "from terminals as template",
      `cross join generate_series(0, ${terminalCount - 1}) as value`,
      "where template.id = 'focused-target-template';",
      "delete from terminals where id = 'focused-target-template';",
    ].join("\n"),
  );
  queries.length = 0;
  return { client, database, queries, repository };
}

const selectorContext = {
  terminalId: null,
  workerId,
  worktreeId,
};

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

async function duration(operation: () => Promise<unknown>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

describe.sequential("focused execution target resolution", () => {
  it("resolves an exact protected surface with one query beyond the catalog cap", async () => {
    const { client, database, queries, repository } = await setup(2_001);
    try {
      const catalog = await repository.listProjectExecutionTargets(
        LOCAL_USER_ID,
        projectId,
        () => true,
      );
      expect(queries).toHaveLength(16);
      expect(catalog).toMatchObject({ truncated: true });
      expect(
        catalog?.targets.some(
          ({ target }) =>
            target.kind === "surface" && target.surfaceId === "terminal-2000",
        ),
      ).toBe(false);

      queries.length = 0;
      const selected = await repository.resolveExecutionTargetSelector(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        "terminal-2000",
        selectorContext,
        () => true,
      );
      expect(selected).toEqual({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: "terminal-2000",
        },
      });
      expect(queries).toHaveLength(1);
      const exactSql = queries.join("\n");
      expect(exactSql).toContain('from "terminals"');
      for (const unrelated of [
        "browsers",
        "chats",
        "code_tabs",
        "explorers",
        "project_views",
        "remote_surfaces",
      ]) {
        expect(exactSql).not.toContain(`"${unrelated}"`);
      }

      for (const [resourceKind, surfaceId, sourceTable] of [
        ["explorer", explorerId, "explorers"],
        ["browser", browserId, "browsers"],
      ] as const) {
        queries.length = 0;
        await expect(
          repository.resolveExecutionTargetSelector(
            LOCAL_USER_ID,
            projectId,
            resourceKind,
            surfaceId,
            selectorContext,
            () => true,
          ),
        ).resolves.toEqual({
          outcome: "selected",
          target: {
            kind: "surface",
            projectId,
            surfaceKind: resourceKind,
            surfaceId,
          },
        });
        expect(queries).toHaveLength(1);
        expect(queries[0]).toContain(`from "${sourceTable}"`);
      }

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "terminal-2000",
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: "terminal-2000",
        },
      });
      expect(queries).toHaveLength(2);

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "terminal-200",
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: "terminal-2000",
        },
      });
      expect(queries).toHaveLength(3);

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "FOCUSED TARGET WORKER",
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: { kind: "worker", projectId, workerId },
      });
      expect(queries).toHaveLength(2);

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "target pri",
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: { kind: "worktree", projectId, worktreeId },
      });
      expect(queries).toHaveLength(3);

      await database
        .update(schema.projectWorktrees)
        .set({ name: "İstanbul primary" });
      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "İSTANBUL PRIMARY",
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: { kind: "worktree", projectId, worktreeId },
      });
      expect(queries).toHaveLength(2);

      await database
        .update(schema.workers)
        .set({ displayName: "terminal-2000" });
      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          "terminal-2000",
          selectorContext,
          () => true,
        ),
      ).resolves.toMatchObject({
        outcome: "ambiguous",
        matches: expect.arrayContaining([
          { id: "terminal-2000", title: "terminal terminal-2000" },
          { id: workerId, title: "terminal-2000" },
        ]),
      });

      queries.length = 0;
      if (selected?.outcome !== "selected") {
        throw new Error("Expected an exact Terminal target.");
      }
      await expect(
        repository.resolveExecutionTarget(
          LOCAL_USER_ID,
          projectId,
          selected.target,
          () => true,
        ),
      ).resolves.toMatchObject({
        placement: { workerId, worktreeId },
      });
      expect(queries.length).toBeGreaterThan(1);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps partial and default lookup resource-scoped and history-independent", async () => {
    const { client, queries, repository } = await setup(2_001);
    try {
      const partial = await repository.resolveExecutionTargetSelector(
        LOCAL_USER_ID,
        projectId,
        "terminal",
        "terminal-200",
        selectorContext,
        () => true,
      );
      expect(partial).toEqual({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "terminal",
          surfaceId: "terminal-2000",
        },
      });
      expect(queries).toHaveLength(5);
      const partialSql = queries.join("\n");
      for (const unrelated of [
        "browsers",
        "chats",
        "code_tabs",
        "explorers",
        "project_views",
        "remote_surfaces",
      ]) {
        expect(partialSql).not.toContain(`"${unrelated}"`);
      }

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "terminal",
          "terminal-00",
          selectorContext,
          () => true,
        ),
      ).resolves.toMatchObject({ outcome: "ambiguous" });
      expect(queries).toHaveLength(5);

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "terminal",
          null,
          { ...selectorContext, terminalId: "terminal-2000" },
          () => true,
        ),
      ).resolves.toMatchObject({
        outcome: "selected",
        target: { surfaceId: "terminal-2000" },
      });
      expect(queries).toHaveLength(1);

      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          "different-owner",
          projectId,
          "terminal",
          "terminal-2000",
          selectorContext,
          () => true,
        ),
      ).resolves.toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);

  it("keeps worktree and managed-folder eligibility fail-closed", async () => {
    const { client, database, repository } = await setup(1);
    try {
      await database.update(schema.projects).set({
        folderManagement: "managed",
        githubRepositoryBlindIndex: null,
        originKind: "managed-folder",
        preferredWorkerId: workerId,
        worktreePolicy: "direct",
      });
      await database
        .update(schema.projectSources)
        .set({ sourceKind: "folder" });
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "worktree",
          null,
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({ outcome: "unavailable" });

      await repository.unlinkWorker(LOCAL_USER_ID, workerId);
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "worktree",
          null,
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({ outcome: "unavailable" });
    } finally {
      await client.close();
    }
  });

  it("keeps untyped Chat selection eligible without an active worker", async () => {
    const { client, database, queries, repository } = await setup(1);
    const chat = protectedChatFields("focused-target-chat");
    try {
      await database.insert(schema.chats).values({
        id: chat.id,
        ownerId: LOCAL_USER_ID,
        contextKind: "project",
        projectId,
        protectedLabel: chat.titleProtection,
        activeWorkerId: null,
        activeWorktreeId: worktreeId,
      });
      queries.length = 0;
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          null,
          chat.id,
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({
        outcome: "selected",
        target: {
          kind: "surface",
          projectId,
          surfaceKind: "chat",
          surfaceId: chat.id,
        },
      });
      expect(queries).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("uses the canonical managed-folder owner when no worker is preferred", async () => {
    const { client, database, repository } = await setup(1);
    const otherWorkerId = "focused-target-other-worker";
    const otherSourceId = "focused-target-other-source";
    const otherWorktreeId = "focused-target-other-worktree";
    const otherTerminal = protectedTerminalFields(
      "focused-target-other-terminal",
    );
    try {
      await database.update(schema.projects).set({
        folderManagement: "managed",
        githubRepositoryBlindIndex: null,
        originKind: "managed-folder",
        preferredWorkerId: null,
        worktreePolicy: "direct",
      });
      await database.update(schema.projectSources).set({
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        sourceKind: "folder",
      });
      await database.insert(schema.workers).values({
        id: otherWorkerId,
        ownerId: LOCAL_USER_ID,
        name: "Other folder worker",
        platform: "linux",
        architecture: "x64",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });
      await database.insert(schema.projectSources).values({
        id: otherSourceId,
        projectId,
        workerId: otherWorkerId,
        sourceKind: "folder",
        absolutePath: "/focused/other-project",
        displayPath: "/focused/other-project",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await database.insert(schema.projectWorktrees).values({
        id: otherWorktreeId,
        projectSourceId: otherSourceId,
        workerId: otherWorkerId,
        rootKind: "folder-root",
        name: "Other folder root",
        absolutePath: "/focused/other-project",
        displayPath: "/focused/other-project",
        isPrimary: true,
        isDefault: true,
        origin: "external",
        lifecycleState: "ready",
      });
      await database.insert(schema.terminals).values({
        id: otherTerminal.id,
        projectId,
        protectedLabel: otherTerminal.titleProtection,
        protectedState: otherTerminal.stateProtection,
        activeWorkerId: otherWorkerId,
        worktreeId: otherWorktreeId,
      });

      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "terminal",
          "terminal-0000",
          selectorContext,
          () => true,
        ),
      ).resolves.toMatchObject({
        outcome: "selected",
        target: { surfaceId: "terminal-0000" },
      });
      await expect(
        repository.resolveExecutionTargetSelector(
          LOCAL_USER_ID,
          projectId,
          "terminal",
          otherTerminal.id,
          selectorContext,
          () => true,
        ),
      ).resolves.toEqual({ outcome: "not-found" });
    } finally {
      await client.close();
    }
  });

  const benchmarkMode = process.env.CANTRIP_BENCHMARK_EXECUTION_TARGETS;
  it.skipIf(
    benchmarkMode !== "1" &&
      benchmarkMode !== "aggregate" &&
      benchmarkMode !== "focused",
  )(
    "benchmarks aggregate and focused lookup at 1, 100, and 2,000 Terminals",
    async () => {
      const metrics: Array<{
        aggregateQueries: number;
        aggregateTargetCount: number;
        aggregateTruncated: boolean;
        aggregateP50Ms: number | null;
        aggregateP95Ms: number | null;
        focusedQueries: number;
        focusedP50Ms: number | null;
        focusedP95Ms: number | null;
        terminalCount: number;
      }> = [];
      const measureAggregate = benchmarkMode !== "focused";
      const measureFocused = benchmarkMode !== "aggregate";
      for (const targetCount of [1, 100, 2_000]) {
        const { client, queries, repository } = await setup(targetCount);
        try {
          const targetId = `terminal-${Math.min(targetCount - 1, 999)
            .toString()
            .padStart(4, "0")}`;
          const aggregate = () =>
            repository.listProjectExecutionTargets(
              LOCAL_USER_ID,
              projectId,
              () => true,
            );
          const focused = () =>
            repository.resolveExecutionTargetSelector(
              LOCAL_USER_ID,
              projectId,
              "terminal",
              targetId,
              selectorContext,
              () => true,
            );
          queries.length = 0;
          const aggregateProbe = await aggregate();
          const aggregateQueries = queries.length;
          expect(
            aggregateProbe?.targets.some(
              ({ target }) =>
                target.kind === "surface" && target.surfaceId === targetId,
            ),
          ).toBe(true);
          queries.length = 0;
          const focusedProbe = await focused();
          const focusedQueries = queries.length;
          expect(focusedProbe).toEqual({
            outcome: "selected",
            target: {
              kind: "surface",
              projectId,
              surfaceKind: "terminal",
              surfaceId: targetId,
            },
          });
          for (let warmup = 0; warmup < 5; warmup += 1) {
            if (measureAggregate) await aggregate();
            if (measureFocused) await focused();
          }
          const aggregateDurations: number[] = [];
          const focusedDurations: number[] = [];
          for (let iteration = 0; iteration < 20; iteration += 1) {
            if (measureAggregate && measureFocused && iteration % 2 === 0) {
              aggregateDurations.push(await duration(aggregate));
              focusedDurations.push(await duration(focused));
            } else {
              if (measureFocused) {
                focusedDurations.push(await duration(focused));
              }
              if (measureAggregate) {
                aggregateDurations.push(await duration(aggregate));
              }
            }
          }
          metrics.push({
            aggregateQueries,
            aggregateTargetCount: aggregateProbe!.targets.length,
            aggregateTruncated: aggregateProbe!.truncated,
            aggregateP50Ms: measureAggregate
              ? percentile(aggregateDurations, 0.5)
              : null,
            aggregateP95Ms: measureAggregate
              ? percentile(aggregateDurations, 0.95)
              : null,
            focusedP50Ms: measureFocused
              ? percentile(focusedDurations, 0.5)
              : null,
            focusedP95Ms: measureFocused
              ? percentile(focusedDurations, 0.95)
              : null,
            focusedQueries,
            terminalCount: targetCount,
          });
        } finally {
          await client.close();
        }
      }
      console.info(JSON.stringify({ executionTargetSelector: metrics }));
      if (measureAggregate && measureFocused) {
        for (const metric of metrics) {
          expect(metric.focusedP50Ms!).toBeLessThan(metric.aggregateP50Ms!);
          expect(metric.focusedP95Ms!).toBeLessThan(metric.aggregateP95Ms!);
        }
      }
    },
    60_000,
  );
});
