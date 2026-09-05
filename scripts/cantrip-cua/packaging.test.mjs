import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildCantripCua, bundleCantripCua } from "./build.mjs";
import {
  verifyPackagedWorkerCua,
  verifyPackagedCuaSignature,
  parsePackagedWorkerCuaArguments,
} from "../verify-packaged-worker-cua.mjs";
import { verifyMacosDistribution } from "../verify-macos-distribution.mjs";
import { installDevelopmentCua } from "./development.mjs";
import { withInstallationLock } from "./install-lock.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const releaseSignature = [
  "Identifier=art.cantrip.cua",
  "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7",
  "Authority=Developer ID Application: Cantrip Test (TEAMID)",
  "TeamIdentifier=TEAMID",
].join("\n");

test("standalone release verification checks the actual signature and rejects invalid release identities", () => {
  const binary = "/final worker/bin/cantrip-cua";
  const calls = [];
  verifyPackagedCuaSignature(binary, (args) => {
    calls.push(args);
    return releaseSignature;
  });
  assert.deepEqual(calls, [
    ["--verify", "--strict", "--verbose=2", binary],
    ["--display", "--verbose=4", binary],
  ]);
  const rejected = new Error("codesign found a modified executable");
  assert.throws(
    () =>
      verifyPackagedCuaSignature(binary, () => {
        throw rejected;
      }),
    (error) => error === rejected,
  );
  for (const details of [
    releaseSignature.replace("art.cantrip.cua", "unstable.identifier"),
    releaseSignature.replace("Developer ID Application:", "Apple Development:"),
    releaseSignature.replace("0x10000(runtime)", "0x0(none)"),
    `${releaseSignature}\nSignature=adhoc`,
    releaseSignature.replace("TeamIdentifier=TEAMID", "TeamIdentifier=not set"),
    releaseSignature.replace(/^Authority=.+$/mu, ""),
  ])
    assert.throws(() => verifyPackagedCuaSignature(binary, () => details));
  assert.deepEqual(
    parsePackagedWorkerCuaArguments([
      "/final worker",
      "--require-developer-id",
    ]),
    {
      workerDirectory: path.resolve("/final worker"),
      requireDeveloperId: true,
    },
  );
  assert.equal(
    parsePackagedWorkerCuaArguments(["/final worker"]).requireDeveloperId,
    false,
  );
  for (const args of [
    [],
    ["--require-developer-id"],
    ["worker", "--unknown"],
    ["worker", "--require-developer-id", "extra"],
  ])
    assert.throws(() => parsePackagedWorkerCuaArguments(args));
});

