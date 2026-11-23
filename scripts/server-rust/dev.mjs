// Development build/watch controller. The native child owns profile preparation
// and serving. This controller builds compatibility tools on demand.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";

const { values } = parseArgs({
  options: {
    watch: { type: "boolean", default: false },
    binary: { type: "string" },
  },
});
const environment = {
  ...process.env,
  CANTRIP_DATA_DIR:
    process.env.CANTRIP_DATA_DIR ?? path.join(repositoryRoot, ".cantrip/dev"),
};
const legacyPostgres = environment.CANTRIP_LEGACY_POSTGRES_BIN_DIR;
const legacyPostgresRequiredExit = 78;
const watchers = [];
let active,
  stopping = false,
  restarting = false,
  building = false,
  dirty = false,
  timer;
const controller = new AbortController();

function launch(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  active = { child, completion };
  return active;
}

async function stop() {
  const current = active;
  if (!current) return;
  current.child.stdin?.end();
  const deadline = setTimeout(() => current.child.kill("SIGKILL"), 10_000);
  try {
    await current.completion;
  } finally {
    clearTimeout(deadline);
    if (active === current) active = undefined;
  }
}

async function waitFor(command, args) {
  const operation = launch(command, args);
  try {
    return await operation.completion;
  } finally {
    if (active === operation) active = undefined;
  }
}

async function prepare(binary) {
  const run = (tools) =>
    waitFor(binary, [
      "--shutdown-on-stdin-close",
      "--migrate-only",
      "--upgrade-profile",
      ...(tools
        ? ["--legacy-postgres-bin-dir", path.resolve(repositoryRoot, tools)]
        : []),
    ]);
  let prepared = await run(legacyPostgres);
  if (
    !stopping &&
    !legacyPostgres &&
    prepared.code === legacyPostgresRequiredExit
  ) {
    const staging = await mkdtemp(path.join(tmpdir(), "cantrip-dev-legacy-"));
    try {
      if (stopping) return;
      console.log(
        "Building compatibility tools for the legacy PGlite profile.",
      );
      const output = path.join(staging, "legacy-postgres");
      const build = await waitFor(process.execPath, [
        "scripts/database-transfer/build-legacy-postgres.mjs",
        output,
        "--shutdown-on-stdin-close",
      ]);
      if (stopping) return;
      if (build.code !== 0)
        throw new Error(
          `Legacy PostgreSQL build failed (${build.code ?? build.signal}). Supply CANTRIP_LEGACY_POSTGRES_BIN_DIR from a matching desktop package.`,
        );
      prepared = await run(path.join(output, "bin"));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (!stopping && prepared.code !== 0)
    throw new Error(
      `Native profile preparation failed (${prepared.code ?? prepared.signal}).`,
    );
}

async function start() {
  restarting = true;
  await stop();
  const binary = values.binary
    ? path.resolve(values.binary)
    : await buildRustServer({ signal: controller.signal });
  if (stopping) return;
  await prepare(binary);
  if (stopping) return;
  const server = launch(binary, ["--shutdown-on-stdin-close"]);
  restarting = false;
  void server.completion
    .then(({ code, signal }) => {
      if (active === server && !stopping && !restarting && !values.watch)
        process.exitCode = code ?? (signal ? 1 : 0);
    })
    .catch(fail);
}

function fail(error) {
  if (!stopping) {
    console.error(error);
    process.exitCode = 1;
  }
}

async function rebuild() {
  dirty = true;
  if (building || stopping) return;
  building = true;
  try {
    do {
      dirty = false;
      await start();
    } while (dirty && !stopping);
  } catch (error) {
    fail(error);
  } finally {
    building = false;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    controller.abort();
    void stop().catch(fail);
  });
}

if (!stopping && values.watch) {
  for (const [relative, recursive, selected] of [
    ["cantrip_server_rs/src", true],
    ["crates", true],
    [".", false, new Set(["Cargo.toml", "Cargo.lock"])],
    ["cantrip_server_rs/third-party", true],
    ["cantrip_server/drizzle", true],
    ["cantrip_server_rs", false, new Set(["Cargo.toml", "build.rs"])],
  ]) {
    watchers.push(
      watch(
        path.join(repositoryRoot, relative),
        { recursive },
        (_event, filename) => {
          if (selected && !selected.has(filename)) return;
          clearTimeout(timer);
          timer = setTimeout(() => void rebuild(), 150);
        },
      ),
    );
  }
}
if (!stopping) await rebuild();
