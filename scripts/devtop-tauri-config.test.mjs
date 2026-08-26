import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDevtopTauriConfig } from "./devtop-tauri-config.mjs";

async function withRepository(testBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-devtop-config-"));
  const primaryRoot = path.join(root, "primary");
  const worktreeRoot = path.join(root, "worktree");
  await Promise.all([
    mkdir(path.join(primaryRoot, ".cantrip", "dev"), { recursive: true }),
    mkdir(path.join(worktreeRoot, ".cantrip", "dev"), { recursive: true }),
  ]);
  try {
    await testBody({ primaryRoot, worktreeRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Primary receives an isolated development client identity", async () => {
  await withRepository(async ({ primaryRoot }) => {
    const result = await ensureDevtopTauriConfig({
      repositoryRoot: primaryRoot,
      createUuid: () => "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
    });
    assert.equal(result.created, true);
    assert.deepEqual(result.config, {
      productName: "Cantrip",
      identifier: "art.cantrip.dev.heeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    });
  });
});

test("a development worktree generates and reuses one isolated identity", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    let uuidCalls = 0;
    const createUuid = () => {
      uuidCalls += 1;
      return "12345678-90ab-cdef-1234-567890abcdef";
    };
    const first = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      createUuid,
    });
    const second = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      createUuid,
    });
    assert.equal(uuidCalls, 1);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(
      first.config.identifier,
      "art.cantrip.dev.h1234567890abcdef1234567890abcdef",
    );
    assert.deepEqual(second.config, first.config);
    assert.deepEqual(
      JSON.parse(await readFile(first.configPath, "utf8")),
      first.config,
    );
  });
});

test("different worktree state directories receive different identities", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    const otherWorktree = `${worktreeRoot}-other`;
    await mkdir(path.join(otherWorktree, ".cantrip", "dev"), {
      recursive: true,
    });
    const first = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      createUuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    const second = await ensureDevtopTauriConfig({
      repositoryRoot: otherWorktree,
      createUuid: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });
    assert.notEqual(first.config.identifier, second.config.identifier);
  });
});

test("a simultaneous identity winner is adopted after the initial missing read", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    const configPath = path.join(
      worktreeRoot,
      ".cantrip",
      "dev",
      "tauri-dev.conf.json",
    );
    const winningConfig = {
      productName: "Cantrip",
      identifier: "art.cantrip.dev.hcccccccccccccccccccccccccccccccc",
    };
    let reads = 0;
    const readTextFile = async (...arguments_) => {
      reads += 1;
      try {
        return await readFile(...arguments_);
      } catch (error) {
        if (reads === 1 && error?.code === "ENOENT") {
          await writeFile(
            configPath,
            `${JSON.stringify(winningConfig)}\n`,
            "utf8",
          );
        }
        throw error;
      }
    };

    const result = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      createUuid: () => "dddddddd-dddd-dddd-dddd-dddddddddddd",
      readTextFile,
    });
    assert.equal(reads, 2);
    assert.equal(result.created, false);
    assert.deepEqual(result.config, winningConfig);
  });
});

test("invalid persisted identity fails instead of silently rotating encryption", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    const configPath = path.join(
      worktreeRoot,
      ".cantrip",
      "dev",
      "tauri-dev.conf.json",
    );
    await writeFile(
      configPath,
      JSON.stringify({ productName: "Cantrip", identifier: "art.cantrip" }),
      "utf8",
    );
    await assert.rejects(
      ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
      }),
      /will not be rotated automatically/u,
    );
  });
});

test("legacy worktree state fails instead of pairing it with a fresh client", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    await writeFile(
      path.join(worktreeRoot, ".cantrip", "dev", "server-state.json"),
      "{}",
      "utf8",
    );
    await assert.rejects(
      ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
      }),
      /intentionally reset its local server, client, and worker/u,
    );
  });
});

test("malformed persisted config fails with its state path", async () => {
  await withRepository(async ({ worktreeRoot }) => {
    const configPath = path.join(
      worktreeRoot,
      ".cantrip",
      "dev",
      "tauri-dev.conf.json",
    );
    await writeFile(configPath, "{broken", "utf8");
    await assert.rejects(
      ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
      }),
      new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  });
});