test(
  "development CLI installs without a circular top-level import",
  { timeout: 120_000 },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-cua-cli-test-"),
    );
    try {
      // Exercise the real CLI main branch in a separate Node process while keeping
      // its user-data destination inside this fixture (without changing HOME).
      const entry = fileURLToPath(new URL("./build.mjs", import.meta.url));
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import os from 'node:os';
      import { pathToFileURL } from 'node:url';
      os.homedir = () => ${JSON.stringify(fixture)};
      process.argv = [process.execPath, ${JSON.stringify(entry)}, '--install-dev'];
      await import(pathToFileURL(process.argv[1]).href);
    `,
        ],
        {
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            CANTRIP_DEV_PROFILE: "default",
            CANTRIP_CUA_SIGNING_IDENTITY: "",
            LOCALAPPDATA: fixture,
            XDG_DATA_HOME: fixture,
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"capturePermissionVerified": false/);
      assert.doesNotMatch(result.stderr, /unsettled top-level await/);
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  },
);

test(
  "final copied worker and desktop artifact helpers run their real protocol",
  { timeout: 120_000 },
  async () => {
    const fixture = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-cua-package-test-"),
    );
    try {
      const binary = buildCantripCua(root);
      const worker = path.join(fixture, "worker artifact");
      await bundleCantripCua(binary, path.join(worker, "bin"));
      // The helper fixture is not a complete pnpm deployment; provide its actual
      // installed Sharp package explicitly. The production verifier resolves
      // from the final worker and never falls back to repository dependencies.
      await mkdir(path.join(worker, "node_modules"));
      await symlink(
        await realpath(
          path.join(root, "cantrip_worker", "node_modules", "sharp"),
        ),
        path.join(worker, "node_modules", "sharp"),
        "junction",
      );
      const result = await verifyPackagedWorkerCua(worker);
      assert.equal(result.backend, "fake");
      assert.equal(result.modelImageEncoder.sharpVersion, "0.34.4");
      assert.ok(result.modelImageEncoder.outputBytes <= 2.5 * 1024 * 1024);
      const verifiedBinaries = [];
      const signedResult = await verifyPackagedWorkerCua(worker, {
        requireDeveloperId: true,
        runCodesign(args) {
          verifiedBinaries.push(args.at(-1));
          return releaseSignature;
        },
      });
      assert.equal(signedResult.backend, "fake");
      assert.equal(signedResult.modelImageEncoder.sharpVersion, "0.34.4");
      assert.deepEqual(verifiedBinaries, [
        path.join(worker, "bin", path.basename(binary)),
        path.join(worker, "bin", path.basename(binary)),
      ]);
      const copied = path.join(
        fixture,
        "Cantrip.app",
        "Contents",
        "Resources",
        "runtime",
        "worker",
      );
      await cp(worker, copied, { recursive: true });
      assert.equal((await verifyPackagedWorkerCua(copied)).backend, "fake");
      await writeFile(
        path.join(copied, "bin", path.basename(binary)),
        Buffer.alloc(32),
      );
      // Signature metadata alone cannot make an unlaunchable final copy pass.
      await assert.rejects(
        verifyPackagedWorkerCua(copied, {
          requireDeveloperId: true,
          runCodesign: () => releaseSignature,
        }),
      );
      await assert.rejects(
        verifyPackagedWorkerCua(path.join(fixture, "missing")),
      );

      const install = await installDevelopmentCua(binary, {
        homeDirectory: fixture,
        environment: {},
      });
      assert.deepEqual(await readFile(install.binary), await readFile(binary));
      await withInstallationLock(
        binary,
        path.join(install.directory, ".installation.lock"),
        async () => {
          await assert.rejects(
            installDevelopmentCua(binary, {
              homeDirectory: fixture,
              environment: {},
            }),
            /Could not lock/,
          );
        },
      );
      // The failed contender neither replaces the helper nor leaves a stale lock.
      assert.equal(
        (
          await installDevelopmentCua(binary, {
            homeDirectory: fixture,
            environment: {},
          })
        ).binary,
        install.binary,
      );
    } finally {
      await rm(fixture, { force: true, recursive: true });
    }
  },
);

test("macOS verification requires stable CUA signature and runs final-layout handshake", async () => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-cua-sign-test-"),
  );
  try {
    const app = path.join(fixture, "Cantrip.app");
    const worker = path.join(app, "Contents", "Resources", "runtime", "worker");
    const binary = path.join(worker, "bin", "cantrip-cua");
    const dmg = path.join(fixture, "Cantrip.dmg");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    await writeFile(dmg, "fixture");
    let identifier = "art.cantrip.cua";
    let observed;
    const options = {
      bundleDirectory: fixture,
      runCommand(_command, args) {
        if (args[0] !== "-dvvv") return "";
        const target = args.at(-1);
        return [
          `Identifier=${target === binary ? identifier : "art.cantrip"}`,
          "flags=0x10000(runtime)",
          "Authority=Developer ID Application: Test (TEAM)",
        ].join("\n");
      },
      verifyCua: async (directory) => {
        observed = directory;
      },
    };
    await verifyMacosDistribution(options);
    assert.equal(observed, worker);
    identifier = "accidental-build-path";
    await assert.rejects(
      verifyMacosDistribution(options),
      /stable art.cantrip.cua signing identifier/,
    );
    identifier = "art.cantrip.cua";
    await assert.rejects(
      verifyMacosDistribution({
        ...options,
        verifyCua: async () => {
          throw new Error("actual launch failed");
        },
      }),
      /actual launch failed/,
    );
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});
