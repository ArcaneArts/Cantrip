import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRunConfigurations } from "./run-configuration-discovery.js";
import { RunSetupManager } from "./run-setup-manager.js";

const temporaryDirectories: string[] = [];

async function fixture(setup: string | null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-run-setup-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "source");
  const worktreeRoot = path.join(root, "worktree");
  const dataDirectory = path.join(root, "data");
  await mkdir(path.join(sourceRoot, ".codex", "environments"), {
    recursive: true,
  });
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(
    path.join(sourceRoot, ".codex", "environments", "environment.toml"),
    `version = 1
name = "Setup fixture"
${setup === null ? "" : `[setup]\nscript = ${JSON.stringify(setup)}\n`}`,
  );
  const inspection = await inspectRunConfigurations(
    sourceRoot,
    process.platform,
  );
  const configurationRevision = inspection.configurations[0]!.revision;
  const input = {
    jobId: randomUUID(),
    attempt: 1,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    sourcePath: sourceRoot,
    worktreePath: worktreeRoot,
    configurationRevision,
  };
  const manager = new RunSetupManager({
    authorize: async (request) => {
      expect(request.sourcePath).toBe(sourceRoot);
      expect(request.worktreePath).toBe(worktreeRoot);
      return { sourceRoot, worktreeRoot };
    },
    dataDirectory,
    environment: {
      ...process.env,
      CANTRIP_SERVER_URL: "https://server.example",
      PRESERVED_SETUP_INPUT: "preserved",
    },
    platform: process.platform,
  });
  await manager.initialize();
  return {
    configurationPath: path.join(
      sourceRoot,
      ".codex",
      "environments",
      "environment.toml",
    ),
    dataDirectory,
    input,
    manager,
    sourceRoot,
    worktreeRoot,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("RunSetupManager", () => {
  it("runs setup asynchronously and keeps bounded exports worker-private", async () => {
    const setup = await fixture(
      "printf 'setup output\\n'; printf '%s' \"$PRESERVED_SETUP_INPUT\" > prepared.txt; export SETUP_FIXTURE_TOKEN=secret; export CANTRIP_SERVER_URL=https://evil.example; export CODEX_WORKTREE_PATH=/evil",
    );
    expect(setup.manager.start(setup.input)).toMatchObject({
      state: "running",
      output: "",
    });
    await expect
      .poll(
        () =>
          setup.manager.status(
            setup.input.jobId,
            setup.input.projectId,
            setup.input.worktreeId,
          ),
        { timeout: 5_000 },
      )
      .toMatchObject({
        found: true,
        status: {
          state: "succeeded",
          exitCode: 0,
          output: expect.stringContaining("setup output"),
        },
      });
    expect(
      await readFile(path.join(setup.worktreeRoot, "prepared.txt"), "utf8"),
    ).toBe("preserved");
    const environment = setup.manager.environmentFor(
      setup.input.projectId,
      setup.input.worktreeId,
      setup.input.configurationRevision,
    );
    expect(environment).toMatchObject({ SETUP_FIXTURE_TOKEN: "secret" });
    expect(environment).not.toHaveProperty("CANTRIP_SERVER_URL");
    expect(environment).not.toHaveProperty("CODEX_WORKTREE_PATH");

    const privateDirectory = path.join(setup.dataDirectory, "run-setup");
    expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
    const privateEntries = await readdir(privateDirectory);
    const records = privateEntries.filter((name) => name.endsWith(".json"));
    expect(records).toHaveLength(1);
    expect(privateEntries).toEqual(records);
    expect(
      (await stat(path.join(privateDirectory, records[0]!))).mode & 0o777,
    ).toBe(0o600);
    await setup.manager.closeAll();
  });

  it("succeeds without a setup script and rejects revision drift", async () => {
    const absent = await fixture(null);
    absent.manager.start(absent.input);
    await expect
      .poll(
        () =>
          absent.manager.status(
            absent.input.jobId,
            absent.input.projectId,
            absent.input.worktreeId,
          ),
        { timeout: 5_000 },
      )
      .toMatchObject({
        found: true,
        status: {
          state: "succeeded",
          output: expect.stringContaining("No platform-compatible setup"),
        },
      });
    await absent.manager.closeAll();

    const stale = await fixture("export SHOULD_NOT_APPEAR=true");
    await writeFile(
      stale.configurationPath,
      'version = 1\nname = "Changed setup"\n',
    );
    stale.manager.start(stale.input);
    await expect
      .poll(
        () =>
          stale.manager.status(
            stale.input.jobId,
            stale.input.projectId,
            stale.input.worktreeId,
          ),
        { timeout: 5_000 },
      )
      .toMatchObject({
        found: true,
        status: {
          state: "failed",
          error: { code: "configuration-stale", retryable: true },
        },
      });
    expect(
      stale.manager.environmentFor(
        stale.input.projectId,
        stale.input.worktreeId,
        stale.input.configurationRevision,
      ),
    ).toEqual({});
    await stale.manager.closeAll();
  });

  it("deletes persisted setup state when its worktree disappears", async () => {
    const setup = await fixture("export CLEANUP_FIXTURE=true");
    setup.manager.start(setup.input);
    await expect
      .poll(
        () =>
          setup.manager.status(
            setup.input.jobId,
            setup.input.projectId,
            setup.input.worktreeId,
          ),
        { timeout: 5_000 },
      )
      .toMatchObject({ found: true, status: { state: "succeeded" } });

    await setup.manager.reconcile(setup.sourceRoot, []);
    expect(
      setup.manager.status(
        setup.input.jobId,
        setup.input.projectId,
        setup.input.worktreeId,
      ),
    ).toEqual({ found: false, jobId: setup.input.jobId });
    expect(
      (await readdir(path.join(setup.dataDirectory, "run-setup"))).filter(
        (name) => name.endsWith(".json"),
      ),
    ).toEqual([]);
    await setup.manager.closeAll();
  });
});
