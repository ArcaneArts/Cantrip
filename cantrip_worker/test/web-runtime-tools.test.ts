import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";

import {
  CANTRIP_MCP_READ_OPERATIONS,
  type CantripMcpBinding,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { RobotsPolicy } from "../src/web/robots.js";
import {
  isPublicAddress,
  normalizedPublicHttpUrl,
  safeFetch,
  type SafeFetchResponse,
} from "../src/web/safe-fetch.js";
import { WorkerWebService } from "../src/web/service.js";

const binding: CantripMcpBinding = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  ownerId: "owner-one",
  projectId: "project-one",
  chatId: "chat-one",
  executionLaneId: "lane-one",
  workerId: "worker-one",
  worktreeId: "worktree-one",
  rootKind: "git-worktree",
  permissionProfileId: ":workspace-write",
  allowedOperations: [...CANTRIP_MCP_READ_OPERATIONS],
  issuedAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T18:00:00.000Z",
};

function response(
  body: string | Buffer,
  overrides: Partial<SafeFetchResponse> = {},
): SafeFetchResponse {
  return {
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    charset: null,
    contentType: "text/plain",
    headers: {},
    status: 200,
    url: "https://example.com/",
    ...overrides,
  };
}

describe("hardened web fetch", () => {
  it("rejects local schemes, credentials, ports, and private address ranges", () => {
    expect(() => normalizedPublicHttpUrl("file:///etc/passwd")).toThrow(
      /HTTP/u,
    );
    expect(() =>
      normalizedPublicHttpUrl("http://user:secret@example.com"),
    ).toThrow(/credentials/u);
    expect(() => normalizedPublicHttpUrl("https://example.com:8443/")).toThrow(
      /standard/u,
    );
    expect(() => normalizedPublicHttpUrl("http://localhost/")).toThrow(
      /private/u,
    );
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("10.2.3.4")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:7f00:1")).toBe(false);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
  });

  it("rejects DNS answers containing private addresses before transport", async () => {
    const request = vi.fn();
    await expect(
      safeFetch("https://example.com/", {
        lookup: vi.fn(async () => [
          { address: "93.184.216.34", family: 4 as const },
          { address: "127.0.0.1", family: 4 as const },
        ]) as never,
        request: request as never,
      }),
    ).rejects.toThrow(/private addresses/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins validated DNS, follows bounded redirects, and decompresses within limits", async () => {
    const compressed = gzipSync(Buffer.from("safe response"));
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: "/final" },
        body: Readable.from([]),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: {
          "content-encoding": "gzip",
          "content-type": "text/plain; charset=utf-8",
        },
        body: Readable.from([compressed]),
      });
    const result = await safeFetch("https://example.com/start", {
      lookup: vi.fn(async () => [
        { address: "93.184.216.34", family: 4 as const },
      ]) as never,
      request: request as never,
    });
    expect(result.url).toBe("https://example.com/final");
    expect(result.body.toString()).toBe("safe response");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects decompression expansion beyond its explicit budget", async () => {
    const compressed = gzipSync(Buffer.alloc(10_000, 65));
    await expect(
      safeFetch("https://example.com/", {
        expandedByteLimit: 1_000,
        lookup: vi.fn(async () => [
          { address: "93.184.216.34", family: 4 as const },
        ]) as never,
        request: vi.fn(async () => ({
          statusCode: 200,
          headers: { "content-encoding": "gzip" },
          body: Readable.from([compressed]),
        })) as never,
      }),
    ).rejects.toThrow();
  });
});

describe("robots and bound web tools", () => {
  it("obeys the longest matching robots rule and caches it", async () => {
    const fetch = vi.fn(async () =>
      response("User-agent: *\nDisallow: /private\nAllow: /private/public\n"),
    );
    const robots = new RobotsPolicy({ fetch: fetch as never });
    await expect(
      robots.assertAllowed(new URL("https://example.com/private/public")),
    ).resolves.toBeUndefined();
    await expect(
      robots.assertAllowed(new URL("https://example.com/private/secret")),
    ).rejects.toThrow(/robots policy/u);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("normalizes search, binds opaque references, extracts readable HTML, and pages with single-use cursors", async () => {
    const request = vi.fn(async () => ({
      query: "fixture query",
      results: [
        {
          title: "Fixture result",
          url: "https://docs.example.com/article#fragment",
          content: "A useful snippet",
          engines: ["duckduckgo", "wikipedia"],
          publishedDate: "2026-08-20T10:00:00Z",
        },
        {
          title: "Excluded",
          url: "https://blocked.example.net/",
          content: "no",
        },
      ],
      unresponsive_engines: [["brave", "timeout"]],
    }));
    const body = `<html><head><title>Fallback</title><link rel="canonical" href="/canonical"></head><body><article><h1>Readable title</h1><p>${"Readable content sentence. ".repeat(180)}</p></article></body></html>`;
    const service = new WorkerWebService({
      searchRuntime: { request },
      robots: { assertAllowed: vi.fn(async () => undefined) } as never,
      fetchPage: vi.fn(async () =>
        response(body, {
          contentType: "text/html",
          url: "https://docs.example.com/article",
        }),
      ) as never,
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });
    const search = await service.search(binding, {
      query: "fixture query",
      includeDomains: ["example.com"],
    });
    const searchData = search.data as {
      diagnostics: unknown[];
      results: Array<{ id: string }>;
    };
    expect(searchData.results).toHaveLength(1);
    expect(searchData.diagnostics).toHaveLength(1);
    const first = await service.read(binding, {
      searchResultId: searchData.results[0]!.id,
      maxChars: 1_000,
      render: "never",
    });
    const firstData = first.data as {
      content: string;
      cursor: string;
      title: string;
      truncated: boolean;
      url: string;
    };
    expect(firstData.title).toBe("Fallback");
    expect(firstData.url).toBe("https://docs.example.com/canonical");
    expect(firstData.truncated).toBe(true);
    const second = await service.read(binding, {
      cursor: firstData.cursor,
      maxChars: 1_000,
    });
    expect((second.data as { content: string }).content.length).toBeGreaterThan(
      0,
    );
    await expect(
      service.read(binding, { cursor: firstData.cursor, maxChars: 1_000 }),
    ).rejects.toThrow(/expired/u);
    await expect(
      service.read(
        { ...binding, ownerId: "owner-two" },
        { searchResultId: searchData.results[0]!.id, maxChars: 1_000 },
      ),
    ).rejects.toThrow(/another task/u);
  });
});
