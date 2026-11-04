import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  provisionLinuxSource,
  createLinuxWorktree,
  inspectLinuxSource,
} from "../src/os-executor/checkouts.js";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { runGuestProcess } from "../src/os-executor/process.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
const execute = promisify(execFile);

// Opt-in, disposable OS only. Each run gets a distinct workspace/source so
// fixture data remains available for reboot/persistence inspection.
describe.skipIf(!enabled)("real Linux-owned source provisioning", () => {
  it("clones the admitted commit, manages Linux worktrees/folders and never repeats an operation", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? (JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        ) as OsExecutorTransport)
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const owner = "00000000-0000-4000-8000-000000000001",
      worker = "00000000-0000-4000-8000-000000000002";
    const status = await executorControl<{
      attachment: { owner_id: string; worker_id: string } | null;
    }>(transport, ["status"]);
    if (!status.attachment)
      await executorControl(transport, ["attach", owner, worker]);
    else
      expect(status.attachment).toEqual({ owner_id: owner, worker_id: worker });
    const workspace = `source-${randomUUID().slice(0, 12)}`;
    await workspaceControl(transport, ["create", workspace]);
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      workspace,
    ]);
    const connection = new OsExecutorConnection(transport, binding);
    const initialized = await connection.request<{ sessionId: string }>(
      "initialize",
      { clientName: "cantrip-source-acceptance", resumeSessionId: null },
    );
    connection.notify("initialized");
    const fixture = await mkdtemp(path.join(tmpdir(), "cantrip-linux-source-"));
    const git = (...args: string[]) =>
      execute("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    const sourceId = randomUUID(),
      operationId = randomUUID();
    const processes: Array<{ processId: string; argv: string[] }> = [];
    try {
      await git("init", "-q");
      await writeFile(path.join(fixture, "README.md"), "source-original\n");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Cantrip Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
      );
      const revision = (await git("rev-parse", "HEAD")).stdout.trim();
      const bundle = path.join(fixture, "source.bundle");
      await git("bundle", "create", bundle, "HEAD");
      const guestBundle = `${binding.home}/Documents/${sourceId}.bundle`;
      await connection.request("fs/writeFile", {
        path: guestFileUri(guestBundle),
        dataBase64: (await readFile(bundle)).toString("base64"),
        sandbox: null,
      });
      const plan = {
        sourceId,
        operationId,
        sourceKind: "git" as const,
        guestPath: `${binding.home}/checkouts/${sourceId}`,
        repositoryUrl: guestBundle,
        revision,
      };
      const prepared = async (processId: string, argv: string[]) => {
        processes.push({ processId, argv });
      };
      const source = await provisionLinuxSource(connection, plan, { prepared });
      expect(source.head).toBe(revision);
      expect(source.detached).toBe(true);
      expect(
        await inspectLinuxSource(connection, {
          sourceId,
          guestPath: source.guestPath,
          sourceKind: "git",
        }),
      ).toEqual(source);
      const completedProcesses = processes.length;
      await expect(
        provisionLinuxSource(connection, plan, { prepared }),
      ).rejects.toThrow();
      expect(processes).toHaveLength(completedProcesses);
      const worktreeId = randomUUID();
      const worktree = await createLinuxWorktree(
        connection,
        {
          sourceId,
          sourceGuestPath: source.guestPath,
          worktreeId,
          guestPath: `${binding.home}/worktrees/${worktreeId}`,
          revision,
          branch: `acceptance-${worktreeId}`,
        },
        { prepared },
      );
      expect(worktree.repositoryFingerprint).toBe(source.repositoryFingerprint);
      expect(worktree.branch).toBe(`acceptance-${worktreeId}`);
      const literal = "source # % ? literal%2F 日本語.txt";
      await connection.request("fs/writeFile", {
        path: guestFileUri(`${worktree.guestPath}/${literal}`),
        dataBase64: Buffer.from("Linux-owned bytes").toString("base64"),
        sandbox: null,
      });
      const commit = await runGuestProcess(
        connection,
        [
          "/bin/bash",
          "-c",
          "git add . && git -c user.name='Cantrip Fixture' -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -qm 'Linux-owned edit' && git status --porcelain && git rev-parse HEAD",
        ],
        worktree.guestPath,
      );
      expect(commit.exitCode).toBe(0);
      expect(commit.stdout.trim()).not.toBe(revision);
      const actual = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          "from pathlib import Path;import sys;print(Path(sys.argv[1]).read_text());print(Path(sys.argv[1]).name)",
          literal,
        ],
        worktree.guestPath,
      );
      expect(actual.stdout.trim().split("\n")).toEqual([
        "Linux-owned bytes",
        literal,
      ]);
      const large = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          "import sys;sys.stdout.write('日本語'*40000);sys.stderr.write('stderr-ok')",
        ],
        binding.home,
      );
      expect(large.stdout).toBe("日本語".repeat(40000));
      expect(large.stderr).toBe("stderr-ok");
      expect(large.outputTruncated).toBe(false);
      const identity = await runGuestProcess(
        connection,
        [
          "/bin/bash",
          "-c",
          'id -u; pwd; sudo -n id -u; test -z "${DISPLAY:-}"',
        ],
        binding.home,
      );
      expect(identity.exitCode).toBe(0);
      expect(identity.stdout.trim()).toBe(`${binding.uid}\n${binding.home}\n0`);
      const folderId = randomUUID();
      const folder = await provisionLinuxSource(
        connection,
        {
          sourceId: folderId,
          operationId: randomUUID(),
          sourceKind: "folder",
          guestPath: `${binding.home}/checkouts/${folderId}`,
          repositoryUrl: null,
          revision: null,
        },
        { prepared },
      );
      expect(folder.gitCommonGuestPath).toBeNull();
      expect(
        await inspectLinuxSource(connection, {
          sourceId: folderId,
          guestPath: folder.guestPath,
          sourceKind: "folder",
        }),
      ).toEqual(folder);
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase3-sources/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(`linux-source-${transport.kind}-${sourceId}.json`, artifacts),
        JSON.stringify(
          {
            binding,
            sessionId: initialized.sessionId,
            source,
            worktree,
            folder,
            identity,
            commit,
            processes,
            largeOutputBytes: Buffer.byteLength(large.stdout),
          },
          null,
          2,
        ),
      );
    } finally {
      await connection.close();
      await executorControl(transport, ["close", workspace]);
    }
  }, 180_000);
});
