import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatScratchManager } from "./chat-scratch.js";

const temporaryDirectories: string[] = [];
const rootId = "019fdcf5-a6e7-75fb-bdf7-22b697df3a57";
const chatId = "019fdcf5-c116-77d0-9588-7c65fc3bc7c2";
const jobId = "019fdcf6-1939-75b4-bb2a-a2f091ba6bf2";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-chat-scratch-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ChatScratchManager", () => {
  it("provisions one private, idempotent directory named for the Chat", async () => {
    const dataDirectory = await temporaryDirectory();
    const manager = new ChatScratchManager(dataDirectory);

    const first = await manager.provision({
      rootId,
      chatId,
      jobId,
      attempt: 1,
    });
    await writeFile(path.join(first.path, "notes.txt"), "retained");
    const second = await manager.provision({
      rootId,
      chatId,
      jobId,
      attempt: 2,
    });

    expect(first).toMatchObject({
      rootId,
      chatId,
      reused: false,
      displayPath: path.join("chat-scratch", chatId),
    });
    expect(second).toMatchObject({ reused: true, path: first.path });
    await expect(
      readFile(path.join(second.path, "notes.txt"), "utf8"),
    ).resolves.toBe("retained");
  });

  it("rejects non-canonical identities and identity collisions", async () => {
    const manager = new ChatScratchManager(await temporaryDirectory());
    await expect(
      manager.provision({
        rootId,
        chatId: chatId.toUpperCase(),
        jobId,
        attempt: 1,
      }),
    ).rejects.toThrow(/canonical lowercase UUID/u);
    await manager.provision({ rootId, chatId, jobId, attempt: 1 });
    await expect(
      manager.provision({
        rootId,
        chatId: "019fdcf6-6bd2-7621-a6f7-b195abde09c5",
        jobId,
        attempt: 2,
      }),
    ).rejects.toThrow(/conflicts/u);
  });

  it("rejects symbolic-link roots and targets", async () => {
    const dataDirectory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(dataDirectory, "chat-scratch"));
    await expect(
      new ChatScratchManager(dataDirectory).provision({
        rootId,
        chatId,
        jobId,
        attempt: 1,
      }),
    ).rejects.toThrow(/not a safe directory/u);

    const secondDataDirectory = await temporaryDirectory();
    await mkdir(path.join(secondDataDirectory, "chat-scratch"));
    await symlink(
      outside,
      path.join(secondDataDirectory, "chat-scratch", chatId),
    );
    await expect(
      new ChatScratchManager(secondDataDirectory).provision({
        rootId,
        chatId,
        jobId,
        attempt: 1,
      }),
    ).rejects.toThrow(/not a safe directory/u);
  });

  it("persists archive deadlines and reconciles state after restart", async () => {
    const dataDirectory = await temporaryDirectory();
    const manager = new ChatScratchManager(dataDirectory);
    await manager.provision({ rootId, chatId, jobId, attempt: 1 });
    await manager.archive({
      rootId,
      chatId,
      archivedAt: "2026-01-01T00:00:00.000Z",
      archiveExpiresAt: "2026-04-01T00:00:00.000Z",
    });

    const restarted = new ChatScratchManager(dataDirectory);
    await expect(
      restarted.reconcile(
        [
          {
            rootId,
            chatId,
            archivedAt: "2026-01-01T00:00:00.000Z",
            archiveExpiresAt: "2026-04-01T00:00:00.000Z",
          },
          {
            rootId: "019fdcf6-6bd2-7621-a6f7-b195abde09c5",
            chatId: "019fdcf6-7211-773e-a157-a0519110d6e5",
            archivedAt: null,
            archiveExpiresAt: null,
          },
        ],
        new Date("2026-05-01T00:00:00.000Z"),
      ),
    ).resolves.toEqual({
      retainedRootIds: [rootId],
      missingRootIds: ["019fdcf6-6bd2-7621-a6f7-b195abde09c5"],
      orphanedRootIds: [],
      dueRootIds: [rootId],
    });
    await expect(restarted.restore({ rootId, chatId })).resolves.toMatchObject({
      archivedAt: null,
      archiveExpiresAt: null,
    });
  });

  it("deletes only the exact registered identity and stays idempotent", async () => {
    const dataDirectory = await temporaryDirectory();
    const manager = new ChatScratchManager(dataDirectory);
    const provisioned = await manager.provision({
      rootId,
      chatId,
      jobId,
      attempt: 1,
    });
    await expect(
      manager.delete({
        rootId,
        chatId: "019fdcf6-7211-773e-a157-a0519110d6e5",
        jobId,
        attempt: 1,
      }),
    ).rejects.toThrow();
    await expect(access(provisioned.path)).resolves.toBeUndefined();
    await expect(
      manager.delete({ rootId, chatId, jobId, attempt: 1 }),
    ).resolves.toMatchObject({ deleted: true });
    await expect(
      manager.delete({ rootId, chatId, jobId, attempt: 2 }),
    ).resolves.toMatchObject({ deleted: false });
  });
});
