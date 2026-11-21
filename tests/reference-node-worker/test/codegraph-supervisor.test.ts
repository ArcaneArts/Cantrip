import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { codeGraphProjectStatusSchema } from "@cantrip/protocol";
import type {
  CodeGraphObservationTarget,
  CodeGraphProjectStatus,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeGraphProjectSupervisor } from "../src/codegraph/supervisor.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
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
  const pendingChanges = new Map<string, number | null>();
  const reindexRecommended = new Set<string>();
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
    if (operation === "init" || operation === "index" || operation === "sync") {
      pendingChanges.set(options.cwd, 0);
      reindexRecommended.delete(options.cwd);
    }
    const pending = pendingChanges.has(options.cwd)
      ? pendingChanges.get(options.cwd)
      : 0;
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
            pendingChanges:
              pending === null
                ? undefined
                : { added: pending, modified: 0, removed: 0 },
            index: {
              reindexRecommended: reindexRecommended.has(options.cwd),
              state: "complete",
            },
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
    pendingChanges,
    reindexRecommended,
  };
}

function codeGraphTarget(
  root: string,
  overrides: Partial<CodeGraphObservationTarget> = {},
): CodeGraphObservationTarget {
  return {
    projectId: "00000000-0000-4000-8000-000000000001",
    worktreeId: `root:${root}`,
    rootKind: "git-worktree",
    sourcePath: root,
    worktreePath: root,
    ...overrides,
  };
}

