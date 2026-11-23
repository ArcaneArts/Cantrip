import type {
  CantripOsRunSelection,
  CantripOsSourceBindingSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import type { RunConfigurationListInventory } from "./run-configuration-api";
import {
  buildRunConfigurationControlModel,
  type RunConfigurationControlItem,
  type RunConfigurationWorktree,
} from "./run-configuration-control-model";

export interface RunConfigurationCatalog {
  key: string;
  label: string;
  binding?: CantripOsSourceBindingSummary;
  selection?: CantripOsRunSelection;
  inventory: RunConfigurationListInventory | null | undefined;
  runtimes: readonly RunConfigurationRuntime[];
  worktrees: readonly RunConfigurationWorktree[];
  available: boolean;
  loading?: boolean;
  error?: string | null;
}
export interface CatalogRunConfigurationItem extends RunConfigurationControlItem {
  configurationId: string;
  catalog: RunConfigurationCatalog;
}

/** UI identity only; protocol requests always use the original configuration ID. */
export function runConfigurationCatalogKey(
  sourceKey: string,
  configurationId: string,
) {
  return sourceKey === "host"
    ? configurationId
    : `linux:${JSON.stringify([sourceKey, configurationId])}`;
}
export function parseRunConfigurationCatalogKey(key: string) {
  if (!key.startsWith("linux:"))
    return { sourceKey: "host", configurationId: key };
  try {
    const parts: unknown = JSON.parse(key.slice(6));
    if (
      Array.isArray(parts) &&
      parts.length === 2 &&
      parts.every((part) => typeof part === "string" && part.length)
    )
      return {
        sourceKey: parts[0] as string,
        configurationId: parts[1] as string,
      };
  } catch {
    /* Retain a malformed Linux handle as unavailable, never Host. */
  }
  return null;
}
export function reconcileCatalogSelection(
  preferred: string | null,
  available: readonly string[],
) {
  if (
    preferred &&
    (preferred.startsWith("linux:") || available.includes(preferred))
  )
    return preferred;
  return available[0] ?? null;
}
export function buildRunConfigurationCatalogModel(
  catalogs: readonly RunConfigurationCatalog[],
  workers: readonly WorkerSummary[],
) {
  const configurations: CatalogRunConfigurationItem[] = [];
  const invalidConfigurations = [];
  for (const catalog of catalogs) {
    const model = buildRunConfigurationControlModel({ ...catalog, workers });
    for (const item of model.configurations) {
      const targets = item.targets.map((target) =>
        catalog.available
          ? target
          : {
              ...target,
              available: false,
              reason: catalog.error ?? `${catalog.label} is unavailable.`,
            },
      );
      configurations.push({
        ...item,
        id: runConfigurationCatalogKey(catalog.key, item.id),
        configurationId: item.id,
        catalog,
        targets,
        primary:
          targets.find(
            (target) => target.worktree.id === item.primary?.worktree.id,
          ) ?? null,
        activeAlternates: targets.filter((target) =>
          item.activeAlternates.some(
            (active) => active.worktree.id === target.worktree.id,
          ),
        ),
        searchValue:
          `${item.searchValue} ${catalog.label} ${catalog.key}`.toLocaleLowerCase(),
      });
    }
    invalidConfigurations.push(
      ...model.invalidConfigurations.map((item) => ({
        ...item,
        label: catalog.binding
          ? `${item.label} · ${catalog.label}`
          : item.label,
        relativePath: `${catalog.key}:${item.relativePath}`,
      })),
    );
  }
  configurations.sort(
    (a, b) =>
      Number(b.anyActive) - Number(a.anyActive) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.catalog.label.localeCompare(b.catalog.label),
  );
  return { configurations, invalidConfigurations };
}
