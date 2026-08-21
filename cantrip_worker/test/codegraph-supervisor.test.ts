import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { codeGraphProjectStatusSchema } from "@cantrip/protocol";
import type { CodeGraphProjectStatus } from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CodeGraphProjectSupervisor } from "../src/codegraph/supervisor.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function gitProject(prefix: string): Promise<{
  gitCommonDir: string;
  root: string;
}> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  directories.push(root);
  await execFileAsync("git", ["-C", root, "init", "--quiet"]);
  const { stdout } = await execFileAsync("git", [
    "-C",
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return { gitCommonDir: stdout.trim(), root };
}

function fakeCodeGraph() {
  const initialized = new Set<string>();
  const calls: Array<{ args: string[]; root: string }> = [];
  let active = 0;
  let maximumActive = 0;
  const execute = async (
    _command: string,
    args: string[],
    options: { cwd: string },
  ) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls.push({ args, root: options.cwd });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const operation = args[0];
    if (operation === "init" || operation === "index") {
      initialized.add(options.cwd);
    }
    const stdout =
      operation === "status"
        ? JSON.stringify({
            initialized: initialized.has(options.cwd),
            projectPath: options.cwd,
            lastIndexed: initialized.has(options.cwd)
              ? "2026-08-19T20:00:00.000Z"
              : null,
            fileCount: initialized.has(options.cwd) ? 4 : undefined,
            nodeCount: initialized.has(options.cwd) ? 12 : undefined,
            edgeCount: initialized.has(options.cwd) ? 18 : undefined,
            pendingChanges: { added: 0, modified: 0, removed: 0 },
            index: { reindexRecommended: false, state: "complete" },
          })
        : "";
    active -= 1;
    return { code: 0, stderr: "", stdout };
  };
  return {
    calls,
    execute,
    initialized,
    maximumActive: () => maximumActive,
  };
}

