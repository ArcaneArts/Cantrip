import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RunConfigurationShellDocument } from "@cantrip/protocol/run-configuration-definitions";
import type {
  RunConfigurationRuntimeLaunchIdentity,
  RunConfigurationRuntimeWorkerObservation,
} from "@cantrip/protocol/run-configuration-runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
  RunConfigurationRuntimeSupervisor,
  type RunConfigurationRuntimeSupervisorOptions,
} from "./run-configuration-runtime-supervisor.js";
import { RunConfigurationRepository } from "./run-configuration-repository.js";

const temporaryDirectories: string[] = [];

interface Fixture {
  configurationId: string;
  definitionRevision: string;
  sourceRoot: string;
  targetRoot: string;
}

async function nodeFixture(): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-node-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = path.join(root, "target");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
  ]);
  await writeFile(
    path.join(targetRoot, "app.js"),
    'process.stdout.write("node-provider|" + process.argv.slice(2).join("|"));\n',
  );
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Node runtime fixture",
      provider: "node",
      workingDirectory: ".",
      target: { kind: "entry", path: "app.js" },
      commandOverride: null,
      arguments: ["--flag", "two words"],
      environment: {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: [],
      platformOverrides: {},
      options: {
        packageManager: "npm",
        runtime: "node",
        runtimeArguments: [],
      },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Node Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

async function fixture(
  command: string,
  options: {
    beforeLaunch?: RunConfigurationShellDocument["beforeLaunch"];
    environment?: RunConfigurationShellDocument["environment"];
    targetRoot?: string;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-run-configuration-runtime-"),
  );
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "primary");
  const targetRoot = options.targetRoot ?? path.join(root, "target");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
  ]);
  const configurationId = randomUUID();
  const repository = await RunConfigurationRepository.open(sourceRoot);
  const written = await repository.write({
    expectedRevision: null,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Runtime fixture",
      provider: "shell",
      workingDirectory: ".",
      target: { kind: "command", command },
      commandOverride: null,
      arguments: [],
      environment: options.environment ?? {
        includeCodexEnvironment: false,
        files: [],
        variables: [],
        secrets: [],
      },
      beforeLaunch: options.beforeLaunch ?? [],
      platformOverrides: {},
      options: { shell: "automatic", login: true },
      stop: { gracePeriodMs: 50 },
    },
  });
  if (!("entry" in written) || !written.entry.revision) {
    throw new Error("Expected a ready Run configuration fixture.");
  }
  return {
    configurationId,
    definitionRevision: written.entry.revision,
    sourceRoot,
    targetRoot,
  };
}

function identity(
  input: Fixture,
  generation = 1,
  overrides: Partial<RunConfigurationRuntimeLaunchIdentity> = {},
): RunConfigurationRuntimeLaunchIdentity {
  return {
    runtimeId: randomUUID(),
    projectId: randomUUID(),
    configurationId: input.configurationId,
    worktreeId: randomUUID(),
    workerId: "runtime-worker",
    definitionRevision: input.definitionRevision,
    codexEnvironmentRevision: null,
    generation,
    operationId: randomUUID(),
    terminalId: randomUUID(),
    ...overrides,
  };
}

function startCommand(
  input: Fixture,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
) {
  return {
    type: "project.run-configuration-runtime.start" as const,
    identity: runtimeIdentity,
    rootKind: "git-root" as const,
    sourcePath: input.sourceRoot,
    targetPath: input.targetRoot,
  };
}

function restartCommand(
  input: Fixture,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
) {
  return {
    ...startCommand(input, runtimeIdentity),
    type: "project.run-configuration-runtime.restart" as const,
  };
}

function supervisor(
  notifications: RunConfigurationRuntimeWorkerObservation[] = [],
  options: Partial<RunConfigurationRuntimeSupervisorOptions> = {},
): RunConfigurationRuntimeSupervisor {
  return new RunConfigurationRuntimeSupervisor({
    platform: "linux",
    environment: process.env,
    authorize: async (command) => ({
      sourceRoot: command.sourcePath,
      targetRoot: command.targetPath,
    }),
    notify: (observation) => notifications.push(observation),
    ...options,
  });
}

