import type {
  ProjectSummary,
  SettingsBundle,
  SkillSettingsItem,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileCode2,
  FileText,
  FolderCog,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteSettingsSkill,
  getSettings,
  getSettingsSkills,
  getWorkers,
  readSettingsSkill,
  updateSettingsSkillFile,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorMessage as errorText } from "@/lib/error-message";
import { SettingsSearchField } from "./settings-controls";

export function preferredSkillProviderId(
  settings: SettingsBundle | undefined,
): string | null {
  if (!settings?.providers.length) return null;
  const defaultModel = settings.models.find(
    ({ id }) => id === settings.preferences.defaultModelId,
  );
  return (
    defaultModel?.routes.find(({ enabled }) => enabled)?.providerId ??
    settings.models
      .flatMap(({ routes }) => routes)
      .find(({ enabled }) => enabled)?.providerId ??
    settings.providers[0]!.id
  );
}

function preferredWorkerId(workers: WorkerSummary[]): string | null {
  return (
    workers.find(({ online }) => online)?.workerId ??
    workers[0]?.workerId ??
    null
  );
}

function locationLabel(item: SkillSettingsItem): string {
  switch (item.location) {
    case "project":
      return "Project";
    case "account":
      return "Cantrip account";
    case "user":
      return "Worker user";
    case "system":
      return "Bundled";
    case "admin":
      return "Administrator";
  }
}

function locationIcon(item: SkillSettingsItem) {
  if (item.location === "project") return FolderCog;
  if (item.location === "system" || item.location === "admin") {
    return ShieldCheck;
  }
  return UserRound;
}

export function skillMatchesSearch(
  item: SkillSettingsItem,
  query: string,
): boolean {
  if (!query) return true;
  return [
    item.name,
    item.displayName,
    item.description,
    item.path,
    locationLabel(item),
  ].some((value) => value?.toLowerCase().includes(query));
}

