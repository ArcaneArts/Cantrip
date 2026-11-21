import type { RunConfigurationPlatform } from "@cantrip/protocol/run-configuration-definitions";

export function runConfigurationEnvironmentNameIsReserved(
  name: string,
): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("CANTRIP_") ||
    upper.startsWith("_CANTRIP_") ||
    upper === "CODEX_WORKTREE_PATH"
  );
}

function environmentNameKey(
  name: string,
  platform: RunConfigurationPlatform,
): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

export function mergeRunConfigurationEnvironmentLayers(
  platform: RunConfigurationPlatform,
  ...layers: Array<Record<string, string> | undefined>
): Record<string, string> {
  const valuesByName = new Map<string, string>();
  const namesByKey = new Map<string, string>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const [name, value] of Object.entries(layer)) {
      const key = environmentNameKey(name, platform);
      const previousName = namesByKey.get(key);
      if (previousName !== undefined && previousName !== name) {
        valuesByName.delete(previousName);
      }
      valuesByName.set(name, value);
      namesByKey.set(key, name);
    }
  }
  return Object.fromEntries(valuesByName);
}

export function runConfigurationEnvironmentValue(
  environment: Record<string, string>,
  name: string,
  platform: RunConfigurationPlatform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const key = environmentNameKey(name, platform);
  let value: string | undefined;
  for (const [candidate, candidateValue] of Object.entries(environment)) {
    if (environmentNameKey(candidate, platform) === key) {
      value = candidateValue;
    }
  }
  return value;
}
