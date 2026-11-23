import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fixtureEnvironment, startServer } from "./process.mjs";

const { values } = parseArgs({
  options: {
    binary: { type: "string" },
    "data-root": { type: "string", default: tmpdir() },
  },
});
assert.ok(values.binary, "--binary is required");
const binary = path.resolve(values.binary);
const root = await mkdtemp(
  path.join(path.resolve(values["data-root"]), "pglite-cache-"),
);
const temp = path.join(root, "tmp");
await mkdir(temp);
const environment = {
  ...fixtureEnvironment(root),
  CANTRIP_BOOTSTRAP_MODE: "standalone",
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
};
delete environment.CANTRIP_WORKER_TOKEN;
delete environment.PGLITE_RUNTIME_DIR;

const launch = (profile, env = {}, args = []) =>
  startServer(
    binary,
    [
      "--database",
      "pglite",
      "--data-dir",
      path.join(root, profile),
      "--port",
      "0",
      "--shutdown-on-stdin-close",
      ...args,
    ],
    { cwd: root, env: { ...environment, ...env } },
  );

async function observe(server, writeTheme) {
  try {
    async function request(route, options) {
      const response = await fetch(server.origin + route, {
        signal: AbortSignal.timeout(10_000),
        ...options,
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    assert.equal((await request("/readyz")).database.engine, "pglite");
    const { server: bootstrap } = await request("/api/bootstrap");
    assert.ok(bootstrap.id);
    if (writeTheme)
      await request("/api/settings", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({ theme: "dark" }),
      });
    const { preferences } = await request("/api/settings");
    return { id: bootstrap.id, theme: preferences.theme };
  } finally {
    await server.close();
  }
}

const retained = await observe(await launch("retained"), true);
assert.equal(retained.theme, "dark");
const [cache, ...unexpected] = await readdir(temp);
assert.match(cache, /^pglite-rs-runtime-/);
assert.deepEqual(unexpected, []);
const original = path.join(temp, cache);
const bootstrapAsset = (directory) =>
  path.join(directory, "share", "postgresql", "postgres.bki");
const retainedAsset = path.join(root, "original-postgres.bki");
await rename(bootstrapAsset(original), retainedAsset);

await assert.rejects(
  launch("explicit-incomplete", { PGLITE_RUNTIME_DIR: original }),
  /exited before listening \(1\)[\s\S]*initdb[\s\S]*postgres\.bki/,
);
assert.deepEqual(await readdir(temp), [cache]);

const simultaneous = await Promise.allSettled([
  launch("retained").then((server) => observe(server, false)),
  launch("fresh").then((server) => observe(server, true)),
]);
const errors = simultaneous
  .filter((result) => result.status === "rejected")
  .map((result) => result.reason);
if (errors.length)
  throw new AggregateError(errors, "Concurrent cache recovery");
const [{ value: reopened }, { value: fresh }] = simultaneous;
assert.deepEqual(reopened, retained);
assert.notEqual(fresh.id, retained.id);
assert.equal(fresh.theme, "dark");
const repair = cache + "-recovery-1";
assert.deepEqual((await readdir(temp)).sort(), [cache, repair]);
await assert.rejects(stat(bootstrapAsset(original)), { code: "ENOENT" });
const restored = await readFile(bootstrapAsset(path.join(temp, repair)));
assert.deepEqual(restored, await readFile(retainedAsset));

await truncate(bootstrapAsset(path.join(temp, repair)), 0);
assert.deepEqual(await observe(await launch("retained"), false), retained);
const nextRepair = cache + "-recovery-2";
assert.deepEqual((await readdir(temp)).sort(), [cache, repair, nextRepair]);
assert.equal((await stat(bootstrapAsset(path.join(temp, repair)))).size, 0);
const complete = path.join(temp, nextRepair);
assert.deepEqual(await readFile(bootstrapAsset(complete)), restored);

const marker = path.join(complete, ".extracted");
await rm(marker);
assert.deepEqual(
  await observe(
    await launch("retained", {}, ["--bundled-pglite-runtime-dir", complete]),
    false,
  ),
  retained,
);
await assert.rejects(stat(marker), { code: "ENOENT" });
assert.deepEqual(await observe(await launch("retained"), false), retained);
assert.deepEqual((await readdir(temp)).sort(), [cache, repair, nextRepair]);

const report = path.join(root, "report.json");
await writeFile(
  report,
  JSON.stringify(
    {
      binary,
      binarySha256: createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      platform: process.platform,
      architecture: process.arch,
      retained,
      fresh,
      explicitIncompleteReportsInitdbFailure: true,
      concurrentStartsShareRepairedCache: true,
      truncatedCacheRecovers: true,
      markerlessExplicitAndImplicitReopen: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(report);
