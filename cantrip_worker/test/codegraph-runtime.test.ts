import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { validateCodeGraphArchivePath } from "../src/codegraph/archive.js";
import {
  CodeGraphRuntimeManager,
  codeGraphTargetFor,
} from "../src/codegraph/runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

interface FakeRelease {
  archive: Buffer;
  assetName: string;
  checksums: Buffer;
  release: Record<string, unknown>;
}

async function fakeRelease(version: string): Promise<FakeRelease> {
  const target = codeGraphTargetFor(process.platform, process.arch);
  if (target.archiveKind !== "tar.gz") {
    throw new Error(
      "The portable fake CodeGraph bundle requires a POSIX test host.",
    );
  }
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-codegraph-bundle-"));
  directories.push(root);
  const folder = `codegraph-${target.target}`;
  const bin = path.join(root, folder, "bin");
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, "codegraph");
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "telemetry" ] && [ "$2" = "off" ]; then exit 0; fi\necho "fake codegraph $*"\n`,
  );
  await chmod(executable, 0o755);
  const archivePath = path.join(root, target.assetName);
  await tar.c({ cwd: root, file: archivePath, gzip: true }, [folder]);
  const archive = await readFile(archivePath);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const checksums = Buffer.from(`${archiveDigest}  ${target.assetName}\n`);
  const checksumDigest = createHash("sha256").update(checksums).digest("hex");
  const releaseBase = `https://github.com/colbymchenry/codegraph/releases/download/v${version}`;
  return {
    archive,
    assetName: target.assetName,
    checksums,
    release: {
      tag_name: `v${version}`,
      draft: false,
      prerelease: false,
      assets: [
        {
          name: target.assetName,
          size: archive.length,
          digest: `sha256:${archiveDigest}`,
          browser_download_url: `${releaseBase}/${target.assetName}`,
        },
        {
          name: "SHA256SUMS",
          size: checksums.length,
          digest: `sha256:${checksumDigest}`,
          browser_download_url: `${releaseBase}/SHA256SUMS`,
        },
      ],
    },
  };
}

