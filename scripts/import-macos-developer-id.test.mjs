import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const importer = fileURLToPath(
  new URL("./import-macos-developer-id.sh", import.meta.url),
);
const supported = process.platform !== "win32";
const priorKeychains = [
  "/fixture/user/login.keychain-db",
  "/fixture/with spaces/build.keychain-db",
];
const mockTool = `import fs from 'node:fs';
import path from 'node:path';
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const safe = args.map(value => [process.env.APPLE_CERTIFICATE_PASSWORD, process.env.KEYCHAIN_PASSWORD].includes(value) ? '[redacted]' : value);
state.calls.push([name, ...safe]);
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
save();
if (process.env.MOCK_FAIL === name + ':' + args[0]) process.exit(41);
if (name === 'security') {
  if (args[0] === 'list-keychains') {
    if (args.includes('-s')) state.keychains = args.slice(args.indexOf('-s') + 1);
    else process.stdout.write(state.keychains.map(value => '    "' + value + '"').join('\\n') + '\\n');
  }
  if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'synthetic keychain');
  if (args[0] === 'delete-keychain') {
    state.keychains = state.keychains.filter(value => value !== args[1]);
    fs.rmSync(args[1], {force:true});
  }
  if (args[0] === 'find-certificate') process.stdout.write('synthetic leaf certificate\\n');
  if (args[0] === 'find-identity') process.stdout.write('  1) ' + (process.env.MOCK_MISMATCH ? 'BBCC' : 'AABB') + ' "Developer ID Application: Fixture (FIXTURE)"\\n');
  save();
} else if (name === 'openssl') {
  if (args[0] === 'base64') {
    fs.readFileSync(0);
    fs.writeFileSync(args[args.indexOf('-out') + 1], 'synthetic certificate');
  } else if (args.includes('-fingerprint')) process.stdout.write('sha1 Fingerprint=AA:BB\\n');
  else process.stdout.write('synthetic certificate metadata\\n');
} else if (name === 'curl') fs.writeFileSync(args[args.indexOf('--output') + 1], 'synthetic public chain');
else if (name === 'shasum') fs.readFileSync(0);
`;

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-signing-import-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin");
  const temporary = path.join(directory, "runner temp");
  await mkdir(bin);
  await mkdir(temporary);
  for (const name of ["security", "openssl", "curl", "shasum"]) {
    const file = path.join(bin, name);
    await writeFile(file, `#!${process.execPath}\n${mockTool}`);
    await chmod(file, 0o755);
  }
  const statePath = path.join(directory, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({ keychains: priorKeychains, calls: [] }),
  );
  const githubEnv = path.join(directory, "github-env");
  await writeFile(githubEnv, "");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RUNNER_TEMP: temporary,
    GITHUB_ENV: githubEnv,
    MOCK_STATE: statePath,
    APPLE_CERTIFICATE: "synthetic-base64-certificate",
    APPLE_CERTIFICATE_PASSWORD: "synthetic-certificate-password",
    KEYCHAIN_PASSWORD: "synthetic-keychain-password",
    CANTRIP_SIGNING_KEYCHAIN: "",
    MOCK_FAIL: "",
    MOCK_MISMATCH: "",
  };
  const keychain = path.join(temporary, "cantrip-signing.keychain-db");
  return {
    keychain,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
    exported: async () => readFile(githubEnv, "utf8"),
    files: () => readdir(temporary),
    run: (args = [], extra = {}) => {
      const result = spawnSync("bash", [importer, ...args], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 10000,
      });
      // A failed test must never dump credential-bearing command arguments.
      for (const value of [
        env.APPLE_CERTIFICATE,
        env.APPLE_CERTIFICATE_PASSWORD,
        env.KEYCHAIN_PASSWORD,
      ]) {
        assert.equal(
          `${result.stdout}${result.stderr}`.includes(value),
          false,
          "importer printed credential material",
        );
      }
      assert.equal(result.error?.code, undefined, "script invocation failed");
      return result.status;
    },
  };
}

test(
  "imports the exact leaf identity, preserves existing keychains, and cleans only its temporary keychain",
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.run(), 0);
    const imported = await f.state();
    assert.deepEqual(imported.keychains, [f.keychain, ...priorKeychains]);
    assert.equal(
      imported.calls.some((call) => call[1] === "default-keychain"),
      false,
    );
    assert.equal(
      imported.calls.filter((call) => call[1] === "import").length,
      3,
    );
    assert.equal(
      imported.calls.some((call) => call[1] === "set-key-partition-list"),
      true,
    );
    assert.match(
      await f.exported(),
      /^APPLE_SIGNING_IDENTITY=Developer ID Application: Fixture \(FIXTURE\)$/m,
    );
    assert.equal(
      (await f.exported()).includes(`CANTRIP_SIGNING_KEYCHAIN=${f.keychain}\n`),
      true,
    );
    assert.deepEqual(await f.files(), ["cantrip-signing.keychain-db"]);
    assert.equal(
      f.run(["cleanup"], { CANTRIP_SIGNING_KEYCHAIN: f.keychain }),
      0,
    );
    assert.deepEqual((await f.state()).keychains, priorKeychains);
    assert.deepEqual(await f.files(), []);
  },
);

for (const failure of [
  "openssl:base64",
  "security:list-keychains",
  "security:create-keychain",
  "security:unlock-keychain",
  "security:import",
  "curl:--fail",
  "shasum:-a",
  "security:set-key-partition-list",
  "security:find-certificate",
]) {
  test(
    `cleans temporary material after actual ${failure} failure`,
    { skip: !supported },
    async (t) => {
      const f = await fixture(t);
      assert.equal(f.run([], { MOCK_FAIL: failure }), 41);
      const state = await f.state();
      assert.deepEqual(state.keychains, priorKeychains);
      if (failure === "security:create-keychain")
        assert.equal(
          state.calls.some((call) => call[1] === "delete-keychain"),
          false,
        );
      assert.deepEqual(await f.files(), []);
      assert.equal(await f.exported(), "");
    },
  );
}

test(
  "rejects an identity unrelated to the imported certificate and cleans the keychain",
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.run([], { MOCK_MISMATCH: "1" }), 1);
    assert.deepEqual((await f.state()).keychains, priorKeychains);
    assert.deepEqual(await f.files(), []);
    assert.equal(await f.exported(), "");
  },
);

test(
  "cleanup is harmless when import never ran and reports an actual deletion failure",
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.run(["cleanup"]), 0);
    assert.deepEqual((await f.state()).calls, []);
    assert.equal(f.run(), 0);
    assert.equal(
      f.run(["cleanup"], {
        CANTRIP_SIGNING_KEYCHAIN: f.keychain,
        MOCK_FAIL: "security:delete-keychain",
      }),
      41,
    );
    assert.equal(
      f.run(["cleanup"], { CANTRIP_SIGNING_KEYCHAIN: f.keychain }),
      0,
    );
    assert.deepEqual((await f.state()).keychains, priorKeychains);
  },
);

test(
  "a failed creation never deletes a keychain already present at that path",
  { skip: !supported },
  async (t) => {
    const f = await fixture(t);
    await writeFile(f.keychain, "pre-existing synthetic keychain");
    assert.equal(f.run([], { MOCK_FAIL: "security:create-keychain" }), 41);
    assert.equal(
      await readFile(f.keychain, "utf8"),
      "pre-existing synthetic keychain",
    );
    assert.equal(
      (await f.state()).calls.some((call) => call[1] === "delete-keychain"),
      false,
    );
    assert.equal(await f.exported(), "");
  },
);
