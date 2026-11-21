import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsPackageManifestSchema,
  type CantripOsPackageArtifact,
} from "@cantrip/protocol";
import { writeOsOperationRecord } from "./operation-files.js";

/** Public build artifacts become immutable Worker-owned content before they can
 * be offered to a client. Manifest filenames/paths never enter public requests. */
export class CantripOsPackageCatalog {
  private readonly cache: string;
  constructor(
    directory: string,
    private readonly source = path.join(directory, "cantrip-os-packages"),
  ) {
    this.cache = path.join(directory, "cantrip-os-package-artifacts");
  }
  private location(artifact: CantripOsPackageArtifact) {
    return path.join(this.cache, `${artifact.sha256}.deb`);
  }
  private async inspect(file: string, expected: CantripOsPackageArtifact) {
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected.bytes)
        throw new Error("Package artifact size/type changed");
      const sha = createHash("sha256");
      for await (const block of handle.createReadStream({ autoClose: false }))
        sha.update(block);
      if (sha.digest("hex") !== expected.sha256)
        throw new Error("Package artifact checksum changed");
    } finally {
      await handle.close();
    }
  }
  async file(artifact: CantripOsPackageArtifact) {
    const file = this.location(artifact);
    await this.inspect(file, artifact);
    const saved = cantripOsPackageManifestSchema.parse(
      JSON.parse(await readFile(`${file}.json`, "utf8")),
    );
    if (!isDeepStrictEqual(saved.artifact, artifact))
      throw new Error("The saved package metadata changed");
    return file;
  }
  private async retain(
    manifest: ReturnType<typeof cantripOsPackageManifestSchema.parse>,
  ) {
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    await chmod(this.cache, 0o700);
    const destination = this.location(manifest.artifact);
    try {
      return await this.file(manifest.artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const publishMetadata = () =>
      writeOsOperationRecord(`${destination}.json`, manifest, true).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    try {
      await this.inspect(destination, manifest.artifact);
      await publishMetadata();
      return await this.file(manifest.artifact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const source = await open(
      path.join(this.source, manifest.file),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const temporary = `${destination}.${randomUUID()}.partial`;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.size !== manifest.artifact.bytes)
        throw new Error("Catalogue artifact size/type differs");
      const output = await open(temporary, "wx", 0o600);
      const sha = createHash("sha256");
      let bytes = 0;
      try {
        for await (const block of source.createReadStream({
          autoClose: false,
        })) {
          sha.update(block);
          bytes += block.length;
          await output.writeFile(block);
        }
        if (
          bytes !== manifest.artifact.bytes ||
          sha.digest("hex") !== manifest.artifact.sha256
        )
          throw new Error("Catalogue artifact checksum differs");
        await output.sync();
      } finally {
        await output.close();
      }
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await publishMetadata();
      const directory = await open(this.cache, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return await this.file(manifest.artifact);
    } finally {
      await source.close();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async list() {
    let files: string[];
    try {
      files = await readdir(this.source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { available: [], unavailable: 0 };
      throw error;
    }
    const entries = new Map<string, CantripOsPackageArtifact>();
    const errors: Array<{ manifest: string; message: string }> = [];
    for (const file of files
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort()) {
      try {
        const manifest = cantripOsPackageManifestSchema.parse(
          JSON.parse(await readFile(path.join(this.source, file), "utf8")),
        );
        if (file !== `${manifest.artifact.sha256}.json`)
          throw new Error("Catalogue manifest identity changed");
        await this.retain(manifest);
        entries.set(manifest.artifact.sha256, manifest.artifact);
        if (entries.size > 256)
          throw new Error("Package catalogue exceeds 256 artifacts");
      } catch (error) {
        errors.push({
          manifest: file,
          message:
            error instanceof Error
              ? error.message
              : "Package catalogue read failed",
        });
      }
    }
    if (errors.length)
      await writeOsOperationRecord(
        path.join(this.cache, "catalog-errors.json"),
        { version: 1, errors },
      );
    return {
      available: [...entries.values()].slice(0, 256),
      unavailable: errors.length,
    };
  }
}
