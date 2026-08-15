import { describe, expect, it } from "vitest";

import type { ExternalChatDiscoveryTarget } from "@cantrip/protocol";

import {
  CodexExternalChatHistorySource,
  normalizeExternalPath,
  normalizeGitOrigin,
} from "../src/external-chat-history.js";

const target: ExternalChatDiscoveryTarget = {
  projectReplicaId: "replica-one",
  path: "/workspace/Cantrip",
  repositoryFingerprint: "fingerprint",
  worktrees: [
    {
      worktreeId: "worktree-primary",
      path: "/workspace/Cantrip",
      isPrimary: true,
    },
    {
      worktreeId: "worktree-feature",
      path: "/workspace/Cantrip-feature",
      isPrimary: false,
    },
  ],
};

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    parentThreadId: null,
    preview: "Implement the importer",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1_786_800_000,
    updatedAt: 1_786_810_000,
    status: { type: "notLoaded" },
    cwd: "/workspace/Cantrip",
    cliVersion: "0.147.0",
    source: "vscode",
    gitInfo: {
      sha: "abc123",
      branch: "main",
      originUrl: "git@github.com:ArcaneArts/Cantrip.git",
    },
    name: "Codex import",
    ...overrides,
  };
}

function sourceWithResponses(
  responses: unknown[],
  requests: Array<{ method: string; params: unknown }>,
) {
  return new CodexExternalChatHistorySource({
    binary: "/bin/codex",
    environment: {},
    homeDirectory: "/Users/tester",
    managedDataDirectory: "/Users/tester/Library/Cantrip",
    platform: "darwin",
    pathExists: async () => true,
    resolvePath: async (candidate) => candidate,
    resolveGitOrigin: async () => "github.com/arcanearts/cantrip",
    readRuntimeVersion: async () => "codex-cli 0.147.0",
    createClient: () => ({
      async request(method, params) {
        requests.push({ method, params });
        if (method === "initialize") {
          return {
            id: 1,
            result: {
              userAgent: "codex-cli/0.147.0",
              platformFamily: "unix",
              platformOs: "macos",
            },
          };
        }
        return { id: requests.length, result: responses.shift() };
      },
      notify() {},
      close() {},
    }),
  });
}

describe("external Codex chat history discovery", () => {
  it("reports a missing default store without starting Codex", async () => {
    let created = false;
    const source = new CodexExternalChatHistorySource({
      binary: "/bin/codex",
      environment: {},
      homeDirectory: "/Users/tester",
      managedDataDirectory: "/Users/tester/Library/Cantrip",
      platform: "darwin",
      pathExists: async () => false,
      resolvePath: async (candidate) => candidate,
      resolveGitOrigin: async () => null,
      readRuntimeVersion: async () => "codex-cli 0.147.0",
      createClient: () => {
        created = true;
        throw new Error("Unexpected Codex client creation.");
      },
    });

    const result = await source.discover({
      includeArchived: false,
      targets: [target],
    });

    expect(created).toBe(false);
    expect(result).toMatchObject([
      {
        kind: "chatgpt-codex",
        availability: "unavailable",
        homeLabel: "~/.codex",
        threads: [],
      },
    ]);
  });

  it("paginates metadata-only listing and matches paths and Git origins", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const source = sourceWithResponses(
      [
        {
          data: [thread()],
          nextCursor: "next-page",
          backwardsCursor: null,
        },
        {
          data: [
            thread({
              id: "01900000-0000-7000-8000-000000000002",
              name: null,
              cwd: "/moved/Cantrip",
              updatedAt: 1_786_820_000,
            }),
            thread({
              id: "01900000-0000-7000-8000-000000000003",
              parentThreadId: "parent",
            }),
            thread({
              id: "01900000-0000-7000-8000-000000000004",
              status: { type: "active", activeFlags: [] },
            }),
          ],
          nextCursor: null,
          backwardsCursor: null,
        },
      ],
      requests,
    );

    const result = await source.discover({
      includeArchived: false,
      targets: [target],
    });

    expect(requests.map(({ method }) => method)).toEqual([
      "initialize",
      "thread/list",
      "thread/list",
    ]);
    expect(requests.some(({ method }) => method === "thread/read")).toBe(false);
    expect(requests[1]?.params).toMatchObject({
      archived: false,
      sourceKinds: ["cli", "vscode"],
      useStateDbOnly: true,
    });
    expect(result[0]?.threads).toHaveLength(2);
    expect(result[0]?.threads[0]).toMatchObject({
      sourceThreadId: "01900000-0000-7000-8000-000000000002",
      match: {
        kind: "git-origin",
        projectReplicaId: "replica-one",
        worktreeId: null,
      },
    });
    expect(result[0]?.threads[1]).toMatchObject({
      sourceThreadId: "01900000-0000-7000-8000-000000000001",
      match: {
        kind: "worktree-path",
        worktreeId: "worktree-primary",
      },
    });
  });

  it("fails closed when Codex returns an incompatible metadata shape", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const source = sourceWithResponses([{ data: "invalid" }], requests);

    const result = await source.discover({
      includeArchived: false,
      targets: [target],
    });

    expect(result[0]).toMatchObject({
      availability: "incompatible",
      threads: [],
    });
  });

  it("normalizes Windows paths and common Git remote forms", () => {
    expect(normalizeExternalPath("C:\\Users\\TEST\\.codex", "win32")).toBe(
      "c:\\users\\test\\.codex",
    );
    expect(normalizeGitOrigin("git@github.com:ArcaneArts/Cantrip.git")).toBe(
      "github.com/arcanearts/cantrip",
    );
    expect(
      normalizeGitOrigin("https://github.com/ArcaneArts/Cantrip.git"),
    ).toBe("github.com/arcanearts/cantrip");
  });
});
