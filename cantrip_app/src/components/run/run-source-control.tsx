import { type ComponentProps } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CantripOsRunSource } from "@cantrip/protocol";
import { RunConfigurationControl } from "./run-configuration-control";
import { getCantripOsRunSources } from "@/lib/api/cantrip-os";
import { linuxRunDefinitionApi } from "@/lib/run-definition-source";
import { listRunConfigurationRuntimes } from "@/lib/run-configuration-api";
import type { RunConfigurationCatalog } from "@/lib/run-configuration-catalog";

export function runSourceSelection(source: CantripOsRunSource) {
  return {
    kind: "binding" as const,
    bindingId: source.binding.id,
    bindingGeneration: source.binding.bindingGeneration,
    attachmentGeneration: source.instance.attachmentGeneration,
    runtimeGeneration: source.instance.runtimeGeneration!,
  };
}

/** One combined catalog. Placement belongs to each configuration, not the header. */
export function RunSourceControl(
  props: ComponentProps<typeof RunConfigurationControl>,
) {
  const sources = useQuery({
    queryKey: ["cantrip-os-run-sources", props.projectId],
    queryFn: () => getCantripOsRunSources(props.projectId),
    refetchInterval: 5000,
    retry: false,
  });
  const groups = new Map<string, CantripOsRunSource>();
  for (const source of sources.data ?? []) {
    const key = `${source.binding.projectSourceId}:${source.binding.workspaceId}`;
    if (!groups.has(key) || source.target.isPrimary) groups.set(key, source);
  }
  const choices = [...groups.values()];
  const inventories = useQueries({
    queries: choices.map((source) => ({
      queryKey: [
        "run-configurations",
        props.projectId,
        JSON.stringify(runSourceSelection(source)),
      ],
      queryFn: () =>
        linuxRunDefinitionApi(source.binding).listRunConfigurations(
          props.projectId,
        ),
      enabled: source.available && source.target.isPrimary,
      refetchInterval: 5000,
      retry: false,
    })),
  });
  const runtimes = useQueries({
    queries: choices.map((source) => ({
      queryKey: [
        "run-configuration-runtimes",
        props.projectId,
        JSON.stringify(runSourceSelection(source)),
      ],
      queryFn: () =>
        listRunConfigurationRuntimes(props.projectId, {
          osSource: runSourceSelection(source),
        }),
      enabled: source.available && source.target.isPrimary,
      refetchInterval: 1000,
      retry: false,
    })),
  });
  const catalogs: RunConfigurationCatalog[] = choices.map((source, index) => ({
    key: JSON.stringify(runSourceSelection(source)),
    label: `CantripOS · ${source.instance.name === "CantripOS" ? "" : `${source.instance.name} / `}${source.workspace.guestWorkspaceId}${choices.filter((other) => other.instance.id === source.instance.id && other.binding.workspaceId === source.binding.workspaceId).length > 1 ? ` · ${source.binding.projectSourceId.slice(0, 8)}` : ""}`,
    binding: source.binding,
    selection: runSourceSelection(source),
    available: source.available && source.target.isPrimary,
    inventory: inventories[index]?.data,
    runtimes: runtimes[index]?.data ?? [],
    worktrees: (sources.data ?? [])
      .filter(
        (target) =>
          target.binding.projectSourceId === source.binding.projectSourceId &&
          target.binding.workspaceId === source.binding.workspaceId,
      )
      .map((target) => target.target),
    loading: inventories[index]?.isLoading,
    error:
      inventories[index]?.error?.message ??
      runtimes[index]?.error?.message ??
      (!source.available ? "The captured Linux source is unavailable." : null),
  }));
  return <RunConfigurationControl {...props} additionalCatalogs={catalogs} />;
}
