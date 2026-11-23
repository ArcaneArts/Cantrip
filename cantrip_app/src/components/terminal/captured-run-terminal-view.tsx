import { useEffect, type ComponentProps } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RunTerminalView } from "./run-terminal-view";
import { getCantripOsRunSources } from "@/lib/api/cantrip-os";
import { listRunConfigurationRuntimes } from "@/lib/run-configuration-api";
import { linuxRunDefinitionApi } from "@/lib/run-definition-source";
import { runConfigurationCatalogKey } from "@/lib/run-configuration-catalog";
import { InlineAlert } from "@/components/ui/inline-alert";

export function CapturedRunTerminalView(
  props: ComponentProps<typeof RunTerminalView> & {
    onEditConfiguration?(configurationId: string): void;
  },
) {
  const queryClient = useQueryClient();
  const { terminal } = props;
  const metadata = useQuery({
    queryKey: [
      "run-configuration-runtime",
      terminal.projectId,
      terminal.runConfigurationRuntimeId,
    ],
    queryFn: () =>
      listRunConfigurationRuntimes(terminal.projectId, {
        runtimeId: terminal.runConfigurationRuntimeId!,
        configurationId: terminal.runConfigurationId,
      }),
    enabled: Boolean(terminal.runConfigurationRuntimeId),
    refetchInterval: 1000,
    retry: false,
  });
  const runtime = metadata.isSuccess
    ? (metadata.data[0] ?? null)
    : props.runtime?.id === terminal.runConfigurationRuntimeId
      ? props.runtime
      : null;
  const selection = runtime?.osDefinition;
  const sources = useQuery({
    enabled: Boolean(selection),
    queryKey: ["cantrip-os-run-sources", terminal.projectId],
    queryFn: () => getCantripOsRunSources(terminal.projectId),
    refetchInterval: 5000,
    retry: false,
  });
  const source = sources.data?.find(
    (candidate) =>
      selection &&
      candidate.binding.id === selection.bindingId &&
      candidate.binding.bindingGeneration === selection.bindingGeneration &&
      candidate.instance.attachmentGeneration ===
        selection.attachmentGeneration &&
      candidate.instance.runtimeGeneration === selection.runtimeGeneration,
  );
  const definition = useQuery({
    enabled: Boolean(
      selection && source?.available && terminal.runConfigurationId,
    ),
    queryKey: [
      "run-configuration-captured-definition",
      terminal.projectId,
      runtime?.id,
      selection,
    ],
    queryFn: () =>
      linuxRunDefinitionApi(source!.binding).getRunConfiguration(
        terminal.projectId,
        terminal.runConfigurationId!,
      ),
    refetchInterval: 5000,
    retry: false,
  });
  const definitionName = definition.data?.found
    ? definition.data.entry.document?.name
    : undefined;
  const capturedTitle =
    definitionName && runtime
      ? source?.target.id === runtime.worktreeId
        ? definitionName
        : `${definitionName} · Linux worktree ${runtime.worktreeId.slice(0, 8)}`
      : null;
  useEffect(() => {
    if (capturedTitle && runtime)
      queryClient.setQueryData<Record<string, string>>(
        ["run-terminal-titles", terminal.projectId],
        (current = {}) => ({ ...current, [runtime.id]: capturedTitle }),
      );
  }, [queryClient, capturedTitle, runtime?.id, terminal.projectId]);
  const edit = useMutation({
    mutationFn: async () => {
      if (!selection || !source || !terminal.runConfigurationId)
        throw new Error("The captured Linux definition source is unavailable.");
      const inventory = await linuxRunDefinitionApi(
        source.binding,
      ).listRunConfigurations(terminal.projectId);
      queryClient.setQueryData(
        ["run-configurations", terminal.projectId, JSON.stringify(selection)],
        inventory,
      );
      props.onEditConfiguration?.(
        runConfigurationCatalogKey(
          JSON.stringify(selection),
          terminal.runConfigurationId,
        ),
      );
    },
  });
  if (!runtime)
    return (
      <RunTerminalView
        {...props}
        runtime={null}
        definitionAvailable={null}
        definitionProblem={
          metadata.error?.message ??
          (metadata.isSuccess
            ? "The captured Run runtime is unavailable."
            : null)
        }
        launchAvailable={false}
        stopAvailable={false}
        onEdit={undefined}
      />
    );
  if (!selection) return <RunTerminalView {...props} runtime={runtime} />;
  const ready =
    definition.data?.found === true && definition.data.entry.status === "ready";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {edit.error ? (
        <InlineAlert tone="error">{edit.error.message}</InlineAlert>
      ) : null}
      <RunTerminalView
        {...props}
        runtime={runtime}
        terminal={{
          ...terminal,
          title:
            definition.data?.found && definition.data.entry.document
              ? definition.data.entry.document.name
              : terminal.title,
        }}
        targetLabel={`Linux · ${runtime.osTargetGuestPath ?? terminal.worktreeId}`}
        definitionAvailable={
          definition.isPending && source?.available ? null : ready
        }
        definitionProblem={
          definition.error?.message ??
          sources.error?.message ??
          (!source
            ? "The captured Linux definition epoch changed or is unavailable."
            : null)
        }
        launchAvailable={Boolean(ready && source?.available)}
        launchProblem={
          source?.available ? null : "The captured Linux source is unavailable."
        }
        stopAvailable={true}
        stopProblem={null}
        onEdit={
          ready && props.onEditConfiguration ? () => edit.mutate() : undefined
        }
      />
    </div>
  );
}
