// Local updater artifacts retain the production installer and use a disposable
// signing key, certificate authority and renderer controller.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { configureDesktopServer } from "../desktop-server-runtime.mjs";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const appRequire = createRequire(
  path.join(repository, "cantrip_app/package.json"),
);
const tauri = appRequire.resolve("@tauri-apps/cli/tauri.js");
export const updaterIdentifier = "art.cantrip.rust-qa-recovery";

export async function runLogged(command, args, { cwd, env, log }) {
  const output = createWriteStream(log, { flags: "wx" });
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`${command} failed (${code ?? signal}); see ${log}`),
          );
      });
    });
  } finally {
    await new Promise((resolve) => output.end(resolve));
  }
}

export async function prepareUpdaterFixture({
  directory,
  bridge,
  endpoint,
  identifier,
  signingIdentity,
}) {
  const productName =
    identifier === updaterIdentifier
      ? "Cantrip Server Update QA"
      : "Cantrip Server Signed Update QA";
  const trust = path.join(directory, "trust");
  await mkdir(trust);
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(trust, "ca.key"),
    "-out",
    path.join(trust, "ca.crt"),
    "-days",
    "2",
    "-subj",
    "/CN=Cantrip Update QA CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  await execute("openssl", [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    path.join(trust, "server.key"),
    "-out",
    path.join(trust, "server.csr"),
  ]);
  await writeFile(
    path.join(trust, "server.ext"),
    "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  await execute("openssl", [
    "x509",
    "-req",
    "-in",
    path.join(trust, "server.csr"),
    "-days",
    "2",
    "-CA",
    path.join(trust, "ca.crt"),
    "-CAkey",
    path.join(trust, "ca.key"),
    "-CAcreateserial",
    "-extfile",
    path.join(trust, "server.ext"),
    "-out",
    path.join(trust, "server.crt"),
  ]);
  const key = path.join(trust, "updater.key");
  await runLogged(
    process.execPath,
    [
      tauri,
      "signer",
      "generate",
      "--ci",
      "--password",
      "",
      "--write-keys",
      key,
    ],
    {
      cwd: repository,
      env: process.env,
      log: path.join(trust, "key-generation.log"),
    },
  );
  const pubkey = (await readFile(key + ".pub", "utf8")).trim();
  const fixture = path.join(directory, "fixture-app");
  const source = path.join(fixture, "src-tauri");
  const tracked = (
    await execute("git", ["ls-files", "-z", "cantrip_app/src-tauri"], {
      cwd: repository,
    })
  ).stdout
    .split("\0")
    .filter(Boolean);
  for (const name of tracked) {
    const destination = path.join(
      source,
      path.relative("cantrip_app/src-tauri", name),
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repository, name), destination);
  }
  await mkdir(path.join(directory, "scripts"));
  for (const name of ["version.mjs", "tauri-build.mjs", "synthetic-build.mjs"])
    await cp(
      path.join(repository, "scripts", name),
      path.join(directory, "scripts", name),
    );
  await cp(
    path.join(trust, "ca.crt"),
    path.join(source, "src/qa-updater-ca.pem"),
  );
  const updateSource = path.join(source, "src/desktop_update.rs");
  const original = await readFile(updateSource, "utf8");
  assert.equal(original.split(".updater_builder()").length - 1, 2);
  await writeFile(
    updateSource,
    original.replaceAll(
      ".updater_builder()",
      `.updater_builder().configure_client(|client| client.add_root_certificate(
      reqwest::Certificate::from_pem(include_bytes!("qa-updater-ca.pem"))
        .expect("local updater fixture certificate")
    ))`,
    ),
  );

  const { build } = await import(appRequire.resolve("vite"));
  const originalTransform = bridge.plugin.transform;
  const plugin = {
    ...bridge.plugin,
    transform(code, id) {
      const transformed = originalTransform(code, id);
      if (!transformed) return null;
      transformed.code += `
import { invoke as qaInvoke } from '@tauri-apps/api/core';
import { getVersion as qaGetVersion } from '@tauri-apps/api/app';
globalThis.__qaUpdaterInvoke = qaInvoke;
globalThis.__qaUpdaterVersion = qaGetVersion;
`;
      return transformed;
    },
  };
  const frontend = path.join(directory, "frontend");
  await build({
    root: path.join(repository, "cantrip_app"),
    configFile: path.join(repository, "cantrip_app/vite.config.ts"),
    plugins: [plugin],
    build: { outDir: frontend, emptyOutDir: false },
  });
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR:
      process.env.CARGO_TARGET_DIR ??
      path.join(
        process.env.HOME,
        ".codex/tmp/cantrip-rust-redis-target-v1/target",
      ),
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "2",
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    APPLE_SIGNING_IDENTITY: signingIdentity,
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
  };
  for (const name of [
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_PATH",
  ])
    delete environment[name];
  const config = {
    productName,
    identifier,
    build: { beforeBuildCommand: "", frontendDist: frontend },
    bundle: {
      createUpdaterArtifacts: true,
      macOS: { signingIdentity },
    },
    plugins: { updater: { endpoints: [endpoint], pubkey } },
  };
  return { trust, fixture, source, environment, config, productName };
}

export async function buildUpdaterBundle(
  prepared,
  { directory, label, version, runtime },
) {
  const resources = path.join(prepared.source, "resources/runtime");
  await rm(resources, { recursive: true, force: true });
  await mkdir(path.dirname(resources), { recursive: true });
  await execute("cp", ["-cR", runtime, resources]);
  await configureDesktopServer(path.join(resources, "server"));
  const signingIdentity = prepared.config.bundle.macOS.signingIdentity;
  if (signingIdentity !== "-")
    await runLogged(
      process.execPath,
      [
        path.join(repository, "scripts/sign-macos-runtime.mjs"),
        "--directory",
        resources,
        "--identity",
        signingIdentity,
      ],
      {
        cwd: repository,
        env: prepared.environment,
        log: path.join(directory, label + "-runtime-signing.log"),
      },
    );
  const config = {
    ...prepared.config,
    version,
    bundle: {
      ...prepared.config.bundle,
      macOS: {
        ...prepared.config.bundle.macOS,
        bundleVersion: version.split(".").at(-1),
      },
    },
  };
  await runLogged(
    process.execPath,
    [tauri, "build", "--config", JSON.stringify(config), "--bundles", "app"],
    {
      cwd: prepared.fixture,
      env: prepared.environment,
      log: path.join(directory, label + "-build.log"),
    },
  );
  const output = path.join(
    prepared.environment.CARGO_TARGET_DIR,
    "release/bundle/macos",
  );
  const bundle = path.join(output, prepared.productName + ".app");
  const target = path.join(directory, label);
  await mkdir(target);
  await execute("cp", ["-cR", bundle, target]);
  for (const suffix of [".app.tar.gz", ".app.tar.gz.sig"]) {
    await cp(
      path.join(output, prepared.productName + suffix),
      path.join(target, prepared.productName + suffix),
    );
  }
  return {
    bundle: path.join(target, prepared.productName + ".app"),
    archive: path.join(target, prepared.productName + ".app.tar.gz"),
    signature: (
      await readFile(
        path.join(target, prepared.productName + ".app.tar.gz.sig"),
        "utf8",
      )
    ).trim(),
    version,
  };
}
