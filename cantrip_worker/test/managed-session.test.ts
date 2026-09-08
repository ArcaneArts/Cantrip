import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManagedSessionCoordinator,
  type ManagedSessionPreparation,
} from "../src/codex/managed-session.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-managed-session-"),
  );
  directories.push(root);
  const directory = path.join(root, "sessions");
  const prepareManagedThread = vi.fn<
    ManagedSessionPreparation["runtime"]["prepareManagedThread"]
  >(async (options) => {
    const threadId = options.threadId ?? "native-thread";
    await options.onThreadIdentified?.(threadId);
    return { threadId };
  });
  const input: ManagedSessionPreparation = {
    identity: {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      chatId: "chat",
      placementId: "worktree",
      projectId: "project",
      contextKind: "project",
    },
    runtime: { prepareManagedThread },
    configuration: {
      intent: "configure",
      executionProfile: "ide",
      cwd: "/workspace/project",
      threadId: null,
      model: {
        id: "model",
        routeId: "route",
        name: "fake-model",
        reasoningEffort: null,
      },
      provider: {
        id: "provider",
        name: "fake-provider",
        kind: "openai",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "must-not-be-persisted",
        protectedApiKey: null,
        accountId: "account",
        credentialHomeKey: "home",
      },
      mcpServers: [],
      subagentDefaults: null,
      permissionProfileId: ":workspace",
      planMode: "default",
    },
  };
  return {
    root,
    directory,
    input,
    prepareManagedThread,
    coordinator: new ManagedSessionCoordinator(directory),
  };
}

