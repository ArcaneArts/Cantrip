import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ProjectSummary,
  ProjectWorktreeSummary,
  WorkerSummary,
  CantripOsSourceBindingSummary,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  getCantripOsInstances,
  getCantripOsWorkspaces,
  getCantripOsBindings,
  refreshCantripOs,
  createCantripOsWorkspace,
  recoverCantripOsBinding,
  verifyCantripOsBinding,
} from "@/lib/api/cantrip-os";
import { ensureChatWorkerEncryption } from "@/lib/chat-worker-encryption";
import { prepareConversationCreation } from "@/lib/api/conversations";
import { errorMessage } from "@/lib/error-message";
import { createRemoteDesktop } from "@/lib/api/surfaces";
import { CantripOsAttachForm } from "./cantrip-os-attach-form";
import { CantripOsSourceForm } from "./cantrip-os-source-form";
import { CantripOsWorktreeForm } from "./cantrip-os-worktree-form";

export function CantripOsSettings({
  project,
  workers,
  worktrees,
  onOpenAgent,
  onOpenDesktop,
}: {
  project: ProjectSummary;
  workers: WorkerSummary[];
  worktrees: ProjectWorktreeSummary[];
  onOpenAgent(id: string): void;
  onOpenDesktop?(id: string): void;
}) {
  const queryClient = useQueryClient();
  const [instanceId, setInstanceId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [profile, setProfile] = useState("work");
  const [adding, setAdding] = useState(false);
  const [worktreeSource, setWorktreeSource] = useState<string | null>(null);
  const instances = useQuery({
    queryKey: ["cantrip-os"],
    queryFn: getCantripOsInstances,
  });
  const selected = instances.data?.find(
    (item) => item.id === (instanceId || instances.data?.[0]?.id),
  );
  const workspaces = useQuery({
    queryKey: ["cantrip-os-workspaces", selected?.id],
    queryFn: () => getCantripOsWorkspaces(selected!.id),
    enabled: Boolean(selected),
  });
  const workspace = workspaces.data?.find(
    (item) => item.id === (workspaceId || workspaces.data?.[0]?.id),
  );
  const bindings = useQuery({
    queryKey: ["cantrip-os-bindings", project.id],
    queryFn: () => getCantripOsBindings(project.id),
  });
  const refreshLists = () => {
    void queryClient.invalidateQueries({ queryKey: ["cantrip-os"] });
    void queryClient.invalidateQueries({ queryKey: ["cantrip-os-workspaces"] });
    void queryClient.invalidateQueries({
      queryKey: ["cantrip-os-bindings", project.id],
    });
  };
  const refresh = useMutation({
    mutationFn: () => refreshCantripOs(selected!.id),
    onSuccess: refreshLists,
  });
  const workspaceOperations = useRef(new Map<string, string>());
  const createWorkspace = useMutation({
    mutationFn: async () => {
      const key = `${selected!.id}/${profile}`;
      let operationId = workspaceOperations.current.get(key);
      if (!operationId) {
        operationId = crypto.randomUUID();
        workspaceOperations.current.set(key, operationId);
      }
      const result = await createCantripOsWorkspace(selected!.id, {
        guestWorkspaceId: profile,
        operationId,
      });
      if (result.state !== "ready")
        throw new Error(
          result.error ??
            `Workspace creation is ${result.state}. Submit again to observe this same operation.`,
        );
      return result;
    },
    onSuccess: refreshLists,
  });
  const observe = useMutation({
    mutationFn: (binding: CantripOsSourceBindingSummary) =>
      recoverCantripOsBinding(project.id, binding.id),
    onSettled: refreshLists,
  });
  const verify = useMutation({
    mutationFn: async (binding: CantripOsSourceBindingSummary) => {
      await refreshCantripOs(binding.instanceId);
      return verifyCantripOsBinding(project.id, binding.id);
    },
    onSettled: refreshLists,
  });
  const creations = useRef(
    new Map<string, Awaited<ReturnType<typeof prepareConversationCreation>>>(),
  );
  const open = useMutation({
    mutationFn: async (binding: CantripOsSourceBindingSummary) => {
      await refreshCantripOs(binding.instanceId);
      await verifyCantripOsBinding(project.id, binding.id);
      const workerId = instances.data?.find(
        (instance) => instance.id === binding.instanceId,
      )?.workerId;
      await ensureChatWorkerEncryption({
        worker: workers.find((worker) => worker.workerId === workerId),
      });
      let create = creations.current.get(binding.id);
      if (!create) {
        create = await prepareConversationCreation(
          project.id,
          `CantripOS · ${workspaces.data?.find((w) => w.id === binding.workspaceId)?.guestWorkspaceId ?? "Linux"}`,
          false,
          { cantripOsBindingId: binding.id, worktreeMode: "pinned" },
        );
        creations.current.set(binding.id, create);
      }
      const chat = await create();
      creations.current.delete(binding.id);
      return chat;
    },
    onSuccess: (chat) => {
      void queryClient.invalidateQueries({ queryKey: ["chats", project.id] });
      onOpenAgent(chat.id);
    },
  });
  const desktop = useMutation({
    mutationFn: async (binding: CantripOsSourceBindingSummary) => {
      const refreshed = await refreshCantripOs(binding.instanceId);
      await verifyCantripOsBinding(project.id, binding.id);
      if (!refreshed.instance.runtimeGeneration)
        throw new Error("The selected OS has no current runtime.");
      return createRemoteDesktop(
        project.id,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          bindingId: binding.id,
          runtimeGeneration: refreshed.instance.runtimeGeneration,
        },
      );
    },
    onSuccess: (view) => {
      queryClient.setQueryData(["remote-desktop", view.id], view);
      void queryClient.invalidateQueries({
        queryKey: ["project-views", project.id],
      });
      onOpenDesktop?.(view.id);
    },
  });
  const error =
    instances.error ??
    workspaces.error ??
    bindings.error ??
    refresh.error ??
    createWorkspace.error ??
    observe.error ??
    verify.error ??
    open.error ??
    desktop.error;
  return (
    <div
      className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8"
      data-content-gutter="standard"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">CantripOS</h2>
          <p className="text-sm text-muted-foreground">
            Linux workspaces connected through your existing worker.
          </p>
        </div>
        <Button variant="ghost" onClick={() => setAdding(!adding)}>
          Attach OS
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : null}
      {adding || (instances.isSuccess && !instances.data.length) ? (
        <CantripOsAttachForm
          workers={workers}
          onAttached={(id) => {
            setInstanceId(id);
            setWorkspaceId("");
            setAdding(false);
            refreshLists();
          }}
        />
      ) : null}
      {selected ? (
        <>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1 text-sm">
              OS instance
              <NativeSelect
                className="w-full"
                value={selected.id}
                onChange={(e) => {
                  setInstanceId(e.target.value);
                  setWorkspaceId("");
                }}
              >
                {instances.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.status}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <Button
              variant="ghost"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              Refresh OS
            </Button>
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="font-medium">Workspace</h3>
            <label className="block space-y-1 text-sm">
              Linux workspace
              <NativeSelect
                className="w-full"
                value={workspace?.id ?? ""}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                <option value="">Choose a workspace</option>
                {workspaces.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.guestWorkspaceId} · UID {item.uid}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                createWorkspace.mutate();
              }}
            >
              <label className="min-w-0 flex-1 space-y-1 text-sm">
                New workspace ID
                <Input
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  maxLength={24}
                  required
                />
              </label>
              <Button type="submit" disabled={createWorkspace.isPending}>
                Create workspace
              </Button>
            </form>
          </div>
          {workspace ? (
            <CantripOsSourceForm
              key={workspace.id}
              project={project}
              workspace={workspace}
              worktrees={worktrees}
              onProvisioned={refreshLists}
            />
          ) : null}
        </>
      ) : null}
      <section className="space-y-3">
        <h3 className="font-medium">Project sources</h3>
        {!bindings.data?.length ? (
          <p className="text-sm text-muted-foreground">
            Add a Linux-owned source or link an exact worktree above.
          </p>
        ) : null}
        {bindings.data?.map((binding) => (
          <article key={binding.id} className="space-y-2 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                {binding.mode === "linked"
                  ? "Linked worktree"
                  : "Linux-owned source"}
              </span>
              <span className="text-xs text-muted-foreground">
                {binding.state}
              </span>
            </div>
            <p className="break-all text-xs text-muted-foreground">
              {instances.data?.find((item) => item.id === binding.instanceId)
                ?.name ?? binding.instanceId}
              {" · Workspace: "}
              {workspaces.data?.find((item) => item.id === binding.workspaceId)
                ?.guestWorkspaceId ?? binding.workspaceId}
            </p>
            <code className="block break-all text-xs">{binding.guestPath}</code>
            {binding.dependencyOverlays.length ? (
              <p className="text-xs text-muted-foreground">
                Linux-only directories:{" "}
                {binding.dependencyOverlays.map((item) => item.path).join(", ")}
              </p>
            ) : null}
            {binding.lastError ? (
              <p className="text-sm text-muted-foreground">
                {binding.lastError}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                onClick={() => observe.mutate(binding)}
                disabled={observe.isPending}
              >
                Observe outcome
              </Button>
              <Button
                variant="ghost"
                onClick={() => verify.mutate(binding)}
                disabled={verify.isPending}
              >
                Verify files
              </Button>
              <Button
                onClick={() => open.mutate(binding)}
                disabled={open.isPending}
              >
                New Linux agent
              </Button>
              {onOpenDesktop ? (
                <Button
                  variant="ghost"
                  disabled={desktop.isPending}
                  onClick={() => desktop.mutate(binding)}
                >
                  Open desktop
                </Button>
              ) : null}
              {project.capabilities.git && binding.mode === "linux-owned" ? (
                <Button
                  variant="ghost"
                  onClick={() => setWorktreeSource(binding.id)}
                >
                  New Linux worktree
                </Button>
              ) : null}
            </div>
            {worktreeSource === binding.id ? (
              <CantripOsWorktreeForm
                key={binding.id}
                source={binding}
                onChanged={refreshLists}
                onCancel={() => setWorktreeSource(null)}
                onCreated={() => {
                  setWorktreeSource(null);
                  refreshLists();
                }}
              />
            ) : null}
          </article>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">
        Open desktop to view this workspace inside Cantrip, or use the
        independent workspace selector URL printed by pnpm os. Shell work does
        not require an open desktop. New Linux agents stay bound to their
        selected source.
      </p>
    </div>
  );
}