function releaseFetch(current: () => FakeRelease): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const release = current();
    if (url.includes("/repos/colbymchenry/codegraph/releases/latest")) {
      return new Response(JSON.stringify(release.release), {
        headers: { "content-type": "application/json", etag: '"fake-release"' },
      });
    }
    if (url.endsWith(`/${release.assetName}`)) {
      return new Response(release.archive);
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(release.checksums);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function run(
  command: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

describe("CodeGraph runtime targets", () => {
  it("maps every supported platform and architecture to its upstream asset", () => {
    expect(codeGraphTargetFor("darwin", "arm64")).toMatchObject({
      assetName: "codegraph-darwin-arm64.tar.gz",
      archiveKind: "tar.gz",
    });
    expect(codeGraphTargetFor("darwin", "x64").assetName).toBe(
      "codegraph-darwin-x64.tar.gz",
    );
    expect(codeGraphTargetFor("linux", "arm64").assetName).toBe(
      "codegraph-linux-arm64.tar.gz",
    );
    expect(codeGraphTargetFor("linux", "x64").assetName).toBe(
      "codegraph-linux-x64.tar.gz",
    );
    expect(codeGraphTargetFor("win32", "arm64")).toMatchObject({
      assetName: "codegraph-win32-arm64.zip",
      archiveKind: "zip",
      executableName: "codegraph.exe",
    });
    expect(codeGraphTargetFor("win32", "x64").assetName).toBe(
      "codegraph-win32-x64.zip",
    );
    expect(() => codeGraphTargetFor("freebsd", "x64")).toThrow(
      "does not publish a runtime",
    );
  });

  it("rejects traversal, absolute, Windows-drive, and ambiguous paths", () => {
    for (const candidate of [
      "../codegraph",
      "/bin/codegraph",
      "C:/bin/codegraph.exe",
      "folder\\codegraph",
      "folder/./codegraph",
      "folder//codegraph",
      "folder/../codegraph",
    ]) {
      expect(() => validateCodeGraphArchivePath(candidate)).toThrow(
        "unsafe path",
      );
    }
    expect(validateCodeGraphArchivePath("bundle/bin/codegraph")).toBe(
      "bundle/bin/codegraph",
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "CodeGraph managed runtime",
  () => {
    it("installs a verified release, disables telemetry, and exposes a managed launcher", async () => {
      const dataDirectory = await mkdtemp(
        path.join(tmpdir(), "cantrip-codegraph-data-"),
      );
      directories.push(dataDirectory);
      const release = await fakeRelease("1.2.3");
      const manager = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });

      await expect(manager.prepare()).resolves.toMatchObject({
        state: "ready",
        cliAvailable: true,
        installedVersion: "1.2.3",
        telemetryDisabled: true,
      });
      const launcher = path.join(
        manager.status().launcherDirectory,
        "codegraph",
      );
      expect(manager.launcherPath()).toBe(launcher);
      await expect(run(launcher, ["--version"])).resolves.toMatchObject({
        code: 0,
        output: "1.2.3\n",
      });
      const invocation = manager.launcherInvocation();
      await expect(
        run(invocation.command, [...invocation.arguments, "--version"]),
      ).resolves.toMatchObject({ code: 0, output: "1.2.3\n" });
      await expect(run(launcher, ["upgrade"])).resolves.toMatchObject({
        code: 2,
        output: expect.stringContaining("managed by Cantrip"),
      });
      expect(manager.childEnvironment()).toMatchObject({
        CODEGRAPH_NO_UPDATE_CHECK: "1",
        CODEGRAPH_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
      });
    });

    it("atomically upgrades while retaining the previous verified runtime", async () => {
      const dataDirectory = await mkdtemp(
        path.join(tmpdir(), "cantrip-codegraph-upgrade-"),
      );
      directories.push(dataDirectory);
      let release = await fakeRelease("1.0.0");
      const first = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });
      await first.prepare();

      release = await fakeRelease("1.1.0");
      const second = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });
      expect(await second.prepare()).toMatchObject({
        cliAvailable: true,
        installedVersion: "1.0.0",
      });
      await expect(second.waitForUpdate()).resolves.toMatchObject({
        state: "ready",
        installedVersion: "1.1.0",
        previousVersion: "1.0.0",
      });
      const versions = await readdir(path.join(second.root, "versions"));
      expect(versions).toHaveLength(2);
    });

    it("keeps the cached runtime available when release checks fail", async () => {
      const dataDirectory = await mkdtemp(
        path.join(tmpdir(), "cantrip-codegraph-offline-"),
      );
      directories.push(dataDirectory);
      const release = await fakeRelease("2.0.0");
      const first = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });
      await first.prepare();

      const offline = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      });
      expect(await offline.prepare()).toMatchObject({
        state: "checking",
        cliAvailable: true,
        installedVersion: "2.0.0",
      });
      await expect(offline.waitForUpdate()).resolves.toMatchObject({
        state: "degraded",
        cliAvailable: true,
        installedVersion: "2.0.0",
        error: "offline",
      });
    });

    it("does not promote an archive whose checksum list disagrees", async () => {
      const dataDirectory = await mkdtemp(
        path.join(tmpdir(), "cantrip-codegraph-rollback-"),
      );
      directories.push(dataDirectory);
      let release = await fakeRelease("3.0.0");
      const first = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });
      await first.prepare();

      const invalid = await fakeRelease("3.1.0");
      invalid.checksums = Buffer.from(
        `${"0".repeat(64)}  ${invalid.assetName}\n`,
      );
      const checksumAsset = (
        invalid.release.assets as Array<Record<string, unknown>>
      ).find((asset) => asset.name === "SHA256SUMS");
      if (!checksumAsset) throw new Error("Missing fake checksum asset.");
      checksumAsset.size = invalid.checksums.length;
      checksumAsset.digest = `sha256:${createHash("sha256")
        .update(invalid.checksums)
        .digest("hex")}`;
      release = invalid;
      const second = new CodeGraphRuntimeManager({
        dataDirectory,
        fetch: releaseFetch(() => release),
      });
      await second.prepare();
      await expect(second.waitForUpdate()).resolves.toMatchObject({
        state: "degraded",
        cliAvailable: true,
        installedVersion: "3.0.0",
        error: expect.stringContaining("signed release checksum"),
      });
      const pointer = JSON.parse(
        await readFile(path.join(second.root, "bin", "current.json"), "utf8"),
      ) as { version: string };
      expect(pointer.version).toBe("3.0.0");
    });
  },
);
