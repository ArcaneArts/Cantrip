import type {
  TunnelProtocolHint,
  TunnelSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { NativeSelect } from "@/components/ui/native-select";
import { getCantripOsRunSources } from "@/lib/api/cantrip-os";
import { TunnelTcpFields, tunnelInputClass as inputClass } from "./tunnel-tcp";
import { TunnelLinuxServiceFields } from "./tunnel-ssh";

export interface TunnelDraft {
  direction: "to-service" | "to-host";
  guestPort: string;
  service: "tcp" | "ssh" | "vnc";
  publicKey: string;
  osSource: TunnelSummary["osSource"] | null;
  description: string;
  host: "127.0.0.1" | "localhost" | "::1";
  name: string;
  port: string;
  projectId: string;
  protocolHint: TunnelProtocolHint;
  workerId: string;
}

export function emptyDraft(projectId: string | null): TunnelDraft {
  return {
    direction: "to-service",
    guestPort: "",
    osSource: null,
    service: "tcp",
    publicKey: "",
    description: "",
    host: "127.0.0.1",
    name: "",
    port: "",
    projectId: projectId ?? "",
    protocolHint: "tcp",
    workerId: "",
  };
}

export function draftFor(tunnel: TunnelSummary): TunnelDraft {
  if (
    tunnel.destination.kind !== "worker-tcp" &&
    tunnel.destination.kind !== "worker-os-tcp" &&
    tunnel.destination.kind !== "worker-os-ssh" &&
    tunnel.destination.kind !== "worker-os-vnc"
  ) {
    return emptyDraft(tunnel.projectId);
  }
  const listener =
    tunnel.source.kind === "worker-os-listener" ? tunnel.source : null;
  return {
    direction: listener ? "to-host" : "to-service",
    guestPort: listener ? String(listener.port) : "",
    service:
      tunnel.destination.kind === "worker-os-ssh"
        ? "ssh"
        : tunnel.destination.kind === "worker-os-vnc"
          ? "vnc"
          : "tcp",
    publicKey:
      tunnel.destination.kind === "worker-os-ssh"
        ? tunnel.destination.publicKey
        : "",
    osSource:
      tunnel.destination.kind === "worker-os-tcp" ||
      tunnel.destination.kind === "worker-os-ssh" ||
      tunnel.destination.kind === "worker-os-vnc"
        ? tunnel.destination.source
        : (listener?.source ?? null),
    description: tunnel.description ?? "",
    host:
      tunnel.destination.kind === "worker-tcp"
        ? tunnel.destination.host
        : "127.0.0.1",
    name: tunnel.name,
    port:
      tunnel.destination.kind === "worker-os-ssh" ||
      tunnel.destination.kind === "worker-os-vnc"
        ? ""
        : String(tunnel.destination.port),
    projectId: tunnel.projectId ?? "",
    protocolHint: tunnel.protocolHint,
    workerId: tunnel.destination.workerId,
  };
}

export function TunnelRouteFields({
  draft,
  setDraft,
  workers,
  osSources,
}: {
  draft: TunnelDraft;
  setDraft: Dispatch<SetStateAction<TunnelDraft>>;
  workers: WorkerSummary[];
  osSources: Awaited<ReturnType<typeof getCantripOsRunSources>>;
}) {
  const reverse = draft.direction === "to-host";
  useEffect(() => {
    const only = osSources.length === 1 ? osSources[0] : undefined;
    if (!reverse || draft.osSource || !only?.instance.runtimeGeneration) return;
    setDraft((current) =>
      current.direction !== "to-host" || current.osSource
        ? current
        : {
            ...current,
            workerId: only.instance.workerId,
            osSource: {
              bindingId: only.binding.id,
              worktreeId: only.binding.worktreeId,
              bindingGeneration: only.binding.bindingGeneration,
              attachmentGeneration: only.instance.attachmentGeneration,
              runtimeGeneration: only.instance.runtimeGeneration!,
            },
          },
    );
  }, [reverse, draft.osSource, osSources, setDraft]);
  const destinationCount =
    workers.length +
    osSources.length +
    (draft.osSource &&
    !osSources.some((source) => source.binding.id === draft.osSource?.bindingId)
      ? 1
      : 0);
  return (
    <>
      {osSources.length || draft.osSource ? (
        <label className="grid gap-1.5 text-sm sm:col-span-2">
          <span className="font-medium">Direction</span>
          <NativeSelect
            className={inputClass}
            value={draft.direction}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                direction: event.target.value as TunnelDraft["direction"],
                service: "tcp",
                osSource: null,
              }))
            }
          >
            <option value="to-service">
              This device → Host or CantripOS service
            </option>
            <option value="to-host">CantripOS → Worker Host</option>
          </NativeSelect>
        </label>
      ) : null}
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">
          {reverse ? "CantripOS workspace" : "Destination"}
        </span>
        {reverse &&
        draft.osSource &&
        osSources.length === 1 &&
        osSources[0]?.binding.id === draft.osSource.bindingId ? (
          <span className="flex h-9 items-center text-sm">
            CantripOS · {osSources[0].instance.name} /{" "}
            {osSources[0].workspace.guestWorkspaceId}
          </span>
        ) : !reverse &&
          destinationCount === 1 &&
          draft.workerId &&
          !draft.osSource ? (
          <span className="flex h-9 items-center text-sm">
            {workers.find((worker) => worker.workerId === draft.workerId)
              ?.name ?? draft.workerId}{" "}
            · Host
          </span>
        ) : (
          <NativeSelect
            className={inputClass}
            required
            value={
              draft.osSource
                ? `os:${draft.osSource.bindingId}`
                : !reverse && draft.workerId
                  ? `host:${draft.workerId}`
                  : ""
            }
            onChange={(event) => {
              const selected = event.target.value;
              const source = osSources.find(
                (source) => `os:${source.binding.id}` === selected,
              );
              setDraft((current) =>
                source && source.instance.runtimeGeneration
                  ? {
                      ...current,
                      workerId: source.instance.workerId,
                      osSource: {
                        bindingId: source.binding.id,
                        worktreeId: source.binding.worktreeId,
                        bindingGeneration: source.binding.bindingGeneration,
                        attachmentGeneration:
                          source.instance.attachmentGeneration,
                        runtimeGeneration: source.instance.runtimeGeneration,
                      },
                    }
                  : {
                      ...current,
                      workerId: selected.replace(/^host:/, ""),
                      osSource: null,
                      service: "tcp",
                    },
              );
            }}
          >
            <option value="" disabled>
              Select a destination
            </option>
            {(!reverse ? workers : []).map((worker) => (
              <option key={worker.workerId} value={`host:${worker.workerId}`}>
                {worker.name} · Host
                {worker.online ? "" : " (offline)"}
              </option>
            ))}
            {osSources.map((source) => (
              <option
                key={source.binding.id}
                value={`os:${source.binding.id}`}
                disabled={!source.instance.runtimeGeneration}
              >
                CantripOS · {source.instance.name} /{" "}
                {source.workspace.guestWorkspaceId} ·{" "}
                {source.binding.worktreeId.slice(0, 8)}
              </option>
            ))}
            {draft.osSource &&
            !osSources.some(
              (source) => source.binding.id === draft.osSource?.bindingId,
            ) ? (
              <option value={`os:${draft.osSource.bindingId}`}>
                CantripOS · captured source{" "}
                {draft.osSource.worktreeId.slice(0, 8)}
              </option>
            ) : null}
          </NativeSelect>
        )}
      </label>
      {draft.osSource && !reverse ? (
        <TunnelLinuxServiceFields
          service={draft.service}
          publicKey={draft.publicKey}
          onChange={(value) =>
            setDraft((current) => ({ ...current, ...value }))
          }
        />
      ) : null}
      {reverse || !(draft.osSource && draft.service !== "tcp") ? (
        <>
          <TunnelTcpFields
            value={draft}
            linux={!reverse && Boolean(draft.osSource)}
            onChange={(value) =>
              setDraft((current) => ({ ...current, ...value }))
            }
          />
        </>
      ) : null}

      {reverse ? (
        <>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Guest listen port</span>
            <input
              className={inputClass}
              type="number"
              min={1}
              max={65535}
              required
              value={draft.guestPort}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  guestPort: event.target.value,
                }))
              }
            />
          </label>
          <p className="self-end pb-2 text-xs text-muted-foreground">
            Listens on 127.0.0.1 inside CantripOS and forwards to the selected
            workspace's Worker Host. The Worker is{" "}
            {workers.find((worker) => worker.workerId === draft.workerId)
              ?.name ?? draft.workerId}
            .
          </p>
        </>
      ) : null}
    </>
  );
}
