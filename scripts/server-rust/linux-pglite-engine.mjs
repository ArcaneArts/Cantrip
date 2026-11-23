// Build dependency only. The published ARM64 engine requires newer glibc than
// Debian 12; native host builds need the same source-built engine as the image.
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const engineCommit = "0062c8c2fec03e389f8c2e8cad18391ecf0d53bd";
const postgresCommit = "06c837c6a30335169df786c610ed224bc51d81c0";
const products = ["libpglite.a", "pglite-runtime.tar"];
async function available(directory) {
  await Promise.all(products.map((name) => access(path.join(directory, name))));
}

export async function linuxPgliteEngine(target, environment) {
  const libc =
    process.report.getReport().header.glibcVersionRuntime ?? "unknown";
  const parent = path.join(
    path.resolve(environment.CARGO_TARGET_DIR),
    "pglite-engine",
    engineCommit,
    target,
  );
  const destination = path.join(parent, libc);
  try {
    await available(destination);
    return destination;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, ".build-"));
  const source = path.join(stage, "source"),
    output = path.join(stage, "products");
  await mkdir(source);
  await mkdir(output);
  const log = path.join(output, "build.log");
  async function run(command, args, cwd = source) {
    try {
      const result = await execute(command, args, {
        cwd,
        env: environment,
        maxBuffer: 64 * 1024 * 1024,
      });
      await appendFile(log, result.stdout + result.stderr);
    } catch (error) {
      await appendFile(log, (error.stdout ?? "") + (error.stderr ?? ""));
      throw new Error(`Native PGlite engine build failed; see ${log}`, {
        cause: error,
      });
    }
  }
  await run("git", ["init"]);
  await run("git", [
    "remote",
    "add",
    "origin",
    "https://github.com/Midwess/pglite-rs.git",
  ]);
  await run("git", ["fetch", "--depth", "1", "origin", engineCommit]);
  await run("git", ["checkout", "--detach", "FETCH_HEAD"]);
  await run("git", [
    "config",
    "submodule.postgres-pglite.url",
    "https://github.com/electric-sql/postgres-pglite.git",
  ]);
  await run("git", [
    "submodule",
    "update",
    "--init",
    "--depth",
    "1",
    "postgres-pglite",
  ]);
  const script = path.join(source, "native/build-libpglite.sh");
  await writeFile(
    script,
    (await readFile(script, "utf8")).replace(/^NPROC=.*$/m, "NPROC=2"),
  );
  await run("bash", ["native/build-libpglite.sh"]);
  await run("bash", ["native/relocate-runtime.sh", "native/out"]);
  for (const name of products)
    await copyFile(
      path.join(source, "native/out", name),
      path.join(output, name),
    );
  await copyFile(
    path.join(source, "LICENSE"),
    path.join(output, "LICENSE.engine"),
  );
  await copyFile(
    path.join(source, "postgres-pglite/COPYRIGHT"),
    path.join(output, "COPYRIGHT.postgres"),
  );
  await writeFile(
    path.join(output, "source.json"),
    JSON.stringify(
      { engineCommit, postgresCommit, target, libc, makeJobs: 2 },
      null,
      2,
    ) + "\n",
  );
  // Compilation consumes the actual libraries, not a completion marker. Publish
  // only complete assets; concurrent builds can reuse a completed publication.
  try {
    await rename(output, destination);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    try {
      await available(destination);
    } catch {
      await rm(source, { recursive: true });
      return output;
    }
  }
  await rm(stage, { recursive: true });
  return destination;
}
