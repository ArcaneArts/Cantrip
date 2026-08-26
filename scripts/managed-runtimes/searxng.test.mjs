import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import {
  hostTarget,
  inputRoot,
  readLock,
  signArtifact,
  tarArgumentPath,
  validateLock,
} from "./searxng-lib.mjs";

test("runtime lock pins exactly six internally consistent native targets", async () => {
  const lock = await readLock();
  assert.equal(Object.keys(lock.targets).length, 6);
  assert.equal(hostTarget("linux", "x64"), "linux-x64");
  assert.equal(hostTarget("freebsd", "x64"), null);
  assert.throws(
    () =>
      validateLock({ ...lock, searxng: { ...lock.searxng, commit: "main" } }),
    /pinned/,
  );
});

test("tar arguments are relative so Windows drive letters are never parsed as remote hosts", () => {
  const cwd = path.join(path.parse(process.cwd()).root, "build", "work");
  const archive = path.join(
    path.parse(process.cwd()).root,
    "cache",
    "runtime.tar.gz",
  );
  const argument = tarArgumentPath(archive, cwd);
  assert.equal(path.isAbsolute(argument), false);
  assert.doesNotMatch(argument, /^[A-Za-z]:/u);
  assert.match(argument, /runtime\.tar\.gz$/u);
});

test("settings bind locally and retain only curated engines", async () => {
  const settings = await readFile(
    path.join(inputRoot, "config-template", "settings.yml"),
    "utf8",
  );
  assert.match(settings, /bind_address: "127\.0\.0\.1"/);
  assert.match(settings, /keep_only:/);
  assert.match(settings, /secret_key: "__CANTRIP_SECRET__"/);
  assert.doesNotMatch(settings, /0\.0\.0\.0/);
});

test("release signature matches the worker's ordered JSON payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifact = {
    schemaVersion: 1,
    component: "searxng",
    version: "1",
    platform: "linux",
    architecture: "x64",
    archiveFormat: "tar.gz",
    downloadUrl: "https://example.test/a.tar.gz",
    sha256: "a".repeat(64),
    signingKeyId: "test",
    compressedBytes: 10,
    extractedBytes: 20,
    licenseManifest: "licenses/manifest.json",
    sourceManifest: "source/manifest.json",
    minimumKernel: "4.18",
  };
  const payload = JSON.stringify(artifact);
  const encoded = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const signature = signArtifact(artifact, encoded);
  assert.equal(
    verify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(signature, "base64"),
    ),
    true,
  );
});

test("requirements lock contains hashes and no editable or URL requirements", async () => {
  const requirements = await readFile(
    path.join(inputRoot, "requirements.lock"),
    "utf8",
  );
  assert.match(requirements, /^babel==/m);
  assert.match(requirements, /--hash=sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(requirements, /^(-e |https?:|git\+)/m);
});
