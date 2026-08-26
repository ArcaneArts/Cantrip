import { chatRelocationContextPayloadSchema } from "@cantrip/protocol";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { relocationExternalSessionRecords } from "../src/codex/app-server.js";
import { CodexLocalProjectExportAdapter } from "../src/project-export-manager.js";

describe("local Codex project export adapter", () => {
  it("anchors a verified native thread to the selected existing folder", async () => {
    const homeDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-export-"),
    );
    const requests: Array<{ method: string; params: unknown }> = [];
    const openedHomes: string[] = [];
    let stagedRecords: Array<Record<string, unknown>> = [];
    let closed = false;
    const adapter = new CodexLocalProjectExportAdapter({
      binary: "/bin/codex",
      environment: {},
      homeDirectory,
      managedDataDirectory: "/Users/tester/Library/Cantrip",
      platform: "darwin",
      pathExists: async () => true,
      resolvePath: async (candidate) => candidate,
      createClient: (codexHome) => {
        openedHomes.push(codexHome);
        return {
          async request(method, params) {
            requests.push({ method, params });
            if (method === "initialize") return { id: 1, result: {} };
            if (method === "externalAgentConfig/import") {
              const sourcePath = (
                params as {
                  migrationItems: Array<{
                    details: { sessions: Array<{ path: string }> };
                  }>;
                }
              ).migrationItems[0]!.details.sessions[0]!.path;
              stagedRecords = (await readFile(sourcePath, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
              return { id: 2, result: { importId: "import-one" } };
            }
            if (method === "thread/read") {
              return {
                id: 3,
                result: {
                  thread: {
                    id: "thread-one",
                    name: "Exporter design",
                    preview: "Build the exporter",
                    turns: [{ id: "turn-one", items: [], status: "completed" }],
                  },
                },
              };
            }
            if (method === "thread/list") {
              return {
                id: 4,
                result: { data: [{ id: "thread-one" }], nextCursor: null },
              };
            }
            return { id: requests.length, result: {} };
          },
          notify() {},
          async waitForNotification(method, predicate) {
            const params = {
              importId: "import-one",
              itemTypeResults: [
                {
                  itemType: "SESSIONS",
                  successes: [
                    {
                      itemType: "SESSIONS",
                      source: "session.jsonl",
                      target: "thread-one",
                    },
                  ],
                  failures: [],
                },
              ],
            };
            expect(method).toBe("externalAgentConfig/import/completed");
            expect(predicate(params)).toBe(true);
            return { method, params };
          },
          close() {
            closed = true;
          },
        };
      },
    });
    const destination = await adapter.destination("/workspace/project");
    const started: string[] = [];

    const result = await adapter.exportChat({
      abandonedThreadId: null,
      cwd: "/workspace/project",
      destination,
      payload: chatRelocationContextPayloadSchema.parse({
        version: 1,
        kind: "visible",
        messages: [
          {
            sequence: 1,
            role: "user",
            mode: "default",
            reasoningEffort: null,
            content: [{ type: "text", text: "Build the exporter" }],
            createdAt: "2026-08-25T00:00:00.000Z",
          },
        ],
        attachments: [],
      }),
      title: "Exporter design",
      onThreadStarted: async (threadId) => {
        started.push(threadId);
      },
    });

    expect(result).toEqual({ threadId: "thread-one" });
    expect(started).toEqual(["thread-one"]);
    expect(openedHomes).toEqual([path.join(homeDirectory, ".codex")]);
    expect(closed).toBe(true);
    expect(requests.map(({ method }) => method)).toEqual([
      "initialize",
      "externalAgentConfig/import",
      "thread/read",
      "thread/list",
    ]);
    expect(requests[1]?.params).toMatchObject({
      migrationSource: "cursor",
      providerId: "cantrip",
      source: "cantrip_project_export",
      migrationItems: [
        {
          itemType: "SESSIONS",
          cwd: "/workspace/project",
          details: {
            sessions: [
              {
                cwd: "/workspace/project",
                title: "Exporter design",
              },
            ],
          },
        },
      ],
    });
    expect(stagedRecords).toEqual([
      { type: "custom-title", customTitle: "Exporter design" },
      {
        type: "user",
        cwd: "/workspace/project",
        timestamp: "2026-08-25T00:00:00.000Z",
        message: { content: "Build the exporter" },
      },
    ]);
    await expect(
      stat(path.join(homeDirectory, ".cursor", "projects", ".cantrip-exports")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await rm(homeDirectory, { recursive: true, force: true });
  });

  it("preserves developer content as an explicit visible session annotation", async () => {
    expect(
      relocationExternalSessionRecords(
        chatRelocationContextPayloadSchema.parse({
          version: 1,
          kind: "visible",
          messages: [
            {
              sequence: 1,
              role: "system",
              mode: "plan",
              reasoningEffort: null,
              content: [{ type: "text", text: "Keep the contract stable" }],
              createdAt: "2026-08-25T00:00:00.000Z",
            },
          ],
          attachments: [],
        }),
        { cwd: "/workspace/project", title: "Export" },
      ),
    ).toEqual([
      { type: "custom-title", customTitle: "Export" },
      {
        type: "user",
        cwd: "/workspace/project",
        timestamp: "2026-08-25T00:00:00.000Z",
        message: {
          content:
            "[Cantrip developer message]\n[Cantrip plan mode]\nKeep the contract stable",
        },
      },
    ]);
  });

  it("rejects and deletes a thread that has no native visible turns", async () => {
    const homeDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-export-empty-"),
    );
    const requests: Array<{ method: string; params: unknown }> = [];
    const adapter = new CodexLocalProjectExportAdapter({
      binary: "/bin/codex",
      environment: {},
      homeDirectory,
      managedDataDirectory: path.join(homeDirectory, "managed"),
      platform: "darwin",
      pathExists: async () => true,
      resolvePath: async (candidate) => candidate,
      createClient: () => ({
        async request(method, params) {
          requests.push({ method, params });
          if (method === "initialize") return { id: 1, result: {} };
          if (method === "externalAgentConfig/import") {
            return { id: 2, result: { importId: "import-empty" } };
          }
          if (method === "thread/read") {
            return {
              id: 3,
              result: {
                thread: { id: "thread-empty", preview: "", turns: [] },
              },
            };
          }
          return { id: requests.length, result: {} };
        },
        notify() {},
        async waitForNotification() {
          return {
            method: "externalAgentConfig/import/completed",
            params: {
              importId: "import-empty",
              itemTypeResults: [
                {
                  itemType: "SESSIONS",
                  successes: [{ itemType: "SESSIONS", target: "thread-empty" }],
                  failures: [],
                },
              ],
            },
          };
        },
        close() {},
      }),
    });
    const destination = await adapter.destination("/workspace/project");

    await expect(
      adapter.exportChat({
        abandonedThreadId: null,
        cwd: "/workspace/project",
        destination,
        payload: chatRelocationContextPayloadSchema.parse({
          version: 1,
          kind: "visible",
          messages: [
            {
              sequence: 1,
              role: "user",
              mode: "default",
              reasoningEffort: null,
              content: [{ type: "text", text: "Visible request" }],
              createdAt: "2026-08-25T00:00:00.000Z",
            },
          ],
          attachments: [],
        }),
        title: "Broken export",
        onThreadStarted: async () => undefined,
      }),
    ).rejects.toThrow("native visible turns");
    expect(requests.at(-1)).toEqual({
      method: "thread/delete",
      params: { threadId: "thread-empty" },
    });
    await rm(homeDirectory, { recursive: true, force: true });
  });

  it("reports unsupported worker platforms without launching Codex", async () => {
    let created = false;
    const adapter = new CodexLocalProjectExportAdapter({
      binary: "/bin/codex",
      homeDirectory: "/home/tester",
      managedDataDirectory: "/home/tester/.cantrip",
      platform: "linux",
      pathExists: async () => true,
      createClient: () => {
        created = true;
        throw new Error("unexpected client");
      },
    });

    await expect(adapter.inspect("/workspace/project")).resolves.toMatchObject({
      available: false,
      platform: "linux",
      message: expect.stringContaining("macOS and Windows"),
    });
    expect(created).toBe(false);
  });

  it("does not follow an external-home symlink into Cantrip managed data", async () => {
    const adapter = new CodexLocalProjectExportAdapter({
      binary: "/bin/codex",
      environment: { CODEX_HOME: "/tmp/codex-link" },
      homeDirectory: "/Users/tester",
      managedDataDirectory: "/Users/tester/Library/Cantrip",
      platform: "darwin",
      pathExists: async () => true,
      resolvePath: async (candidate) =>
        candidate === "/tmp/codex-link"
          ? "/Users/tester/Library/Cantrip/codex-home"
          : candidate,
    });

    await expect(
      adapter.destination("/workspace/project"),
    ).resolves.toMatchObject({
      label: "~/.codex",
      path: "/Users/tester/.codex",
    });
  });
});
