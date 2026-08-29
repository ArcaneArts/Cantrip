import { access, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ManagedFolderManager } from "./managed-folders.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ManagedFolderManager", () => {
  it("attaches an existing directory without taking ownership of it", async () => {
    const root = await temporaryDirectory("cantrip-folder-manager-");
    const dataDirectory = path.join(root, "worker-data");
    const existingPath = path.join(root, "existing-project");
    await mkdir(existingPath);
    const manager = new ManagedFolderManager(dataDirectory);
    const projectId = "019fdcf5-a6e7-75fb-bdf7-22b697df3a57";

    const result = await manager.materialize({
      attempt: 1,
      existingPath,
      jobId: "019fdcf5-c116-77d0-9588-7c65fc3bc7c2",
      projectId,
    });

    expect(result).toMatchObject({
      displayPath: existingPath,
      path: await realpath(existingPath),
      reused: true,
      status: "ready",
    });
    await expect(manager.delete(projectId)).resolves.toEqual({
      deleted: false,
    });
    await expect(access(existingPath)).resolves.toBeUndefined();
  });

  it("rejects an existing path that is not a directory", async () => {
    const root = await temporaryDirectory("cantrip-folder-manager-");
    const manager = new ManagedFolderManager(path.join(root, "worker-data"));

    await expect(
      manager.materialize({
        attempt: 1,
        existingPath: path.join(root, "missing"),
        jobId: "019fdcf5-c116-77d0-9588-7c65fc3bc7c2",
        projectId: "019fdcf5-a6e7-75fb-bdf7-22b697df3a57",
      }),
    ).rejects.toThrow();
  });

  it("accepts an existing directory reported as a file URL", async () => {
    const root = await temporaryDirectory("cantrip-folder-manager-");
    const existingPath = path.join(root, "existing-project");
    await mkdir(existingPath);
    const manager = new ManagedFolderManager(path.join(root, "worker-data"));

    await expect(
      manager.materialize({
        attempt: 1,
        existingPath: pathToFileURL(existingPath).href,
        jobId: "019fdcf5-c116-77d0-9588-7c65fc3bc7c2",
        projectId: "019fdcf5-a6e7-75fb-bdf7-22b697df3a57",
      }),
    ).resolves.toMatchObject({ path: await realpath(existingPath) });
  });
});
