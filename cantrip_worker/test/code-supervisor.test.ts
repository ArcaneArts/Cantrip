import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { verifyCantripCodeInstallation } from "../src/code/installation.js";
import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";
import {
  CodeSupervisor,
  type CodeSupervisorOptions,
} from "../src/code/supervisor.js";

const directories: string[] = [];
const supervisors: CodeSupervisor[] = [];

afterEach(async () => {
  await Promise.all(
    supervisors.splice(0).map((supervisor) => supervisor.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  options: Pick<
    CodeSupervisorOptions,
    | "bridge"
    | "editorIdleTimeoutMs"
    | "idleSweepIntervalMs"
    | "idleTimeoutMs"
    | "profileIdleTimeoutMs"
  > = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-code-supervisor-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "worker-data");
  await Promise.all([
    mkdir(path.join(bundle, "bin"), { recursive: true }),
    mkdir(path.join(bundle, "extensions", "cantrip-workbench"), {
      recursive: true,
    }),
    mkdir(repository),
  ]);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const userDataDir = process.argv[process.argv.indexOf("--user-data-dir") + 1];
fs.writeFileSync(path.join(userDataDir, "launch-args.json"), JSON.stringify(process.argv.slice(2)));
const server = http.createServer((_request, response) => response.end("ready"));
server.listen(port, "127.0.0.1", () => console.log("ready"));
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`;
  const entrypoint = path.join(bundle, "bin", "cantrip-code.cjs");
  await writeFile(entrypoint, source);
  await chmod(entrypoint, 0o755);
  const bytes = Buffer.from(source);
  const workbenchContents = `${JSON.stringify({ name: "cantrip-workbench", version: "0.1.0" })}\n`;
  const workbenchBytes = Buffer.from(workbenchContents);
  await writeFile(
    path.join(bundle, "extensions", "cantrip-workbench", "package.json"),
    workbenchContents,
  );
  await writeFile(
    path.join(bundle, "cantrip-code.manifest.json"),
    JSON.stringify({
      schemaVersion: 3,
      component: "cantrip-code",
      version: "1.109.5-cantrip.1",
      target: `${process.platform}-${process.arch}`,
      platform: process.platform,
      arch: process.arch,
      fingerprint: "a".repeat(64),
      openvscodeServerCommit: "b".repeat(40),
      vscodeCommit: "c".repeat(40),
      patchset: 1,
      cantripWorkbenchVersion: "0.1.0",
      entrypoint: "bin/cantrip-code.cjs",
      files: [
        {
          path: "bin/cantrip-code.cjs",
          type: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: true,
        },
        {
          path: "extensions/cantrip-workbench/package.json",
          type: "file",
          size: workbenchBytes.length,
          sha256: createHash("sha256").update(workbenchBytes).digest("hex"),
          executable: false,
        },
      ],
    }),
  );
  const installation = await verifyCantripCodeInstallation(bundle, {
    full: true,
  });
  const capabilities = {
    available: true as const,
    version: installation.editorBuild.version,
    upstreamRevision: installation.editorBuild.upstreamRevision,
    patchset: installation.editorBuild.patchset,
    transport: "web-proxy" as const,
    maxSessions: 4,
    reason: null,
  };
  const supervisor = new CodeSupervisor({
    capabilities,
    dataDirectory,
    installation,
    readinessTimeoutMs: 3_000,
    ...options,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return {
    capabilities,
    dataDirectory,
    installation,
    repository,
    supervisor,
  };
}

function openCommand(
  sessionId: string,
  repository: string,
  worktreeId: string,
) {
  return {
    type: "code.open" as const,
    sessionId,
    codeTabId: `tab-${sessionId}`,
    projectId: "project-one",
    worktreeId,
    cwd: repository,
    profileId: "default",
    themeMode: "follow-cantrip" as const,
    appearance: "dark" as const,
    presentation: "workbench" as const,
  };
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("Cantrip Code supervisor", () => {
  it("does not block reopening on an unresponsive workbench surface", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 1_000 });
    const { repository, supervisor } = await fixture({ bridge });
    const command = openCommand("stale-workbench", repository, "primary");
    await supervisor.open(command);
    const target = supervisor.proxyTarget(command.sessionId);
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const stale = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);

    await expect(
      Promise.race([
        supervisor.open(command),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Reopening waited on the stale bridge.")),
            250,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ status: "running" });
    stale.close();
  });

  it("serializes concurrent opens for the same durable session", async () => {
    const { repository, supervisor } = await fixture();
    const command = openCommand("shared", repository, "primary");
    const [first, second, third] = await Promise.all([
      supervisor.open(command),
      supervisor.open(command),
      supervisor.open(command),
    ]);

    expect(second.processInstanceId).toBe(first.processInstanceId);
    expect(third.processInstanceId).toBe(first.processInstanceId);
    expect(supervisor.status("shared").status).toBe("running");
  });

  it("retires a stale workspace incarnation when the same session moves", async () => {
    const { repository, supervisor } = await fixture();
    const replacement = path.join(path.dirname(repository), "replacement");
    await mkdir(replacement);
    const command = openCommand("moving", repository, "primary");
    const first = await supervisor.open(command);
    const firstTarget = supervisor.proxyTarget(command.sessionId);
    const firstWorkspace = JSON.parse(
      await readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const staleBridge = await openSocket(
      firstWorkspace.settings["cantrip.bridgeUrl"]!,
    );
    const staleBridgeClosed = new Promise<number>((resolve) => {
      staleBridge.once("close", (code) => resolve(code));
    });

    const moved = await supervisor.open({ ...command, cwd: replacement });
    const movedTarget = supervisor.proxyTarget(command.sessionId);
    const movedWorkspace = JSON.parse(
      await readFile(new URL(movedTarget.workspaceUri), "utf8"),
    ) as { folders: Array<{ path: string }> };
    const canonicalReplacement = await realpath(replacement);

    expect(moved.processInstanceId).toBe(first.processInstanceId);
    expect(movedTarget.workspaceUri).not.toBe(firstTarget.workspaceUri);
    expect(movedWorkspace.folders).toEqual([
      {
        name: path.basename(canonicalReplacement),
        path: canonicalReplacement,
      },
    ]);
    expect(JSON.stringify(movedWorkspace)).not.toContain(repository);
    await expect(
      readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ).rejects.toThrow();
    await expect(staleBridgeClosed).resolves.toBe(1000);
  });

  it("multiplexes more sessions than the legacy advertised limit", async () => {
    const { repository, supervisor } = await fixture();
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        supervisor.open(
          openCommand(`unbounded-${index}`, repository, `tree-${index}`),
        ),
      ),
    );

    expect(
      new Set(sessions.map((session) => session.processInstanceId)),
    ).toEqual(new Set([sessions[0]?.processInstanceId]));

    await Promise.all(
      sessions
        .slice(0, -1)
        .map((session) => supervisor.stop(session.sessionId)),
    );
    expect(supervisor.status("unbounded-7").status).toBe("running");
    expect(supervisor.proxyTarget("unbounded-7").processInstanceId).toBe(
      sessions.at(-1)?.processInstanceId,
    );
  });

  it("treats stopping an already-removed session as success", async () => {
    const { repository, supervisor } = await fixture();
    await supervisor.open(openCommand("disposable", repository, "primary"));
    await supervisor.stop("disposable");

    await expect(supervisor.stop("disposable")).resolves.toMatchObject({
      sessionId: "disposable",
      status: "stopped",
      processInstanceId: null,
    });
  });

  it("keeps an idle profile warm for the next editor attachment", async () => {
    const { repository, supervisor } = await fixture();
    const first = await supervisor.open(
      openCommand("first-editor", repository, "primary"),
    );
    await supervisor.stop("first-editor");

    const second = await supervisor.open(
      openCommand("second-editor", repository, "primary"),
    );
    expect(second.processInstanceId).toBe(first.processInstanceId);
  });

  it("removes every workspace incarnation when the supervisor closes", async () => {
    const { repository, supervisor } = await fixture();
    await Promise.all([
      supervisor.open(openCommand("close-one", repository, "primary")),
      supervisor.open(openCommand("close-two", repository, "feature")),
    ]);
    const workspaceUris = [
      supervisor.proxyTarget("close-one").workspaceUri,
      supervisor.proxyTarget("close-two").workspaceUri,
    ];

    await supervisor.close();

    for (const workspaceUri of workspaceUris) {
      await expect(readFile(new URL(workspaceUri), "utf8")).rejects.toThrow();
    }
  });

  it("evicts a warm profile after its idle timeout", async () => {
    const { repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      profileIdleTimeoutMs: 1_000,
    });
    const first = await supervisor.open(
      openCommand("first-idle-editor", repository, "primary"),
    );
    await supervisor.stop("first-idle-editor");
    await supervisor.evictIdleSessions(Date.now() + 2_000);

    const second = await supervisor.open(
      openCommand("second-idle-editor", repository, "primary"),
    );
    expect(second.processInstanceId).not.toBe(first.processInstanceId);
  });

  it("shares a persistent profile process and always writes the Cantrip theme", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const profileDirectory = path.join(
      dataDirectory,
      "code",
      "profiles",
      createHash("sha256").update("default").digest("hex"),
    );
    const staleExtensionCache = path.join(
      profileDirectory,
      "user-data",
      "CachedProfilesData",
      "__default__profile__",
      "extensions.builtin.cache",
    );
    await mkdir(path.dirname(staleExtensionCache), { recursive: true });
    await writeFile(staleExtensionCache, "stale");
    const first = await supervisor.open({
      ...openCommand("one", repository, "primary"),
      themeMode: "independent",
    });
    const second = await supervisor.open(
      openCommand("two", repository, "feature"),
    );

    expect(first.status).toBe("running");
    expect(second.processInstanceId).toBe(first.processInstanceId);
    const firstTarget = supervisor.proxyTarget("one");
    const secondTarget = supervisor.proxyTarget("two");
    expect(secondTarget.editorOrigin).toBe(firstTarget.editorOrigin);
    expect(secondTarget.workspaceUri).not.toBe(firstTarget.workspaceUri);

    const workspace = JSON.parse(
      await readFile(new URL(firstTarget.workspaceUri), "utf8"),
    ) as {
      folders: Array<{ path: string }>;
      settings: Record<string, unknown>;
    };
    expect(workspace.folders[0]?.path).toBe(await realpath(repository));
    expect(workspace.settings).toMatchObject({
      "cantrip.appearance": "dark",
      "cantrip.sessionId": "one",
      "cantrip.worktreeId": "primary",
      "security.workspace.trust.enabled": false,
      "window.title": "Command Palette",
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.colorTheme": "Cantrip Dark",
    });
    await expect(readFile(staleExtensionCache, "utf8")).rejects.toThrow();
    await expect(
      readFile(path.join(profileDirectory, ".cantrip-code-build"), "utf8"),
    ).resolves.toBe(`${"a".repeat(64)}\n`);
    const launchArguments = JSON.parse(
      await readFile(
        path.join(profileDirectory, "user-data", "launch-args.json"),
        "utf8",
      ),
    ) as string[];
    expect(launchArguments).toContain("--disable-workspace-trust");
    expect(launchArguments).not.toContain("--disable-extension");
    expect(firstTarget.workspaceUri).toContain(
      path.basename(path.join(dataDirectory, "code")),
    );

    await supervisor.stop("one");
    expect(supervisor.status("two").status).toBe("running");
    await supervisor.stop("two");

    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain(firstTarget.connectionToken);
    expect(state).not.toContain("cantrip.bridgeToken");
  });

  it("reconfigures a compatibility workbench as editor-only and opens a safe relative file", async () => {
    const { repository, supervisor } = await fixture();
    const canonicalRepository = await realpath(repository);
    await writeFile(path.join(repository, "example.ts"), "export {};\n");
    await writeFile(path.join(repository, "second.ts"), "export {};\n");
    await supervisor.open({
      ...openCommand("editor", repository, "primary"),
      initialFile: "example.ts",
      presentation: "workbench",
    });
    const target = supervisor.proxyTarget("editor");
    let workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).toMatchObject({
      "cantrip.presentation": "workbench",
    });
    expect(workspace.settings).not.toHaveProperty("cantrip.initialFile");

    const socket = await openSocket(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
        params: { expectedWorkspaceRootUri?: string; path?: string };
      };
      if (request.method === "openFile") {
        expect(request.params).toEqual({
          expectedWorkspaceRootUri: pathToFileURL(canonicalRepository).href,
          path: "second.ts",
        });
      }
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result:
            request.method === "openFile"
              ? { relativePath: request.params.path }
              : { applied: true },
        }),
      );
    });

    await supervisor.setPresentation("editor", "editor");
    workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).toMatchObject({
      "breadcrumbs.enabled": true,
      "cantrip.presentation": "editor",
      "window.commandCenter": false,
      "workbench.activityBar.location": "hidden",
      "workbench.editor.editorActionsLocation": "hidden",
      "workbench.editor.empty.hint": "hidden",
      "workbench.editor.showTabs": "none",
      "workbench.layoutControl.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.statusBar.visible": true,
    });
    expect(workspace.settings).not.toHaveProperty("window.menuBarVisibility");

    await expect(supervisor.openFile("editor", "second.ts")).resolves.toEqual({
      relativePath: "second.ts",
    });
    workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, unknown> };
    expect(workspace.settings).not.toHaveProperty("cantrip.initialFile");
    await expect(
      supervisor.openFile("editor", "../outside.ts"),
    ).rejects.toThrow("safe worktree-relative file path");
    socket.close();
  });

  it("binds workspace navigation to the canonical worktree root", async () => {
    const { repository, supervisor } = await fixture();
    const repositoryAlias = path.join(
      path.dirname(repository),
      "repository-alias",
    );
    await symlink(repository, repositoryAlias, "dir");
    await writeFile(path.join(repository, "canonical.ts"), "export {};\n");
    await supervisor.open(
      openCommand("canonical-root", repositoryAlias, "primary"),
    );

    const target = supervisor.proxyTarget("canonical-root");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as {
      folders: Array<{ name: string; path: string }>;
      settings: Record<string, unknown>;
    };
    const canonicalRoot = await realpath(repository);
    expect(workspace.folders).toEqual([
      { name: path.basename(canonicalRoot), path: canonicalRoot },
    ]);
    const socket = await openSocket(
      workspace.settings["cantrip.bridgeUrl"] as string,
    );
    const openRequest = new Promise<Record<string, unknown>>((resolve) => {
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        if (request.method === "openFile") resolve(request.params);
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result:
              request.method === "openFile"
                ? { relativePath: request.params.path }
                : { applied: true },
          }),
        );
      });
    });

    await expect(
      supervisor.openFile("canonical-root", "canonical.ts"),
    ).resolves.toEqual({ relativePath: "canonical.ts" });
    await expect(openRequest).resolves.toEqual({
      expectedWorkspaceRootUri: pathToFileURL(canonicalRoot).href,
      path: "canonical.ts",
    });
    socket.close();
  });

  it("rejects missing files and symlinks outside the authorized worktree", async () => {
    const { repository, supervisor } = await fixture();
    const outside = path.join(path.dirname(repository), "outside.ts");
    await writeFile(outside, "private\n");
    await symlink(outside, path.join(repository, "outside-link.ts"));

    await expect(
      supervisor.open({
        ...openCommand("missing-file", repository, "primary"),
        initialFile: "missing.ts",
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      supervisor.open({
        ...openCommand("escaping-link", repository, "primary"),
        initialFile: "outside-link.ts",
      }),
    ).rejects.toThrow("outside the authorized worktree");
  });

  it("prepares dirty editors and reports bounded agent file changes", async () => {
    const { repository, supervisor } = await fixture();
    await supervisor.open(openCommand("safe-turn", repository, "primary"));
    const target = supervisor.proxyTarget("safe-turn");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const socket = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
        params: { paths?: string[] };
      };
      if (request.method === "prepareAgentTurn") {
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result: {
              allowed: true,
              policy: "always",
              dirtyEditors: [],
              saved: ["file:///repository/src/index.ts"],
              failed: [],
              reason: null,
            },
          }),
        );
      } else if (request.method === "agentTurnState") {
        expect(request.params.paths).toEqual(["src/index.ts"]);
        socket.send(
          JSON.stringify({
            type: "response",
            id: request.id,
            ok: true,
            result: { refreshed: ["src/index.ts"], conflicts: [] },
          }),
        );
      }
    });

    await expect(
      supervisor.prepareAgentTurn(repository),
    ).resolves.toMatchObject({
      prepared: true,
      sessions: [{ sessionId: "safe-turn", allowed: true }],
    });
    await expect(
      supervisor.agentTurnState(repository, "completed", [
        "src/index.ts",
        "../outside.ts",
      ]),
    ).resolves.toEqual({
      notifiedSessions: 1,
      refreshed: ["src/index.ts"],
      conflicts: [],
    });
    socket.close();
  });

  it("restores compatible session identity and eagerly prewarms its profile", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    await writeFile(path.join(repository, "restored.ts"), "export {};\n");
    const command = {
      ...openCommand("restored", repository, "primary"),
      initialFile: "restored.ts",
    };
    const first = await supervisor.open(command);
    await supervisor.close();
    const stateFile = path.join(dataDirectory, "code", "state", "runtime.json");
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(persisted.sessions[0]?.initialFile).toBe("restored.ts");
    persisted.sessions.push({
      ...persisted.sessions[0],
      codeTabId: "tab-orphaned-editor",
      presentation: "editor",
      sessionId: "orphaned-editor",
    });
    await writeFile(stateFile, `${JSON.stringify(persisted, null, 2)}\n`);

    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);
    await restored.start();
    expect(restored.status("restored")).toMatchObject({
      status: "running",
    });
    expect(restored.proxyTarget("restored").workspaceUri).toBe(
      first.workspaceUri,
    );
    const restoredWorkspace = JSON.parse(
      await readFile(
        new URL(restored.proxyTarget("restored").workspaceUri),
        "utf8",
      ),
    ) as { settings: Record<string, unknown> };
    expect(restoredWorkspace.settings).not.toHaveProperty(
      "cantrip.initialFile",
    );
    expect(() => restored.status("orphaned-editor")).toThrow("is not open");
    const reopened = await restored.open(command);
    expect(reopened.status).toBe("running");
    expect(reopened.processInstanceId).not.toBe(first.processInstanceId);
    expect(reopened.processInstanceId).toBe(
      restored.status("restored").processInstanceId,
    );
  });

  it("does not persist temporary editor-only sessions", async () => {
    const {
      capabilities,
      dataDirectory,
      installation,
      repository,
      supervisor,
    } = await fixture();
    await supervisor.open({
      ...openCommand("temporary-editor", repository, "primary"),
      presentation: "editor",
    });
    await supervisor.close();

    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain("temporary-editor");

    const restored = new CodeSupervisor({
      capabilities,
      dataDirectory,
      installation,
      readinessTimeoutMs: 3_000,
    });
    supervisors.push(restored);
    await restored.start();
    expect(() => restored.status("temporary-editor")).toThrow("is not open");
  });

  it("makes compatibility sessions ephemeral before bridge acknowledgement", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 50 });
    const { dataDirectory, repository, supervisor } = await fixture({ bridge });
    await supervisor.open(
      openCommand("compatibility-editor", repository, "primary"),
    );
    const target = supervisor.proxyTarget("compatibility-editor");
    const workspace = JSON.parse(
      await readFile(new URL(target.workspaceUri), "utf8"),
    ) as { settings: Record<string, string> };
    const socket = await openSocket(workspace.settings["cantrip.bridgeUrl"]!);

    await expect(
      supervisor.setPresentation("compatibility-editor", "editor"),
    ).rejects.toThrow("timed out");
    const state = await readFile(
      path.join(dataDirectory, "code", "state", "runtime.json"),
      "utf8",
    );
    expect(state).not.toContain("compatibility-editor");
    socket.close();
  });

  it("evicts detached editor-only sessions sooner than durable workbenches", async () => {
    const { repository, supervisor } = await fixture({
      editorIdleTimeoutMs: 1_000,
      idleSweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    await supervisor.open(openCommand("durable", repository, "primary"));
    await supervisor.open({
      ...openCommand("temporary", repository, "primary"),
      presentation: "editor",
    });

    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual(["temporary"]);
    expect(supervisor.status("durable").status).toBe("running");
  });

  it("evicts unattached idle sessions but preserves active tunnel streams", async () => {
    const { repository, supervisor } = await fixture({
      idleSweepIntervalMs: 60_000,
      idleTimeoutMs: 1_000,
    });
    await supervisor.open(openCommand("idle", repository, "primary"));
    supervisor.beginTunnelStream("idle", "attachment\0stream");
    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual([]);
    supervisor.endTunnelStream("idle", "attachment\0stream");
    await expect(
      supervisor.evictIdleSessions(Date.now() + 2_000),
    ).resolves.toEqual(["idle"]);
    expect(() => supervisor.status("idle")).toThrow("is not open");
  });
});
