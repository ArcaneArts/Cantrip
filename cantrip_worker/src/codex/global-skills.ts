import os from "node:os";
import path from "node:path";

export function workerGlobalCodexSkillsRoot(
  homeDirectory = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredCodexHome = environment.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? path.resolve(configuredCodexHome)
    : path.join(path.resolve(homeDirectory), ".codex");
  return path.join(codexHome, "skills");
}

function pathIdentity(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function mergeCodexSkillRoots(
  ...rootGroups: ReadonlyArray<readonly string[]>
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const root of rootGroups.flat()) {
    const resolved = path.resolve(root);
    const identity = pathIdentity(resolved);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(resolved);
  }
  return merged;
}
