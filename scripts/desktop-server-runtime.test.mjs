import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureDesktopServer,
  replaceDesktopRuntime,
} from "./desktop-server-runtime.mjs";

async function preparedRuntime(t) {
  const root = await mkdtemp(
    path.join(tmpdir(), "cantrip-desktop-stage-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "runtime");
  await mkdir(runtime);
  await writeFile(path.join(runtime, "previous"), "last successful assembly");
  return { root, runtime };
}

test("a legacy artifact failure preserves the existing desktop runtime", async (t) => {
  const { root, runtime } = await preparedRuntime(t);
  await assert.rejects(
    replaceDesktopRuntime(runtime, async (candidate) => {
      const server = path.join(candidate, "server");
      await mkdir(path.join(server, "node_modules"), { recursive: true });
      await configureDesktopServer(server);
    }),
    { code: "ENOENT" },
  );

  assert.equal(
    await readFile(path.join(runtime, "previous"), "utf8"),
    "last successful assembly",
  );
  assert.deepEqual(await readdir(runtime), ["previous"]);
  assert.deepEqual(await readdir(root), ["runtime"]);
});

test("a failed final rename restores the previous desktop runtime", async (t) => {
  const { root, runtime } = await preparedRuntime(t);
  await assert.rejects(
    replaceDesktopRuntime(runtime, (candidate) =>
      rm(candidate, { recursive: true }),
    ),
    { code: "ENOENT" },
  );

  assert.deepEqual(await readdir(runtime), ["previous"]);
  assert.deepEqual(await readdir(root), ["runtime"]);
});

test("an assembled desktop runtime replaces the previous tree", async (t) => {
  const { root, runtime } = await preparedRuntime(t);
  await replaceDesktopRuntime(runtime, async (candidate) => {
    const server = path.join(candidate, "server");
    await mkdir(server);
    await writeFile(
      path.join(server, "native-server.json"),
      JSON.stringify({
        postgres: { bin: "postgres/bin" },
        legacyPostgresBin: "legacy-postgres/bin",
      }),
    );
    await configureDesktopServer(server);
    assert.deepEqual(await readdir(runtime), ["previous"]);
  });

  assert.deepEqual(await readdir(runtime), ["server"]);
  assert.deepEqual(
    JSON.parse(
      await readFile(
        path.join(runtime, "server", "desktop-server.json"),
        "utf8",
      ),
    ),
    {
      runtime: "rust",
      postgresBin: "postgres/bin",
      legacyPostgresBin: "legacy-postgres/bin",
    },
  );
  assert.deepEqual(await readdir(root), ["runtime"]);
});
