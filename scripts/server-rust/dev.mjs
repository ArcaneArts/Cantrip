// Development build/watch controller. Requests and background work run in the
// native child; JavaScript is used only for builds and bounded legacy conversion.
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildRustServer, repositoryRoot } from "./build.mjs";
import { pnpmCommand } from "../pnpm-command.mjs";

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
const converter = path.join(
  repositoryRoot,
  "packages/profile-converter/dist/index.mjs",
);
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

async function start() {
  restarting = true;
  await stop();
  const binary = values.binary
    ? path.resolve(values.binary)
    : await buildRustServer({ signal: controller.signal });
  if (stopping) return;
  const preparation = launch(binary, [
    "--shutdown-on-stdin-close",
    "--migrate-only",
    "--upgrade-profile",
    "--legacy-node",
    process.execPath,
    "--legacy-profile-converter",
    converter,
  ]);
  const prepared = await preparation.completion;
  if (active === preparation) active = undefined;
  if (stopping) return;
  if (prepared.code !== 0)
    throw new Error(
      `Native profile preparation failed (${prepared.code ?? prepared.signal}).`,
    );
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

const command = pnpmCommand([
  "--filter",
  "@cantrip/profile-converter",
  "build",
]);
const converterBuild = launch(command.command, command.arguments);
const result = await converterBuild.completion;
active = undefined;
if (!stopping && result.code !== 0)
  throw new Error(
    `Legacy profile converter build failed (${result.code ?? result.signal}).`,
  );
if (!stopping && values.watch) {
  for (const [relative, recursive, selected] of [
    ["cantrip_server_rs/src", true],
    ["cantrip_server_rs/third-party", true],
    ["cantrip_server/drizzle", true],
    [
      "cantrip_server_rs",
      false,
      new Set(["Cargo.toml", "Cargo.lock", "build.rs"]),
    ],
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