describe("CodeGraph project supervisor", () => {
  it("retires an index only after its aborted process closes and fences reconfiguration", async () => {
    const project = await gitProject("cantrip-codegraph-retire-process-");
    const script = path.join(project.root, "fake-codegraph.cjs");
    const pidFile = path.join(project.root, "index-pid");
    const closedFile = path.join(project.root, "index-closed");
    const cache = path.join(project.root, ".codegraph-cantrip");
    await writeFile(
      script,
      `
      const fs = require("node:fs"), path = require("node:path");
      const [operation, ...rest] = process.argv.slice(2), root = rest.at(-1);
      if (operation === "status") process.stdout.write(JSON.stringify({ initialized: false, projectPath: root }));
      else if (operation === "init") {
        fs.mkdirSync(path.join(root, ".codegraph-cantrip"), { recursive: true });
        process.on("SIGTERM", () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(closedFile)}, "closed"); process.exit(0); }, 300));
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => {}, 1000);
      } else if (operation === "uninit") fs.rmSync(path.join(root, ".codegraph-cantrip"), { recursive: true, force: true });
    `,
    );
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: process.execPath,
      commandArguments: [script],
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await supervisor.configure([codeGraphTarget(project.root)]);
      await expect
        .poll(() => readFile(pidFile, "utf8").catch(() => ""))
        .not.toBe("");
      const pid = Number(await readFile(pidFile, "utf8"));
      let entered = false;
      const retirement = supervisor.withRetiredIndex(project.root, async () => {
        entered = true;
        expect(() => process.kill(pid, 0)).toThrow();
        if (process.platform !== "win32")
          expect(await readFile(closedFile, "utf8")).toBe("closed");
        await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
        await held;
        return "removed";
      });
      retirement.catch(() => {});
      await expect.poll(() => entered).toBe(true);
      await supervisor.configure([codeGraphTarget(project.root)]);
      expect(supervisor.statuses()).toEqual([]);
      finish();
      await expect(retirement).resolves.toBe("removed");
    } finally {
      finish();
      supervisor.close();
    }
  });

  it("attempts index cleanup before first observation, preserves links and continues real removal checks on failure", async () => {
    const project = await gitProject("cantrip-codegraph-retire-failure-");
    const fake = fakeCodeGraph();
    const calls: string[] = [];
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "codegraph",
      execute: async (command, args, options) => {
        calls.push(args[0]!);
        if (args[0] === "uninit")
          return { code: 1, stdout: "", stderr: "cannot remove index" };
        return fake.execute(command, args, options);
      },
    });
    try {
      const cache = path.join(project.root, ".codegraph-cantrip");
      await mkdir(cache);
      await writeFile(path.join(cache, "data"), "derived");
      let removed = false;
      await supervisor.withRetiredIndex(project.root, async () => {
        removed = true;
      });
      expect(removed).toBe(true);
      expect(calls).toEqual(["uninit"]);
      await supervisor.configure([codeGraphTarget(project.root)]);
      await expect.poll(() => supervisor.statuses()[0]?.state).toBe("ready");
      await supervisor.withRetiredIndex(project.root, async () => {
        expect(await readFile(path.join(cache, "data"), "utf8")).toBe(
          "derived",
        );
        return "worktree-dirty";
      });
      expect(calls).toContain("uninit");
      await rm(cache, { recursive: true });
      const privateDirectory = path.join(project.root, "private-directory");
      await mkdir(privateDirectory);
      await writeFile(path.join(privateDirectory, "private.txt"), "user data");
      await symlink(
        privateDirectory,
        cache,
        process.platform === "win32" ? "junction" : "dir",
      );
      calls.length = 0;
      await supervisor.withRetiredIndex(project.root, async () => {
        expect(
          await readFile(path.join(privateDirectory, "private.txt"), "utf8"),
        ).toBe("user data");
      });
      expect(calls).not.toContain("uninit");
      await supervisor.configure([codeGraphTarget(project.root)]);
      await expect.poll(() => supervisor.statuses()[0]?.state).toBe("ready");
    } finally {
      supervisor.close();
    }
  });

  it.each([false, true])(
    "initializes a nested worktree after ancestor discovery and validates the result (stale after init: %s)",
    async (staleAfterInit) => {
      const project = await gitProject("cantrip-codegraph-nested-");
      const fake = fakeCodeGraph();
      const supervisor = new CodeGraphProjectSupervisor({
        authorize: async () => [project],
        command: "/managed/codegraph",
        execute: async (command, args, options) => {
          const beforeInit = !fake.initialized.has(project.root);
          const result = await fake.execute(command, args, options);
          if (args[0] === "status" && (beforeInit || staleAfterInit)) {
            const status = JSON.parse(result.stdout);
            result.stdout = JSON.stringify({
              ...status,
              projectPath: path.dirname(project.root),
              initialized: true,
            });
          }
          return result;
        },
      });
      try {
        await supervisor.configure([codeGraphTarget(project.root)]);
        await supervisor.waitForIdle();
        expect(fake.calls.map(({ args }) => args[0])).toEqual([
          "status",
          "init",
          "status",
        ]);
        expect(supervisor.statuses()[0]!.state).toBe(
          staleAfterInit ? "degraded" : "ready",
        );
      } finally {
        await supervisor.close();
      }
    },
  );
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

    await supervisor.configure([codeGraphTarget(project.root)]);
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

    fake.pendingChanges.set(project.root, 1);
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

  it("skips clean syncs while preserving unknown and reindex fallbacks", async () => {
    const project = await gitProject("cantrip-codegraph-noop-sync-");
    const fake = fakeCodeGraph();
    fake.initialized.add(project.root);
    const projectId = "00000000-0000-4000-8000-000000000001";
    const worktreeId = "primary:noop-sync";
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    await supervisor.configure([
      codeGraphTarget(project.root, { projectId, worktreeId }),
    ]);
    await supervisor.waitForIdle();

    const cleanStart = fake.calls.length;
    const acknowledgement = supervisor.requestAction(
      projectId,
      worktreeId,
      "sync",
    );
    await supervisor.waitForIdle();
    expect(fake.calls.slice(cleanStart).map(({ args }) => args[0])).toEqual([
      "status",
    ]);
    expect(supervisor.publicStatus(projectId, worktreeId)).toEqual(
      expect.objectContaining({
        state: "ready",
        pendingChanges: 0,
        job: expect.objectContaining({
          id: acknowledgement.jobId,
          state: "completed",
        }),
      }),
    );

    fake.pendingChanges.set(project.root, null);
    const unknownStart = fake.calls.length;
    supervisor.resync(project.root);
    await supervisor.waitForIdle();
    expect(fake.calls.slice(unknownStart).map(({ args }) => args[0])).toEqual([
      "status",
      "sync",
      "status",
    ]);

    fake.reindexRecommended.add(project.root);
    const reindexStart = fake.calls.length;
    supervisor.resync(project.root);
    await supervisor.waitForIdle();
    expect(fake.calls.slice(reindexStart).map(({ args }) => args[0])).toEqual([
      "status",
      "index",
      "status",
    ]);
    supervisor.close();
  });

  it("keeps watched clean repositories idle until the safety sweep, without delaying explicit sync", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const project = await gitProject("cantrip-codegraph-idle-");
    const fake = fakeCodeGraph();
    let now = 0;
    const watcher = Object.assign(new EventEmitter(), {
      close: () => undefined,
    });
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: fake.execute,
      now: () => new Date(now),
      watch: () => watcher as FSWatcher,
    });
    const advance = async (minutes: number) => {
      now += minutes * 60_000;
      vi.advanceTimersByTime(minutes * 60_000);
      await supervisor.waitForIdle();
    };
    try {
      await supervisor.configure([codeGraphTarget(project.root)]);
      await supervisor.waitForIdle();
      const start = fake.calls.length;
      await advance(28);
      expect(fake.calls).toHaveLength(start);
      await advance(2);
      expect(fake.calls.slice(start).map(({ args }) => args[0])).toEqual([
        "status",
      ]);

      fake.pendingChanges.set(project.root, 1);
      supervisor.resync(project.root);
      await supervisor.waitForIdle();
      expect(fake.calls.slice(start + 1).map(({ args }) => args[0])).toEqual([
        "status",
        "sync",
        "status",
      ]);

      const afterSync = fake.calls.length;
      await advance(2);
      expect(fake.calls).toHaveLength(afterSync);
      watcher.emit("error", new Error("watcher lost"));
      fake.pendingChanges.set(project.root, 1);
      await advance(2);
      expect(fake.calls.slice(afterSync).map(({ args }) => args[0])).toEqual([
        "status",
        "sync",
        "status",
      ]);
    } finally {
      supervisor.close();
    }
  });

  it("does not enqueue another periodic probe while a repository operation is running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const project = await gitProject("cantrip-codegraph-busy-");
    const fake = fakeCodeGraph();
    let advanceDuringProbe = false;
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: async (command, args, options) => {
        if (advanceDuringProbe) {
          advanceDuringProbe = false;
          vi.advanceTimersByTime(2 * 60_000);
        }
        return fake.execute(command, args, options);
      },
      watch: () => {
        throw new Error("watch unavailable");
      },
    });
    try {
      await supervisor.configure([codeGraphTarget(project.root)]);
      await supervisor.waitForIdle();
      const start = fake.calls.length;
      advanceDuringProbe = true;
      supervisor.resync(project.root);
      await supervisor.waitForIdle();
      expect(fake.calls.slice(start).map(({ args }) => args[0])).toEqual([
        "status",
      ]);
    } finally {
      supervisor.close();
    }
  });

  it("reconciles pending changes when the filesystem watcher is unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const project = await gitProject("cantrip-codegraph-reconcile-fallback-");
    const fake = fakeCodeGraph();
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async () => [project],
      command: "/managed/codegraph",
      execute: fake.execute,
      watch: () => {
        throw new Error("watching unavailable");
      },
    });

    try {
      await supervisor.configure([codeGraphTarget(project.root)]);
      await supervisor.waitForIdle();
      fake.pendingChanges.set(project.root, 1);
      const reconcileStart = fake.calls.length;

      vi.advanceTimersByTime(2 * 60_000);
      await supervisor.waitForIdle();

      expect(
        fake.calls.slice(reconcileStart).map(({ args }) => args[0]),
      ).toEqual(["status", "sync", "status"]);
    } finally {
      supervisor.close();
    }
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

    const target = codeGraphTarget(project.root);
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
      codeGraphTarget(project.root, {
        projectId,
        worktreeId,
      }),
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
      projects.map(({ root }) => codeGraphTarget(root)),
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

    await supervisor.configure([codeGraphTarget(project.root)]);
    await supervisor.waitForIdle();
    const callsBeforeChange = fake.calls.length;
    fake.pendingChanges.set(project.root, 2);
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
      codeGraphTarget(project.root, { worktreePath: unrelated }),
    ]);
    await supervisor.waitForIdle();

    expect(fake.calls).toEqual([]);
    expect(supervisor.statuses()).toEqual([]);
    await expect(supervisor.prepareForAgent(unrelated)).resolves.toBeNull();
    supervisor.close();
  });

  it("initializes a plain folder without requiring Git metadata", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "cantrip-codegraph-folder-")),
    );
    directories.push(root);
    const fake = fakeCodeGraph();
    const supervisor = new CodeGraphProjectSupervisor({
      authorize: async (sourcePath, requested, rootKind) => {
        expect(sourcePath).toBe(root);
        expect(requested).toEqual([root]);
        expect(rootKind).toBe("folder-root");
        return [{ gitCommonDir: null, root }];
      },
      command: "/managed/codegraph",
      execute: fake.execute,
    });

    await supervisor.configure([
      codeGraphTarget(root, { rootKind: "folder-root" }),
    ]);
    await supervisor.waitForIdle();

    expect(fake.calls.map(({ args }) => args[0])).toEqual([
      "status",
      "init",
      "status",
    ]);
    await expect(supervisor.prepareForAgent(root)).resolves.toBe(root);
    expect(supervisor.statuses()).toEqual([
      expect.objectContaining({ root, state: "ready" }),
    ]);
    supervisor.close();
  });
});
