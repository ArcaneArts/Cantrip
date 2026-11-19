// Native PostgreSQL reader for legacy WASM PGlite data. Build-time tool only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const version = "18.7";
const sha256 =
  "441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { jobs: { type: "string", default: "2" } },
});
assert.equal(
  positionals.length,
  1,
  "Usage: build-legacy-postgres.mjs <new destination directory> [--jobs N]",
);
assert.match(values.jobs, /^[1-9][0-9]*$/);
const output = path.resolve(positionals[0]);
const build = await mkdtemp(
  path.join(path.dirname(output), ".cantrip-legacy-postgres-build-"),
);

function run(executable, args, cwd = build, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(executable + " failed (" + (signal ?? code) + ")"));
    });
  });
}

try {
  const archive = "postgresql-" + version + ".tar.bz2";
  await run("curl", [
    "--fail",
    "--show-error",
    "--silent",
    "--location",
    "--output",
    archive,
    "https://ftp.postgresql.org/pub/source/v" + version + "/" + archive,
  ]);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path.join(build, archive)))
    digest.update(chunk);
  assert.equal(digest.digest("hex"), sha256, "PostgreSQL source checksum");
  await run("tar", ["-xf", archive]);
  const source = path.join(build, "postgresql-" + version);
  async function patch(file, from, to, count = 1) {
    const target = path.join(source, file);
    const content = await readFile(target, "utf8");
    assert.equal(
      content.split(from).length,
      count + 1,
      "unexpected PostgreSQL source in " + file,
    );
    await writeFile(
      target,
      content.replaceAll(from, () => to),
    );
  }
  await patch(
    "src/include/pg_config_manual.h",
    "#if SIZEOF_VOID_P >= 8\n#define USE_FLOAT8_BYVAL 1",
    "#if 0 /* Legacy PGlite passes 8-byte data types by reference. */\n#define USE_FLOAT8_BYVAL 1",
  );
  // Stored catalog expressions encode by-value constants as four little-endian
  // bytes. Heap values still use the real native architecture and PostgreSQL
  // validates the physical cluster during open.
  await patch(
    "src/backend/nodes/readfuncs.c",
    "(Size) sizeof(Datum)",
    "(Size) sizeof(uint32)",
    2,
  );
  await patch(
    "src/backend/nodes/outfuncs.c",
    "(Size) sizeof(Datum)",
    "(Size) sizeof(uint32)",
  );
  await patch(
    "src/backend/utils/adt/datum.c",
    "res = (value1 == value2);",
    "res = ((uint32) value1 == (uint32) value2);",
  );
  const mac = process.platform === "darwin";
  if (mac) {
    await patch(
      "src/Makefile.shlib",
      "-install_name '$(libdir)/lib",
      "-install_name '@rpath/lib",
    );
  } else if (process.platform === "linux") {
    await patch(
      "src/makefiles/Makefile.linux",
      "rpath = -Wl,-rpath,'$(rpathdir)',--enable-new-dtags",
      "rpath = -Wl,-rpath,'$$ORIGIN/../lib',--enable-new-dtags",
    );
  }
  // PostgreSQL locates share and library files from bin at runtime. Staging
  // avoids publishing a partially installed runtime at the requested path.
  const prefix = "/usr/local/cantrip-legacy-postgres";
  const stage = path.join(build, "install");
  const environment = { ...process.env };
  if (mac) {
    // Match the Rust service's macOS baseline instead of inheriting the
    // release builder's OS version from Apple Clang.
    environment.MACOSX_DEPLOYMENT_TARGET ??=
      process.arch === "arm64" ? "11.0" : "10.12";
  }
  await run(
    "./configure",
    [
      "--prefix=" + prefix,
      "--with-extra-version=-cantrip-legacy-pglite",
      "--without-icu",
      "--without-readline",
    ],
    source,
    {
      ...environment,
      CFLAGS: "-O1 -g0 -fsigned-char",
      ...(mac ? { LDFLAGS: "-Wl,-rpath,@loader_path/../lib" } : {}),
    },
  );
  await run("make", ["-j" + values.jobs, "world-bin"], source, environment);
  await run(
    "make",
    ["install-world-bin", "DESTDIR=" + stage],
    source,
    environment,
  );
  const installed = path.join(stage, prefix);
  await copyFile(
    path.join(source, "COPYRIGHT"),
    path.join(installed, "COPYRIGHT"),
  );
  await mkdir(output);
  try {
    await rename(installed, output);
  } catch (error) {
    await rmdir(output);
    throw error;
  }
} finally {
  await rm(build, { recursive: true, force: true });
}
