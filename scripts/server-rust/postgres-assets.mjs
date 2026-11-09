// Build-time PostgreSQL asset collection. No package manager runs at startup.
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
async function defaultPostgresBin(platform) {
  if (platform === "darwin") {
    const { stdout } = await exec("brew", ["--prefix", "postgresql@18"]);
    return (
      await exec(path.join(stdout.trim(), "bin", "pg_config"), ["--bindir"])
    ).stdout.trim();
  }
  if (platform === "win32") {
    const script = new URL("./windows-postgres-assets.ps1", import.meta.url);
    const { fileURLToPath } = await import("node:url");
    const cache = path.join(
      process.env.LOCALAPPDATA ?? process.env.TEMP,
      "Cantrip",
      "build-cache",
      "postgresql-18.6-1-win32-x64",
    );
    return (
      await exec("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(script),
        "-CacheDirectory",
        cache,
      ])
    ).stdout.trim();
  }
  return (await exec("pg_config", ["--bindir"])).stdout.trim();
}
async function files(root) {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) entries.push(...(await files(name)));
    else entries.push(name);
  }
  return entries;
}
function commonParent(paths) {
  let prefix = path.dirname(paths[0]);
  while (
    paths.some(
      (p) =>
        path.relative(prefix, p).startsWith("..") ||
        path.isAbsolute(path.relative(prefix, p)),
    )
  )
    prefix = path.dirname(prefix);
  return prefix;
}
async function copyNotices(source, destination) {
  let entries;
  try {
    entries = await readdir(source);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (!/^(?:licen[cs]e|copying|copyright)(?:[.-]|$)/i.test(name)) continue;
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, name), path.join(destination, name), {
      recursive: true,
      dereference: true,
    });
  }
}
export async function copyDistributionNotices(source, destination) {
  await copyNotices(source, destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory())
      await copyDistributionNotices(
        path.join(source, entry.name),
        path.join(destination, entry.name),
      );
  }
}
export async function bundlePostgres(
  destination,
  { bin, share, lib, platform = process.platform, serverBinary },
) {
  bin ??= await defaultPostgresBin(platform);
  // pg_config supplies the actual installed layout; explicit asset paths support
  // distribution images that do not contain development headers or pg_config.
  if (!share || !lib) {
    const config = path.join(
      bin,
      platform === "win32" ? "pg_config.exe" : "pg_config",
    );
    share ??= (await exec(config, ["--sharedir"])).stdout.trim();
    lib ??= (await exec(config, ["--pkglibdir"])).stdout.trim();
  }
  // pg_config may report symlinks outside the versioned installation prefix.
  // Keep the real installed layout so PostgreSQL can relocate its share/lib
  // paths relative to its executable, including Homebrew and Debian layouts.
  const sourcePaths = await Promise.all(
    [bin, share, lib].map((p) => realpath(p)),
  );
  const prefix = commonParent(sourcePaths);
  const targetRoot = path.join(destination, "postgres");
  for (const source of sourcePaths)
    await cp(source, path.join(targetRoot, path.relative(prefix, source)), {
      recursive: true,
      dereference: true,
    });
  const bundledBin = path.join(
    targetRoot,
    path.relative(prefix, sourcePaths[0]),
  );
  const queue = [
    ...(await files(targetRoot)).map((file) => ({
      file,
      original: path.join(prefix, path.relative(targetRoot, file)),
    })),
    ...(await files(path.join(destination, "bin"))).map((file) => ({
      file,
      original: serverBinary ?? file,
    })),
  ];
  const libraryRoot = path.join(destination, "lib");
  await mkdir(libraryRoot, { recursive: true });
  const copied = new Map();
  const macho = [];
  for (let index = 0; index < queue.length; index++) {
    const { file, original } = queue[index];
    const header = await readFile(file).then((b) => b.subarray(0, 4));
    const isElf = header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const isMach = [
      "cffaedfe",
      "cefaedfe",
      "feedfacf",
      "feedface",
      "cafebabe",
      "bebafeca",
    ].includes(header.toString("hex"));
    if (platform === "linux" && isElf) {
      const { stdout } = await exec("ldd", [file]);
      for (const line of stdout.split("\n")) {
        const match = /=>\s+(\/\S+)/.exec(line);
        if (!match) continue;
        const source = match[1];
        const name = path.basename(source);
        // Native distributions use the host's kernel loader and glibc ABI. All
        // other discovered libraries, including OpenSSL/ICU/readline, are bundled.
        if (
          /^(?:libc|libm|libpthread|libdl|librt|libresolv|libutil)\.so/.test(
            name,
          )
        )
          continue;
        const target = path.join(libraryRoot, name);
        // $ORIGIN dependencies can already point into the collected library
        // directory. They are in the queue; copying onto themselves is invalid.
        if (path.resolve(source) === path.resolve(target)) continue;
        if (!copied.has(source)) {
          await cp(source, target, { dereference: true });
          copied.set(source, target);
          queue.push({ file: target, original: source });
        }
      }
    } else if (platform === "darwin" && isMach) {
      macho.push(file);
      const { stdout } = await exec("otool", ["-L", file]);
      for (const line of stdout.split("\n").slice(1)) {
        const reference = line.trim().split(" (")[0];
        let source = reference;
        if (source.startsWith("@loader_path/"))
          source = path.resolve(
            path.dirname(original),
            source.slice("@loader_path/".length),
          );
        else if (source.startsWith("@rpath/")) {
          const { stdout: loadCommands } = await exec("otool", [
            "-l",
            original,
          ]);
          const rpaths = [
            ...loadCommands.matchAll(
              /cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g,
            ),
          ].map((match) => match[1]);
          const failures = [];
          for (const rpath of rpaths) {
            const directory = rpath.replace(
              /^@loader_path/,
              path.dirname(original),
            );
            try {
              source = await realpath(
                path.join(directory, source.slice("@rpath/".length)),
              );
              break;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              failures.push(error);
            }
          }
          if (source.startsWith("@rpath/"))
            throw new AggregateError(
              failures,
              `Resolve ${reference} from ${original}`,
            );
        }
        if (
          !source.startsWith("/") ||
          source.startsWith("/usr/lib/") ||
          source.startsWith("/System/")
        )
          continue;
        source = await realpath(source);
        // A dylib's first -L entry is its own LC_ID_DYLIB, not a dependency.
        if (source === (await realpath(original))) continue;
        let target = copied.get(source);
        if (!target) {
          target = path.join(libraryRoot, path.basename(source));
          await cp(source, target, { dereference: true });
          copied.set(source, target);
          queue.push({ file: target, original: source });
        }
        const relative = path
          .relative(path.dirname(file), target)
          .split(path.sep)
          .join("/");
        await exec("install_name_tool", [
          "-change",
          reference,
          "@loader_path/" + relative,
          file,
        ]);
      }
    }
  }
  if (platform === "darwin")
    for (const file of macho)
      await exec("codesign", ["--force", "--sign", "-", file]);
  await copyNotices(prefix, path.join(destination, "licenses", "postgresql"));
  await copyNotices(
    path.dirname(sourcePaths[0]),
    path.join(destination, "licenses", "postgresql"),
  );
  for (const source of copied.keys()) {
    const library = await realpath(source);
    const packageRoot = path.dirname(path.dirname(library));
    await copyNotices(
      packageRoot,
      path.join(destination, "licenses", path.basename(source)),
    );
  }
  const { stdout: version } = await exec(
    path.join(bin, platform === "win32" ? "postgres.exe" : "postgres"),
    ["--version"],
  );
  const result = {
    bin: path.relative(destination, bundledBin).split(path.sep).join("/"),
    version: version.trim(),
    sharedLibraries: copied.size,
  };
  await writeFile(
    path.join(destination, "POSTGRES_VERSION"),
    result.version + "\n",
  );
  return result;
}
export async function artifactManifest(root) {
  const entries = [];
  for (const file of (await files(root)).sort()) {
    const contents = await readFile(file);
    entries.push({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return entries;
}
