import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  developmentProfileConfigPath,
  developmentProfileStateDirectory,
  ensureDevtopTauriConfig,
  parseDevtopProfileArguments,
} from "./devtop-tauri-config.mjs";

async function withRepository(testBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-dev-profile-"));
  const commonDirectory = path.join(root, "common.git");
  const primaryRoot = path.join(root, "primary");
  const worktreeRoot = path.join(root, "worktree");
  await Promise.all([
    mkdir(commonDirectory, { recursive: true }),
    mkdir(path.join(primaryRoot, ".cantrip", "dev"), { recursive: true }),
    mkdir(path.join(worktreeRoot, ".cantrip", "dev"), { recursive: true }),
  ]);
  try {
    await testBody({ commonDirectory, primaryRoot, worktreeRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const legacyConfig = {
  productName: "Cantrip",
  identifier: "art.cantrip.dev.heeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};

test("the shared default profile adopts the primary checkout's legacy identity", async () => {
  await withRepository(
    async ({ commonDirectory, primaryRoot, worktreeRoot }) => {
      const legacyPath = path.join(
        primaryRoot,
        ".cantrip",
        "dev",
        "tauri-dev.conf.json",
      );
      await writeFile(legacyPath, `${JSON.stringify(legacyConfig)}\n`, "utf8");
      const result = await ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
        repositoryCommonDirectory: commonDirectory,
        createUuid: () => {
          throw new Error("must adopt rather than rotate");
        },
        legacyConfigPaths: [legacyPath],
      });

      assert.equal(result.created, true);
      assert.equal(result.adoptedFrom, legacyPath);
      assert.deepEqual(result.config, legacyConfig);
      assert.deepEqual(
        JSON.parse(await readFile(result.configPath, "utf8")),
        legacyConfig,
      );
      assert.deepEqual(
        JSON.parse(await readFile(result.launchConfigPath, "utf8")),
        legacyConfig,
      );
    },
  );
});

test("rebuilding or replacing a worktree reuses the shared named identity", async () => {
  await withRepository(async ({ commonDirectory, worktreeRoot }) => {
    let uuidCalls = 0;
    const input = {
      repositoryRoot: worktreeRoot,
      repositoryCommonDirectory: commonDirectory,
      createUuid: () => {
        uuidCalls += 1;
        return "12345678-90ab-cdef-1234-567890abcdef";
      },
      legacyConfigPaths: [],
    };
    const first = await ensureDevtopTauriConfig(input);
    await rm(path.join(worktreeRoot, ".cantrip"), {
      recursive: true,
      force: true,
    });
    const second = await ensureDevtopTauriConfig(input);

    assert.equal(uuidCalls, 1);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.config, first.config);
    assert.equal(second.configPath, first.configPath);
    assert.equal(
      second.config.identifier,
      "art.cantrip.dev.h1234567890abcdef1234567890abcdef",
    );
  });
});

test("explicit clean profiles have independent stable identities and state", async () => {
  await withRepository(async ({ commonDirectory, worktreeRoot }) => {
    const first = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      repositoryCommonDirectory: commonDirectory,
      profileName: "migration-test",
      createUuid: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });
    const second = await ensureDevtopTauriConfig({
      repositoryRoot: worktreeRoot,
      repositoryCommonDirectory: commonDirectory,
      profileName: "update-test",
      createUuid: () => "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    });

    assert.notEqual(first.config.identifier, second.config.identifier);
    assert.notEqual(first.configPath, second.configPath);
    assert.equal(
      first.stateDirectory,
      path.join(worktreeRoot, ".cantrip", "dev-profiles", "migration-test"),
    );
    assert.equal(
      second.stateDirectory,
      path.join(worktreeRoot, ".cantrip", "dev-profiles", "update-test"),
    );
  });
});

test("a simultaneous shared-profile winner is adopted", async () => {
  await withRepository(async ({ commonDirectory, worktreeRoot }) => {
    const configPath = developmentProfileConfigPath(commonDirectory, "default");
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
          await mkdir(path.dirname(configPath), { recursive: true });
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
      repositoryCommonDirectory: commonDirectory,
      createUuid: () => "dddddddd-dddd-dddd-dddd-dddddddddddd",
      legacyConfigPaths: [],
      readTextFile,
    });
    assert.equal(result.created, false);
    assert.deepEqual(result.config, winningConfig);
  });
});

test("invalid shared identity fails instead of silently rotating", async () => {
  await withRepository(async ({ commonDirectory, worktreeRoot }) => {
    const configPath = developmentProfileConfigPath(commonDirectory, "default");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ productName: "Cantrip", identifier: "art.cantrip" }),
      "utf8",
    );
    await assert.rejects(
      ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
        repositoryCommonDirectory: commonDirectory,
      }),
      /never rotated automatically/u,
    );
  });
});

test("unpaired existing state fails instead of receiving a new identity", async () => {
  await withRepository(async ({ commonDirectory, worktreeRoot }) => {
    await writeFile(
      path.join(worktreeRoot, ".cantrip", "dev", "server-state.json"),
      "{}",
      "utf8",
    );
    await assert.rejects(
      ensureDevtopTauriConfig({
        repositoryRoot: worktreeRoot,
        repositoryCommonDirectory: commonDirectory,
        legacyConfigPaths: [],
      }),
      /will not pair existing encrypted data with a new identity/u,
    );
  });
});

test("profile selection is explicit and rejects conflicting sources", () => {
  assert.equal(parseDevtopProfileArguments([], {}), "default");
  assert.equal(
    parseDevtopProfileArguments(["--profile", "Update-Test"], {}),
    "update-test",
  );
  assert.equal(
    parseDevtopProfileArguments([], { CANTRIP_DEV_PROFILE: "migration-test" }),
    "migration-test",
  );
  assert.throws(
    () =>
      parseDevtopProfileArguments(["--profile=one"], {
        CANTRIP_DEV_PROFILE: "two",
      }),
    /conflicts/u,
  );
  assert.throws(
    () => parseDevtopProfileArguments(["--profile", "../escape"], {}),
    /must start with a letter/u,
  );
  assert.throws(
    () => parseDevtopProfileArguments(["--profile"], {}),
    /requires a profile name/u,
  );
  assert.throws(
    () => parseDevtopProfileArguments(["--profile="], {}),
    /requires a profile name/u,
  );
});

test("default and named state paths preserve the existing default contract", () => {
  assert.equal(
    developmentProfileStateDirectory("/repo", "default"),
    path.join("/repo", ".cantrip", "dev"),
  );
  assert.equal(
    developmentProfileStateDirectory("/repo", "clean-test"),
    path.join("/repo", ".cantrip", "dev-profiles", "clean-test"),
  );
});
