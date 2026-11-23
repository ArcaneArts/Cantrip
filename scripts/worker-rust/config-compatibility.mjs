// Differential development fixture: only owned disposable profiles and synthetic
// credentials. Do not point this secret-emitting fixture at an actual profile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readWorkerConfig } from "../../tests/reference-node-worker/src/config.ts";
import { resolveCodexInstallation } from "../../tests/reference-node-worker/src/codex/bundled-runtime.ts";
import {
  loadOrCreateWorkerIdentity,
  loadStoredWorkerCredential,
  saveWorkerCredential,
} from "../../tests/reference-node-worker/src/credential-store.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(
  values.binary,
  "--binary requires the built config-fixture executable",
);
const binary = path.resolve(values.binary);
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-worker-config-")),
);
const workerRoot = fileURLToPath(
  new URL("../../tests/reference-node-worker", import.meta.url),
);
const credential = "ctwk_" + "a".repeat(43),
  code = "ctwl_" + "b".repeat(32);
const originalEnvironment = { ...process.env },
  originalCwd = process.cwd();
let comparisons = 0;
function rust(input) {
  const child = spawnSync(binary, [], {
    encoding: "utf8",
    input: JSON.stringify(input) + "\n",
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function observe(read) {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
function compare(input, expected, label) {
  assert.deepEqual(rust(input), expected, label);
  comparisons++;
}
try {
  const dev = { CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP: "true" };
  const cases = [
    {},
    dev,
    { ...dev, CANTRIP_WORKER_NAME: "", CANTRIP_WORKER_DATA_DIR: "" },
    { ...dev, CANTRIP_WORKER_TOKEN: " legacy " },
    { CANTRIP_WORKER_TOKEN: "legacy" },
    { CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP: "TRUE" },
    { ...dev, CANTRIP_SERVER_URL: "https://remote.example" },
    ...[
      "http://[::1]/",
      "http://localhost/",
      "http://2130706433/",
      "http://127.0.0.1/?",
      "http://127.0.0.1/#",
      "http://127.0.0.1/./",
      "http://127.0.0.2",
      "http://user@localhost",
      "http://localhost/path",
      "https://localhost/?x",
      "ftp://localhost",
      "invalid",
    ].map((url) => ({ ...dev, CANTRIP_SERVER_URL: url })),
    { CANTRIP_WORKER_ENROLLMENT_CODE: code },
    {
      CANTRIP_WORKER_ENROLLMENT_CODE: "\ufeff" + code + "\ufeff",
      CANTRIP_WORKER_ID: "  fixture-worker  ",
    },
    { CANTRIP_WORKER_ENROLLMENT_CODE: "invalid" },
    {
      CANTRIP_WORKER_ENROLLMENT_CODE: code,
      CANTRIP_WORKER_CREDENTIAL: credential,
    },
    { CANTRIP_WORKER_CREDENTIAL: credential },
    { CANTRIP_WORKER_CREDENTIAL: "invalid", CANTRIP_WORKER_ID: "worker" },
    { CANTRIP_WORKER_CREDENTIAL: credential, CANTRIP_WORKER_ID: "worker" },
    {
      ...dev,
      CANTRIP_WORKER_CREDENTIAL: credential,
      CANTRIP_WORKER_ID: "worker",
    },
    { CANTRIP_WORKER_ENROLLMENT_CODE: code, CANTRIP_WORKER_REPLACES_ID: "old" },
    {
      CANTRIP_WORKER_REPLACES_ID: "old",
      CANTRIP_WORKER_REPLACES_CREDENTIAL: credential,
    },
    {
      CANTRIP_WORKER_ENROLLMENT_CODE: code,
      CANTRIP_WORKER_REPLACES_ID: "old",
      CANTRIP_WORKER_REPLACES_CREDENTIAL: "invalid",
    },
    {
      CANTRIP_WORKER_ENROLLMENT_CODE: code,
      CANTRIP_WORKER_REPLACES_ID: "old",
      CANTRIP_WORKER_REPLACES_CREDENTIAL: credential,
    },
  ];
  for (const [index, inputEnvironment] of cases.entries()) {
    const directory = path.join(root, "config-" + index);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "worker-identity.json"),
      JSON.stringify({ version: 1, workerId: "worker-雪😀\ud800" }),
    );
    const environment = {
      CANTRIP_WORKER_DATA_DIR: directory,
      CANTRIP_CODEX_BIN: "unprobed-codex",
      ...inputEnvironment,
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("CANTRIP_")) delete process.env[key];
    Object.assign(process.env, environment);
    process.chdir(directory);
    compare(
      {
        directory,
        workerRoot,
        environment,
        platform: process.platform,
        architecture: process.arch,
        hostname: hostname(),
      },
      observe(readWorkerConfig),
      "config " + index,
    );
  }
  process.chdir(originalCwd);
  for (const [index, raw] of [
    "{",
    "null",
    "false",
    "0",
    '""',
    "{}",
    '{"version":2,"workerId":"bad"}',
    '{"version":1,"workerId":"worker-雪😀\\ud800"}',
  ].entries()) {
    const directory = path.join(root, "stored-" + index);
    await mkdir(directory);
    const identityPath = path.join(directory, "worker-identity.json");
    await writeFile(identityPath, raw);
    const expected = observe(() => loadOrCreateWorkerIdentity(directory));
    const actual = rust({ operation: "identity", directory });
    if (expected.ok || expected.error.includes("stored worker identity"))
      assert.deepEqual(actual, expected);
    else
      assert.equal(
        actual.ok,
        false,
        "exclusive creation must reject existing malformed file",
      );
    assert.equal(
      await readFile(identityPath, "utf8"),
      raw,
      "never overwrite malformed identity",
    );
    comparisons++;
  }
  const directory = path.join(root, "cross-language");
  const generated = rust({ operation: "identity", directory });
  assert.equal(generated.ok, true);
  assert.match(generated.value, /^worker-[a-f0-9-]{36}$/);
  assert.equal(loadOrCreateWorkerIdentity(directory), generated.value);
  const stored = {
    credential,
    dataDirectory: directory,
    serverUrl: "https://server.example",
    workerId: "worker-雪😀\ud800",
  };
  saveWorkerCredential(stored);
  const nodeBytes = await readFile(
    path.join(directory, "worker-credential.json"),
    "utf8",
  );
  compare(
    { operation: "load", directory, serverUrl: stored.serverUrl },
    observe(() => loadStoredWorkerCredential(directory, stored.serverUrl)),
    "Rust reads Node credentials",
  );
  compare(
    { operation: "load", directory, serverUrl: "https://foreign.example" },
    observe(() =>
      loadStoredWorkerCredential(directory, "https://foreign.example"),
    ),
    "foreign-server rejection",
  );
  assert.deepEqual(rust({ operation: "save", directory, ...stored }), {
    ok: true,
    value: null,
  });
  assert.equal(
    await readFile(path.join(directory, "worker-credential.json"), "utf8"),
    nodeBytes,
    "byte-identical credential format",
  );
  assert.equal(
    loadStoredWorkerCredential(directory, stored.serverUrl).workerId,
    stored.workerId,
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(path.join(directory, "worker-credential.json"))).mode & 0o777,
      0o600,
    );
  for (const extra of [
    {},
    { CANTRIP_WORKER_ENROLLMENT_CODE: code },
    { CANTRIP_WORKER_ID: "explicit-id" },
    {
      CANTRIP_WORKER_ENROLLMENT_CODE: code,
      CANTRIP_WORKER_REPLACES_ID: "old",
      CANTRIP_WORKER_REPLACES_CREDENTIAL: credential,
    },
  ]) {
    const environment = {
      CANTRIP_CODEX_BIN: "unprobed-codex",
      CANTRIP_WORKER_DATA_DIR: directory,
      CANTRIP_SERVER_URL: stored.serverUrl,
      ...extra,
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("CANTRIP_")) delete process.env[key];
    Object.assign(process.env, environment);
    process.chdir(directory);
    compare(
      {
        directory,
        workerRoot,
        environment,
        hostname: hostname(),
        platform: process.platform,
        architecture: process.arch,
      },
      observe(readWorkerConfig),
      "persisted credential precedence",
    );
  }
  process.chdir(originalCwd);
  for (const [index, files] of [
    [],
    ["bin/codex-runtime.json"],
    ["bin/codex"],
    ["../cantrip_codex/.build/darwin-arm64/bundle/codex-runtime.json"],
  ].entries()) {
    const workerRoot = path.join(root, "install-" + index, "worker");
    await mkdir(workerRoot, { recursive: true });
    for (const file of files) {
      const destination = path.join(workerRoot, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "fixture");
    }
    for (const override of [undefined, "", " ", "/explicit/missing/codex"]) {
      compare(
        {
          operation: "installation",
          directory: root,
          workerRoot,
          platform: "darwin",
          architecture: "arm64",
          override,
        },
        observe(() =>
          resolveCodexInstallation({
            workerRoot,
            platform: "darwin",
            architecture: "arm64",
            override,
          }),
        ),
        "installation resolution",
      );
    }
  }
  console.log(
    JSON.stringify({
      suite: "rust-worker-configuration-credentials",
      passed: true,
      differentialComparisons: comparisons,
      bidirectionalPersistence: true,
      credentialBytesIdentical: true,
      freshIdentityReopenedByNode: true,
      privateCredentialPermissions: process.platform !== "win32",
      platform: process.platform,
    }),
  );
} finally {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env))
    if (key.startsWith("CANTRIP_")) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnvironment))
    if (key.startsWith("CANTRIP_")) process.env[key] = value;
  await rm(root, { recursive: true, force: true });
}
