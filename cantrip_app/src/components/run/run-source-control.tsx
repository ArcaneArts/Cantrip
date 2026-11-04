import { useSyncExternalStore, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CantripOsRunSource } from "@cantrip/protocol";
import { RunConfigurationControl } from "./run-configuration-control";
import { getCantripOsRunSources } from "@/lib/api/cantrip-os";
import {
  linuxRunDefinitionApi,
  RunDefinitionSourceProvider,
} from "@/lib/run-definition-source";
import { listRunConfigurationRuntimes } from "@/lib/run-configuration-api";
import {
  readRunSource,
  writeRunSource,
  parseRunSource,
  RUN_SOURCE_EVENT,
} from "@/lib/run-source-selection";
import { NativeSelect } from "@/components/ui/native-select";
import { InlineAlert } from "@/components/ui/inline-alert";

export function runSourceSelection(source: CantripOsRunSource) {
  return {
    kind: "binding" as const,
    bindingId: source.binding.id,
    bindingGeneration: source.binding.bindingGeneration,
    attachmentGeneration: source.instance.attachmentGeneration,
    runtimeGeneration: source.instance.runtimeGeneration!,
  };
}
const subscribe = (notify: () => void) => {
  window.addEventListener(RUN_SOURCE_EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(RUN_SOURCE_EVENT, notify);
    window.removeEventListener("storage", notify);
  };
};

export function RunSourceControl(
  props: ComponentProps<typeof RunConfigurationControl>,
) {
  const encoded = useSyncExternalStore(
    subscribe,
    () => readRunSource(props.projectId),
    () => "host",
  );
  const selection = parseRunSource(encoded);
  const sources = useQuery({
    queryKey: ["cantrip-os-run-sources", props.projectId],
    queryFn: () => getCantripOsRunSources(props.projectId),
    refetchInterval: 5000,
    retry: false,
  });
  const groups = new Map<string, CantripOsRunSource>();
  for (const source of sources.data ?? []) {
    const group = `${source.binding.projectSourceId}:${source.binding.workspaceId}`;
    if (!groups.has(group) || source.target.isPrimary)
      groups.set(group, source);
  }
  const choices = [...groups.values()];
  const current = selection
    ? choices.find(
        (source) => JSON.stringify(runSourceSelection(source)) === encoded,
      )
    : undefined;
  const linux = encoded !== "host";
  const available = Boolean(current?.available && current.target.isPrimary);
  const inventory = useQuery({
    enabled: linux && available,
    queryKey: ["run-configurations", props.projectId, encoded],
    queryFn: () =>
      linuxRunDefinitionApi(current!.binding).listRunConfigurations(
        props.projectId,
      ),
    refetchInterval: 5000,
    retry: false,
  });
  const runtimes = useQuery({
    enabled: linux && available,
    queryKey: ["run-configuration-runtimes", props.projectId, encoded],
    queryFn: () =>
      listRunConfigurationRuntimes(props.projectId, { osSource: selection! }),
    refetchInterval: 1000,
    retry: false,
  });
  const targets = (sources.data ?? []).filter(
    (source) =>
      current &&
      source.binding.projectSourceId === current.binding.projectSourceId &&
      source.binding.workspaceId === current.binding.workspaceId,
  );
  const label = current
    ? `Linux · ${current.instance.name} / ${current.workspace.guestWorkspaceId}`
    : linux
      ? "Linux source unavailable"
      : "Host";
  return (
    <div className="flex min-w-0 items-center gap-1" data-run-source-control>
      <NativeSelect
        aria-label="Run source"
        className="max-w-60"
        value={linux ? encoded : "host"}
        onChange={(event) => {
          props.onEditorConfigurationChange(null);
          if (event.target.value === "host")
            writeRunSource(props.projectId, null);
          else {
            const selected = parseRunSource(event.target.value);
            if (selected) writeRunSource(props.projectId, selected);
          }
        }}
      >
        <option value="host">Host</option>
        {linux && !current ? <option value={encoded}>{label}</option> : null}
        {choices.map((source) => {
          const value = JSON.stringify(runSourceSelection(source));
          return (
            <option
              key={value}
              value={value}
              disabled={
                !source.target.isPrimary || !source.instance.runtimeGeneration
              }
            >
              Linux · {source.instance.name} /{" "}
              {source.workspace.guestWorkspaceId} ·{" "}
              {source.binding.projectSourceId.slice(0, 8)}
              {source.available ? "" : " (unavailable)"}
            </option>
          );
        })}
      </NativeSelect>
      {!linux ? (
        <RunConfigurationControl {...props} />
      ) : available && current ? (
        <RunDefinitionSourceProvider binding={current.binding}>
          <RunConfigurationControl
            {...props}
            key={encoded}
            sourceKey={encoded}
            osSelection={selection!}
            inventory={inventory.data}
            runtimes={runtimes.data ?? []}
            worktrees={targets.map((source) => source.target)}
            loading={inventory.isLoading}
            error={inventory.error?.message ?? runtimes.error?.message ?? null}
          />
        </RunDefinitionSourceProvider>
      ) : (
        <InlineAlert tone="error">
          {sources.isLoading
            ? "Loading Linux Run source…"
            : (sources.error?.message ??
              "The selected Linux source changed or is unavailable. Select its current epoch after refreshing/verifying it in Settings. Primary must be bound in this workspace.")}
        </InlineAlert>
      )}
    </div>
  );
}
