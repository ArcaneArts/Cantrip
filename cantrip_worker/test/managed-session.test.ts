import { createHash } from "node:crypto";
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

import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

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
  it("retries an incompletely prepared replacement after restart without creating another thread", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({
        threadId: null,
        intent: "configure",
        mcpServers: [],
      });
      await options.onThreadIdentified?.("replacement");
      throw new Error("managed configuration failed");
    });
    await expect(
      f.coordinator.replace(f.input, "native-thread"),
    ).rejects.toThrow("managed configuration failed");
    const restored = new ManagedSessionCoordinator(f.directory);
    await expect(restored.replace(f.input, "native-thread")).resolves.toEqual({
      threadId: "replacement",
    });
    expect(f.prepareManagedThread.mock.calls[2]![0]).toMatchObject({
      threadId: "replacement",
      intent: "configure",
    });
    // Ordinary attachment retains the lineage marker for an idempotent handoff retry.
    await restored.prepare({
      ...f.input,
      configuration: { ...f.input.configuration, intent: "preserve" },
    });
    await new ManagedSessionCoordinator(f.directory).replace(
      f.input,
      "native-thread",
    );
    expect(f.prepareManagedThread.mock.calls[4]![0]).toMatchObject({
      threadId: "replacement",
      intent: "preserve",
    });
    const journal = JSON.parse(
      await readFile(
        path.join(f.directory, (await readdir(f.directory))[0]!),
        "utf8",
      ),
    );
    expect(journal).toMatchObject({
      threadId: "replacement",
      replacementOf: "native-thread",
      prepared: true,
    });
  });

  it("retries a prepared replacement handoff without reading or restoring the old Core", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    const source = {
      sourceThreadId: "native-thread",
      transportGeneration: "transport",
      sourcePreparationVersion: 0,
      settings: nativeThreadSettings({ model: "source-choice" }),
    };
    const captureReplacementSettings = vi.fn(async () => source);
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options.replacementSettings).toEqual(source);
      await options.onThreadIdentified?.("replacement");
      return { threadId: "replacement" };
    });
    await expect(
      f.coordinator.replace(
        {
          ...f.input,
          captureReplacementSettings,
          onPrepared: async () => {
            throw new Error("handoff unavailable");
          },
        },
        "native-thread",
      ),
    ).rejects.toThrow("handoff unavailable");
    // The old Core can now be gone and the replacement can have newer choices.
    captureReplacementSettings.mockRejectedValue(new Error("old Core closed"));
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({
        threadId: "replacement",
        intent: "preserve",
      });
      expect(options.replacementSettings).toBeUndefined();
      await options.onThreadIdentified?.("replacement");
      return { threadId: "replacement" };
    });
    await expect(
      new ManagedSessionCoordinator(f.directory).replace(
        {
          ...f.input,
          captureReplacementSettings,
          configuration: {
            ...f.input.configuration,
            replacementSettings: source,
          },
        },
        "native-thread",
      ),
    ).resolves.toEqual({ threadId: "replacement" });
    expect(captureReplacementSettings).toHaveBeenCalledTimes(1);
  });

  it("captures the source again before retrying an incompletely configured replacement", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    const captureReplacementSettings = vi.fn(async () => ({
      sourceThreadId: "native-thread",
      transportGeneration: "transport",
      sourcePreparationVersion: 0,
      settings: nativeThreadSettings({ model: "first-selection" }),
    }));
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options.replacementSettings?.settings.model).toBe(
        "first-selection",
      );
      await options.onThreadIdentified?.("replacement");
      throw new Error("settings application failed");
    });
    const onPrepared = vi.fn(async () => {});
    await expect(
      f.coordinator.replace(
        { ...f.input, captureReplacementSettings, onPrepared },
        "native-thread",
      ),
    ).rejects.toThrow("settings application failed");
    expect(onPrepared).not.toHaveBeenCalled();
    captureReplacementSettings.mockImplementationOnce(async () => ({
      sourceThreadId: "native-thread",
      transportGeneration: "new-transport",
      sourcePreparationVersion: 0,
      settings: nativeThreadSettings({ model: "latest-selection" }),
    }));
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      expect(options).toMatchObject({
        threadId: "replacement",
        intent: "configure",
        replacementSettings: { settings: { model: "latest-selection" } },
      });
      await options.onThreadIdentified?.("replacement");
      return { threadId: "replacement" };
    });
    await new ManagedSessionCoordinator(f.directory).replace(
      { ...f.input, captureReplacementSettings, onPrepared },
      "native-thread",
    );
    expect(captureReplacementSettings).toHaveBeenCalledTimes(2);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    const journal = await readFile(
      path.join(f.directory, (await readdir(f.directory))[0]!),
      "utf8",
    );
    expect(journal).not.toContain("selection");
    expect(journal).not.toContain("replacementSettings");
  });

  it("retains an identified replacement across journal failure in the current process", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      await rm(f.directory, { recursive: true });
      await writeFile(f.directory, "obstruct replacement journal");
      await options.onThreadIdentified?.("replacement");
      return { threadId: "replacement" };
    });
    await expect(
      f.coordinator.replace(f.input, "native-thread"),
    ).rejects.toThrow();
    await rm(f.directory);
    await expect(
      f.coordinator.replace(f.input, "native-thread"),
    ).resolves.toEqual({ threadId: "replacement" });
    expect(f.prepareManagedThread.mock.calls[2]![0]).toMatchObject({
      threadId: "replacement",
      intent: "configure",
    });
  });

  it("serializes replacements and compare-and-swaps the actual previous association", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      await options.onThreadIdentified?.("replacement");
      await barrier;
      return { threadId: "replacement" };
    });
    const first = f.coordinator.replace(f.input, "native-thread");
    const second = f.coordinator.replace(f.input, "native-thread");
    await vi.waitFor(() =>
      expect(f.prepareManagedThread).toHaveBeenCalledTimes(2),
    );
    release();
    await expect(first).resolves.toEqual({ threadId: "replacement" });
    await expect(second).resolves.toEqual({ threadId: "replacement" });
    expect(f.prepareManagedThread.mock.calls[2]![0].threadId).toBe(
      "replacement",
    );
    const count = f.prepareManagedThread.mock.calls.length;
    await expect(
      f.coordinator.replace(f.input, "foreign-thread"),
    ).rejects.toThrow("association changed");
    await expect(
      f.coordinator.replace(
        { ...f.input, identity: { ...f.input.identity, placementId: "moved" } },
        "native-thread",
      ),
    ).rejects.toThrow("association changed");
    expect(f.prepareManagedThread).toHaveBeenCalledTimes(count);
  });

  it("keeps replacement preparation and canonical handoff serialized before an old-canonical attachment", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    f.prepareManagedThread.mockImplementationOnce(async (options) => {
      await options.onThreadIdentified?.("replacement");
      return { threadId: "replacement" };
    });
    let release!: () => void;
    const handoff = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onPrepared = vi.fn(async (threadId: string) => {
      const journal = JSON.parse(
        await readFile(
          path.join(f.directory, (await readdir(f.directory))[0]!),
          "utf8",
        ),
      );
      expect(journal).toMatchObject({
        prepared: true,
        threadId,
        replacementOf: "native-thread",
      });
      await handoff;
    });
    const replacement = f.coordinator.replace(
      { ...f.input, onPrepared },
      "native-thread",
    );
    await vi.waitFor(() =>
      expect(onPrepared).toHaveBeenCalledWith("replacement"),
    );
    const attach = f.coordinator.prepare({
      ...f.input,
      configuration: {
        ...f.input.configuration,
        threadId: "native-thread",
        intent: "preserve",
      },
    });
    await Promise.resolve();
    expect(f.prepareManagedThread).toHaveBeenCalledTimes(2);
    release();
    await replacement;
    await attach;
    expect(f.prepareManagedThread).toHaveBeenCalledTimes(3);
  });

  it("requires an explicit canonical old identity when no recovery association exists", async () => {
    const f = await fixture();
    await expect(f.coordinator.replace(f.input, "old-thread")).rejects.toThrow(
      "association changed",
    );
    expect(f.prepareManagedThread).not.toHaveBeenCalled();
    await expect(
      f.coordinator.replace(
        {
          ...f.input,
          configuration: { ...f.input.configuration, threadId: "old-thread" },
        },
        "old-thread",
      ),
    ).resolves.toEqual({ threadId: "native-thread" });
    expect(f.prepareManagedThread.mock.calls[0]![0]).toMatchObject({
      threadId: null,
      intent: "configure",
    });
  });

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

  it("upgrades a matching legacy route journal before later same-account route changes", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    const [name] = await readdir(f.directory);
    const filename = path.join(f.directory, name!);
    const i = f.input.identity;
    const c = f.input.configuration;
    const legacy = createHash("sha256")
      .update(
        JSON.stringify([
          i.placementId,
          i.projectId,
          i.contextKind,
          c.cwd,
          c.executionProfile,
          c.model.routeId,
          c.provider.id,
          c.provider.kind,
          c.provider.accountId ?? null,
          c.provider.credentialHomeKey ?? null,
        ]),
      )
      .digest("hex");
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        identity: legacy,
        threadId: "legacy-native",
        prepared: true,
      }),
    );
    await new ManagedSessionCoordinator(f.directory).prepare({
      ...f.input,
      configuration: { ...c, intent: "preserve" },
    });
    expect(f.prepareManagedThread.mock.calls[1]![0]).toMatchObject({
      threadId: "legacy-native",
      intent: "preserve",
    });
    expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({
      version: 2,
      threadId: "legacy-native",
    });
    await new ManagedSessionCoordinator(f.directory).prepare({
      ...f.input,
      configuration: {
        ...c,
        intent: "preserve",
        model: { ...c.model, routeId: "next-route" },
      },
    });
    expect(f.prepareManagedThread.mock.calls[2]![0]).toMatchObject({
      threadId: "legacy-native",
      intent: "preserve",
    });
  });

  it("recovers the same session after a root route changes within its account", async () => {
    const f = await fixture();
    await f.coordinator.prepare(f.input);
    const coordinator = new ManagedSessionCoordinator(f.directory);
    await coordinator.prepare({
      ...f.input,
      configuration: {
        ...f.input.configuration,
        intent: "preserve",
        model: {
          ...f.input.configuration.model,
          routeId: "other-route",
          name: "other-model",
        },
      },
    });
    expect(f.prepareManagedThread.mock.calls[1]![0]).toMatchObject({
      threadId: "native-thread",
      intent: "preserve",
    });
  });

  it("keeps account migrations separate from a previous unbound preparation", async () => {
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
      version: 2,
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
