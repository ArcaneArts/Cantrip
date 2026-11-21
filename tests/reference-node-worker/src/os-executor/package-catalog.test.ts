import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerBuiltPackage } from "@cantrip/os-host";
import { cantripOsPackageArtifactSchema } from "@cantrip/protocol";
import { CantripOsPackageCatalog } from "./package-catalog.js";

describe("Worker-owned package artifacts", () => {
  it("freezes exact bytes/metadata and keeps an admitted artifact after a same-version rebuild", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cantrip-package-catalog-"));
    try {
      const file = path.join(root, "cantrip-os-recovery_0.5.0_all.deb");
      const metadata = {
        name: "cantrip-os-recovery",
        version: "0.5.0",
        architecture: "all",
      };
      const bytes = Buffer.alloc(192 * 1024, 31);
      await writeFile(file, bytes);
      const first = await registerBuiltPackage(file, metadata);
      const catalog = new CantripOsPackageCatalog(
        path.join(root, "worker"),
        root,
      );
      expect(await catalog.list()).toEqual({
        available: [first.artifact],
        unavailable: 0,
      });
      const artifact = cantripOsPackageArtifactSchema.parse(first.artifact);
      const retained = await catalog.file(artifact);
      expect(await readFile(retained)).toEqual(bytes);
      expect((await stat(retained)).mode & 0o777).toBe(0o600);
      await unlink(`${retained}.json`); // actual crash boundary: bytes published, metadata absent
      expect((await catalog.list()).available).toEqual([first.artifact]);
      await writeFile(file, "new same-version build");
      const next = await registerBuiltPackage(file, metadata);
      expect(
        (await readdir(root)).filter((name) => name.endsWith(".json")),
      ).toEqual([`${next.artifact.sha256}.json`]);
      expect((await catalog.list()).available).toEqual([next.artifact]);
      expect(await readFile(await catalog.file(artifact))).toEqual(bytes);
      await expect(
        catalog.file({ ...artifact, version: "another" }),
      ).rejects.toThrow("metadata changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("an unrelated corrupt manifest cannot hide a valid repair; symlink payloads are not followed", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "cantrip-package-catalog-errors-"),
    );
    try {
      const file = path.join(root, "recovery.deb");
      await writeFile(file, "fixture public artifact");
      const manifest = await registerBuiltPackage(file, {
        name: "cantrip-os-recovery",
        version: "0.5.0",
        architecture: "all",
      });
      await writeFile(path.join(root, `${"f".repeat(64)}.json`), "{broken");
      const catalog = new CantripOsPackageCatalog(
        path.join(root, "worker"),
        root,
      );
      expect(await catalog.list()).toEqual({
        available: [manifest.artifact],
        unavailable: 1,
      });
      const diagnostic = path.join(
        root,
        "worker/cantrip-os-package-artifacts/catalog-errors.json",
      );
      expect((await stat(diagnostic)).mode & 0o777).toBe(0o600);
      const other = path.join(root, "private-original");
      await writeFile(other, "unrelated private bytes");
      await unlink(file);
      await symlink(other, file);
      // A new Worker with no retained bytes must reject the source symlink.
      const fresh = new CantripOsPackageCatalog(
        path.join(root, "fresh-worker"),
        root,
      );
      expect(await fresh.list()).toEqual({ available: [], unavailable: 2 });
      expect(await readFile(other, "utf8")).toBe("unrelated private bytes");
      expect((await catalog.list()).available).toEqual([manifest.artifact]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