describe("managed chat session preparation", () => {
  it("serializes racing first send and attach around one newly identified thread", async () => {
    const { coordinator, input, prepareManagedThread } = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    prepareManagedThread.mockImplementationOnce(async (options) => {
      observed.push("start");
      await options.onThreadIdentified?.("thread-created-once");
      await barrier;
      return { threadId: "thread-created-once" };
    });
    const first = coordinator.prepare(input);
    const attach = coordinator.prepare({
      ...input,
      configuration: { ...input.configuration, intent: "preserve" },
    });
    await vi.waitFor(() => expect(observed).toEqual(["start"]));
    expect(prepareManagedThread).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ threadId: "thread-created-once" });
    expect(await attach).toEqual({ threadId: "thread-created-once" });
    expect(prepareManagedThread.mock.calls[1]![0]).toMatchObject({
      intent: "preserve",
      threadId: "thread-created-once",
    });
  });

  it("recovers the same thread after MCP failure and coordinator restart", async () => {
    const { coordinator, directory, input, prepareManagedThread } =
      await fixture();
    const failure = new Error("required MCP initialize failed");
    prepareManagedThread.mockImplementationOnce(async (options) => {
      await options.onThreadIdentified?.("created-before-mcp-error");
      throw failure;
    });
    await expect(coordinator.prepare(input)).rejects.toBe(failure);
    expect(
      await new ManagedSessionCoordinator(directory).prepare(input),
    ).toEqual({ threadId: "created-before-mcp-error" });
    expect(prepareManagedThread.mock.calls[1]![0].threadId).toBe(
      "created-before-mcp-error",
    );
  });

  it("finishes incomplete configuration on view retry, then preserves it on later attaches", async () => {
    const { coordinator, input, directory, prepareManagedThread } =
      await fixture();
    const view = {
      ...input,
      configuration: { ...input.configuration, intent: "preserve" as const },
    };
    prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options.intent).toBe("configure");
      await options.onThreadIdentified?.("new-view-thread");
      throw new Error("MCP not initialized");
    });
    await expect(coordinator.prepare(view)).rejects.toThrow(
      "MCP not initialized",
    );
    await new ManagedSessionCoordinator(directory).prepare(view);
    expect(prepareManagedThread.mock.calls[1]![0]).toMatchObject({
      threadId: "new-view-thread",
      intent: "configure",
    });
    await new ManagedSessionCoordinator(directory).prepare(view);
    expect(prepareManagedThread.mock.calls[2]![0]).toMatchObject({
      threadId: "new-view-thread",
      intent: "preserve",
    });
  });

  it("does not lose an identified thread when its journal write fails", async () => {
    const { coordinator, directory, input, prepareManagedThread } =
      await fixture();
    prepareManagedThread.mockImplementationOnce(async (options) => {
      await writeFile(directory, "obstruct journal directory");
      await options.onThreadIdentified?.("native-thread");
      return { threadId: "native-thread" };
    });
    await expect(coordinator.prepare(input)).rejects.toThrow();
    await rm(directory);
    expect(await coordinator.prepare(input)).toEqual({
      threadId: "native-thread",
    });
    expect(prepareManagedThread.mock.calls[1]![0].threadId).toBe(
      "native-thread",
    );
  });

  it("awaits canonical association acknowledgment before preparation returns", async () => {
    const { coordinator, directory, input, prepareManagedThread } =
      await fixture();
    const failure = new Error("server persistence unavailable");
    const onThreadIdentified = vi.fn(async () => {
      throw failure;
    });
    await expect(
      coordinator.prepare({ ...input, onThreadIdentified }),
    ).rejects.toBe(failure);
    await new ManagedSessionCoordinator(directory).prepare(input);
    expect(onThreadIdentified).toHaveBeenCalledWith("native-thread");
    expect(prepareManagedThread.mock.calls[1]![0].threadId).toBe(
      "native-thread",
    );
  });

  it.each([
    "serverId",
    "ownerId",
    "workerId",
    "chatId",
    "placementId",
  ] as const)("does not reuse another %s's unbound thread", async (field) => {
    const { coordinator, input, prepareManagedThread } = await fixture();
    await coordinator.prepare(input);
    await coordinator.prepare({
      ...input,
      identity: { ...input.identity, [field]: "different" },
    });
    expect(prepareManagedThread.mock.calls[1]![0].threadId).toBeNull();
  });

  it("keeps account and route migrations separate from a previous unbound preparation", async () => {
    const { coordinator, input, prepareManagedThread } = await fixture();
    await coordinator.prepare(input);
    await coordinator.prepare({
      ...input,
      configuration: {
        ...input.configuration,
        provider: {
          ...input.configuration.provider,
          accountId: "different-account",
        },
      },
    });
    expect(prepareManagedThread.mock.calls[1]![0].threadId).toBeNull();
    await coordinator.prepare({
      ...input,
      configuration: {
        ...input.configuration,
        model: { ...input.configuration.model, routeId: "different-route" },
      },
    });
    expect(prepareManagedThread.mock.calls[2]![0].threadId).toBeNull();
  });

  it("uses an explicitly supplied canonical thread instead of a recovery candidate", async () => {
    const { coordinator, input, prepareManagedThread } = await fixture();
    await coordinator.prepare(input);
    await coordinator.prepare({
      ...input,
      configuration: {
        ...input.configuration,
        threadId: "canonical-thread",
        intent: "preserve",
      },
    });
    expect(prepareManagedThread.mock.calls[1]![0]).toMatchObject({
      threadId: "canonical-thread",
      intent: "preserve",
    });
  });

  it("stores only routing fingerprints and thread identity, with private file permissions", async () => {
    const { coordinator, directory, input } = await fixture();
    await coordinator.prepare(input);
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const filename = path.join(directory, files[0]!);
    const content = await readFile(filename, "utf8");
    expect(JSON.parse(content)).toEqual({
      version: 1,
      identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      threadId: "native-thread",
      prepared: true,
    });
    expect(content).not.toContain("must-not-be-persisted");
    expect(content).not.toContain(input.configuration.cwd);
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
  });

  it("surfaces corrupted recovery data instead of starting a replacement thread", async () => {
    const { coordinator, directory, input, prepareManagedThread } =
      await fixture();
    await coordinator.prepare(input);
    await writeFile(
      path.join(directory, (await readdir(directory))[0]!),
      "broken-json",
    );
    prepareManagedThread.mockClear();
    await expect(
      new ManagedSessionCoordinator(directory).prepare(input),
    ).rejects.toThrow();
    expect(prepareManagedThread).not.toHaveBeenCalled();
  });

  it("does not block another chat behind a stalled preparation", async () => {
    const { coordinator, input, prepareManagedThread } = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    prepareManagedThread.mockImplementationOnce(async (options) => {
      await options.onThreadIdentified?.("slow-thread");
      await barrier;
      return { threadId: "slow-thread" };
    });
    const pending = coordinator.prepare(input);
    await vi.waitFor(() =>
      expect(prepareManagedThread).toHaveBeenCalledTimes(1),
    );
    expect(
      await coordinator.prepare({
        ...input,
        identity: { ...input.identity, chatId: "other-chat" },
      }),
    ).toEqual({ threadId: "native-thread" });
    release();
    await pending;
  });
});
