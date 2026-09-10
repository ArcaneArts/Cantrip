import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TerminalManager,
  type TerminalLaunch,
} from "../src/terminal-manager.js";

const roots: string[] = [];
const managers: TerminalManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(ignoreHangup = false) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-cli-retarget-"));
  roots.push(root);
  const binary = path.join(root, "synthetic-cli");
  const source = `#!${process.execPath}
${ignoreHangup ? "process.on('SIGHUP', () => {});" : ""}
console.log('ATTACHED:' + process.env.CANTRIP_CODEX_ATTACH_THREAD_ID);
process.stdin.on('data', data => console.log('INPUT:' + data.toString().trim()));
setInterval(() => {}, 1000);
`;
  await writeFile(binary, source);
  await chmod(binary, 0o700);
  const manager = new TerminalManager();
  managers.push(manager);
  const launch: Extract<TerminalLaunch, { type: "codex" }> = {
    type: "codex",
    binary,
    codexHome: root,
    remoteUrl: "ws://127.0.0.1:1/managed/old",
    threadId: "old",
    model: { id: "model", name: "synthetic", reasoningEffort: null },
    provider: {
      id: "provider",
      name: "Provider",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: null,
    },
    session: {
      chatId: "chat",
      contextKind: "project",
      projectId: "project",
      worktreeId: "worktree",
      rootKind: "git-worktree",
      scratchRootId: null,
      computerUseEnabled: false,
    },
  };
  const output: string[] = [];
  const open = manager.open(
    "terminal",
    "first",
    root,
    111,
    37,
    launch,
    (event) => {
      if (event.type === "terminal.output") output.push(event.data);
    },
  );
  let settled = false;
  void open.finally(() => {
    settled = true;
  });
  await expect
    .poll(() => output.join(""), { timeout: 5000 })
    .toContain("ATTACHED:old");
  return {
    root,
    binary,
    source,
    manager,
    launch,
    output,
    open,
    settled: () => settled,
  };
}

