import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  deriveManagedFolderLocation,
  ManagedFolderManager,
} from "../src/managed-folders.js";

const directories: string[] = [];
const projectId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338";
const jobId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb339";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function manager() {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-folders-test-"));
  directories.push(directory);
  return { directory, manager: new ManagedFolderManager(directory) };
}

describe("managed folders", () => {
  it.each([
    {
      dataDirectory: "/srv/cantrip/worker-data",
      expectedDisplayPath: `folders/${projectId}`,
      expectedRoot: "/srv/cantrip/worker-data/folders",
      expectedTarget: `/srv/cantrip/worker-data/folders/${projectId}`,
      name: "POSIX",
      pathApi: path.posix,
    },
    {
      dataDirectory: "C:\\Cantrip\\worker-data",
      expectedDisplayPath: `folders\\${projectId}`,
      expectedRoot: "C:\\Cantrip\\worker-data\\folders",
      expectedTarget: `C:\\Cantrip\\worker-data\\folders\\${projectId}`,
      name: "Windows",
      pathApi: path.win32,
    },
  ])("derives a UUID-only target beneath the $name root", (test) => {
    const location = deriveManagedFolderLocation(
      test.dataDirectory,
      projectId.toUpperCase(),
      test.pathApi,
    );
    expect(location).toEqual({
      displayPath: test.expectedDisplayPath,
      root: test.expectedRoot,
      target: test.expectedTarget,
    });
    expect(test.pathApi.dirname(location.target)).toBe(location.root);
    expect(location.target).not.toBe(location.root);
  });

  it("materializes an owner-only UUID directory idempotently", async () => {
    const test = await manager();
    const first = await test.manager.materialize({
      projectId,
      jobId,
      attempt: 1,
    });
    await writeFile(path.join(first.path, "kept.txt"), "direct write\n");
    const second = await test.manager.materialize({
      projectId,
      jobId,
      attempt: 2,
    });

    expect(first).toMatchObject({
      reused: false,
      displayPath: `folders/${projectId}`,
    });
    expect(second).toMatchObject({ path: first.path, reused: true });
    expect(await readFile(path.join(first.path, "kept.txt"), "utf8")).toBe(
      "direct write\n",
    );
    if (process.platform !== "win32") {
      expect((await lstat(first.path)).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects traversal-shaped identifiers before touching another path", async () => {
    const test = await manager();
    await expect(
      test.manager.materialize({ projectId: "../escape", jobId, attempt: 1 }),
    ).rejects.toThrow("project UUID");
    await expect(test.manager.delete("../escape")).rejects.toThrow(
      "project UUID",
    );
    expect(() =>
      deriveManagedFolderLocation(test.directory, "folders", path.posix),
    ).toThrow("project UUID");
  });

  it("rejects symlink collisions and never deletes their targets", async () => {
    const test = await manager();
    const outside = path.join(test.directory, "outside");
    const target = path.join(test.directory, "folders", projectId);
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, "safe.txt"), "safe\n");
    await symlink(outside, target, "dir");

    await expect(
      test.manager.materialize({ projectId, jobId, attempt: 1 }),
    ).rejects.toThrow("safe directory");
    await expect(test.manager.delete(projectId)).rejects.toThrow(
      "safe directory",
    );
    expect(await readFile(path.join(outside, "safe.txt"), "utf8")).toBe(
      "safe\n",
    );
  });

  it("deletes only the exact derived project directory", async () => {
    const test = await manager();
    const created = await test.manager.materialize({
      projectId,
      jobId,
      attempt: 1,
    });
    const sibling = path.join(
      test.directory,
      "folders",
      `${projectId}-sibling`,
    );
    await mkdir(sibling);
    await writeFile(path.join(sibling, "safe.txt"), "safe\n");

    expect(await test.manager.delete(projectId)).toEqual({ deleted: true });
    await expect(lstat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(sibling, "safe.txt"), "utf8")).toBe(
      "safe\n",
    );
    expect(await test.manager.delete(projectId)).toEqual({ deleted: false });
  });
});
