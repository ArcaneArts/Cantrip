import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  rename,
  unlink,
  readdir,
  readFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Normal builders already know Debian control metadata. Guests independently
 * verify those fields on receipt; macOS does not need a local dpkg binary. */
export async function registerBuiltPackage(file, metadata, options = {}) {
  const source = resolve(file);
  const sha = createHash("sha256");
  let bytes = 0;
  for await (const block of createReadStream(source)) {
    sha.update(block);
    bytes += block.length;
  }
  const artifact = { ...metadata, sha256: sha.digest("hex"), bytes };
  const directory = resolve(options.directory ?? dirname(source));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename =
    directory === dirname(source) ? basename(source) : `${artifact.sha256}.deb`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*\.deb$/.test(filename))
    throw new Error(
      "Use a separate catalogue directory for a nonportable artifact filename",
    );
  const destination = join(directory, filename);
  if (destination !== source) {
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const actual = createHash("sha256");
    for await (const block of createReadStream(destination))
      actual.update(block);
    if (actual.digest("hex") !== artifact.sha256)
      throw new Error("The registered artifact bytes changed");
  }
  const handle = await open(destination, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const manifest = {
    format: "cantrip-os-package-artifact",
    version: 1,
    file: filename,
    artifact,
  };
  const temporary = join(directory, `.${randomUUID()}.partial`);
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(JSON.stringify(manifest) + "\n");
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, join(directory, `${artifact.sha256}.json`));
    // A development rebuild may replace the named artifact at the same
    // version. Retire only manifests for those replaced bytes at that path.
    for (const name of await readdir(directory)) {
      if (
        !/^[a-f0-9]{64}\.json$/.test(name) ||
        name === `${artifact.sha256}.json`
      )
        continue;
      let previous;
      try {
        previous = JSON.parse(await readFile(join(directory, name), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
        throw error;
      }
      if (
        previous.format === manifest.format &&
        previous.version === 1 &&
        previous.file === filename
      )
        await unlink(join(directory, name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return manifest;
}