// Actual child exit/spawn. Pinned native protocol and authorized turn acceptance
// are separately exercised in native-managed-command-session.test.ts.
describe.skipIf(process.platform === "win32")(
  "managed CLI surface replacement",
  () => {
    it("keeps two views, dimensions, input routing and canonical replay through reattachment", async () => {
      const f = await fixture();
      const output: string[] = [];
      const second = f.manager.attachExisting("terminal", "second", (event) => {
        if (event.type === "terminal.output") output.push(event.data);
      });
      await f.manager.retargetManagedCodex("other-chat", {
        threadId: "foreign",
        remoteUrl: "ws://127.0.0.1:2/foreign",
      });
      expect(f.output.join("")).not.toContain("ATTACHED:foreign");
      const target = {
        threadId: "new",
        remoteUrl: "ws://127.0.0.1:2/managed/new",
      };
      await Promise.all([
        f.manager.retargetManagedCodex("chat", target),
        f.manager.retargetManagedCodex("chat", target),
      ]);
      await expect.poll(() => output.join("")).toContain("ATTACHED:new");
      expect(f.settled()).toBe(false);
      expect(f.output.join("").match(/ATTACHED:new/g)).toHaveLength(1);
      expect(f.output.join("")).toContain("\x1b[?1049l\x1bc");
      f.manager.input("terminal", "NEW_INPUT\r");
      await expect.poll(() => f.output.join("")).toContain("INPUT:NEW_INPUT");
      const snapshot = await f.manager.canonicalSnapshot("terminal");
      expect(snapshot).toMatchObject({ cols: 111, rows: 37 });
      expect(snapshot?.data).toContain("ATTACHED:new");
      expect(snapshot?.data).not.toContain("ATTACHED:old");
      f.manager.detach("terminal", "second");
      await expect(second).resolves.toEqual({ status: "detached" });
      f.manager.close("terminal");
      await expect(f.open).resolves.toMatchObject({ status: "exited" });
    });

    it("coalesces replacements while the old child ignores hangup and rejects unforwarded input", async () => {
      const f = await fixture(true);
      const first = f.manager.retargetManagedCodex("chat", {
        threadId: "intermediate",
        remoteUrl: "ws://127.0.0.1:2/intermediate",
      });
      expect(() => f.manager.input("terminal", "must-not-dispatch\r")).toThrow(
        "input was not sent",
      );
      const latest = f.manager.retargetManagedCodex("chat", {
        threadId: "latest",
        remoteUrl: "ws://127.0.0.1:3/latest",
      });
      await Promise.all([first, latest]);
      await expect.poll(() => f.output.join("")).toContain("ATTACHED:latest");
      expect(f.output.join("")).not.toContain("ATTACHED:intermediate");
      expect(f.output.join("")).not.toContain("must-not-dispatch");
      expect(f.settled()).toBe(false);
      f.manager.input("terminal", "\x03");
      await f.open;
    }, 10000);

    it("a newly routed view retargets the existing surface instead of attaching its stale CLI", async () => {
      const f = await fixture();
      const output: string[] = [];
      const incoming = f.manager.open(
        "terminal",
        "new-view",
        f.root,
        100,
        30,
        {
          ...f.launch,
          threadId: "new",
          remoteUrl: "ws://127.0.0.1:2/new",
        },
        (event) => {
          if (event.type === "terminal.output") output.push(event.data);
        },
      );
      await expect.poll(() => output.join("")).toContain("ATTACHED:new");
      expect(f.output.join("")).toContain("ATTACHED:new");
      expect(f.settled()).toBe(false);
      expect(() =>
        f.manager.open(
          "terminal",
          "foreign",
          f.root,
          100,
          30,
          {
            ...f.launch,
            session: { ...f.launch.session!, chatId: "foreign" },
          },
          () => {},
        ),
      ).toThrow("different managed chat");
      f.manager.close("terminal");
      await Promise.all([incoming, f.open]);
    });

    it("closing the presentation during handoff does not spawn the replacement", async () => {
      const f = await fixture();
      const retarget = f.manager.retargetManagedCodex("chat", {
        threadId: "new",
        remoteUrl: "ws://127.0.0.1:2/new",
      });
      const rejected = expect(retarget).rejects.toThrow("reattachment failed");
      f.manager.close("terminal");
      await rejected;
      await f.open;
      expect(f.output.join("")).not.toContain("ATTACHED:new");
      expect(f.manager.hasLiveSession("terminal")).toBe(false);
    });

    it("an awaiting view follows a superseding handoff without restoring its older launch", async () => {
      const f = await fixture(true);
      const output: string[] = [];
      const incoming = f.manager.open(
        "terminal",
        "awaiting-view",
        f.root,
        100,
        30,
        {
          ...f.launch,
          threadId: "intermediate",
          remoteUrl: "ws://127.0.0.1:2/intermediate",
        },
        (event) => {
          if (event.type === "terminal.output") output.push(event.data);
        },
      );
      await f.manager.retargetManagedCodex("chat", {
        threadId: "latest",
        remoteUrl: "ws://127.0.0.1:3/latest",
      });
      await expect.poll(() => output.join("")).toContain("ATTACHED:latest");
      f.manager.input("terminal", "LATEST_INPUT\r");
      await expect.poll(() => output.join("")).toContain("INPUT:LATEST_INPUT");
      expect(f.output.join("")).not.toContain("ATTACHED:intermediate");
      f.manager.input("terminal", "\x03");
      await Promise.all([incoming, f.open]);
    }, 10000);

    it("reports actual respawn failure and allows reopening on the replacement", async () => {
      const f = await fixture();
      await rm(f.binary);
      const target = { threadId: "new", remoteUrl: "ws://127.0.0.1:2/new" };
      // node-pty reports this exec failure through onExit after spawning.
      await f.manager.retargetManagedCodex("chat", target);
      const failed = await f.open;
      expect(failed).toMatchObject({ status: "exited" });
      expect(failed.status === "exited" && failed.exitCode).not.toBe(0);
      expect(f.output.join("")).toContain("Reopen the CLI to retry");
      await writeFile(f.binary, f.source);
      await chmod(f.binary, 0o700);
      const output: string[] = [];
      const reopened = f.manager.open(
        "terminal",
        "reopened",
        f.root,
        111,
        37,
        { ...f.launch, ...target },
        (event) => {
          if (event.type === "terminal.output") output.push(event.data);
        },
      );
      await expect.poll(() => output.join("")).toContain("ATTACHED:new");
      f.manager.close("terminal");
      await reopened;
    });
  },
);
