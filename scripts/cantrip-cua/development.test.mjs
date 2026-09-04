import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  developmentCuaPaths,
  inspectDevelopmentCua,
  installDevelopmentCua,
} from "./development.mjs";

test("named development helper location is independent of worktrees and build output", () => {
  const options = {
    homeDirectory: path.resolve("home"),
    platform: "darwin",
    environment: {},
  };
  const first = developmentCuaPaths(options);
  const rebuilt = developmentCuaPaths({
    ...options,
    environment: { CARGO_TARGET_DIR: "/new/build", PWD: "/another/worktree" },
  });
  assert.deepEqual(first, rebuilt);
  assert.equal(
    first.binary,
    path.join(
      options.homeDirectory,
      "Library",
      "Application Support",
      "art.cantrip.cua",
      "development",
      "default",
      "cantrip-cua",
    ),
  );
  assert.notEqual(
    first.binary,
    developmentCuaPaths({ ...options, profileName: "test-profile" }).binary,
  );
  assert.equal(
    developmentCuaPaths({ ...options, profileName: "a".repeat(48) }).profileName
      .length,
    48,
  );
  for (const profileName of ["../escape", "a".repeat(49), ""])
    assert.throws(() => developmentCuaPaths({ ...options, profileName }));
});

test("Windows and Linux use their native user-data conventions", () => {
  const homeDirectory = path.resolve("home");
  assert.equal(
    developmentCuaPaths({
      homeDirectory,
      platform: "win32",
      environment: { LOCALAPPDATA: path.resolve("localdata") },
    }).binary,
    path.resolve(
      "localdata",
      "art.cantrip.cua",
      "development",
      "default",
      "cantrip-cua.exe",
    ),
  );
  assert.equal(
    developmentCuaPaths({
      homeDirectory,
      platform: "linux",
      environment: { XDG_DATA_HOME: path.resolve("xdgdata") },
    }).binary,
    path.resolve(
      "xdgdata",
      "art.cantrip.cua",
      "development",
      "default",
      "cantrip-cua",
    ),
  );
});

test("signed development rebuild reuses deliberate identity and preserves prior binary on signing failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cua-dev-"));
  try {
    const source = path.join(root, "source");
    const calls = [];
    const options = {
      homeDirectory: root,
      platform: "darwin",
      runCodesign: (args) => calls.push(args),
      runLocked: (_binary, _path, action) => action(),
      runSmoke: async () => {},
    };
    await writeFile(source, "first build");
    const initial = await installDevelopmentCua(source, {
      ...options,
      environment: {
        CANTRIP_CUA_SIGNING_IDENTITY: "Apple Development: fixture",
      },
    });
    assert.equal(await readFile(initial.binary, "utf8"), "first build");
    await writeFile(source, "second build");
    const rebuilt = await installDevelopmentCua(source, {
      ...options,
      environment: {},
    });
    assert.equal(rebuilt.binary, initial.binary);
    assert.equal(rebuilt.signingIdentity, "Apple Development: fixture");
    assert.equal(await readFile(rebuilt.binary, "utf8"), "second build");
    await assert.rejects(
      installDevelopmentCua(source, {
        ...options,
        environment: {},
        runSmoke() {
          throw new Error("runtime failed");
        },
      }),
      /runtime failed/,
    );
    assert.equal(await readFile(rebuilt.binary, "utf8"), "second build");
    assert.equal(calls.length, 6);
    assert.ok(calls[2].includes("art.cantrip.cua.dev"));
    assert.ok(calls[2].includes("Apple Development: fixture"));
    assert.deepEqual(calls[3].slice(0, 2), ["--verify", "--strict"]);
    await assert.rejects(
      installDevelopmentCua(source, {
        ...options,
        environment: {},
        runCodesign() {
          throw new Error("signing denied");
        },
      }),
      /signing denied/,
    );
    assert.equal(await readFile(rebuilt.binary, "utf8"), "second build");
    assert.equal(
      (await inspectDevelopmentCua({ ...options, environment: {} }))
        .capturePermissionVerified,
      undefined,
    );
    await assert.rejects(
      installDevelopmentCua(source, {
        ...options,
        environment: { CANTRIP_CUA_SIGNING_IDENTITY: "-" },
      }),
      /Ad-hoc/,
    );
    await writeFile(initial.configuration, "broken configuration");
    await assert.rejects(
      installDevelopmentCua(source, { ...options, environment: {} }),
    );
    assert.equal(await readFile(rebuilt.binary, "utf8"), "second build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsigned/fake development does not invoke native signing or capture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cua-unsigned-"));
  try {
    const source = path.join(root, "source");
    await writeFile(source, "fake");
    const result = await installDevelopmentCua(source, {
      homeDirectory: root,
      platform: "darwin",
      environment: {},
      runLocked: (_binary, _path, action) => action(),
      runSmoke: async () => {},
      runCodesign() {
        assert.fail("unexpected signing");
      },
    });
    assert.equal(result.signingIdentity, null);
    assert.equal(result.capturePermissionVerified, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
