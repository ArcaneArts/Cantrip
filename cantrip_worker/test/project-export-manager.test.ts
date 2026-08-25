import { chatRelocationContextPayloadSchema } from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { CodexLocalProjectExportAdapter } from "../src/project-export-manager.js";

describe("local Codex project export adapter", () => {
  it("anchors a verified native thread to the selected existing folder", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const openedHomes: string[] = [];
    let closed = false;
    const adapter = new CodexLocalProjectExportAdapter({
      binary: "/bin/codex",
      environment: {},
      homeDirectory: "/Users/tester",
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
            if (method === "thread/start") {
              return { id: 2, result: { thread: { id: "thread-one" } } };
            }
            if (method === "thread/read") {
              return { id: 6, result: { thread: { id: "thread-one" } } };
            }
            return { id: requests.length, result: {} };
          },
          notify() {},
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
    expect(openedHomes).toEqual(["/Users/tester/.codex"]);
    expect(closed).toBe(true);
    expect(requests.map(({ method }) => method)).toEqual([
      "initialize",
      "thread/start",
      "thread/inject_items",
      "thread/name/set",
      "thread/read",
      "thread/unsubscribe",
    ]);
    expect(requests[1]?.params).toEqual({
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: ["/workspace/project"],
      ephemeral: false,
    });
    expect(requests[3]?.params).toEqual({
      threadId: "thread-one",
      name: "Exporter design",
    });
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
