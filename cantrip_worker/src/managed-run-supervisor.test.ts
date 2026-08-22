import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ManagedRunSupervisor,
  runShellInvocation,
  type ManagedRunStart,
} from "./managed-run-supervisor.js";
import { inspectRunConfigurations } from "./run-configuration-discovery.js";

const temporaryDirectories: string[] = [];

async function project(command: string): Promise<{
  root: string;
  input: ManagedRunStart;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-managed-run-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, ".codex", "environments");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "environment.toml"),
    `version = 1
name = "Managed Run"
[[actions]]
name = "Run fixture"
icon = "run"
command = ${JSON.stringify(command)}
platform = "linux"
`,
  );
  const inspection = await inspectRunConfigurations(root, "linux");
  const configuration = inspection.configurations[0]!;
  const action = configuration.actions[0]!;
  return {
    root,
    input: {
      runId: randomUUID(),
      requestId: randomUUID(),
      projectId: randomUUID(),
      worktreeId: randomUUID(),
      rootKind: "folder-root",
      sourcePath: root,
      worktreePath: root,
      actionId: action.id,
      configurationRevision: configuration.revision,
    },
  };
}

function supervisor(
  root: string,
  notifications: unknown[] = [],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return new ManagedRunSupervisor({
    platform: "linux",
    environment,
    authorize: async (input) => {
      expect(input.sourcePath).toBe(root);
      expect(input.worktreePath).toBe(root);
      return { sourceRoot: root, worktreeRoot: root };
    },
    notify: (run) => notifications.push(run),
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("ManagedRunSupervisor", () => {
  it("runs once with compatible environment variables and bounded logs", async () => {
    const fixture = await project(
      'printf \'%s|%s|%s|%s|%s|%s\' "$CODEX_WORKTREE_PATH" "$CANTRIP_WORKTREE_PATH" "$CANTRIP_PROJECT_ROOT" "$CANTRIP_RUN_ID" "$CANTRIP_ACTION_ID" "$PRESERVED_FIXTURE"',
    );
    const notifications: unknown[] = [];
    const runs = supervisor(fixture.root, notifications, {
      ...process.env,
      CANTRIP_ACTION_ID: "must-not-win",
      CANTRIP_PROJECT_ROOT: "must-not-win",
      CANTRIP_RUN_ID: "must-not-win",
      CANTRIP_WORKTREE_PATH: "must-not-win",
      CODEX_WORKTREE_PATH: "must-not-win",
      PRESERVED_FIXTURE: "preserved",
    });

    expect((await runs.start(fixture.input)).state).toMatch(/running|exited/u);
    await expect
      .poll(() => runs.status(fixture.input.runId), { timeout: 5_000 })
      .toMatchObject({ found: true, run: { state: "exited", exitCode: 0 } });
    const logs = runs.logs(fixture.input.runId, 100_000);
    expect(logs.data).toContain(
      `${fixture.root}|${fixture.root}|${fixture.root}|${fixture.input.runId}|${fixture.input.actionId}|preserved`,
    );
    expect(runs.logs(fixture.input.runId, 10)).toMatchObject({
      data: expect.stringMatching(/preserved$/u),
      truncated: true,
    });
    expect(JSON.stringify(notifications)).not.toContain("printf");
    await runs.closeAll();
  });

  it("uses Run identity for idempotency and rejects stale revisions", async () => {
    const fixture = await project(
      "printf 'started\\n' >> run-count.txt; sleep 0.5",
    );
    const runs = supervisor(fixture.root);
    await runs.start(fixture.input);
    await runs.start(fixture.input);
    await expect(
      runs.start({ ...fixture.input, actionId: "c".repeat(64) }),
    ).rejects.toThrow(/already associated/iu);
    await expect
      .poll(() => runs.status(fixture.input.runId), { timeout: 5_000 })
      .toMatchObject({ found: true, run: { state: "exited" } });
    expect(
      await readFile(path.join(fixture.root, "run-count.txt"), "utf8"),
    ).toBe("started\n");

    await expect(
      runs.start({
        ...fixture.input,
        runId: randomUUID(),
        requestId: randomUUID(),
        configurationRevision: "f".repeat(64),
      }),
    ).rejects.toThrow(/configuration changed/iu);
    await runs.closeAll();
  });

  it("attaches encrypted terminal transports to the existing Run PTY", async () => {
    const fixture = await project(
      "printf 'ready:'; read line; printf 'received:%s' \"$line\"",
    );
    const runs = supervisor(fixture.root);
    await runs.start(fixture.input);
    const events: Array<{ type: string; data?: string }> = [];
    const opened = runs.attach(
      fixture.input.runId,
      "attachment-one",
      90,
      30,
      (event) => events.push(event),
    );
    expect(events[0]).toEqual({ type: "terminal.ready" });
    runs.input(fixture.input.runId, "hello\r");
    await expect(opened).resolves.toMatchObject({
      status: "exited",
      exitCode: 0,
    });
    expect(events.map((event) => event.data ?? "").join("")).toContain(
      "received:hello",
    );
    expect(runs.snapshot(fixture.input.runId, 100_000)).toMatchObject({
      terminalId: fixture.input.runId,
      status: "exited",
      data: expect.stringContaining("received:hello"),
    });
    await runs.closeAll();
  });

  it("stops the complete process group and never restarts an action", async () => {
    const fixture = await project(
      "(sleep 1; printf 'orphan' > escaped.txt) & while :; do sleep 1; done",
    );
    const runs = supervisor(fixture.root);
    await runs.start(fixture.input);
    await expect
      .poll(() => runs.status(fixture.input.runId), { timeout: 2_000 })
      .toMatchObject({ found: true, run: { state: "running" } });
    await expect(runs.stop(fixture.input.runId)).resolves.toMatchObject({
      found: true,
      run: { state: "stopped" },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await expect(
      readFile(path.join(fixture.root, "escaped.txt")),
    ).rejects.toThrow();
    expect(runs.status(fixture.input.runId)).toMatchObject({
      found: true,
      run: { state: "stopped" },
    });
    await runs.closeAll();
  });

  it("marks active processes lost during shutdown and reconciles no stale process", async () => {
    const fixture = await project("while :; do sleep 1; done");
    const notifications: unknown[] = [];
    const runs = supervisor(fixture.root, notifications);
    await runs.start(fixture.input);
    await runs.closeAll();
    expect(runs.status(fixture.input.runId)).toMatchObject({
      found: true,
      run: { state: "lost" },
    });

    const restarted = supervisor(fixture.root);
    expect(restarted.reconcile([fixture.input])).toEqual([
      { found: false, runId: fixture.input.runId },
    ]);
    await restarted.closeAll();
  });

  it("stops Runs before their worktree or project files are removed", async () => {
    const fixture = await project("while :; do sleep 1; done");
    const runs = supervisor(fixture.root);
    await runs.start(fixture.input);
    expect(await runs.stopProject("another-project")).toBe(0);
    expect(await runs.stopForPath(fixture.root)).toBe(1);
    expect(runs.status(fixture.input.runId)).toMatchObject({
      found: true,
      run: { state: "stopped" },
    });

    const second = {
      ...fixture.input,
      runId: randomUUID(),
      requestId: randomUUID(),
    };
    await runs.start(second);
    expect(await runs.stopProject(fixture.input.projectId)).toBe(1);
    expect(runs.status(second.runId)).toMatchObject({
      found: true,
      run: { state: "stopped" },
    });
    await runs.closeAll();
  });
});

describe("runShellInvocation", () => {
  it("uses PowerShell on Windows and login shells on Unix", () => {
    expect(runShellInvocation("Write-Host ok", "win32")).toEqual({
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Write-Host ok",
      ],
    });
    expect(
      runShellInvocation("printf ok", "linux", { SHELL: "/bin/fish" }),
    ).toEqual({
      command: "/bin/fish",
      args: ["-lc", "printf ok"],
    });
  });
});
