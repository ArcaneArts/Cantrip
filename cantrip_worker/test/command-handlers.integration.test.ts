import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerEvent } from "@cantrip/protocol";
import { AttachmentStore } from "../src/attachment-store.js";
import {
  openWorkerAttachmentChunk,
  protectWorkerAttachmentChunk,
  protectWorkerAttachmentMetadata,
} from "../src/attachment-encryption.js";
import { handleAttachmentCommand } from "../src/commands/attachment.js";
import { handleGitCommand } from "../src/commands/git.js";
import { handleWorkspaceCommand } from "../src/commands/workspace.js";
import {
  handleWorktreeCommand,
  type WorktreeCommandDependencies,
} from "../src/commands/worktree.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";
import { WorktreeManager } from "../src/worktrees.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function temporaryRoot() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "cantrip-command-handlers-")),
  );
  directories.push(root);
  return root;
}
async function repository() {
  const root = await temporaryRoot(),
    cwd = path.join(root, "repo");
  await mkdir(cwd);
  await exec("git", ["init", "-b", "main", cwd]);
  await exec("git", ["-C", cwd, "config", "user.name", "Cantrip Test"]);
  await exec("git", ["-C", cwd, "config", "user.email", "test@cantrip.art"]);
  await writeFile(path.join(cwd, "README.md"), "initial\n");
  await exec("git", ["-C", cwd, "add", "."]);
  await exec("git", ["-C", cwd, "commit", "-m", "Initial"]);
  return { root, cwd };
}
function encryption() {
  const key = randomBytes(32);
  return {
    ownerId: () => "owner",
    componentKey: () => ({ key: Uint8Array.from(key), keyRevision: 1 }),
  } as unknown as WorkerEncryptionService;
}