describe("CodeGraph project supervisor", () => {
  it("authorizes, excludes, initializes, and incrementally synchronizes a worktree", async () => {
    const project = await gitProject("cantrip-codegraph-project-");
    const fake = fakeCodeGraph();
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async (_source, requested) => {
        expect(requested).toEqual([project.root]);
        return [project];
      },
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    await supervisor.configure([
      { sourcePath: project.root, worktreePath: project.root },
    ]);
    await supervisor.waitForIdle();

    expect(fake.calls.map(({ args }) => args[0])).toEqual([
      "status",
      "init",
      "status",
    ]);
    expect(supervisor.statuses()).toEqual([
      expect.objectContaining({
        root: project.root,
        state: "ready",
        fileCount: 4,
        nodeCount: 12,
        edgeCount: 18,
      }),
    ]);
    await expect(supervisor.prepareForAgent(project.root)).resolves.toBe(
      project.root,
    );
    const nested = path.join(project.root, "packages", "agent");
    await mkdir(nested, { recursive: true });
    await expect(supervisor.prepareForAgent(nested)).resolves.toBe(
      project.root,
    );
    await supervisor.waitForIdle();
    await expect(
      readFile(path.join(project.gitCommonDir, "info", "exclude"), "utf8"),
    ).resolves.toContain("/.codegraph-cantrip/");

    supervisor.resync(project.root);
    await supervisor.waitForIdle();
    expect(fake.calls.map(({ args }) => args[0]).slice(-3)).toEqual([
      "status",
      "sync",
      "status",
    ]);

    await supervisor.configure([]);
    expect(supervisor.statuses()).toEqual([]);
    supervisor.close();
  });

  it("rebuilds an initialized worktree and preserves only one exclude marker", async () => {
    const project = await gitProject("cantrip-codegraph-rebuild-");
    const fake = fakeCodeGraph();
    fake.initialized.add(project.root);
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    const target = { sourcePath: project.root, worktreePath: project.root };
    await supervisor.configure([target]);
    await supervisor.waitForIdle();
    await supervisor.configure([target]);
    supervisor.rebuild(project.root);
    await supervisor.waitForIdle();

    expect(fake.calls.some(({ args }) => args[0] === "index")).toBe(true);
    const exclude = await readFile(
      path.join(project.gitCommonDir, "info", "exclude"),
      "utf8",
    );
    expect(exclude.match(/BEGIN CANTRIP CODEGRAPH/gu)).toHaveLength(1);
    supervisor.close();
  });

  it("addresses nonblocking jobs by server-owned project identity", async () => {
    const project = await gitProject("cantrip-codegraph-identity-");
    const fake = fakeCodeGraph();
    const observations: CodeGraphProjectStatus[] = [];
    const projectId = "00000000-0000-4000-8000-000000000001";
    const worktreeId = "primary:test";
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: fake.execute,
      onStatus: (status) =>
        observations.push(codeGraphProjectStatusSchema.parse(status)),
    });

    await supervisor.configure([
      {
        projectId,
        worktreeId,
        sourcePath: project.root,
        worktreePath: project.root,
      },
    ]);
    await supervisor.waitForIdle();

    const acknowledgement = supervisor.requestAction(
      projectId,
      worktreeId,
      "sync",
    );
    expect(acknowledgement).toEqual(
      expect.objectContaining({ action: "sync", status: "queued" }),
    );
    await supervisor.waitForIdle();
    expect(supervisor.publicStatus(projectId, worktreeId)).toEqual(
      expect.objectContaining({
        projectId,
        worktreeId,
        state: "ready",
        job: expect.objectContaining({
          id: acknowledgement.jobId,
          state: "completed",
        }),
      }),
    );
    expect(observations.some(({ job }) => job?.state === "running")).toBe(true);
    expect(observations.at(-1)).toMatchObject({
      projectId,
      worktreeId,
      job: { state: "completed" },
    });
    expect(() =>
      supervisor.requestAction(projectId, "unmanaged", "rebuild"),
    ).toThrow("not managed");
    supervisor.close();
  });

  it("limits initial indexing concurrency across many worktrees", async () => {
    const projects = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        gitProject(`cantrip-codegraph-concurrency-${index}-`),
      ),
    );
    const fake = fakeCodeGraph();
    const byRoot = new Map(projects.map((project) => [project.root, project]));
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async (_source, requested) => {
        return requested.map((root) => {
          const project = byRoot.get(root);
          if (!project) throw new Error("unauthorized");
          return project;
        });
      },
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    await supervisor.configure(
      projects.map(({ root }) => ({ sourcePath: root, worktreePath: root })),
    );
    await supervisor.waitForIdle();

    expect(fake.maximumActive()).toBeLessThanOrEqual(2);
    expect(supervisor.statuses()).toHaveLength(5);
    supervisor.close();
  });

  it("debounces file changes and recovers a failed filesystem watcher", async () => {
    const project = await gitProject("cantrip-codegraph-watcher-");
    const fake = fakeCodeGraph();
    let listener:
      ((event: string, fileName: string | Buffer | null) => void) | null = null;
    const watchers: EventEmitter[] = [];
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      changeDebounceMs: 5,
      command: "/managed/codegraph",
      execute: fake.execute,
      watcherRetryBaseMs: 5,
      watch: (_root, nextListener) => {
        listener = nextListener;
        const watcher = new EventEmitter();
        Object.assign(watcher, { close: () => undefined });
        watchers.push(watcher);
        return watcher as FSWatcher;
      },
    });

    await supervisor.configure([
      { sourcePath: project.root, worktreePath: project.root },
    ]);
    await supervisor.waitForIdle();
    const callsBeforeChange = fake.calls.length;
    listener?.("change", "src/first.ts");
    listener?.("change", "src/second.ts");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await supervisor.waitForIdle();
    expect(
      fake.calls.slice(callsBeforeChange).map(({ args }) => args[0]),
    ).toEqual(["status", "sync", "status"]);

    watchers[0]?.emit("error", new Error("watcher closed"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(watchers).toHaveLength(2);
    supervisor.close();
  });

  it("does not authorize or index an unrelated path", async () => {
    const project = await gitProject("cantrip-codegraph-authorized-");
    const unrelated = await mkdtemp(
      path.join(tmpdir(), "cantrip-codegraph-unrelated-"),
    );
    directories.push(unrelated);
    await writeFile(path.join(unrelated, "secret.txt"), "not indexed");
    const fake = fakeCodeGraph();
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async (_source, requested) => {
        if (requested[0] !== project.root) throw new Error("unauthorized");
        return [project];
      },
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    await supervisor.configure([
      { sourcePath: project.root, worktreePath: unrelated },
    ]);
    await supervisor.waitForIdle();

    expect(fake.calls).toEqual([]);
    expect(supervisor.statuses()).toEqual([]);
    await expect(supervisor.prepareForAgent(unrelated)).resolves.toBeNull();
    supervisor.close();
  });
});
