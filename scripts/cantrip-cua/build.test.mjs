import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCantripCua,
  bundleCantripCua,
  cantripCuaExecutableName,
  parseBuildArguments,
} from "./build.mjs";

test("build uses Cargo's actual executable even with a configured/custom target", () => {
  let call;
  const root = path.resolve("fixture-root");
  const executable = path.join(root, "custom-output", "actual-cantrip-cua");
  const result = buildCantripCua(root, {
    release: true,
    target: "x86_64-pc-windows-msvc",
    cargoTargetDirectory: "shared output",
    run(command, args, options) {
      call = { command, args, options };
      return [
        {
          reason: "compiler-artifact",
          target: { name: "cantrip_cua", kind: ["lib"] },
          executable: null,
        },
        {
          reason: "compiler-artifact",
          target: { name: "cantrip-cua", kind: ["bin"] },
          executable,
        },
        { reason: "build-finished", success: true },
      ]
        .map(JSON.stringify)
        .join("\n");
    },
  });
  assert.equal(result, executable);
  assert.equal(call.command, "cargo");
  assert.equal(call.options.cwd, root);
  assert.deepEqual(call.args, [
    "build",
    "--locked",
    "--manifest-path",
    path.join(root, "cantrip_cua", "Cargo.toml"),
    "--message-format=json-render-diagnostics",
    "--release",
    "--target",
    "x86_64-pc-windows-msvc",
    "--target-dir",
    path.join(root, "shared output"),
  ]);
});

test("a failed build or missing executable cannot select stale output", () => {
  assert.throws(
    () =>
      buildCantripCua("fixture", {
        run() {
          throw new Error("compile failed");
        },
      }),
    /compile failed/,
  );
  assert.throws(
    () =>
      buildCantripCua("fixture", {
        run() {
          return '{"reason":"build-finished","success":true}\n';
        },
      }),
    /did not report/,
  );
});

test("build arguments reject missing values and unknown options", () => {
  assert.deepEqual(parseBuildArguments([]), {});
  assert.deepEqual(
    parseBuildArguments([
      "--release",
      "--install-dev",
      "--target",
      "triple",
      "--target-dir",
      "output",
    ]),
    {
      release: true,
      installDev: true,
      target: "triple",
      cargoTargetDirectory: "output",
    },
  );
  for (const args of [
    ["--target"],
    ["--target-dir", "--release"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseBuildArguments(args));
  }
});

test("bundling copies exact executable bytes under platform-correct name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-cua-bundle-"));
  try {
    const source = path.join(root, "source");
    await writeFile(source, "fixture binary");
    for (const platform of ["darwin", "win32", "linux"]) {
      const binary = await bundleCantripCua(
        source,
        path.join(root, platform, "bin"),
        { platform },
      );
      assert.equal(path.basename(binary), cantripCuaExecutableName(platform));
      assert.equal(await readFile(binary, "utf8"), "fixture binary");
      if (platform !== "win32" && process.platform !== "win32")
        assert.equal((await stat(binary)).mode & 0o111, 0o111);
    }
    await assert.rejects(
      bundleCantripCua(path.join(root, "missing"), path.join(root, "bad")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