describe("feature command integration", () => {
  it("discovers a real Git repository with request-scoped progress and reads its status", async () => {
    const { root, cwd } = await repository();
    const events: WorkerEvent[] = [];
    const jobId = randomUUID();
    const result = (await handleWorkspaceCommand(
      {
        type: "workspace.repositories.discover",
        jobId,
        attempt: 2,
        rootPath: root,
        depth: 2,
      },
      (event) => events.push(event),
    )) as { candidates: Array<{ path: string }> };
    expect(result.candidates.map((candidate) => candidate.path)).toContain(cwd);
    expect(events.length).toBeGreaterThan(0);
    expect(
      events.every(
        (event) =>
          event.type === "workspace.repositories.discovery-progress" &&
          event.jobId === jobId &&
          event.attempt === 2,
      ),
    ).toBe(true);
    await writeFile(path.join(cwd, "untracked.txt"), "pending\n");
    const status = await handleGitCommand({ type: "git.status", cwd });
    expect(JSON.stringify(status)).toContain("untracked.txt");
  });

  it("creates, lists and removes an actual managed worktree through extracted commands", async () => {
    const { root, cwd } = await repository();
    const manager = new WorktreeManager(path.join(root, "worker"));
    const stopForPath = vi.fn().mockResolvedValue(undefined);
    const forgetPath = vi.fn();
    const dependencies: WorktreeCommandDependencies = {
      worktrees: manager,
      runConfigurationRuntimes: { stopForPath },
      codegraphObservations: { forgetPath, configure: vi.fn() },
      getCodegraphProjects: () => null,
    };
    try {
      const created = (await handleWorktreeCommand(
        {
          type: "worktree.create",
          sourcePath: cwd,
          worktreeId: randomUUID(),
          name: "feature",
          mode: { type: "newBranch", branch: "feature", startPoint: "HEAD" },
        },
        dependencies,
      )) as { created: boolean; worktree: { path: string } };
      expect(created.created).toBe(true);
      expect(
        await readFile(path.join(created.worktree.path, "README.md"), "utf8"),
      ).toBe("initial\n");
      const listed = (await handleWorktreeCommand(
        { type: "worktree.list", sourcePath: cwd },
        dependencies,
      )) as { worktrees: Array<{ path: string }> };
      expect(
        listed.worktrees.some((entry) => entry.path === created.worktree.path),
      ).toBe(true);
      await expect(
        handleWorktreeCommand(
          {
            type: "worktree.remove",
            sourcePath: cwd,
            worktreePath: created.worktree.path,
            allowExternal: false,
            force: false,
          },
          dependencies,
        ),
      ).resolves.toMatchObject({ removedPath: created.worktree.path });
      expect(stopForPath).toHaveBeenCalledWith(created.worktree.path);
      expect(forgetPath).toHaveBeenCalledWith(created.worktree.path);
      await expect(
        readFile(path.join(created.worktree.path, "README.md")),
      ).rejects.toThrow();
    } finally {
      manager.close();
    }
  });

  it("round-trips encrypted attachment commands through the real store", async () => {
    const root = await temporaryRoot(),
      service = encryption(),
      store = new AttachmentStore(root);
    const chatId = randomUUID(),
      attachmentId = randomUUID(),
      operationId = randomUUID();
    const bytes = Buffer.from("encrypted command payload");
    const protectedMetadata = await protectWorkerAttachmentMetadata({
      chatId,
      attachmentId,
      service,
      content: {
        version: 1,
        fileName: "sample.txt",
        mimeType: "text/plain",
        kind: "file",
        source: "file",
        previewText: null,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        error: null,
      },
    });
    const dependencies = { attachments: store, workerEncryption: service };
    await expect(
      handleAttachmentCommand(
        {
          type: "attachment.upload.begin",
          direction: "upload",
          chatId,
          attachmentId,
          operationId,
          protectedMetadata,
          sizeBytes: bytes.length,
        },
        dependencies,
      ),
    ).resolves.toEqual({ accepted: true });
    const chunk = await protectWorkerAttachmentChunk({
      chatId,
      attachmentId,
      operationId,
      direction: "upload",
      sequence: 0,
      eof: true,
      bytes,
      service,
    });
    await handleAttachmentCommand(
      {
        type: "attachment.upload.chunk",
        chatId,
        attachmentId,
        operationId,
        direction: "upload",
        chunk,
      },
      dependencies,
    );
    await expect(
      handleAttachmentCommand(
        {
          type: "attachment.upload.complete",
          chatId,
          attachmentId,
          operationId,
        },
        dependencies,
      ),
    ).resolves.toMatchObject({ verified: true });
    const result = (await handleAttachmentCommand(
      {
        type: "attachment.read",
        chatId,
        attachmentId,
        protectedMetadata,
        operationId,
        direction: "download",
        sequence: 0,
        offset: 0,
        limit: 128,
      },
      dependencies,
    )) as { chunk: typeof chunk; sizeBytes: number };
    expect(result.sizeBytes).toBe(bytes.length);
    expect(
      Buffer.from(
        await openWorkerAttachmentChunk({
          chatId,
          attachmentId,
          operationId,
          direction: "download",
          chunk: result.chunk,
          service,
        }),
      ).toString(),
    ).toBe(bytes.toString());
    await handleAttachmentCommand(
      { type: "attachment.delete", chatId, attachmentId },
      dependencies,
    );
    await expect(
      store.read(chatId, attachmentId, "sample.txt", 0, 128),
    ).rejects.toThrow();
  });

  it("clears decrypted upload bytes when the store rejects the write", async () => {
    const service = encryption(),
      chatId = randomUUID(),
      attachmentId = randomUUID(),
      operationId = randomUUID();
    const chunk = await protectWorkerAttachmentChunk({
      chatId,
      attachmentId,
      operationId,
      direction: "upload",
      sequence: 0,
      eof: true,
      bytes: Buffer.from("private"),
      service,
    });
    let observed: Uint8Array | undefined;
    const attachments = {
      append: async (
        _chat: string,
        _attachment: string,
        _sequence: number,
        bytes: Uint8Array,
      ) => {
        observed = bytes;
        throw new Error("disk full");
      },
    } as unknown as AttachmentStore;
    await expect(
      handleAttachmentCommand(
        {
          type: "attachment.upload.chunk",
          chatId,
          attachmentId,
          operationId,
          direction: "upload",
          chunk,
        },
        { workerEncryption: service, attachments },
      ),
    ).rejects.toThrow("disk full");
    expect(observed?.length).toBe(7);
    expect(observed?.every((byte) => byte === 0)).toBe(true);
  });
});
