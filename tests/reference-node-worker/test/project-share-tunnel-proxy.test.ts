import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectShareManager } from "../src/project-share-manager.js";

const directories: string[] = [];
const managers: ProjectShareManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("protected project-share endpoint", () => {
  it("opens a loopback WebDAV listener with client-provided credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-share-endpoint-"));
    directories.push(root);
    await writeFile(path.join(root, "README.md"), "protected share\n");
    const manager = new ProjectShareManager();
    managers.push(manager);
    const descriptor = await manager.open({
      password: "p".repeat(32),
      publicBasePath: `/project-shares/${"a".repeat(43)}`,
      publicOrigin: "http://127.0.0.1",
      realm: "Cantrip Project Share",
      root,
      shareId: "share-1",
      username: "cantrip-protected-share",
    });

    expect(descriptor).toMatchObject({
      loopbackHost: "127.0.0.1",
      password: "p".repeat(32),
      username: "cantrip-protected-share",
    });
    const challenge = await fetch(
      `http://${descriptor.loopbackHost}:${descriptor.loopbackPort}${descriptor.publicBasePath}/`,
      { method: "PROPFIND", headers: { Depth: "1" } },
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      "Cantrip Project Share",
    );
  });
});
