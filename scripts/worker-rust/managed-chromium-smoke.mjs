// A disposable HTTPS release in the production archive and signature formats.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { eventually } from "../server-rust/full-worker.mjs";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["chromium", "worker", "server"].map((name) => [name, { type: "string" }]),
  ),
});
assert.equal(
  Boolean(values.worker),
  Boolean(values.server),
  "Pass both production executables to check the Core endpoint.",
);
assert.ok(values.chromium);
const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-managed-chromium-"));
const keyFile = path.join(root, "server-key.pem");
const cert = path.join(root, "server.pem");
const signing = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(
  signing.publicKey.export({ format: "jwk" }).x,
  "base64url",
).toString("base64");
const bodies = new Map();
const assets = new Map();
const reads = new Map();
let server;

async function makeAsset(name, runnable) {
  const content = path.join(root, name);
  const target = path.join(root, name + ".zip");
  const quoted =
    "'" + path.resolve(values.chromium).replaceAll("'", "'\\''") + "'";
  const files = {
    "build-info.json": JSON.stringify({
      schemaVersion: 1,
      component: "playwright",
      version: name,
      chromiumRevision: "fixture",
    }),
    "licenses/manifest.json": "{}",
    "source/manifest.json": "{}",
    "sbom.cdx.json": "{}",
    "certificates/ca-bundle.crt": await readFile(cert),
    "fontconfig/fonts.conf": "<fontconfig/>",
    "browsers/chrome-headless-shell": runnable
      ? `#!/bin/sh\nexec ${quoted} "$@"\n`
      : "#!/bin/sh\nexit 21\n",
  };
  for (const [name, body] of Object.entries(files)) {
    const destination = path.join(content, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body, {
      mode: name.startsWith("browsers/") ? 0o700 : 0o600,
    });
  }
  await run("python3", [
    "managed_runtimes/searxng/tools/archive_runtime.py",
    content,
    target,
  ]);
  const archive = await readFile(target);
  assets.set("/archive/" + name, archive);
  return {
    schemaVersion: 1,
    component: "playwright",
    version: name,
    platform: process.platform,
    architecture: process.arch,
    archiveFormat: "zip",
    downloadUrl: base + "/archive/" + name,
    sha256: createHash("sha256").update(archive).digest("hex"),
    signingKeyId: "fixture-ed25519",
    compressedBytes: archive.length,
    extractedBytes: Object.values(files).reduce(
      (total, body) => total + Buffer.byteLength(body),
      0,
    ),
    licenseManifest: "licenses/manifest.json",
    sourceManifest: "source/manifest.json",
    minimumOs: "fixture metadata",
  };
}

function descriptor(artifact) {
  return {
    ...artifact,
    signature: sign(
      null,
      Buffer.from(JSON.stringify(artifact)),
      signing.privateKey,
    ).toString("base64"),
  };
}

function manifest(artifacts) {
  return JSON.stringify({
    schemaVersion: 1,
    channel: "fixture",
    publishedAt: "2026-08-22T00:00:00.000Z",
    artifacts,
  });
}

