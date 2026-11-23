import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerRoutingRegistry } from "./routing-registry.js";
import { attachWorkspaceRoot } from "./workspace-root-attachment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("attachWorkspaceRoot", () => {
  it("canonicalizes an accessible absolute directory and protects both paths", async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-workspace-root-"),
    );
    temporaryDirectories.push(temporary);
    const dataDirectory = path.join(temporary, "worker-data");
    const requested = path.join(temporary, "workspace", "nested", "..");
    await mkdir(path.join(temporary, "workspace", "nested"), {
      recursive: true,
    });
    const registry = new WorkerRoutingRegistry(dataDirectory);

    const attachment = await attachWorkspaceRoot(requested, registry);

    expect(attachment.rootPathHandle).toMatch(/^ctrr_/u);
    expect(attachment.displayHandle).toMatch(/^ctrr_/u);
    const canonicalPath = await realpath(path.join(temporary, "workspace"));
    await expect(
      registry.resolveMetadata({
        rootPath: attachment.rootPathHandle,
        displayPath: attachment.displayHandle,
      }),
    ).resolves.toEqual({
      rootPath: canonicalPath,
      displayPath: canonicalPath,
    });
  });

  it("rejects relative, missing, and non-directory roots", async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-workspace-root-invalid-"),
    );
    temporaryDirectories.push(temporary);
    const registry = new WorkerRoutingRegistry(
      path.join(temporary, "worker-data"),
    );
    const file = path.join(temporary, "file.txt");
    await writeFile(file, "not a directory");

    await expect(
      attachWorkspaceRoot("relative/path", registry),
    ).rejects.toMatchObject({
      code: "invalid-root",
      message: expect.stringMatching(/absolute path/iu),
    });
    await expect(
      attachWorkspaceRoot(path.join(temporary, "missing"), registry),
    ).rejects.toMatchObject({
      code: "root-unavailable",
      message: expect.stringMatching(/does not exist|inaccessible/iu),
    });
    await expect(attachWorkspaceRoot(file, registry)).rejects.toMatchObject({
      code: "invalid-root",
      message: expect.stringMatching(/not a directory/iu),
    });
  });
});