function SkillRows({
  emptyText,
  items,
  onOpen,
}: {
  emptyText: string;
  items: SkillSettingsItem[];
  onOpen(item: SkillSettingsItem): void;
}) {
  return (
    <div className="border-y">
      <div className="hidden grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1.4fr)_minmax(9rem,0.55fr)_4rem] gap-4 border-b px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
        <span>Skill</span>
        <span>Description</span>
        <span>Scope</span>
        <span className="sr-only">Open</span>
      </div>
      <div className="divide-y">
        {items.map((item) => {
          const Icon = locationIcon(item);
          return (
            <button
              key={`${item.location}:${item.id}`}
              type="button"
              data-high-contrast-row
              className="grid w-full gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 md:grid-cols-[minmax(12rem,0.8fr)_minmax(16rem,1.4fr)_minmax(9rem,0.55fr)_4rem] md:items-center md:gap-4"
              onClick={() => onOpen(item)}
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {item.displayName ?? item.name}
                  </span>
                </span>
                {item.displayName ? (
                  <span className="mt-1 block truncate pl-6 font-mono text-[10px] text-muted-foreground">
                    ${item.name}
                  </span>
                ) : null}
              </span>
              <span className="line-clamp-1 text-xs text-muted-foreground">
                {item.description}
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{locationLabel(item)}</Badge>
                {!item.editable ? (
                  <Badge variant="outline">Read only</Badge>
                ) : null}
              </span>
              <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                {item.editable ? (
                  <Pencil className="size-3.5" />
                ) : (
                  <FileText className="size-3.5" />
                )}
                View
              </span>
            </button>
          );
        })}
        {!items.length ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {emptyText}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SkillsSettings({ project }: { project?: ProjectSummary }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryFn: getSettings, queryKey: ["settings"] });
  const workers = useQuery({ queryFn: getWorkers, queryKey: ["workers"] });
  const fixedWorkerId = project?.source?.workerId ?? null;
  const [workerId, setWorkerId] = useState<string | null>(fixedWorkerId);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<SkillSettingsItem | null>(
    null,
  );
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const available = workers.data ?? [];
    if (fixedWorkerId) {
      setWorkerId(fixedWorkerId);
      return;
    }
    if (
      !workerId ||
      !available.some((worker) => worker.workerId === workerId)
    ) {
      setWorkerId(preferredWorkerId(available));
    }
  }, [fixedWorkerId, workerId, workers.data]);

  useEffect(() => {
    const providers = settings.data?.providers ?? [];
    if (!providerId || !providers.some(({ id }) => id === providerId)) {
      setProviderId(preferredSkillProviderId(settings.data));
    }
  }, [providerId, settings.data]);

  const context = useMemo(
    () =>
      workerId && providerId
        ? {
            workerId,
            providerId,
            projectId: project?.id ?? null,
          }
        : null,
    [project?.id, providerId, workerId],
  );
  const inventory = useQuery({
    enabled: Boolean(context),
    queryFn: () => getSettingsSkills(context!),
    queryKey: [
      "settings-skills",
      project?.id ?? "global",
      workerId,
      providerId,
    ],
    retry: false,
  });
  const document = useQuery({
    enabled: Boolean(context && selectedSkill),
    queryFn: () =>
      readSettingsSkill({
        ...context!,
        skillId: selectedSkill!.id,
        file: selectedFile,
      }),
    queryKey: [
      "settings-skill-document",
      project?.id ?? "global",
      workerId,
      providerId,
      selectedSkill?.id,
      selectedFile,
    ],
    retry: false,
  });

  useEffect(() => {
    if (document.data) setDraft(document.data.content);
  }, [document.data]);

  const refreshInventory = async () => {
    await queryClient.invalidateQueries({ queryKey: ["settings-skills"] });
  };
  const save = useMutation({
    mutationFn: () =>
      updateSettingsSkillFile({
        ...context!,
        skillId: selectedSkill!.id,
        file: selectedFile,
        content: draft,
      }),
    onSuccess: async () => {
      await Promise.all([
        refreshInventory(),
        queryClient.invalidateQueries({
          queryKey: ["settings-skill-document"],
        }),
      ]);
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      deleteSettingsSkill({
        ...context!,
        skillId: selectedSkill!.id,
      }),
    onSuccess: async () => {
      setConfirmDelete(false);
      setSelectedSkill(null);
      await refreshInventory();
    },
  });

  const openSkill = (skill: SkillSettingsItem) => {
    save.reset();
    remove.reset();
    setSelectedFile("SKILL.md");
    setDraft("");
    setSelectedSkill(skill);
  };
  const currentWorker = (workers.data ?? []).find(
    (worker) => worker.workerId === workerId,
  );
  const currentProvider = settings.data?.providers.find(
    (provider) => provider.id === providerId,
  );
  const canSave = Boolean(
    selectedSkill?.editable &&
    document.data &&
    draft !== document.data.content &&
    !save.isPending,
  );
  const search = searchQuery.trim().toLowerCase();
  const visibleProjectSkills = (inventory.data?.project ?? []).filter((item) =>
    skillMatchesSearch(item, search),
  );
  const visibleGlobalSkills = (inventory.data?.global ?? []).filter((item) =>
    skillMatchesSearch(item, search),
  );

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {project ? "Project skills" : "Global skills"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Browse skill instructions and supporting files. Editable skills can
            be updated here; deleted skills are moved into Cantrip recovery
            storage.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={!context || inventory.isFetching}
          onClick={() => void inventory.refetch()}
        >
          <RefreshCw
            className={cn("size-4", inventory.isFetching && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      <SettingsSearchField
        ariaLabel="Search skills"
        placeholder="Search skills"
        value={searchQuery}
        onValueChange={setSearchQuery}
      />

      <div className="grid gap-3 border-y px-3 py-3 sm:grid-cols-2">
        {!project ? (
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Worker</span>
            <NativeSelect
              value={workerId ?? ""}
              onChange={(event) => {
                setSelectedSkill(null);
                setWorkerId(event.target.value || null);
              }}
            >
              {(workers.data ?? []).map((worker) => (
                <option key={worker.workerId} value={worker.workerId}>
                  {worker.name}
                  {worker.online ? "" : " (offline)"}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : (
          <div className="grid gap-1.5 text-sm">
            <span className="font-medium">Worker</span>
            <div className="flex h-9 items-center rounded-md border bg-background px-3">
              {currentWorker?.name ?? project.source?.workerId ?? "Unavailable"}
            </div>
          </div>
        )}
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Codex account / provider</span>
          <NativeSelect
            value={providerId ?? ""}
            onChange={(event) => {
              setSelectedSkill(null);
              setProviderId(event.target.value || null);
            }}
          >
            {(settings.data?.providers ?? []).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      {!workers.isLoading && !workerId ? (
        <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          Add or connect a worker before browsing skills.
        </p>
      ) : null}
      {!settings.isLoading && !providerId ? (
        <p className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
          Configure a model provider before browsing its Cantrip account skills.
        </p>
      ) : null}
      {currentWorker && !currentWorker.online ? (
        <p className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {currentWorker.name} is offline. Skill files become available when it
          reconnects.
        </p>
      ) : null}
      {inventory.isError ? (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorText(inventory.error)}
        </p>
      ) : null}
      {inventory.data?.errors.length ? (
        <div className="rounded-lg bg-amber-500/10 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
          {inventory.data.errors.map((error) => (
            <p key={`${error.path}:${error.message}`}>
              {error.path}: {error.message}
            </p>
          ))}
        </div>
      ) : null}

      {project ? (
        <section
          aria-labelledby="project-skill-list-title"
          className="space-y-2"
        >
          <div className="px-3">
            <h3 id="project-skill-list-title" className="text-sm font-semibold">
              Project Skills
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Loaded from this repository’s .agents/skills directory.
            </p>
          </div>
          <SkillRows
            items={visibleProjectSkills}
            emptyText={
              search
                ? `No project skills match “${searchQuery.trim()}”.`
                : "No project-specific skills were found."
            }
            onOpen={openSkill}
          />
        </section>
      ) : null}

      <section
        aria-labelledby="global-skill-list-title"
        className={cn("space-y-2", project && "border-t pt-4")}
      >
        <div className="px-3">
          <h3 id="global-skill-list-title" className="text-sm font-semibold">
            Global Skills
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Available from {currentProvider?.name ?? "the selected provider"},
            the worker user profile, bundled Codex skills, and administrator
            policy.
          </p>
        </div>
        <SkillRows
          items={visibleGlobalSkills}
          emptyText={
            search
              ? `No global skills match “${searchQuery.trim()}”.`
              : "No global skills were found for this worker and provider."
          }
          onOpen={openSkill}
        />
      </section>

      <p className="pb-2 text-xs text-muted-foreground">
        To install another personal skill, invoke $skill-installer in an agent
        using the same worker and provider.
      </p>

      <Dialog
        open={Boolean(selectedSkill)}
        onOpenChange={(open) => {
          if (!open) setSelectedSkill(null);
        }}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {selectedSkill?.displayName ?? selectedSkill?.name ?? "Skill"}
            </DialogTitle>
            <DialogDescription className="break-all">
              {selectedSkill?.path}
            </DialogDescription>
          </DialogHeader>
          {document.isLoading ? (
            <div className="flex min-h-80 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading skill…
            </div>
          ) : document.isError ? (
            <p className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
              {errorText(document.error)}
            </p>
          ) : document.data ? (
            <div className="grid min-h-0 gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
              <div className="max-h-[52vh] overflow-y-auto rounded-lg border p-1">
                {document.data.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted",
                      selectedFile === file.path && "bg-muted font-medium",
                    )}
                    onClick={() => {
                      save.reset();
                      setSelectedFile(file.path);
                    }}
                  >
                    <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {file.sizeBytes.toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
              <div className="grid min-h-0 gap-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-mono">{selectedFile}</span>
                  <Badge
                    variant={selectedSkill?.editable ? "secondary" : "outline"}
                  >
                    {selectedSkill?.editable ? "Editable" : "Read only"}
                  </Badge>
                </div>
                <textarea
                  aria-label={`Contents of ${selectedFile}`}
                  className="min-h-80 resize-y rounded-lg border bg-background p-3 font-mono text-xs leading-5 outline-none ring-ring focus:ring-2 disabled:opacity-80 md:h-[52vh]"
                  value={draft}
                  readOnly={!selectedSkill?.editable}
                  onChange={(event) => setDraft(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          {save.isError || remove.isError ? (
            <p className="text-sm text-destructive">
              {errorText(save.error ?? remove.error)}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            {selectedSkill?.deletable ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive sm:mr-auto"
                disabled={remove.isPending}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="size-4" /> Delete skill
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground sm:mr-auto">
                Bundled and administrator skills are managed outside Cantrip.
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setSelectedSkill(null)}
            >
              Close
            </Button>
            {selectedSkill?.editable ? (
              <Button
                type="button"
                disabled={!canSave}
                onClick={() => save.mutate()}
              >
                {save.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save file
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {selectedSkill?.displayName ?? selectedSkill?.name}?
            </DialogTitle>
            <DialogDescription>
              The skill folder will be removed from Codex discovery and moved
              into the selected worker’s Cantrip recovery storage.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              Delete skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
