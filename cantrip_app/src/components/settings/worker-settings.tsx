import type {
  WorkerCredentialSummary,
  WorkerEnrollmentCodeResult,
  WorkerManagementSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Cpu,
  GitCompareArrows,
  HardDrive,
  KeyRound,
  Laptop,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Trash2,
  Unplug,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createWorkerEnrollmentCode,
  getWorkerCredentials,
  getWorkerEnrollmentCodeStatus,
  getWorkerManagement,
  getSettings,
  revokeWorkerCredential,
  rotateWorkerCredential,
  unlinkWorker,
  updateSettings,
  updateWorker,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import {
  forgetDesktopWorker,
  getDesktopAutostart,
  listDesktopWorkers,
  pairDesktopWorker,
  setDesktopAutostart,
  supportsDesktopWorkers,
} from "@/lib/desktop-worker";
import {
  getActiveServerConnection,
  getActiveServerUrl,
} from "@/lib/server-connections";
import { SettingsSearchField } from "./settings-controls";

const inputClass =
  "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";

export function formatWorkerLastSeen(value: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  if (elapsed < 30_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000)
    return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  return new Date(value).toLocaleString();
}

export function workerPairingCommands(
  serverUrl: string,
  code: string,
): { posix: string; powershell: string } {
  return {
    posix: `CANTRIP_SERVER_URL='${serverUrl}' CANTRIP_WORKER_ENROLLMENT_CODE='${code}' ./bin/cantrip-worker`,
    powershell: `$env:CANTRIP_SERVER_URL=\"${serverUrl}\"; $env:CANTRIP_WORKER_ENROLLMENT_CODE=\"${code}\"; .\\bin\\cantrip-worker.exe`,
  };
}

export function canAddThisMachine(input: {
  desktopApp: boolean;
  hasInternalWorker: boolean;
  linkedWorkerId: string | null;
  serverIsRemote: boolean;
  serverWorkerIds: string[];
}): boolean {
  return (
    input.desktopApp &&
    input.serverIsRemote &&
    !input.hasInternalWorker &&
    (!input.linkedWorkerId ||
      !input.serverWorkerIds.includes(input.linkedWorkerId))
  );
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function WorkerCapabilities({ worker }: { worker: WorkerManagementSummary }) {
  const capabilities = [
    worker.code.available ? "Code" : null,
    worker.remoteSurfaces.browser ? "Browser" : null,
    worker.remoteSurfaces.desktop ? "Desktop" : null,
    `Codex ${worker.codexRuntime.compatibility}`,
  ].filter(Boolean);
  return (
    <p className="truncate text-xs text-muted-foreground">
      {capabilities.join(" · ")}
    </p>
  );
}

function CredentialRow({
  credential,
  revoking,
  onRevoke,
}: {
  credential: WorkerCredentialSummary;
  revoking: boolean;
  onRevoke(): void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 odd:bg-muted/[0.18]">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {credential.label ?? "Worker credential"}
          </span>
          <Badge variant={credential.active ? "secondary" : "outline"}>
            {credential.active ? "Active" : "Revoked"}
          </Badge>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          Created {new Date(credential.createdAt).toLocaleString()}
          {credential.lastUsedAt
            ? ` · last used ${formatWorkerLastSeen(credential.lastUsedAt)}`
            : " · never used"}
        </p>
      </div>
      {credential.active ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={revoking}
          onClick={onRevoke}
        >
          <Trash2 className="size-3.5" /> Revoke
        </Button>
      ) : null}
    </div>
  );
}

function WorkerRow({
  isDefault,
  isThisMachine,
  worker,
  onManage,
  onUnlink,
}: {
  isDefault: boolean;
  isThisMachine: boolean;
  worker: WorkerManagementSummary;
  onManage(): void;
  onUnlink(): void;
}) {
  return (
    <div
      data-high-contrast-row
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-md bg-muted/45 ${worker.online ? "text-emerald-500" : "text-muted-foreground"}`}
        >
          {worker.internal ? (
            <Laptop className="size-4" />
          ) : worker.online ? (
            <Wifi className="size-4" />
          ) : (
            <WifiOff className="size-4" />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{worker.name}</p>
            {worker.internal ? (
              <Badge variant="secondary">Internal</Badge>
            ) : null}
            {isThisMachine && !worker.internal ? (
              <Badge variant="secondary">This machine</Badge>
            ) : null}
            {isDefault ? <Badge variant="outline">Default</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {worker.online ? "Online" : "Offline"} · last seen{" "}
            {formatWorkerLastSeen(worker.lastSeenAt)}
          </p>
        </div>
      </div>
      <div className="col-span-2 min-w-0 pl-10 lg:col-span-1 lg:pl-0">
        <p className="truncate text-xs">
          {worker.platform} · {worker.architecture}
          {worker.codexVersion ? ` · ${worker.codexVersion}` : ""}
        </p>
        <WorkerCapabilities worker={worker} />
      </div>
      <div className="col-span-2 min-w-0 pl-10 lg:col-span-1 lg:pl-0">
        <p className="truncate text-xs">
          {worker.sources.length
            ? worker.sources
                .map(({ nameWithOwner }) => nameWithOwner)
                .join(", ")
            : "No project sources"}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {worker.sources.length} source{worker.sources.length === 1 ? "" : "s"}
          {worker.sources.length
            ? ` · ${worker.sources.map(({ displayPath }) => displayPath).join(", ")}`
            : ""}
          {worker.internal
            ? " · managed by this Cantrip installation"
            : ` · ${worker.activeCredentialCount} active credential${worker.activeCredentialCount === 1 ? "" : "s"}`}
        </p>
      </div>
      <div className="col-start-2 row-start-1 flex items-center justify-end lg:col-auto lg:row-auto">
        {worker.editable ? (
          <Button size="icon" variant="ghost" onClick={onManage}>
            <Pencil className="size-3.5" />
            <span className="sr-only">Manage {worker.name}</span>
          </Button>
        ) : (
          <span title="Internal workers are managed by Cantrip">
            <ShieldCheck className="mx-2 size-4 text-muted-foreground" />
          </span>
        )}
        {worker.removable ? (
          <Button size="icon" variant="ghost" onClick={onUnlink}>
            <Unplug className="size-3.5" />
            <span className="sr-only">Unlink {worker.name}</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WorkerSettings() {
  const queryClient = useQueryClient();
  const desktopApp = supportsDesktopWorkers();
  const activeConnection = getActiveServerConnection()!;
  const serverUrl = getActiveServerUrl() || window.location.origin;
  const workers = useQuery({
    queryFn: getWorkerManagement,
    queryKey: ["worker-management"],
    refetchInterval: 10_000,
  });
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const desktopWorkers = useQuery({
    enabled: desktopApp,
    queryFn: listDesktopWorkers,
    queryKey: ["desktop-workers"],
    refetchInterval: 5_000,
  });
  const desktopAutostart = useQuery({
    enabled: desktopApp,
    queryFn: getDesktopAutostart,
    queryKey: ["desktop-autostart"],
  });
  const [search, setSearch] = useState("");
  const [pairOpen, setPairOpen] = useState(false);
  const [pairLabel, setPairLabel] = useState("");
  const [pairExpiry, setPairExpiry] = useState(600);
  const [pairResult, setPairResult] =
    useState<WorkerEnrollmentCodeResult | null>(null);
  const [commandKind, setCommandKind] = useState<"posix" | "powershell">(
    "posix",
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkerManagementSummary | null>(
    null,
  );
  const [nameDraft, setNameDraft] = useState("");
  const [rotation, setRotation] = useState<{
    credential: string;
    delivered: boolean;
  } | null>(null);
  const [unlinkTarget, setUnlinkTarget] =
    useState<WorkerManagementSummary | null>(null);
  const [desktopEnrollment, setDesktopEnrollment] =
    useState<WorkerEnrollmentCodeResult | null>(null);

  const pairing = useMutation({
    mutationFn: () =>
      createWorkerEnrollmentCode({
        label: pairLabel.trim() || null,
        expiresInSeconds: pairExpiry,
      }),
    onSuccess: setPairResult,
  });
  const pairingStatus = useQuery({
    enabled: Boolean(pairResult),
    queryFn: () => getWorkerEnrollmentCodeStatus(pairResult!.id),
    queryKey: ["worker-enrollment-status", pairResult?.id],
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || !query.state.data
        ? 1_500
        : false,
  });
  useEffect(() => {
    if (pairingStatus.data?.status !== "paired") return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
      queryClient.invalidateQueries({ queryKey: ["workers"] }),
    ]);
  }, [pairingStatus.data?.status, queryClient]);

  const desktopEnrollmentStatus = useQuery({
    enabled: Boolean(desktopEnrollment),
    queryFn: () => getWorkerEnrollmentCodeStatus(desktopEnrollment!.id),
    queryKey: ["desktop-worker-enrollment-status", desktopEnrollment?.id],
    refetchInterval: (query) =>
      query.state.data?.status === "pending" || !query.state.data
        ? 1_000
        : false,
  });
  useEffect(() => {
    if (desktopEnrollmentStatus.data?.status !== "paired") return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["desktop-workers"] }),
      queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
      queryClient.invalidateQueries({ queryKey: ["workers"] }),
    ]);
  }, [desktopEnrollmentStatus.data?.status, queryClient]);

  const updateAutostart = useMutation({
    mutationFn: setDesktopAutostart,
    onSuccess: (enabled) =>
      queryClient.setQueryData(["desktop-autostart"], enabled),
  });
  const addThisMachine = useMutation({
    mutationFn: async () => {
      const enrollment = await createWorkerEnrollmentCode({
        label: "This machine",
        expiresInSeconds: 300,
      });
      const desktopWorker = await pairDesktopWorker({
        enrollmentCode: enrollment.code,
        name: "This machine",
        serverUrl,
      });
      return { desktopWorker, enrollment };
    },
    onSuccess: ({ enrollment }) => {
      setDesktopEnrollment(enrollment);
      void queryClient.invalidateQueries({ queryKey: ["desktop-workers"] });
      if (!desktopAutostart.data) updateAutostart.mutate(true);
    },
  });

  const credentials = useQuery({
    enabled: Boolean(selected),
    queryFn: () => getWorkerCredentials(selected!.workerId),
    queryKey: ["worker-credentials", selected?.workerId],
  });
  const rename = useMutation({
    mutationFn: () => updateWorker(selected!.workerId, { name: nameDraft }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
        queryClient.invalidateQueries({ queryKey: ["workers"] }),
      ]);
      setSelected(null);
    },
  });
  const rotate = useMutation({
    mutationFn: () =>
      rotateWorkerCredential(selected!.workerId, {
        label: `${nameDraft.trim() || selected!.name} rotated`,
      }),
    onSuccess: async (result) => {
      setRotation({
        credential: result.credential,
        delivered: result.delivered,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["worker-credentials", selected?.workerId],
        }),
        queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
        queryClient.invalidateQueries({ queryKey: ["workers"] }),
      ]);
    },
  });
  const revoke = useMutation({
    mutationFn: (credentialId: string) =>
      revokeWorkerCredential(selected!.workerId, credentialId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["worker-credentials", selected?.workerId],
        }),
        queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
        queryClient.invalidateQueries({ queryKey: ["workers"] }),
      ]);
    },
  });
  const unlink = useMutation({
    mutationFn: async () => {
      const workerId = unlinkTarget!.workerId;
      await unlinkWorker(workerId);
      if (desktopWorkers.data?.some((worker) => worker.workerId === workerId)) {
        await forgetDesktopWorker(workerId);
      }
    },
    onSuccess: async () => {
      setUnlinkTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["worker-management"] }),
        queryClient.invalidateQueries({ queryKey: ["workers"] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["desktop-workers"] }),
      ]);
    },
  });
  const updatePlacementPolicy = useMutation({
    mutationFn: updateSettings,
    onSuccess: (value) => queryClient.setQueryData(["settings"], value),
  });

  const normalizedSearch = search.trim().toLowerCase();
  const visibleWorkers = useMemo(
    () =>
      (workers.data ?? []).filter((worker) =>
        [
          worker.name,
          worker.runtimeName,
          worker.platform,
          worker.architecture,
          worker.codexVersion ?? "",
          worker.online ? "online" : "offline",
          worker.internal ? "internal embedded local" : "remote",
          ...worker.sources.flatMap((source) => [
            source.nameWithOwner,
            source.displayPath,
          ]),
        ].some((value) => value.toLowerCase().includes(normalizedSearch)),
      ),
    [normalizedSearch, workers.data],
  );
  const desktopWorkerForServer = desktopWorkers.data?.find(
    (worker) => worker.serverUrl === serverUrl,
  );
  const serverWorkerIds = (workers.data ?? []).map((worker) => worker.workerId);
  const hasInternalWorker = (workers.data ?? []).some(
    (worker) => worker.internal,
  );
  const offerThisMachine = canAddThisMachine({
    desktopApp,
    hasInternalWorker,
    linkedWorkerId: desktopWorkerForServer?.workerId ?? null,
    serverIsRemote: activeConnection.kind === "remote",
    serverWorkerIds,
  });
  const desktopPairing =
    addThisMachine.isPending ||
    desktopEnrollmentStatus.data?.status === "pending";
  const commands = pairResult
    ? workerPairingCommands(serverUrl, pairResult.code)
    : null;

  const rememberCopy = async (key: string, value: string) => {
    try {
      await copyText(value);
      setCopyError(null);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch (error) {
      setCopyError(errorMessage(error));
    }
  };

  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsSearchField
          ariaLabel="Search workers"
          placeholder="Search workers, platforms, and project sources"
          value={search}
          onValueChange={setSearch}
        />
        {!workers.isLoading &&
        !desktopWorkers.isLoading &&
        desktopEnrollmentStatus.data?.status !== "paired" &&
        (offerThisMachine || desktopPairing) ? (
          <Button
            className="shrink-0"
            disabled={desktopPairing}
            onClick={() => {
              addThisMachine.reset();
              setDesktopEnrollment(null);
              addThisMachine.mutate();
            }}
          >
            {desktopPairing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Laptop className="size-4" />
            )}
            {desktopPairing ? "Adding this machine…" : "Add this machine"}
          </Button>
        ) : null}
        <Button
          className="shrink-0"
          variant={offerThisMachine || desktopPairing ? "outline" : "default"}
          onClick={() => {
            pairing.reset();
            setPairResult(null);
            setCopyError(null);
            setPairOpen(true);
          }}
        >
          <Plus className="size-4" /> Pair worker
        </Button>
      </div>

      {desktopApp ? (
        <section className="border-y" aria-labelledby="desktop-worker-title">
          <div className="flex items-center gap-2.5 px-3 py-3">
            <Rocket className="size-4 shrink-0 text-muted-foreground" />
            <div>
              <h2 id="desktop-worker-title" className="text-sm font-semibold">
                This desktop
              </h2>
              <p className="text-xs text-muted-foreground">
                {activeConnection.kind === "local"
                  ? "The bundled local worker is detected and managed automatically."
                  : desktopWorkerForServer
                    ? `${desktopWorkerForServer.name} is ${desktopWorkerForServer.running ? "running" : "stopped"} for ${activeConnection.name}.`
                    : `Add this machine to run work for ${activeConnection.name} without copying a link code.`}
              </p>
            </div>
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-4 border-t px-3 py-3">
            <span className="flex min-w-0 items-start gap-2.5">
              <Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  Launch Cantrip at login
                </span>
                <span className="block text-xs text-muted-foreground">
                  Starts hidden in the system tray so linked workers reconnect
                  after a restart. Closing the window also keeps them online.
                </span>
              </span>
            </span>
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-foreground"
              checked={desktopAutostart.data ?? false}
              disabled={desktopAutostart.isLoading || updateAutostart.isPending}
              onChange={(event) => updateAutostart.mutate(event.target.checked)}
            />
          </label>
          {addThisMachine.isError ||
          desktopEnrollmentStatus.isError ||
          updateAutostart.isError ? (
            <p className="border-t px-3 py-2 text-sm text-destructive">
              {errorMessage(
                addThisMachine.error ??
                  desktopEnrollmentStatus.error ??
                  updateAutostart.error,
              )}
            </p>
          ) : desktopEnrollmentStatus.data?.status === "expired" ? (
            <p className="border-t px-3 py-2 text-sm text-destructive">
              This machine did not finish linking before enrollment expired. Try
              adding it again.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="border-y" aria-labelledby="worker-placement-title">
        <div className="flex items-center gap-2.5 px-3 py-3">
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
          <div>
            <h2 id="worker-placement-title" className="text-sm font-semibold">
              Placement defaults
            </h2>
            <p className="text-xs text-muted-foreground">
              Defaults used when Cantrip places future project replicas and
              surfaces. Existing resources are not moved.
            </p>
          </div>
        </div>
        <div className="divide-y border-t">
          <label className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center">
            <span>
              <span className="block text-sm font-medium">Default worker</span>
              <span className="block text-xs text-muted-foreground">
                Preferred machine when a project does not override placement.
              </span>
            </span>
            <select
              className={inputClass}
              disabled={settings.isLoading || updatePlacementPolicy.isPending}
              value={settings.data?.preferences.defaultWorkerId ?? ""}
              onChange={(event) =>
                updatePlacementPolicy.mutate({
                  defaultWorkerId: event.target.value || null,
                })
              }
            >
              <option value="">Automatic fallback</option>
              {(workers.data ?? []).map((worker) => (
                <option key={worker.workerId} value={worker.workerId}>
                  {worker.name} ({worker.online ? "online" : "offline"})
                </option>
              ))}
            </select>
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-4 px-3 py-3">
            <span className="flex min-w-0 items-start gap-2.5">
              <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  Provision missing replicas automatically
                </span>
                <span className="block text-xs text-muted-foreground">
                  Allows future placement flows to create a worker-local clone
                  when the selected worker has no replica.
                </span>
              </span>
            </span>
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-foreground"
              checked={
                settings.data?.preferences.automaticReplicaProvisioning ?? false
              }
              disabled={settings.isLoading || updatePlacementPolicy.isPending}
              onChange={(event) =>
                updatePlacementPolicy.mutate({
                  automaticReplicaProvisioning: event.target.checked,
                })
              }
            />
          </label>
          <label className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-center">
            <span className="flex min-w-0 items-start gap-2.5">
              <GitCompareArrows className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">
                  Automatic replica synchronization
                </span>
                <span className="block text-xs text-muted-foreground">
                  Safety policy for future placement. Fast-forward never resets,
                  rebases, cleans, or overwrites local work.
                </span>
              </span>
            </span>
            <select
              className={inputClass}
              disabled={settings.isLoading || updatePlacementPolicy.isPending}
              value={
                settings.data?.preferences.automaticReplicaSynchronization ??
                "off"
              }
              onChange={(event) =>
                updatePlacementPolicy.mutate({
                  automaticReplicaSynchronization: event.target.value as
                    "off" | "verify-only" | "fast-forward-primary",
                })
              }
            >
              <option value="off">Off</option>
              <option value="verify-only">Verify exact revision</option>
              <option value="fast-forward-primary">
                Fast-forward clean Primary
              </option>
            </select>
          </label>
        </div>
        {settings.isError || updatePlacementPolicy.isError ? (
          <p className="border-t px-3 py-2 text-sm text-destructive">
            {errorMessage(settings.error ?? updatePlacementPolicy.error)}
          </p>
        ) : null}
      </section>

      <section className="border-y">
        <div className="flex items-center justify-between gap-3 px-3 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Cpu className="size-4 shrink-0 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">
                Workers {workers.data?.length ?? 0}
              </h2>
              <p className="text-xs text-muted-foreground">
                Machines that run files, terminals, Codex, Code, and remote
                surfaces.
              </p>
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            disabled={workers.isFetching}
            onClick={() => workers.refetch()}
          >
            <RefreshCw
              className={`size-3.5 ${workers.isFetching ? "animate-spin" : ""}`}
            />
            <span className="sr-only">Refresh workers</span>
          </Button>
        </div>
        <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_72px] gap-3 border-t px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground lg:grid">
          <span>Worker</span>
          <span>Runtime</span>
          <span>Project sources</span>
          <span className="text-right">Actions</span>
        </div>
        <div className="border-t">
          {visibleWorkers.map((worker) => (
            <WorkerRow
              key={worker.workerId}
              isDefault={
                settings.data?.preferences.defaultWorkerId === worker.workerId
              }
              isThisMachine={
                desktopWorkerForServer?.workerId === worker.workerId
              }
              worker={worker}
              onManage={() => {
                setSelected(worker);
                setNameDraft(worker.name);
                setRotation(null);
                setCopyError(null);
              }}
              onUnlink={() => setUnlinkTarget(worker)}
            />
          ))}
          {workers.isLoading ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline size-4 animate-spin" /> Loading
              workers…
            </p>
          ) : workers.isError ? (
            <p className="px-3 py-8 text-center text-sm text-destructive">
              {errorMessage(workers.error)}
            </p>
          ) : !visibleWorkers.length ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {normalizedSearch
                ? "No workers match this search."
                : "No workers are linked yet."}
            </p>
          ) : null}
        </div>
      </section>

      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pair a worker</DialogTitle>
            <DialogDescription>
              Create a one-time link code. The server stores only a hash and
              never shows the worker credential after enrollment.
            </DialogDescription>
          </DialogHeader>
          {!pairResult ? (
            <form
              className="grid gap-4"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                pairing.mutate();
              }}
            >
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Worker label</span>
                <input
                  autoFocus
                  className={inputClass}
                  value={pairLabel}
                  placeholder="Desk Mac"
                  onChange={(event) => setPairLabel(event.target.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Code expires in</span>
                <select
                  className={inputClass}
                  value={pairExpiry}
                  onChange={(event) =>
                    setPairExpiry(Number(event.target.value))
                  }
                >
                  <option value={300}>5 minutes</option>
                  <option value={600}>10 minutes</option>
                  <option value={1800}>30 minutes</option>
                </select>
              </label>
              {pairing.isError ? (
                <p className="text-sm text-destructive">
                  {errorMessage(pairing.error)}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={pairing.isPending}>
                  {pairing.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <KeyRound className="size-4" />
                  )}
                  Create link code
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="grid gap-4">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {pairingStatus.data?.status === "paired"
                      ? "Worker paired"
                      : pairingStatus.data?.status === "expired"
                        ? "Link code expired"
                        : "Waiting for worker…"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(pairResult.expiresAt).toLocaleString()}
                  </p>
                </div>
                {pairingStatus.data?.status === "paired" ? (
                  <Check className="size-5 text-emerald-500" />
                ) : pairingStatus.data?.status === "expired" ? (
                  <WifiOff className="size-5 text-destructive" />
                ) : (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                )}
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">One-time code</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => rememberCopy("code", pairResult.code)}
                  >
                    {copied === "code" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "code" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <code className="overflow-x-auto rounded-md bg-muted/45 p-3 text-xs">
                  {pairResult.code}
                </code>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex rounded-md bg-muted/45 p-0.5">
                    {(["posix", "powershell"] as const).map((kind) => (
                      <Button
                        key={kind}
                        size="sm"
                        variant={commandKind === kind ? "default" : "ghost"}
                        className="h-7 text-xs capitalize"
                        onClick={() => setCommandKind(kind)}
                      >
                        {kind}
                      </Button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      rememberCopy("command", commands![commandKind])
                    }
                  >
                    {copied === "command" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "command" ? "Copied" : "Copy command"}
                  </Button>
                </div>
                <code className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/45 p-3 text-xs">
                  {commands?.[commandKind]}
                </code>
              </div>
              {pairingStatus.isError ? (
                <p className="text-sm text-destructive">
                  Could not check pairing progress:{" "}
                  {errorMessage(pairingStatus.error)}
                </p>
              ) : null}
              {copyError ? (
                <p className="text-sm text-destructive">
                  Could not copy to the clipboard: {copyError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    pairing.reset();
                    setPairResult(null);
                  }}
                >
                  Create another
                </Button>
                <Button onClick={() => setPairOpen(false)}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Manage worker</DialogTitle>
            <DialogDescription>
              Rename this worker or manage its independently revocable
              credentials.
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="grid gap-5">
              <form
                className="flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename.mutate();
                }}
              >
                <label className="grid min-w-0 flex-1 gap-1.5 text-sm">
                  <span className="font-medium">Display name</span>
                  <input
                    className={inputClass}
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!nameDraft.trim() || rename.isPending}
                >
                  Save name
                </Button>
              </form>
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Credentials</p>
                    <p className="text-xs text-muted-foreground">
                      Rotation securely updates an online worker before it
                      reconnects.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rotate.isPending}
                    onClick={() => rotate.mutate()}
                  >
                    {rotate.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Rotate
                  </Button>
                </div>
                <div className="border-y">
                  {(credentials.data ?? []).map((credential) => (
                    <CredentialRow
                      key={credential.id}
                      credential={credential}
                      revoking={revoke.isPending}
                      onRevoke={() => revoke.mutate(credential.id)}
                    />
                  ))}
                  {credentials.isLoading ? (
                    <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                      Loading credentials…
                    </p>
                  ) : !credentials.data?.length ? (
                    <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                      No credentials found.
                    </p>
                  ) : null}
                </div>
              </div>
              {rotation ? (
                <div className="grid gap-2 rounded-lg bg-muted/35 p-3">
                  <p className="text-sm font-medium">
                    {rotation.delivered
                      ? "Credential updated on the worker"
                      : "Save this replacement credential on the offline worker"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This credential is shown only now.{" "}
                    {rotation.delivered
                      ? "The worker will reconnect automatically."
                      : "Set CANTRIP_WORKER_CREDENTIAL before restarting it."}
                  </p>
                  <div className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-background/65 p-2 text-xs">
                      {rotation.credential}
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        rememberCopy("rotation", rotation.credential)
                      }
                    >
                      <Copy className="size-3.5" />
                      {copied === "rotation" ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              ) : null}
              {[rename.error, rotate.error, revoke.error]
                .filter(Boolean)
                .map((error, index) => (
                  <p key={index} className="text-sm text-destructive">
                    {errorMessage(error)}
                  </p>
                ))}
              {copyError ? (
                <p className="text-sm text-destructive">
                  Could not copy to the clipboard: {copyError}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Done</Button>
                </DialogClose>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(unlinkTarget)}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Unlink {unlinkTarget?.name}?</DialogTitle>
            <DialogDescription>
              Its credentials will be revoked and the connection will close.
              Server-owned projects and conversations remain, while its local
              sources become unavailable until the same worker is paired again.
            </DialogDescription>
          </DialogHeader>
          {unlinkTarget?.sources.length ? (
            <div className="rounded-lg bg-muted/35 p-3 text-sm">
              <p className="font-medium">
                {unlinkTarget.sources.length} associated project source
                {unlinkTarget.sources.length === 1 ? "" : "s"}
              </p>
              <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                {unlinkTarget.sources.map((source) => (
                  <li key={source.projectId} className="truncate">
                    {source.nameWithOwner} · {source.displayPath}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unlink.isError ? (
            <p className="text-sm text-destructive">
              {errorMessage(unlink.error)}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={unlink.isPending}
              onClick={() => unlink.mutate()}
            >
              <Unplug className="size-4" /> Unlink worker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
