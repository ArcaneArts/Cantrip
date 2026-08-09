import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { WorkerProjectShareOpenResult } from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectShareManager } from "../src/project-share-manager.js";

const directories: string[] = [];
const managers: ProjectShareManager[] = [];
const PUBLIC_BASE_PATH = `/project-shares/${"a".repeat(43)}`;
const SECOND_PUBLIC_BASE_PATH = `/project-shares/${"b".repeat(43)}`;
const PUBLIC_ORIGIN = "https://surface.cantrip.example";

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function digestProperties(challenge: string): Record<string, string> {
  return Object.fromEntries(
    [...challenge.slice("Digest ".length).matchAll(/(\w+)="?([^",]+)"?/gu)].map(
      ([, key, value]) => [key!, value!],
    ),
  );
}

async function authenticatedRequest(
  descriptor: WorkerProjectShareOpenResult,
  method: string,
  pathname: string,
  body?: string,
  headers: HeadersInit = {},
): Promise<Response> {
  const url = `http://${descriptor.loopbackHost}:${descriptor.loopbackPort}${pathname}`;
  const initial = await fetch(url, { headers, method });
  expect(initial.status).toBe(401);
  const challenge = initial.headers.get("www-authenticate");
  expect(challenge).toMatch(/^Digest /u);
  const properties = digestProperties(challenge!);
  const nc = "00000001";
  const cnonce = "cantrip-test-client";
  const qop = properties.qop ?? "auth";
  const ha1 = md5(
    `${descriptor.username}:${properties.realm}:${descriptor.password}`,
  );
  const ha2 = md5(`${method}:${pathname}`);
  const response = md5(
    `${ha1}:${properties.nonce}:${nc}:${cnonce}:${qop}:${ha2}`,
  );
  const authorization = [
    `Digest username="${descriptor.username}"`,
    `realm="${properties.realm}"`,
    `nonce="${properties.nonce}"`,
    `uri="${pathname}"`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
    "algorithm=MD5",
  ].join(", ");
  const authenticatedHeaders = new Headers(headers);
  authenticatedHeaders.set("authorization", authorization);
  return fetch(url, {
    body,
    headers: authenticatedHeaders,
    method,
  });
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ProjectShareManager", () => {
  it("serves a project directory only on authenticated worker loopback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-project-share-"));
    directories.push(root);
    await writeFile(path.join(root, "README.md"), "# Shared project\n");
    const manager = new ProjectShareManager();
    managers.push(manager);

    const descriptor = await manager.open({
      publicBasePath: PUBLIC_BASE_PATH,
      publicOrigin: PUBLIC_ORIGIN,
      root,
      shareId: "share-1",
    });
    expect(descriptor).toMatchObject({
      loopbackHost: "127.0.0.1",
      protocol: "webdav",
      publicBasePath: PUBLIC_BASE_PATH,
      publicOrigin: PUBLIC_ORIGIN,
      realm: "Cantrip Project Share",
      shareId: "share-1",
    });
    expect(descriptor.password.length).toBeGreaterThanOrEqual(24);
    expect(manager.get("share-1")).toEqual(descriptor);

    const directory = await authenticatedRequest(
      descriptor,
      "PROPFIND",
      `${descriptor.publicBasePath}/`,
      undefined,
      { depth: "1" },
    );
    expect(directory.status).toBe(207);
    await expect(directory.text()).resolves.toContain("README.md");

    const read = await authenticatedRequest(
      descriptor,
      "GET",
      `${descriptor.publicBasePath}/README.md`,
    );
    expect(read.status).toBe(200);
    await expect(read.text()).resolves.toBe("# Shared project\n");

    const write = await authenticatedRequest(
      descriptor,
      "PUT",
      `${descriptor.publicBasePath}/from-network-drive.txt`,
      "worker-owned\n",
    );
    expect([201, 204]).toContain(write.status);
    await expect(
      readFile(path.join(root, "from-network-drive.txt"), "utf8"),
    ).resolves.toBe("worker-owned\n");

    await expect(manager.close("share-1")).resolves.toBe(true);
    expect(manager.get("share-1")).toBeNull();
    await expect(
      fetch(
        `http://${descriptor.loopbackHost}:${descriptor.loopbackPort}/README.md`,
      ),
    ).rejects.toThrow();
  });

  it("reuses share identities and bounds live worker sessions", async () => {
    const firstRoot = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-share-first-"),
    );
    const secondRoot = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-share-second-"),
    );
    directories.push(firstRoot, secondRoot);
    const manager = new ProjectShareManager({ maxShares: 1 });
    managers.push(manager);

    const [first, reused] = await Promise.all([
      manager.open({
        publicBasePath: PUBLIC_BASE_PATH,
        publicOrigin: PUBLIC_ORIGIN,
        root: firstRoot,
        shareId: "share-1",
      }),
      manager.open({
        publicBasePath: PUBLIC_BASE_PATH,
        publicOrigin: PUBLIC_ORIGIN,
        root: firstRoot,
        shareId: "share-1",
      }),
    ]);
    expect(reused).toEqual(first);
    await expect(
      manager.open({
        publicBasePath: PUBLIC_BASE_PATH,
        publicOrigin: PUBLIC_ORIGIN,
        root: secondRoot,
        shareId: "share-1",
      }),
    ).rejects.toThrow("already bound to another root or public endpoint");
    await expect(
      manager.open({
        publicBasePath: SECOND_PUBLIC_BASE_PATH,
        publicOrigin: PUBLIC_ORIGIN,
        root: firstRoot,
        shareId: "share-1",
      }),
    ).rejects.toThrow("already bound to another root or public endpoint");
    await expect(
      manager.open({
        publicBasePath: SECOND_PUBLIC_BASE_PATH,
        publicOrigin: PUBLIC_ORIGIN,
        root: secondRoot,
        shareId: "share-2",
      }),
    ).rejects.toThrow("limit of 1 sessions reached");
  });
});
