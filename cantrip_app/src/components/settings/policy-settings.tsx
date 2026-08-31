import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  POLICY_BODY_LIMIT,
  POLICY_LIMIT,
  POLICY_SUMMARY_LIMIT,
  type PolicyCreate,
  type PolicyDetail,
  type PolicyList,
  type PolicySummary,
} from "@cantrip/protocol/policies";
import type { ResourceAudience } from "@cantrip/protocol/audiences";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Download,
  Eye,
  FilePlus2,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";

import { Markdown } from "@/components/chat/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { NativeSelect } from "@/components/ui/native-select";
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
  createPolicy,
  createPolicyFromTemplate,
  deletePolicy,
  getPolicies,
  getPolicy,
  getPolicyTemplate,
  getPolicyTemplates,
  reorderPolicies,
  resetPolicyFromTemplate,
  updatePolicy,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import {
  createPolicyBundle,
  parsePolicyImport,
  preparePolicyImports,
  serializePolicyFile,
} from "@/lib/policy-transfer";
import { filterPolicyTemplates } from "@/lib/policy-templates";
import { cn } from "@/lib/utils";
import { SettingsSearchField } from "./settings-controls";

type PolicyDraft = Pick<
  PolicyCreate,
  | "audience"
  | "bodyMarkdown"
  | "enabled"
  | "key"
  | "mandatory"
  | "name"
  | "summary"
>;

const emptyDraft: PolicyDraft = {
  key: "policy",
  name: "",
  summary: "",
  bodyMarkdown: "",
  enabled: true,
  mandatory: false,
  audience: "ide",
};

export function nextAvailablePolicyKey(
  requestedKey: string,
  policies: Pick<PolicySummary, "key">[],
): string {
  const normalized =
    requestedKey
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "policy";
  const used = new Set(policies.map(({ key }) => key));
  if (!used.has(normalized)) return normalized;
  let suffix = 2;
  while (used.has(`${normalized}-${suffix}`)) suffix += 1;
  return `${normalized}-${suffix}`;
}

export function reorderedPolicies(
  policies: PolicySummary[],
  activeId: string,
  overId: string,
): PolicySummary[] {
  const from = policies.findIndex(({ id }) => id === activeId);
  const to = policies.findIndex(({ id }) => id === overId);
  if (from < 0 || to < 0 || from === to) return policies;
  return arrayMove(policies, from, to).map((policy, position) => ({
    ...policy,
    position,
  }));
}

