import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { TunnelDataPlaneFrameHeader } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectShareManager } from "../src/project-share-manager.js";
import {
  ProjectShareTunnelDestinationAdapter,
  StreamingByteRewriter,
} from "../src/project-share-tunnel-adapter.js";

const directories: string[] = [];
const managers: ProjectShareManager[] = [];
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
  adapter: ProjectShareTunnelDestinationAdapter,
  input: {
    body?: string;
    headers?: Array<[string, string]>;
    method: string;
    path: string;
    shareId: string;
  },
): Promise<TunnelResponse> {
  const connectionId = randomUUID();
  const tunnelId = "tunnel-1";
  const attachmentId = input.shareId;
  const sourceEndpointId = `server:project-share:${input.shareId}`;
  const destinationEndpointId = `worker:${input.shareId}`;
  const frames: Array<{
    header: TunnelDataPlaneFrameHeader;
    payload: Uint8Array;
  }> = [];
  adapter.setFrameEmitter((header, payload) => {
    frames.push({ header, payload: Uint8Array.from(payload) });
    return true;
  });
  const base = {
    protocolVersion: 1 as const,
    tunnelId,
    attachmentId,
    sourceEndpointId,
    destinationEndpointId,
    connectionId,
  };
  adapter.handleFrame(
    {
      ...base,
      sequence: 0,
      kind: "connect",
      target: {
        kind: "adapter",
        adapter: "project-share",
        resourceId: input.shareId,
      },
      initialCreditBytes: 1024 * 1024,
    },
    new Uint8Array(),
  );
  const encodedHead = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      method: input.method,
      path: input.path,
      headers: input.headers ?? [],
    }),
  );
  const request = Buffer.allocUnsafe(4 + encodedHead.byteLength);
  request.writeUInt32BE(encodedHead.byteLength, 0);
  encodedHead.copy(request, 4);
  const body = Buffer.from(input.body ?? "");
  adapter.handleFrame(
    {
      ...base,
      sequence: 1,
      kind: "data",
      direction: "source-to-destination",
    },
    Buffer.concat([request, body]),
  );
  adapter.handleFrame(
    {
      ...base,
      sequence: 2,
      kind: "half-close",
      direction: "source-to-destination",
    },
    new Uint8Array(),
  );
  await vi.waitFor(() =>
    expect(
      frames.some(
        ({ header }) =>
          header.connectionId === connectionId && header.kind === "half-close",
      ),
    ).toBe(true),
  );
  const responseBytes = Buffer.concat(
    frames
      .filter(
        ({ header }) =>
          header.connectionId === connectionId && header.kind === "data",
      )
      .map(({ payload }) => Buffer.from(payload)),
  );
  const headLength = responseBytes.readUInt32BE(0);
  const head = JSON.parse(
    responseBytes.subarray(4, 4 + headLength).toString("utf8"),
  ) as { statusCode: number; headers: Array<[string, string]> };
  adapter.handleFrame(
    { ...base, sequence: 3, kind: "close", code: "normal", message: null },
    new Uint8Array(),
  );
  return {
    headers: head.headers,
    status: head.statusCode,
    text: responseBytes.subarray(4 + headLength).toString(),
  };
}

async function authenticatedTunnelRequest(
  adapter: ProjectShareTunnelDestinationAdapter,
  descriptor: NonNullable<ReturnType<ProjectShareManager["get"]>>,
  input: {
    body?: string;
    headers?: Array<[string, string]>;
    method: string;
    path: string;
  },
): Promise<TunnelResponse> {
  const initial = await tunnelRequest(adapter, {
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
  return tunnelRequest(adapter, {
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

describe("ProjectShareTunnelDestinationAdapter", () => {
  it("rewrites public origins split across response chunks", () => {
    const rewriter = new StreamingByteRewriter(
      "http://surface.cantrip.example",
      "https://surface.cantrip.example",
    );
    expect(
      Buffer.concat([
        rewriter.write(Buffer.from("<href>http://surface.can")),
        rewriter.write(Buffer.from("trip.example/project</href>")),
        rewriter.end(),
      ]).toString(),
    ).toBe("<href>https://surface.cantrip.example/project</href>");
  });

  it("preserves Digest paths, writes, and WebDAV Destination headers", async () => {
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
    const adapter = new ProjectShareTunnelDestinationAdapter(manager);

    const directory = await authenticatedTunnelRequest(adapter, descriptor, {
      method: "PROPFIND",
      path: `${descriptor.publicBasePath}/`,
      headers: [["Depth", "1"]],
    });
    expect(directory.status).toBe(207);
    expect(directory.text).toContain("README.md");
    expect(directory.text).toContain(PUBLIC_ORIGIN);
    expect(directory.text).not.toContain(
      `${descriptor.loopbackHost}:${descriptor.loopbackPort}`,
    );

    const written = await authenticatedTunnelRequest(adapter, descriptor, {
      body: "network drive write\n",
      method: "PUT",
      path: `${descriptor.publicBasePath}/before-move.txt`,
    });
    expect([201, 204]).toContain(written.status);
    const moved = await authenticatedTunnelRequest(adapter, descriptor, {
      method: "MOVE",
      path: `${descriptor.publicBasePath}/before-move.txt`,
      headers: [
        [
          "Destination",
          `${PUBLIC_ORIGIN}${descriptor.publicBasePath}/after-move.txt`,
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
    adapter.close();
  });
});