async function waitForState(
  runs: RunConfigurationRuntimeSupervisor,
  runtimeIdentity: RunConfigurationRuntimeLaunchIdentity,
  state: RunConfigurationRuntimeWorkerObservation["state"],
  timeout = 5_000,
): Promise<RunConfigurationRuntimeWorkerObservation> {
  await expect
    .poll(
      () => {
        const lookup = runs.status(runtimeIdentity);
        return lookup.found ? lookup.observation.state : "missing";
      },
      { timeout },
    )
    .toBe(state);
  const lookup = runs.status(runtimeIdentity);
  if (!lookup.found) throw new Error("Expected the runtime to be available.");
  return lookup.observation;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")(
  "RunConfigurationRuntimeSupervisor",
  () => {
    it("rereads the Primary definition and launches a bounded worker-owned PTY", async () => {
      const input = await fixture(
        `printf '%s|%s|%s|%s|%s|%s' "$CANTRIP_PROJECT_ROOT" "$CANTRIP_WORKTREE_PATH" "$CANTRIP_RUN_CONFIGURATION_ID" "$CANTRIP_RUN_GENERATION" "$PLAIN_FIXTURE" "$LAYERED_FIXTURE"`,
        {
          beforeLaunch: [
            {
              kind: "command",
              command: "printf 'before-launch\\n'",
              workingDirectory: ".",
            },
          ],
          environment: {
            includeCodexEnvironment: true,
            files: [],
            variables: [
              { name: "PLAIN_FIXTURE", value: "plain", enabled: true },
              {
                name: "LAYERED_FIXTURE",
                value: "plain-must-not-win",
                enabled: true,
              },
              {
                name: "CANTRIP_PROJECT_ROOT",
                value: "reserved-must-not-win",
                enabled: true,
              },
            ],
            secrets: [],
          },
        },
      );
      const runtimeIdentity = identity(input);
      const notifications: RunConfigurationRuntimeWorkerObservation[] = [];
      const runs = supervisor(notifications, {
        resolveEnvironment: async () => ({
          codex: { LAYERED_FIXTURE: "codex" },
          files: { LAYERED_FIXTURE: "file" },
          secrets: { LAYERED_FIXTURE: "secret" },
          codexEnvironmentRevision: null,
        }),
      });

      expect(
        await runs.start(startCommand(input, runtimeIdentity)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { state: "starting", generation: 1 },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      const output = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: runtimeIdentity,
        tail: 100_000,
      });
      expect(output.data).toContain("before-launch");
      expect(output.data).toContain(
        `${input.sourceRoot}|${input.targetRoot}|${input.configurationId}|1|plain|secret`,
      );
      expect(JSON.stringify(notifications)).not.toContain(
        "reserved-must-not-win",
      );
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 8,
        }),
      ).toMatchObject({ truncated: true });
      await runs.closeAll();
    });

    it("launches a structured Node entrypoint without a handwritten command", async () => {
      const input = await nodeFixture();
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await expect(
        runs.start(startCommand(input, runtimeIdentity)),
      ).resolves.toMatchObject({
        outcome: "accepted",
        observation: { state: "starting" },
      });
      await waitForState(runs, runtimeIdentity, "exited");
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).toContain("node-provider|--flag|two words");
      await runs.closeAll();
    });

    it("replays one generation and fails closed when its revision is stale", async () => {
      const input = await fixture("printf started >> launch-count.txt");
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      const command = startCommand(input, runtimeIdentity);
      await runs.start(command);
      expect(await runs.start(command)).toMatchObject({ outcome: "replayed" });
      await waitForState(runs, runtimeIdentity, "exited");
      expect(
        await readFile(path.join(input.targetRoot, "launch-count.txt"), "utf8"),
      ).toBe("started");

      const nextGeneration = {
        ...runtimeIdentity,
        generation: 2,
        operationId: randomUUID(),
      };
      expect(
        await runs.start(startCommand(input, nextGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: {
          generation: 2,
          terminalId: runtimeIdentity.terminalId,
        },
      });
      await waitForState(runs, nextGeneration, "exited");
      expect(
        await readFile(path.join(input.targetRoot, "launch-count.txt"), "utf8"),
      ).toBe("startedstarted");
      expect(await runs.start(command)).toMatchObject({ outcome: "stale" });

      const recoveredGeneration = {
        ...nextGeneration,
        generation: 7,
        operationId: randomUUID(),
      };
      expect(
        await runs.start(startCommand(input, recoveredGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { generation: 7 },
      });
      await waitForState(runs, recoveredGeneration, "exited");

      const coldWorker = supervisor();
      const durableGeneration = identity(input, 11);
      expect(
        await coldWorker.start(startCommand(input, durableGeneration)),
      ).toMatchObject({
        outcome: "accepted",
        observation: { generation: 11 },
      });
      await waitForState(coldWorker, durableGeneration, "exited");
      await coldWorker.closeAll();

      const staleIdentity = identity(input, 1, {
        definitionRevision: "f".repeat(64),
      });
      await runs.start(startCommand(input, staleIdentity));
      const failed = await waitForState(runs, staleIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "definition",
        code: "definition-revision-mismatch",
      });
      await runs.closeAll();
    });

    it("fails a generation before spawn when an ordered pre-launch step fails", async () => {
      const input = await fixture("printf forbidden > main-started.txt", {
        beforeLaunch: [
          {
            kind: "command",
            command: "printf 'preflight failed\\n'; exit 7",
            workingDirectory: ".",
          },
        ],
      });
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "before-launch",
        code: "before-launch-failed",
      });
      expect(
        runs.output({
          type: "project.run-configuration-runtime.output",
          requestOperationId: randomUUID(),
          identity: runtimeIdentity,
          tail: 100_000,
        }).data,
      ).toContain("preflight failed");
      await expect(
        readFile(path.join(input.targetRoot, "main-started.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });

    it("redacts unexpected worker-local launch errors from observations", async () => {
      const input = await fixture("printf should-not-start");
      const runtimeIdentity = identity(input);
      const notifications: RunConfigurationRuntimeWorkerObservation[] = [];
      const runs = supervisor(notifications, {
        authorize: async () => {
          throw new Error("sensitive-local-path /private/project/token");
        },
      });
      await runs.start(startCommand(input, runtimeIdentity));
      const failed = await waitForState(runs, runtimeIdentity, "failed");
      expect(failed.failure).toMatchObject({
        phase: "spawn",
        code: "launch-failed",
        message: "The Run could not start.",
      });
      expect(JSON.stringify(notifications)).not.toContain(
        "sensitive-local-path",
      );
      await runs.closeAll();
    });

    it("restarts immediately in the same terminal and fences the stale exit", async () => {
      const input = await fixture(
        `printf 'generation:%s\\n' "$CANTRIP_RUN_GENERATION"
if [ "$CANTRIP_RUN_GENERATION" = 1 ]; then
  (sleep 0.4; printf old > old-orphan.txt) &
else
  (sleep 1; printf stopped > stop-orphan.txt) &
fi
while :; do sleep 1; done`,
      );
      const first = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, first));
      await waitForState(runs, first, "running");
      await expect
        .poll(
          () =>
            runs.output({
              type: "project.run-configuration-runtime.output",
              requestOperationId: randomUUID(),
              identity: first,
              tail: 100_000,
            }).data,
          { timeout: 2_000 },
        )
        .toContain("generation:1");

      const second = {
        ...first,
        generation: 2,
        operationId: randomUUID(),
      };
      expect(await runs.restart(restartCommand(input, second))).toMatchObject({
        outcome: "accepted",
        observation: { generation: 2 },
      });
      await waitForState(runs, second, "running");
      const restartedOutput = runs.output({
        type: "project.run-configuration-runtime.output",
        requestOperationId: randomUUID(),
        identity: second,
        tail: 100_000,
      }).data;
      expect(restartedOutput).toContain("generation:1");
      expect(restartedOutput).toContain("[Restarting · generation 2]");
      await expect
        .poll(
          () =>
            runs.output({
              type: "project.run-configuration-runtime.output",
              requestOperationId: randomUUID(),
              identity: second,
              tail: 100_000,
            }).data,
          { timeout: 2_000 },
        )
        .toContain("generation:2");
      expect(second.terminalId).toBe(first.terminalId);
      expect(runs.status(first)).toMatchObject({ found: false });

      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(
        readFile(path.join(input.targetRoot, "old-orphan.txt")),
      ).rejects.toThrow();
      expect(runs.status(second)).toMatchObject({
        found: true,
        observation: { state: "running", generation: 2 },
      });

      const stopIdentity = { ...second, operationId: randomUUID() };
      expect(
        await runs.stop({
          type: "project.run-configuration-runtime.stop",
          identity: stopIdentity,
        }),
      ).toMatchObject({
        outcome: "accepted",
        observation: { state: "idle", terminalId: first.terminalId },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(
        readFile(path.join(input.targetRoot, "stop-orphan.txt")),
      ).rejects.toThrow();
      await runs.closeAll();
    });

    it("runs the same configuration independently in parallel worktrees", async () => {
      const input = await fixture(
        `printf '%s' "$CANTRIP_RUN_WORKTREE_ID"; while :; do sleep 1; done`,
      );
      const alternateRoot = path.join(
        path.dirname(input.targetRoot),
        "alternate-target",
      );
      await mkdir(alternateRoot, { recursive: true });
      const alternate = { ...input, targetRoot: alternateRoot };
      const primaryIdentity = identity(input);
      const alternateIdentity = identity(alternate, 1, {
        projectId: primaryIdentity.projectId,
        configurationId: primaryIdentity.configurationId,
      });
      const runs = supervisor();

      await Promise.all([
        runs.start(startCommand(input, primaryIdentity)),
        runs.start(startCommand(alternate, alternateIdentity)),
      ]);
      await Promise.all([
        waitForState(runs, primaryIdentity, "running"),
        waitForState(runs, alternateIdentity, "running"),
      ]);
      await Promise.all(
        [primaryIdentity, alternateIdentity].map((runtimeIdentity) =>
          expect
            .poll(
              () =>
                runs.output({
                  type: "project.run-configuration-runtime.output",
                  requestOperationId: randomUUID(),
                  identity: runtimeIdentity,
                  tail: 100_000,
                }).data,
            )
            .toContain(runtimeIdentity.worktreeId),
        ),
      );

      const reconciliation = await runs.reconcile([primaryIdentity]);
      expect(reconciliation).toMatchObject({
        runtimes: [{ found: true, observation: { state: "running" } }],
        orphanedRuntimeIds: [alternateIdentity.runtimeId],
      });
      expect(runs.status(alternateIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      expect(await runs.stopProject(primaryIdentity.projectId)).toBe(1);
      expect(runs.status(primaryIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      await runs.closeAll();
    });

    it("stops active processes before a matching target path is removed", async () => {
      const input = await fixture("while :; do sleep 1; done");
      const runtimeIdentity = identity(input);
      const runs = supervisor();
      await runs.start(startCommand(input, runtimeIdentity));
      await waitForState(runs, runtimeIdentity, "running");
      expect(await runs.stopForPath(input.targetRoot)).toBe(1);
      expect(runs.status(runtimeIdentity)).toMatchObject({
        found: true,
        observation: { state: "lost" },
      });
      await runs.closeAll();
    });
  },
);

describe("Run configuration input boundary", () => {
  it("does not expose programmatic stdin", () => {
    const runs = supervisor();
    expect("input" in runs).toBe(false);
  });
});
