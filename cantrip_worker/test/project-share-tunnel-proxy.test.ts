import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProjectShareTunnelFrameHeader } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectShareManager } from "../src/project-share-manager.js";
import {
  ProjectShareTunnelProxy,
  StreamingByteRewriter,
} from "../src/project-share-tunnel-proxy.js";

const directories: string[] = [];
const managers: ProjectShareManager[] = [];
let sequence = 0;
const PUBLIC_BASE_PATH = `/project-shares/${"a".repeat(43)}`;
const PUBLIC_ORIGIN = "https://surface.cantrip.example";

interface TunnelResponse {
  headers: Array<[string, string]>;
  status: number;
  text: string;
}

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

async function tunnelRequest(
  proxy: ProjectShareTunnelProxy,
  frames: Array<{
    header: ProjectShareTunnelFrameHeader;
    payload: Uint8Array;
  }>,
  input: {
    body?: string;
    headers?: Array<[string, string]>;
    method: string;
    path: string;
    shareId: string;
  },
): Promise<TunnelResponse> {
  const streamId = `stream-${++sequence}`;
  await proxy.handleFrame(
    {
      protocolVersion: 1,
      shareId: input.shareId,
      streamId,
      kind: "http-request-start",
      method: input.method,
      path: input.path,
      headers: input.headers ?? [],
    },
    new Uint8Array(),
  );
  if (input.body !== undefined) {
    await proxy.handleFrame(
      {
        protocolVersion: 1,
        shareId: input.shareId,
        streamId,
        kind: "http-request-data",
      },
      new TextEncoder().encode(input.body),
    );
  }
  await proxy.handleFrame(
    {
      protocolVersion: 1,
      shareId: input.shareId,
      streamId,
      kind: "http-request-end",
    },
    new Uint8Array(),
  );
  await vi.waitFor(() => {
    expect(
      frames.some(
        ({ header }) =>
          header.streamId === streamId &&
          (header.kind === "http-response-end" || header.kind === "error"),
      ),
    ).toBe(true);
  });
  const streamFrames = frames.filter(
    ({ header }) => header.streamId === streamId,
  );
  const error = streamFrames.find(({ header }) => header.kind === "error");
  if (error?.header.kind === "error") throw new Error(error.header.message);
  const start = streamFrames.find(
    ({ header }) => header.kind === "http-response-start",
  )?.header;
  if (!start || start.kind !== "http-response-start") {
    throw new Error("Tunnel response did not start.");
  }
  return {
    headers: start.headers,
    status: start.statusCode,
    text: Buffer.concat(
      streamFrames
        .filter(({ header }) => header.kind === "http-response-data")
        .map(({ payload }) => Buffer.from(payload)),
    ).toString(),
  };
}

async function authenticatedTunnelRequest(
  proxy: ProjectShareTunnelProxy,
  frames: Array<{
    header: ProjectShareTunnelFrameHeader;
    payload: Uint8Array;
  }>,
  descriptor: NonNullable<ReturnType<ProjectShareManager["get"]>>,
  input: {
    body?: string;
    headers?: Array<[string, string]>;
    method: string;
    path: string;
  },
): Promise<TunnelResponse> {
  const initial = await tunnelRequest(proxy, frames, {
    ...input,
    shareId: descriptor.shareId,
  });
  expect(initial.status).toBe(401);
  const challenge = initial.headers.find(
    ([name]) => name.toLowerCase() === "www-authenticate",
  )?.[1];
  expect(challenge).toMatch(/^Digest /u);
  const properties = digestProperties(challenge!);
  const nc = "00000001";
  const cnonce = "cantrip-tunnel-test";
  const qop = properties.qop ?? "auth";
  const ha1 = md5(
    `${descriptor.username}:${properties.realm}:${descriptor.password}`,
  );
  const ha2 = md5(`${input.method}:${input.path}`);
  const response = md5(
    `${ha1}:${properties.nonce}:${nc}:${cnonce}:${qop}:${ha2}`,
  );
  return tunnelRequest(proxy, frames, {
    ...input,
    headers: [
      ...(input.headers ?? []),
      [
        "Authorization",
        [
          `Digest username="${descriptor.username}"`,
          `realm="${properties.realm}"`,
          `nonce="${properties.nonce}"`,
          `uri="${input.path}"`,
          `qop=${qop}`,
          `nc=${nc}`,
          `cnonce="${cnonce}"`,
          `response="${response}"`,
          "algorithm=MD5",
        ].join(", "),
      ],
    ],
    shareId: descriptor.shareId,
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

describe("ProjectShareTunnelProxy", () => {
  it("rewrites public origins split across response chunks", () => {
    const rewriter = new StreamingByteRewriter(
      "http://surface.cantrip.example",
      "https://surface.cantrip.example",
    );
    const chunks = [
      rewriter.write(new TextEncoder().encode("<href>http://surface.can")),
      rewriter.write(new TextEncoder().encode("trip.example/project</href>")),
      rewriter.end(),
    ];
    expect(Buffer.concat(chunks).toString()).toBe(
      "<href>https://surface.cantrip.example/project</href>",
    );
  });

  it("preserves Digest paths and WebDAV Destination headers through worker loopback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-share-tunnel-"));
    directories.push(root);
    await writeFile(path.join(root, "README.md"), "shared through tunnel\n");
    const manager = new ProjectShareManager();
    managers.push(manager);
    const descriptor = await manager.open({
      publicBasePath: PUBLIC_BASE_PATH,
      publicOrigin: PUBLIC_ORIGIN,
      root,
      shareId: "share-1",
    });
    const frames: Array<{
      header: ProjectShareTunnelFrameHeader;
      payload: Uint8Array;
    }> = [];
    const proxy = new ProjectShareTunnelProxy(manager);
    proxy.setFrameEmitter((header, payload) => {
      frames.push({ header, payload: Uint8Array.from(payload) });
      return true;
    });

    const directory = await authenticatedTunnelRequest(
      proxy,
      frames,
      descriptor,
      {
        method: "PROPFIND",
        path: `${descriptor.publicBasePath}/`,
        headers: [["Depth", "1"]],
      },
    );
    expect(directory.status).toBe(207);
    expect(directory.text).toContain("README.md");
    expect(directory.text).toContain(PUBLIC_ORIGIN);
    expect(directory.text).not.toContain(
      `${descriptor.loopbackHost}:${descriptor.loopbackPort}`,
    );

    const written = await authenticatedTunnelRequest(
      proxy,
      frames,
      descriptor,
      {
        body: "network drive write\n",
        method: "PUT",
        path: `${descriptor.publicBasePath}/before-move.txt`,
      },
    );
    expect([201, 204]).toContain(written.status);
    const moved = await authenticatedTunnelRequest(proxy, frames, descriptor, {
      method: "MOVE",
      path: `${descriptor.publicBasePath}/before-move.txt`,
      headers: [
        [
          "Destination",
          `https://surface.cantrip.example${descriptor.publicBasePath}/after-move.txt`,
        ],
      ],
    });
    expect([201, 204]).toContain(moved.status);
    await expect(
      readFile(path.join(root, "after-move.txt"), "utf8"),
    ).resolves.toBe("network drive write\n");
    await expect(
      readFile(path.join(root, "before-move.txt"), "utf8"),
    ).rejects.toThrow();

    proxy.close();
  });
});
