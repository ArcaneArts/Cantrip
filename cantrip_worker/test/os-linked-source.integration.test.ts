import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  executorControl,
  workspaceControl,
  OsExecutorConnection,
  type OsExecutorBinding,
} from "../src/os-executor/connection.js";
import { installLinkedSource } from "../src/os-executor/linked.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { runGuestProcess } from "../src/os-executor/process.js";

const container = process.env.CANTRIP_OS_TEST_LINKED_CONTAINER;
const execute = promisify(execFile);

// This intentionally recreates only the explicitly supplied disposable OS.
// Retain the fixture because the live source mount still refers to its path.
describe.skipIf(!container)("real Docker linked worktree", () => {
  it("shares actual worktree bytes and notifications while preserving host Git and dependencies", async () => {
    const transport = { kind: "docker" as const, container: container! };
    const workspace = `linked-${randomUUID().slice(0, 12)}`;
    await workspaceControl(transport, ["create", workspace]);
    const expected = await executorControl<OsExecutorBinding>(transport, [
      "open",
      workspace,
    ]);
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "cantrip-linked-source-")),
    );
    const repository = path.join(root, "repository"),
      worktree = path.join(root, "worktree");
    await mkdir(repository);
    const git = (cwd: string, ...args: string[]) =>
      execute("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
    await git(repository, "init", "-q");
    await writeFile(path.join(repository, "README.md"), "host-original\n");
    await writeFile(
      path.join(repository, ".gitignore"),
      "node_modules/\n.venv/\nignored.txt\n",
    );
    await git(repository, "add", ".");
    await git(
      repository,
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
    await git(repository, "worktree", "add", "-qb", "linked", worktree);
    await writeFile(
      path.join(worktree, "ignored.txt"),
      "ignored files remain shared\n",
    );
    await writeFile(
      path.join(worktree, "run.sh"),
      "#!/bin/sh\necho executable-ok\n",
    );
    await chmod(path.join(worktree, "run.sh"), 0o755);
    await symlink("README.md", path.join(worktree, "readme-link"));
    for (const cache of ["node_modules", ".venv"]) {
      await mkdir(path.join(worktree, cache));
      await writeFile(path.join(worktree, cache, "platform"), "host-platform");
    }
    const gitBefore = await readFile(path.join(worktree, ".git"));
    const ownership = await stat(worktree);
    const id = randomUUID(),
      operationId = randomUUID();
    const mount = {
      id,
      cacheKey: `fixture:${workspace}:${id}`,
      workerPath: worktree,
      guestPath: `/workspace/${id}`,
      dependencyOverlays: [{ path: "node_modules" }, { path: ".venv" }],
    };
    const input = {
      container: container!,
      expected,
      mount,
      operationId,
      journalPath: path.join(root, "mount-operation.json"),
    };
    const receipt = await installLinkedSource(input);
    expect(receipt.recreated).toBe(true);
    await expect(
      installLinkedSource({
        ...input,
        expected: { ...expected, generation: receipt.runtimeGeneration },
      }),
    ).rejects.toThrow(/exist/i);
    const binding = await executorControl<OsExecutorBinding>(transport, [
      "open",
      workspace,
    ]);
    const connection = new OsExecutorConnection(transport, binding);
    await connection.request("initialize", {
      clientName: "cantrip-linked-source-acceptance",
      resumeSessionId: null,
    });
    connection.notify("initialized");
    const guestRead = async (file: string) =>
      Buffer.from(
        (
          await connection.request<{ dataBase64: string }>("fs/readFile", {
            path: guestFileUri(`${mount.guestPath}/${file}`),
            sandbox: null,
          })
        ).dataBase64,
        "base64",
      ).toString();
    const guestWrite = async (file: string, data: string) =>
      connection.request("fs/writeFile", {
        path: guestFileUri(`${mount.guestPath}/${file}`),
        dataBase64: Buffer.from(data).toString("base64"),
        sandbox: null,
      });
    try {
      expect(await guestRead("README.md")).toBe("host-original\n");
      expect(await guestRead("ignored.txt")).toBe(
        "ignored files remain shared\n",
      );
      await guestWrite("README.md", "guest-written\n");
      expect(await readFile(path.join(worktree, "README.md"), "utf8")).toBe(
        "guest-written\n",
      );
      const literal = "guest # % ? literal%2F 日本語.txt";
      await guestWrite(literal, "literal Linux bytes");
      expect(await readFile(path.join(worktree, literal), "utf8")).toBe(
        "literal Linux bytes",
      );
      await writeFile(path.join(worktree, "host-write.txt"), "host-written\n");
      expect(await guestRead("host-write.txt")).toBe("host-written\n");
      for (const cache of ["node_modules", ".venv"]) {
        await expect(guestRead(`${cache}/platform`)).rejects.toThrow();
        await guestWrite(`${cache}/platform`, "linux-platform");
        expect(
          await readFile(path.join(worktree, cache, "platform"), "utf8"),
        ).toBe("host-platform");
      }
      const executable = await runGuestProcess(
        connection,
        ["./run.sh"],
        mount.guestPath,
      );
      expect(executable.stdout.trim()).toBe("executable-ok");
      expect(await guestRead("readme-link")).toBe("guest-written\n");
      expect(await readlink(path.join(worktree, "readme-link"))).toBe(
        "README.md",
      );
      expect((await stat(worktree)).uid).toBe(ownership.uid);
      expect(await readFile(path.join(worktree, ".git"))).toEqual(gitBefore);
      expect(
        (await git(worktree, "rev-parse", "--show-toplevel")).stdout.trim(),
      ).toBe(worktree);
      expect(
        (
          await runGuestProcess(
            connection,
            ["git", "rev-parse", "HEAD"],
            mount.guestPath,
          )
        ).exitCode,
      ).not.toBe(0);
      const watched = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          watcher.close();
          reject(new Error("Host did not observe guest write"));
        }, 10_000);
        const watcher = watch(worktree, (_event, name) => {
          if (name?.toString() === "watch-guest.txt") {
            clearTimeout(timer);
            watcher.close();
            resolve();
          }
        });
        watcher.on("error", (error) => {
          clearTimeout(timer);
          watcher.close();
          reject(error);
        });
      });
      await guestWrite("watch-guest.txt", "notify host");
      await watched;
      const linuxWatch = runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          [
            "import ctypes,os,sys,time",
            "libc=ctypes.CDLL(None,use_errno=True);fd=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)",
            "assert fd>=0;assert libc.inotify_add_watch(fd,os.fsencode(sys.argv[1]),0x100|0x2)>=0",
            "open(sys.argv[1]+'/watch-ready','w').write('ready')",
            "deadline=time.monotonic()+10",
            "while time.monotonic()<deadline:",
            " try:",
            "  if b'watch-host.txt' in os.read(fd,65536): print('linux-notified');sys.exit(0)",
            " except BlockingIOError: pass",
            " time.sleep(.02)",
            "sys.exit(3)",
          ].join("\n"),
          mount.guestPath,
        ],
        binding.home,
      );
      const readyDeadline = Date.now() + 10_000;
      while (true) {
        try {
          await readFile(path.join(worktree, "watch-ready"));
          break;
        } catch {
          if (Date.now() >= readyDeadline)
            throw new Error("Linux watcher did not start");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await writeFile(path.join(worktree, "watch-host.txt"), "notify Linux");
      expect((await linuxWatch).stdout.trim()).toBe("linux-notified");
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase3-sources/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(`linked-source-${id}.json`, artifacts),
        JSON.stringify(
          {
            root,
            worktree,
            mount,
            binding,
            receipt,
            preservedHostUid: ownership.uid,
            bidirectionalNotifications: true,
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
