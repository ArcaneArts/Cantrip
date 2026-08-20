import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const serviceWorkspaceBuilds = [
  "@cantrip/version",
  "@cantrip/logging",
  "@cantrip/protocol",
  "@cantrip/crypto",
];

function runtimeExportTarget(manifest) {
  const rootExport = manifest.exports?.["."];
  if (typeof rootExport === "string") return rootExport;
  if (!rootExport || typeof rootExport !== "object") return null;
  return rootExport.import ?? rootExport.default ?? null;
}

export async function assertPackagedWorkspaceRuntime(serviceRoot) {
  const serviceManifest = JSON.parse(
    await readFile(path.join(serviceRoot, "package.json"), "utf8"),
  );
  const dependencies = Object.keys(serviceManifest.dependencies ?? {}).filter(
    (dependency) => dependency.startsWith("@cantrip/"),
  );

  for (const dependency of dependencies) {
    const dependencyRoot = path.join(serviceRoot, "node_modules", dependency);
    let dependencyManifest;
    try {
      dependencyManifest = JSON.parse(
        await readFile(path.join(dependencyRoot, "package.json"), "utf8"),
      );
    } catch (error) {
      throw new Error(
        `Packaged service is missing runtime dependency ${dependency}: ${error.message}`,
      );
    }
    const target = runtimeExportTarget(dependencyManifest);
    if (!target) {
      throw new Error(
        `Packaged runtime dependency ${dependency} has no importable root export.`,
      );
    }
    try {
      await access(path.resolve(dependencyRoot, target));
    } catch (error) {
      throw new Error(
        `Packaged runtime dependency ${dependency} is missing ${target}: ${error.message}`,
      );
    }
  }
}
