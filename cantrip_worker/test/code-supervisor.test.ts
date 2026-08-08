import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyCantripCodeInstallation } from "../src/code/installation.js";
import { CodeSupervisor } from "../src/code/supervisor.js";

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

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-code-supervisor-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const repository = path.join(root, "repository");
  const dataDirectory = path.join(root, "worker-data");
  await Promise.all([
    mkdir(path.join(bundle, "bin"), { recursive: true }),
    mkdir(repository),
  ]);
  const source = `#!/usr/bin/env node
const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
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
  await writeFile(
    path.join(bundle, "cantrip-code.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      component: "cantrip-code",
      version: "1.109.5-cantrip.1",
      target: `${process.platform}-${process.arch}`,
      platform: process.platform,
      arch: process.arch,
      fingerprint: "a".repeat(64),
      openvscodeServerCommit: "b".repeat(40),
      vscodeCommit: "c".repeat(40),
      patchset: 1,
      entrypoint: "bin/cantrip-code.cjs",
      files: [
        {
          path: "bin/cantrip-code.cjs",
          type: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          executable: true,
        },
      ],
    }),
  );
  const installation = await verifyCantripCodeInstallation(bundle, {
    full: true,
  });
  const supervisor = new CodeSupervisor({
    capabilities: {
      available: true,
      version: installation.editorBuild.version,
      upstreamRevision: installation.editorBuild.upstreamRevision,
      patchset: installation.editorBuild.patchset,
      transport: "web-proxy",
      maxSessions: 4,
      reason: null,
    },
    dataDirectory,
    installation,
    readinessTimeoutMs: 3_000,
  });
  supervisors.push(supervisor);
  await supervisor.start();
  return { dataDirectory, repository, supervisor };
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
  };
}

describe("Cantrip Code supervisor", () => {
  it("shares a persistent profile process while isolating tab workspaces", async () => {
    const { dataDirectory, repository, supervisor } = await fixture();
    const first = await supervisor.open(
      openCommand("one", repository, "primary"),
    );
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
    expect(workspace.folders[0]?.path).toBe(repository);
    expect(workspace.settings).toMatchObject({
      "cantrip.sessionId": "one",
      "cantrip.worktreeId": "primary",
      "workbench.colorTheme": "Default Dark Modern",
    });
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
});