export function policyDeletionMessage(
  policy: Pick<
    PolicySummary,
    "name" | "projectAssignmentCount" | "workspaceAssignmentCount"
  >,
): string {
  const assignments =
    policy.projectAssignmentCount + policy.workspaceAssignmentCount;
  if (!assignments) {
    return `Delete ${policy.name}? The packaged template, if any, remains available.`;
  }
  return `Delete ${policy.name} and remove ${assignments} explicit workspace/project assignment${assignments === 1 ? "" : "s"}?`;
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60";

function SortablePolicyRow({
  disabled,
  exportPending,
  onDelete,
  onEdit,
  onExport,
  policy,
}: {
  disabled: boolean;
  exportPending: boolean;
  onDelete(): void;
  onEdit(): void;
  onExport(): void;
  policy: PolicySummary;
}) {
  const sortable = useSortable({ id: policy.id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const assignments =
    policy.workspaceAssignmentCount + policy.projectAssignmentCount;
  return (
    <div
      ref={sortable.setNodeRef}
      data-high-contrast-row
      role="button"
      tabIndex={0}
      aria-label={`Edit ${policy.name}`}
      className={cn(
        "grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 py-2 outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]",
        sortable.isDragging && "z-10 bg-background opacity-50 shadow-lg",
      )}
      style={style}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onEdit();
      }}
    >
      <button
        type="button"
        className="grid size-7 touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        disabled={disabled}
        aria-label={`Drag ${policy.name} to reorder`}
        onClick={(event) => event.stopPropagation()}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="truncate text-sm font-medium">{policy.name}</p>
          <code className="hidden truncate text-[10px] text-muted-foreground sm:block">
            {policy.key}
          </code>
        </div>
        <p
          className="truncate text-xs text-muted-foreground"
          title={policy.summary}
        >
          {policy.summary}
        </p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 sm:hidden">
          <Badge variant={policy.enabled ? "secondary" : "outline"}>
            {policy.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Badge variant="outline">
            {policy.audience === "both"
              ? "Both"
              : policy.audience === "chat"
                ? "Chat"
                : "IDE"}
          </Badge>
          {policy.mandatory ? (
            <Badge variant="secondary">
              <ShieldCheck className="size-3" /> Mandatory
            </Badge>
          ) : null}
          <span className="text-[10px] text-muted-foreground">
            {policy.templateKey ? "Template" : "Custom"} · {assignments}{" "}
            assignment{assignments === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <div className="hidden items-center gap-1 sm:flex">
        <Badge variant={policy.enabled ? "secondary" : "outline"}>
          {policy.enabled ? "Enabled" : "Disabled"}
        </Badge>
        <Badge variant="outline">
          {policy.audience === "both"
            ? "Both"
            : policy.audience === "chat"
              ? "Chat"
              : "IDE"}
        </Badge>
        {policy.mandatory ? (
          <Badge variant="secondary">
            <ShieldCheck className="size-3" /> Mandatory
          </Badge>
        ) : null}
      </div>
      <div className="hidden min-w-24 text-right text-[10px] text-muted-foreground sm:block">
        <p>{policy.templateKey ? "Template" : "Custom"}</p>
        <p>{assignments} assignments</p>
      </div>
      <div
        className="flex items-center justify-end"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={exportPending}
          onClick={onExport}
        >
          {exportPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="sr-only">Export {policy.name}</span>
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={onEdit}>
          <Pencil className="size-3.5" />
          <span className="sr-only">Edit {policy.name}</span>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          <span className="sr-only">Delete {policy.name}</span>
        </Button>
      </div>
    </div>
  );
}

function draftFromPolicy(policy: PolicyDetail): PolicyDraft {
  return {
    key: policy.key,
    name: policy.name,
    summary: policy.summary,
    bodyMarkdown: policy.bodyMarkdown,
    enabled: policy.enabled,
    mandatory: policy.mandatory,
    audience: policy.audience,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function isMobilePolicyExportRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    !("__TAURI_INTERNALS__" in window)
  );
}

async function downloadPolicyFile(
  name: string,
  contents: string | Uint8Array,
  type: string,
): Promise<void> {
  if (isMobilePolicyExportRuntime()) {
    const bytes =
      typeof contents === "string"
        ? new TextEncoder().encode(contents)
        : contents;
    const path = `cantrip-policy-exports/${name}`;
    await Filesystem.writeFile({
      data: bytesToBase64(bytes),
      directory: Directory.Cache,
      path,
      recursive: true,
    });
    const { uri } = await Filesystem.getUri({
      directory: Directory.Cache,
      path,
    });
    await Share.share({
      dialogTitle: "Export Cantrip policies",
      files: [uri],
      title: "Cantrip policies",
    });
    return;
  }
  const blobPart =
    typeof contents === "string" ? contents : new Uint8Array(contents);
  const url = URL.createObjectURL(new Blob([blobPart], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function loadPolicyDetails(
  policies: readonly PolicySummary[],
): Promise<PolicyDetail[]> {
  const details: PolicyDetail[] = [];
  const concurrency = 8;
  for (let offset = 0; offset < policies.length; offset += concurrency) {
    details.push(
      ...(await Promise.all(
        policies
          .slice(offset, offset + concurrency)
          .map(({ id }) => getPolicy(id)),
      )),
    );
  }
  return details;
}

export function PolicySettings({
  initialPolicyId = null,
  onInitialPolicyHandled,
}: {
  initialPolicyId?: string | null;
  onInitialPolicyHandled?(): void;
}) {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [templateSearchQuery, setTemplateSearchQuery] = useState("");
  const [chooserOpen, setChooserOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [creatingTemplateKey, setCreatingTemplateKey] = useState<string | null>(
    null,
  );
  const [hydratedPolicyId, setHydratedPolicyId] = useState<string | null>(null);
  const [handledInitialPolicyId, setHandledInitialPolicyId] = useState<
    string | null
  >(null);
  const [draft, setDraft] = useState<PolicyDraft>(emptyDraft);
  const [bodyMode, setBodyMode] = useState<"edit" | "preview">("edit");
  const [deleteTarget, setDeleteTarget] = useState<PolicySummary | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [importAudience, setImportAudience] = useState<ResourceAudience>("ide");
  const importInputRef = useRef<HTMLInputElement>(null);
  const policies = useQuery({ queryFn: getPolicies, queryKey: ["policies"] });
  const templates = useQuery({
    queryFn: getPolicyTemplates,
    queryKey: ["policy-templates"],
  });
  const detail = useQuery({
    enabled: Boolean(editingPolicyId && editorOpen),
    queryFn: () => getPolicy(editingPolicyId!),
    queryKey: ["policy", editingPolicyId],
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    if (
      !editorOpen ||
      !detail.data ||
      detail.data.id !== editingPolicyId ||
      hydratedPolicyId === editingPolicyId
    ) {
      return;
    }
    setDraft(draftFromPolicy(detail.data));
    setHydratedPolicyId(detail.data.id);
  }, [detail.data, editingPolicyId, editorOpen, hydratedPolicyId]);
  const activeDetail =
    editingPolicyId && detail.data?.id === editingPolicyId ? detail.data : null;

  useEffect(() => {
    if (!initialPolicyId || handledInitialPolicyId === initialPolicyId) return;
    setEditingPolicyId(initialPolicyId);
    setCreatingTemplateKey(null);
    setHydratedPolicyId(null);
    setDraft(emptyDraft);
    setBodyMode("edit");
    setEditorOpen(true);
    setHandledInitialPolicyId(initialPolicyId);
    onInitialPolicyHandled?.();
  }, [handledInitialPolicyId, initialPolicyId, onInitialPolicyHandled]);

  const invalidatePolicies = async () => {
    await queryClient.invalidateQueries({ queryKey: ["policies"] });
  };
  const save = useMutation({
    mutationFn: () =>
      editingPolicyId
        ? updatePolicy(editingPolicyId, {
            rowVersion: activeDetail!.rowVersion,
            name: draft.name,
            summary: draft.summary,
            bodyMarkdown: draft.bodyMarkdown,
            enabled: draft.enabled,
            mandatory: draft.mandatory,
            audience: draft.audience,
          })
        : creatingTemplateKey
          ? createPolicyFromTemplate(creatingTemplateKey, draft)
          : createPolicy(draft),
    onSuccess: async (policy) => {
      queryClient.setQueryData(["policy", policy.id], policy);
      setEditorOpen(false);
      await invalidatePolicies();
    },
  });
  const remove = useMutation({
    mutationFn: (policy: PolicySummary) =>
      deletePolicy(policy.id, policy.rowVersion),
    onSuccess: async () => {
      setDeleteTarget(null);
      setEditorOpen(false);
      await invalidatePolicies();
    },
  });
  const reorder = useMutation({
    mutationFn: (ordered: PolicySummary[]) =>
      reorderPolicies({
        collectionVersion: policies.data!.collectionVersion,
        policyIds: ordered.map(({ id }) => id),
      }),
    onMutate: (ordered) => {
      queryClient.setQueryData<PolicyList>(["policies"], (current) =>
        current ? { ...current, policies: ordered } : current,
      );
    },
    onSuccess: (result) => queryClient.setQueryData(["policies"], result),
    onError: invalidatePolicies,
  });
  const loadTemplate = useMutation({
    mutationFn: getPolicyTemplate,
    onSuccess: (template) => {
      const currentPolicies = policies.data?.policies ?? [];
      setDraft({
        key: nextAvailablePolicyKey(
          template.suggestedPolicyKey,
          currentPolicies,
        ),
        name: template.name,
        summary: template.summary,
        bodyMarkdown: template.bodyMarkdown,
        enabled: template.suggestedEnabled,
        mandatory: template.suggestedMandatory,
        audience: "ide",
      });
      setEditingPolicyId(null);
      setCreatingTemplateKey(template.templateKey);
      setHydratedPolicyId(null);
      setBodyMode("edit");
      setChooserOpen(false);
      setEditorOpen(true);
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      resetPolicyFromTemplate(editingPolicyId!, {
        rowVersion: activeDetail!.rowVersion,
        restoreDefaults: false,
      }),
    onSuccess: async (policy) => {
      queryClient.setQueryData(["policy", policy.id], policy);
      setDraft(draftFromPolicy(policy));
      setHydratedPolicyId(policy.id);
      setResetConfirmOpen(false);
      await invalidatePolicies();
    },
  });

  const currentPolicies = policies.data?.policies ?? [];
  const exportOne = useMutation({
    mutationFn: async (policy: PolicySummary) => {
      const policyDetail = await getPolicy(policy.id);
      queryClient.setQueryData(["policy", policy.id], policyDetail);
      await downloadPolicyFile(
        `${policyDetail.key}.json`,
        serializePolicyFile(policyDetail),
        "application/json",
      );
      return policyDetail.name;
    },
    onMutate: () => setTransferMessage(null),
    onSuccess: (name) => setTransferMessage(`Exported ${name}.`),
  });
  const exportAll = useMutation({
    mutationFn: async () => {
      const details = await loadPolicyDetails(currentPolicies);
      for (const policy of details) {
        queryClient.setQueryData(["policy", policy.id], policy);
      }
      const archive = await createPolicyBundle(details);
      await downloadPolicyFile(
        `cantrip-policies-${new Date().toISOString().slice(0, 10)}.zip`,
        new Uint8Array(archive),
        "application/zip",
      );
      return details.length;
    },
    onMutate: () => setTransferMessage(null),
    onSuccess: (count) =>
      setTransferMessage(
        `Exported ${count} polic${count === 1 ? "y" : "ies"}.`,
      ),
  });
  const importFiles = useMutation({
    mutationFn: async (files: File[]) => {
      const decoded: PolicyCreate[] = [];
      for (const file of files) {
        decoded.push(
          ...(await parsePolicyImport(
            file.name,
            new Uint8Array(await file.arrayBuffer()),
          )),
        );
        if (decoded.length > POLICY_LIMIT) {
          throw new Error(
            `A single import cannot contain more than ${POLICY_LIMIT} policies.`,
          );
        }
      }
      const prepared = preparePolicyImports(
        decoded.map((policy) => ({ ...policy, audience: importAudience })),
        currentPolicies,
      );
      let importedCount = 0;
      try {
        for (const policy of prepared.policies) {
          await createPolicy(policy);
          importedCount += 1;
        }
      } catch (error) {
        throw new Error(
          `Imported ${importedCount} of ${prepared.policies.length} policies before the server stopped the import: ${errorMessage(error)}`,
        );
      }
      return { importedCount, renamedCount: prepared.renamedCount };
    },
    onMutate: () => setTransferMessage(null),
    onSuccess: async ({ importedCount, renamedCount }) => {
      setTransferMessage(
        `Imported ${importedCount} polic${importedCount === 1 ? "y" : "ies"}.${
          renamedCount
            ? ` Renamed ${renamedCount} duplicate key${renamedCount === 1 ? "" : "s"}.`
            : ""
        }`,
      );
      await invalidatePolicies();
    },
    onError: invalidatePolicies,
  });
  const query = searchQuery.trim().toLowerCase();
  const templateQuery = templateSearchQuery.trim().toLowerCase();
  const visibleTemplates = filterPolicyTemplates(
    templates.data ?? [],
    templateQuery,
  );
  const visiblePolicies = query
    ? currentPolicies.filter((policy) =>
        [
          policy.name,
          policy.key,
          policy.summary,
          policy.templateKey ?? "custom",
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
      )
    : currentPolicies;
  const editingSummary = currentPolicies.find(
    ({ id }) => id === editingPolicyId,
  );
  const editorReady = !editingPolicyId || Boolean(activeDetail);
  const error =
    policies.error ??
    templates.error ??
    detail.error ??
    save.error ??
    reorder.error ??
    loadTemplate.error ??
    reset.error ??
    exportOne.error ??
    exportAll.error ??
    importFiles.error;

  const openBlank = () => {
    setDraft({
      ...emptyDraft,
      key: nextAvailablePolicyKey("policy", currentPolicies),
    });
    setEditingPolicyId(null);
    setCreatingTemplateKey(null);
    setHydratedPolicyId(null);
    setBodyMode("edit");
    setChooserOpen(false);
    setEditorOpen(true);
  };
  const openExisting = (policy: PolicySummary) => {
    save.reset();
    reset.reset();
    setEditingPolicyId(policy.id);
    setCreatingTemplateKey(null);
    setHydratedPolicyId(null);
    setBodyMode("edit");
    setDraft({
      key: policy.key,
      name: policy.name,
      summary: policy.summary,
      bodyMarkdown: "",
      enabled: policy.enabled,
      mandatory: policy.mandatory,
      audience: policy.audience,
    });
    setEditorOpen(true);
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over || query) return;
    const ordered = reorderedPolicies(
      currentPolicies,
      String(event.active.id),
      String(event.over.id),
    );
    if (ordered !== currentPolicies) reorder.mutate(ordered);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editorReady) return;
    save.mutate();
  };

  return (
    <div className="grid w-full min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SettingsSearchField
          ariaLabel="Search policies"
          placeholder="Search policies"
          value={searchQuery}
          onValueChange={setSearchQuery}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {currentPolicies.length} polic
            {currentPolicies.length === 1 ? "y" : "ies"}
          </span>
          <input
            ref={importInputRef}
            type="file"
            className="hidden"
            accept=".json,.zip,application/json,application/zip"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) importFiles.mutate(files);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!policies.data || importFiles.isPending}
            onClick={() => importInputRef.current?.click()}
          >
            {importFiles.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            Import
          </Button>
          <NativeSelect
            aria-label="Imported policy audience"
            className="h-8"
            value={importAudience}
            disabled={importFiles.isPending}
            onChange={(event) =>
              setImportAudience(event.target.value as ResourceAudience)
            }
          >
            <option value="ide">IDE</option>
            <option value="chat">Chat</option>
            <option value="both">Both</option>
          </NativeSelect>
          <Button
            size="sm"
            variant="outline"
            disabled={!currentPolicies.length || exportAll.isPending}
            onClick={() => exportAll.mutate()}
          >
            {exportAll.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            Export all
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setTemplateSearchQuery("");
              setChooserOpen(true);
            }}
          >
            <Plus className="size-3.5" /> Policy
          </Button>
        </div>
      </div>

      <div className="min-w-0 divide-y overflow-hidden border-y">
        {policies.isLoading ? (
          <div
            role="status"
            aria-label="Loading policies"
            className="grid place-items-center py-12 text-muted-foreground"
          >
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : visiblePolicies.length ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={dragEnd}
          >
            <SortableContext
              items={visiblePolicies.map(({ id }) => id)}
              strategy={verticalListSortingStrategy}
            >
              {visiblePolicies.map((policy) => (
                <SortablePolicyRow
                  key={policy.id}
                  policy={policy}
                  disabled={Boolean(query) || reorder.isPending}
                  exportPending={
                    exportOne.isPending && exportOne.variables?.id === policy.id
                  }
                  onEdit={() => openExisting(policy)}
                  onExport={() => exportOne.mutate(policy)}
                  onDelete={() => setDeleteTarget(policy)}
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          <div className="py-12 text-center text-muted-foreground">
            <Search className="mx-auto mb-3 size-5" />
            <p className="text-sm font-medium">
              {query ? "No policies found" : "No policies yet"}
            </p>
            <p className="mt-1 text-xs">
              {query
                ? "Try a policy name, key, or summary."
                : "Create a blank policy or start from a template."}
            </p>
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      ) : null}
      {transferMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {transferMessage}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Enabled mandatory policies apply to every project. Other policy
        assignments are managed from workspace and project settings. JSON and
        ZIP exports contain policy content and settings, but not assignments.
      </p>

      <Dialog
        open={chooserOpen}
        onOpenChange={(open) => {
          setChooserOpen(open);
          if (!open) setTemplateSearchQuery("");
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New policy</DialogTitle>
            <DialogDescription>
              Start blank or copy a packaged template. Nothing is saved until
              you finish the editor.
            </DialogDescription>
          </DialogHeader>
          <SettingsSearchField
            ariaLabel="Search policy templates"
            placeholder="Search policy templates"
            value={templateSearchQuery}
            onValueChange={setTemplateSearchQuery}
          />
          <div className="max-h-[min(28rem,55dvh)] divide-y overflow-y-auto border-y">
            <button
              type="button"
              className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-muted/30"
              onClick={openBlank}
            >
              <FilePlus2 className="mt-0.5 size-4 text-muted-foreground" />
              <span>
                <span className="block text-sm font-medium">Blank policy</span>
                <span className="block text-xs text-muted-foreground">
                  Write a new reusable instruction document.
                </span>
              </span>
            </button>
            {visibleTemplates.map((template) => (
              <button
                key={template.templateKey}
                type="button"
                className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-muted/30"
                disabled={loadTemplate.isPending}
                onClick={() => loadTemplate.mutate(template.templateKey)}
              >
                <BookOpen className="mt-0.5 size-4 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {template.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {template.summary}
                  </span>
                </span>
              </button>
            ))}
            {templates.isLoading ? (
              <div
                role="status"
                aria-label="Loading policy templates"
                className="grid place-items-center px-3 py-4 text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : null}
            {!templates.isLoading &&
            templateQuery &&
            !visibleTemplates.length ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                No policy templates match your search.
              </p>
            ) : null}
          </div>
          {templates.isError || loadTemplate.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(templates.error ?? loadTemplate.error)}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="flex h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl flex-col overflow-hidden sm:h-[min(52rem,calc(100vh-2rem))] sm:w-full">
          <DialogHeader>
            <DialogTitle>
              {editingPolicyId ? "Edit policy" : "New policy"}
            </DialogTitle>
            <DialogDescription>
              Policies are server-owned instructions. Agents receive the summary
              and can read the current full Markdown body when needed.
            </DialogDescription>
          </DialogHeader>
          {detail.isError && editingPolicyId ? (
            <div className="grid min-h-0 flex-1 place-items-center gap-3 text-center">
              <p className="text-sm text-destructive">
                {errorMessage(detail.error)}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => detail.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : !editorReady ? (
            <div
              role="status"
              aria-label="Loading policy"
              className="grid min-h-0 flex-1 place-items-center text-muted-foreground"
            >
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <form
              className="flex min-h-0 flex-1 flex-col gap-4"
              onSubmit={submit}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name">
                  <input
                    required
                    maxLength={120}
                    className={inputClass}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </Field>
                <Field label="Audience">
                  <NativeSelect
                    className="w-full"
                    value={draft.audience}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        audience: event.target.value as ResourceAudience,
                      }))
                    }
                  >
                    <option value="ide">IDE</option>
                    <option value="chat">Chat</option>
                    <option value="both">Both</option>
                  </NativeSelect>
                </Field>
                <Field label="Stable key">
                  <input
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={80}
                    disabled={Boolean(editingPolicyId)}
                    className={cn(inputClass, "font-mono")}
                    value={draft.key}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        key: event.target.value,
                      }))
                    }
                  />
                </Field>
              </div>
              <Field label="Agent-visible summary">
                <textarea
                  required
                  maxLength={POLICY_SUMMARY_LIMIT}
                  className="min-h-20 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2"
                  value={draft.summary}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                />
                <span className="text-right text-[10px] tabular-nums text-muted-foreground">
                  {draft.summary.length}/{POLICY_SUMMARY_LIMIT} characters ·{" "}
                  {new TextEncoder().encode(draft.summary).byteLength} encoded
                  bytes
                </span>
              </Field>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Full Markdown body</span>
                <div className="flex rounded-md bg-muted/50 p-0.5">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    variant={bodyMode === "edit" ? "default" : "ghost"}
                    aria-pressed={bodyMode === "edit"}
                    onClick={() => setBodyMode("edit")}
                  >
                    <Pencil className="size-3" /> Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    variant={bodyMode === "preview" ? "default" : "ghost"}
                    aria-pressed={bodyMode === "preview"}
                    onClick={() => setBodyMode("preview")}
                  >
                    <Eye className="size-3" /> Preview
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-background">
                {bodyMode === "edit" ? (
                  <textarea
                    required
                    maxLength={POLICY_BODY_LIMIT}
                    aria-label="Policy Markdown body"
                    className="size-full min-h-56 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                    value={draft.bodyMarkdown}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        bodyMarkdown: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <div className="size-full overflow-y-auto p-4">
                    <Markdown>{draft.bodyMarkdown}</Markdown>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={draft.mandatory}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          mandatory: event.target.checked,
                        }))
                      }
                    />
                    Mandatory for all projects
                  </label>
                  {editingSummary ? (
                    <span className="text-xs text-muted-foreground">
                      {editingSummary.workspaceAssignmentCount} workspace ·{" "}
                      {editingSummary.projectAssignmentCount} project
                      assignments
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {activeDetail?.templateKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={reset.isPending}
                      onClick={() => setResetConfirmOpen(true)}
                    >
                      <RotateCcw className="size-3.5" /> Reset template
                    </Button>
                  ) : null}
                  <DialogClose asChild>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    type="submit"
                    disabled={!editorReady}
                    pending={save.isPending}
                    pendingLabel="Saving…"
                  >
                    Save changes
                  </Button>
                </div>
              </div>
              {save.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(save.error)}
                </p>
              ) : null}
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        confirmDisabled={!deleteTarget}
        confirmLabel="Delete policy"
        confirmPendingLabel="Deleting…"
        contentClassName="max-w-md"
        description={deleteTarget ? policyDeletionMessage(deleteTarget) : ""}
        error={remove.isError ? errorMessage(remove.error) : undefined}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        pending={remove.isPending}
        title="Delete policy?"
      />

      <ConfirmDialog
        confirmLabel="Reset policy"
        confirmPendingLabel="Resetting…"
        confirmVariant="default"
        contentClassName="max-w-md"
        description="This replaces the saved name, summary, and Markdown body with the packaged template. Enabled, Mandatory, assignments, and position are preserved."
        error={reset.isError ? errorMessage(reset.error) : undefined}
        onConfirm={() => reset.mutate()}
        onOpenChange={setResetConfirmOpen}
        open={resetConfirmOpen}
        pending={reset.isPending}
        title="Reset from template?"
      />
    </div>
  );
}
