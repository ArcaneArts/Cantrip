import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  repositoryOperationRequestContentSchema,
  workerCommandSchema,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readGitRevisionFileDiff } from "../src/git.js";
import {
  openWorkerRepositoryOperationContent,
  protectWorkerRepositoryOperationContent,
} from "../src/repository-operation-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const execFileAsync = promisify(execFile);
let directory: string;
let baseHash: string;
let targetHash: string;
const service = {
  componentKey: () => ({ key: new Uint8Array(32).fill(7), keyRevision: 1 }),
  ownerId: () => "revision-diff-owner",
} as unknown as WorkerEncryptionService;
const git = async (...args: string[]) =>
  (await execFileAsync("git", ["-C", directory, ...args])).stdout.trim();

// Exercise the real protected input and trusted-command validation used by
// repository.operation, rather than calling the Git helper with unchecked refs.
async function compare(revision: string, baseRevision: string | null) {
  const context = {
    serverId: "revision-diff-server",
    projectId: "revision-diff-project",
    worktreeId: "revision-diff-worktree",
    operationId: randomUUID(),
    direction: "request" as const,
  };
  const opaque = await protectWorkerRepositoryOperationContent({
    context,
    service,
    schema: repositoryOperationRequestContentSchema,
    content: {
      type: "git.revision.diff" as const,
      arguments: {
        revision,
        baseRevision,
        path: "example.txt",
        contextLines: 3,
      },
    },
  });
  const request = await openWorkerRepositoryOperationContent({
    context,
    service,
    opaque,
    schema: repositoryOperationRequestContentSchema,
  });
  const command = workerCommandSchema.parse({
    ...request.arguments,
    type: request.type,
    cwd: directory,
  });
  if (command.type !== "git.revision.diff")
    throw new Error("Unexpected command");
  return readGitRevisionFileDiff(
    command.cwd,
    command.revision,
    command.baseRevision,
    command.path,
    command.contextLines,
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-revision-command-"));
  await git("init", "--object-format=sha1", "-b", "main");
  await git("config", "user.name", "Cantrip Test");
  await git("config", "user.email", "test@cantrip.art");
  await writeFile(path.join(directory, "example.txt"), "original line\n");
  await git("add", "example.txt");
  await git("commit", "-m", "Base");
  baseHash = await git("rev-parse", "HEAD");
  await git("tag", "wqa-base");
  await writeFile(path.join(directory, "example.txt"), "changed line\n");
  await git("commit", "-am", "Target");
  targetHash = await git("rev-parse", "HEAD");
  await git("branch", "wqa-target");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("protected Git revision comparison", () => {
  it.each(["", "   ", "x".repeat(1_025)])(
    "rejects empty or oversized revision input before Git execution (%#)",
    async (revision) => {
      await expect(compare(revision, "HEAD~1")).rejects.toThrow();
      expect(await git("rev-parse", "HEAD")).toBe(targetHash);
      expect(await git("status", "--porcelain")).toBe("");
    },
  );

  it.each(["defaults", "short hashes", "branch and tag", "full hashes"])(
    "resolves %s to the correct patch without changing the checkout",
    async (kind) => {
      const [base, target] =
        kind === "defaults"
          ? ["HEAD~1", "HEAD"]
          : kind === "short hashes"
            ? [baseHash.slice(0, 8), targetHash.slice(0, 8)]
            : kind === "branch and tag"
              ? ["wqa-base", "wqa-target"]
              : [baseHash, targetHash];
      const result = await compare(target!, base!);
      expect(result).toMatchObject({
        revision: targetHash,
        baseRevision: baseHash,
        binary: false,
      });
      expect(result.patch).toContain("-original line");
      expect(result.patch).toContain("+changed line");
      expect(await git("rev-parse", "HEAD")).toBe(targetHash);
      expect(await git("status", "--porcelain")).toBe("");
      expect(await readFile(path.join(directory, "example.txt"), "utf8")).toBe(
        "changed line\n",
      );
    },
  );

  it.each([
    "missing-revision",
    "--help",
    "HEAD; touch injected",
    "HEAD:example.txt",
  ])("reports an unresolved %s as a concise commit error", async (revision) => {
    await expect(compare(revision, "HEAD~1")).rejects.toThrow(
      `Commit ${revision} does not exist.`,
    );
    expect(await git("rev-parse", "HEAD")).toBe(targetHash);
    expect(await git("status", "--porcelain")).toBe("");
  });

  it("rejects ambiguous abbreviated object IDs without choosing a commit", async () => {
    const tree = await git("rev-parse", "HEAD^{tree}");
    const prefixes = new Map<string, string>();
    let collision: [string, string, string] | undefined;
    for (let index = 0; index < 10_000; index += 1) {
      const content = `tree ${tree}\nauthor Cantrip Test <test@cantrip.art> 1 +0000\ncommitter Cantrip Test <test@cantrip.art> 1 +0000\n\nCollision ${index}\n`;
      const hash = createHash("sha1")
        .update(`commit ${Buffer.byteLength(content)}\0${content}`)
        .digest("hex");
      const prefix = hash.slice(0, 4);
      const prior = prefixes.get(prefix);
      if (prior) {
        collision = [prefix, prior, content];
        break;
      }
      prefixes.set(prefix, content);
    }
    expect(collision).toBeDefined();
    for (const [index, content] of collision!.slice(1).entries()) {
      const file = path.join(directory, ".git", `wqa-collision-${index}`);
      await writeFile(file, content);
      await git("hash-object", "-t", "commit", "-w", file);
      await rm(file);
    }
    await expect(compare(collision![0], "HEAD~1")).rejects.toThrow(
      `Commit ${collision![0]} does not exist.`,
    );
    expect(await git("rev-parse", "HEAD")).toBe(targetHash);
    expect(await git("status", "--porcelain")).toBe("");
  });
});