async function verifyCoreAction() {
  const workerDirectory = path.join(root, "worker");
  const environment = {
    ...fixtureEnvironment(path.join(root, "core")),
    CANTRIP_BOOTSTRAP_MODE: "standalone",
  };
  delete environment.CANTRIP_WORKER_TOKEN;
  const core = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env: environment },
  );
  let worker;
  let exit;
  let diagnostics = "";
  const workerId = "native-managed-chromium-fixture";
  async function call(method, route, status, body) {
    const response = await fetch(core.origin + route, {
      method,
      headers: {
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    return text ? JSON.parse(text) : null;
  }
  try {
    const enrollment = await call(
      "POST",
      "/api/workers/enrollment-codes",
      201,
      { label: workerId },
    );
    worker = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...environment,
        PATH: "",
        CANTRIP_SERVER_URL: core.origin,
        CANTRIP_WORKER_ID: workerId,
        CANTRIP_WORKER_DATA_DIR: workerDirectory,
        CANTRIP_WORKER_ENROLLMENT_CODE: enrollment.code,
        CANTRIP_MANAGED_RUNTIME_MANIFEST_URL: base + "/first",
      },
    });
    exit = once(worker, "exit");
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-16000);
      });
    }
    const advertised = await eventually(
      async () =>
        (await call("GET", "/api/workers", 200)).find(
          ({ workerId: id }) => id === workerId,
        ),
      (result) => assert.equal(result?.online, true),
      10000,
    );
    assert.equal(advertised.webRuntimes.browser.component, "playwright");
    assert.equal(advertised.webRuntimes.browser.supported, true);
    const route = "/api/workers/" + workerId + "/web-runtimes/actions";
    const failed = await call("POST", route, 200, {
      component: "playwright",
      action: "retry",
    });
    assert.equal(
      failed.status.failure.category,
      "download",
      "Production worker distrusts the fixture certificate",
    );
    const profiles = path.join(
      workerDirectory,
      "managed-runtimes/playwright/state/profiles",
    );
    const marker = path.join(profiles, "owned-profile");
    await mkdir(profiles, { recursive: true });
    await writeFile(marker, "fixture");
    const cleared = await call("POST", route, 200, {
      component: "playwright",
      action: "clear-profiles",
    });
    assert.equal(cleared.accepted, true);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    console.log(
      JSON.stringify({ suite: "managed-chromium-core-action", passed: true }),
    );
  } catch (error) {
    console.error(diagnostics, core.diagnostics());
    throw error;
  } finally {
    try {
      if (worker) {
        worker.stdin.end();
        const timer = setTimeout(() => worker.kill("SIGKILL"), 8000);
        try {
          assert.equal((await exit)[0], 0, diagnostics);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      await core.close();
    }
  }
}

let base;
try {
  const config = path.join(root, "openssl.conf");
  await writeFile(
    config,
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n`,
  );
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-config",
    config,
    "-keyout",
    keyFile,
    "-out",
    cert,
  ]);
  server = createServer(
    { key: await readFile(keyFile), cert: await readFile(cert) },
    (request, response) => {
      reads.set(request.url, (reads.get(request.url) ?? 0) + 1);
      const asset = assets.get(request.url);
      const body = asset ?? bodies.get(request.url);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-length": Buffer.byteLength(body) })
        .end(body);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `https://127.0.0.1:${server.address().port}`;
  const first = await makeAsset("fixture-1", true);
  const second = await makeAsset("fixture-2", true);
  const unhealthy = await makeAsset("fixture-unhealthy", false);
  bodies.set("/first", manifest([descriptor(first)]));
  bodies.set("/second", manifest([descriptor(second)]));
  bodies.set("/unhealthy", manifest([descriptor(unhealthy)]));
  bodies.set("/duplicate", manifest([descriptor(first), descriptor(first)]));
  bodies.set(
    "/wrong-digest",
    manifest([descriptor({ ...second, sha256: "0".repeat(64) })]),
  );
  bodies.set(
    "/unsigned",
    manifest([
      { ...descriptor(second), downloadUrl: base + "/unexpected-download" },
    ]),
  );
  const child = spawn(
    process.execPath,
    [
      "scripts/worker-rust/cargo.mjs",
      "test",
      "--offline",
      "--lib",
      "managed_chromium::tests::signed_release_install_update_and_failure",
      "--",
      "--ignored",
      "--exact",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CANTRIP_TEST_CHROMIUM_MANIFEST: base,
        CANTRIP_TEST_CHROMIUM_CERTIFICATE: cert,
        CANTRIP_TEST_CHROMIUM_KEY: publicKey,
      },
    },
  );
  assert.equal((await once(child, "exit"))[0], 0);
  assert.equal(reads.get("/archive/fixture-1"), 2);
  assert.equal(reads.get("/archive/fixture-2"), 2);
  assert.equal(reads.get("/unexpected-download"), undefined);
  console.log(
    JSON.stringify({ suite: "managed-chromium-signed-release", passed: true }),
  );
  if (values.server) await verifyCoreAction();
} finally {
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
