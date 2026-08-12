import { type ChatSummary } from "@cantrip/protocol";
import {
  workflowDefinitionCreateSchema,
  workflowPermissionRequirementsSchema,
  workflowRevisionCreateSchema,
  type WorkflowDefinitionCreate,
  type WorkflowDefinitionDetail,
  type WorkflowDefinitionGenerationResult,
  type WorkflowGraph,
  type WorkflowJsonObject,
  type WorkflowProvenance,
  type WorkflowRevisionCreate,
  type WorkflowScope,
  type WorkflowSource,
  type WorkflowTrustState,
  type WorkflowDefinitionGenerationSource,
} from "@cantrip/protocol/workflows";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Save, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  appendWorkflowRevision,
  createWorkflow,
  generateWorkflowDefinition,
  getWorkflow,
  updateWorkflow,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

const defaultPermissions = workflowPermissionRequirementsSchema.parse({});

export const starterWorkflowGraph: WorkflowGraph = {
  version: 1,
  nodes: [
    {
      key: "step",
      type: "agent",
      name: "Agent step",
      configuration: {
        prompt: "Describe the work this step should complete.",
        developerInstructions: null,
        includeStructuredInput: true,
        automaticRetries: null,
      },
      inputSchema: {},
      outputSchema: {},
      permissionRequirements: defaultPermissions,
      mutationMode: "read-only",
      modelRouteId: null,
      permissionProfileId: null,
    },
  ],
  edges: [],
};

export interface WorkflowAuthoringValues {
  declaredInputsText: string;
  declaredOutputsText: string;
  defaultsText: string;
  description: string;
  graphText: string;
  name: string;
  permissionsText: string;
  provenance: WorkflowProvenance;
  scope: WorkflowScope;
  slug: string;
  source: WorkflowSource;
  trustState: WorkflowTrustState;
}

function parseObject(value: string, label: string): WorkflowJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as WorkflowJsonObject;
}

export function parseWorkflowAuthoringRevision(
  values: WorkflowAuthoringValues,
  _workflow: WorkflowDefinitionDetail | null,
): WorkflowRevisionCreate {
  const graph = parseObject(values.graphText, "Graph");
  return workflowRevisionCreateSchema.parse({
    graph,
    declaredInputs: parseObject(values.declaredInputsText, "Declared inputs"),
    declaredOutputs: parseObject(
      values.declaredOutputsText,
      "Declared outputs",
    ),
    defaults: parseObject(values.defaultsText, "Defaults"),
    permissionRequirements: parseObject(
      values.permissionsText,
      "Permission requirements",
    ),
    source: values.source,
    provenance: values.provenance,
    trustState: values.trustState,
  });
}

export function parseWorkflowDefinitionCreate(
  values: WorkflowAuthoringValues,
  projectId: string,
): WorkflowDefinitionCreate {
  const revision = parseWorkflowAuthoringRevision(values, null);
  return workflowDefinitionCreateSchema.parse({
    scope: values.scope,
    projectId: values.scope === "project" ? projectId : null,
    slug: values.slug,
    name: values.name,
    description: values.description.trim() || null,
    source: revision.source,
    provenance: revision.provenance,
    trustState: revision.trustState,
    revision,
  });
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function initialValues(
  workflow: WorkflowDefinitionDetail | null,
): WorkflowAuthoringValues {
  const revision = workflow?.revision;
  const provenance: WorkflowProvenance = workflow
    ? {
        origin: "cantrip",
        sourceId: workflow.workflow.id,
        sourceRevision: workflow.revision?.contentHash ?? null,
        reference: workflow.workflow.provenance.reference,
        importedAt: null,
        metadata: {
          editedFromSource: workflow.workflow.source,
          editedFromTrust: workflow.workflow.trustState,
        },
      }
    : {
        origin: "cantrip",
        sourceId: null,
        sourceRevision: null,
        reference: null,
        importedAt: null,
        metadata: { authoredIn: "cantrip" },
      };
  return {
    scope: workflow?.workflow.scope ?? "project",
    slug: workflow?.workflow.slug ?? "new-workflow",
    name: workflow?.workflow.name ?? "New workflow",
    description: workflow?.workflow.description ?? "",
    trustState:
      workflow?.workflow.trustState === "trusted"
        ? "modified"
        : (workflow?.workflow.trustState ?? "untrusted"),
    source: "manual",
    provenance,
    graphText: json(revision?.graph ?? starterWorkflowGraph),
    declaredInputsText: json(revision?.declaredInputs ?? {}),
    declaredOutputsText: json(revision?.declaredOutputs ?? {}),
    defaultsText: json(revision?.defaults ?? {}),
    permissionsText: json(
      revision?.permissionRequirements ?? defaultPermissions,
    ),
  };
}

export function valuesFromGeneratedWorkflow(
  current: WorkflowAuthoringValues,
  result: WorkflowDefinitionGenerationResult,
  editing: boolean,
): WorkflowAuthoringValues {
  const { definition } = result;
  return {
    ...current,
    scope: editing ? current.scope : definition.scope,
    slug: editing ? current.slug : definition.slug,
    name: definition.name,
    description: definition.description ?? "",
    trustState: "untrusted",
    source: "generated",
    provenance: definition.provenance,
    graphText: json(definition.revision.graph),
    declaredInputsText: json(definition.revision.declaredInputs),
    declaredOutputsText: json(definition.revision.declaredOutputs),
    defaultsText: json(definition.revision.defaults),
    permissionsText: json(definition.revision.permissionRequirements),
  };
}

function errorText(error: unknown) {
  return errorMessage(error, "The workflow could not be saved.");
}

function JsonField({
  label,
  onChange,
  rows = 8,
  value,
}: {
  label: string;
  onChange(value: string): void;
  rows?: number;
  value: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        className="w-full rounded-lg border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
      />
    </label>
  );
}

export function WorkflowAuthorDialog({
  chats,
  generationSeed,
  onOpenChange,
  onSaved,
  open,
  projectId,
  workflow,
}: {
  chats: ChatSummary[];
  generationSeed?: { label: string; prompt: string } | null;
  onOpenChange(open: boolean): void;
  onSaved(workflow: WorkflowDefinitionDetail): void;
  open: boolean;
  projectId: string;
  workflow: WorkflowDefinitionDetail | null;
}) {
  const [values, setValues] = useState<WorkflowAuthoringValues>(() =>
    initialValues(workflow),
  );
  const [generationChatId, setGenerationChatId] = useState(chats[0]?.id ?? "");
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationSource, setGenerationSource] =
    useState<WorkflowDefinitionGenerationSource>("task");
  const [generationResult, setGenerationResult] =
    useState<WorkflowDefinitionGenerationResult | null>(null);
  const editing = Boolean(workflow);

  useEffect(() => {
    if (!open) return;
    setValues(initialValues(workflow));
    setGenerationChatId((current) =>
      chats.some(({ id }) => id === current) ? current : (chats[0]?.id ?? ""),
    );
    setGenerationPrompt(generationSeed?.prompt ?? "");
    setGenerationSource(generationSeed ? "runbook" : "task");
    setGenerationResult(null);
  }, [chats, generationSeed, open, workflow]);

  const generate = useMutation({
    mutationFn: () =>
      generateWorkflowDefinition(generationChatId, {
        sourceType: generationSource,
        prompt: generationPrompt,
        scope: values.scope,
      }),
    onSuccess: (result) => {
      setGenerationResult(result);
      setValues((current) =>
        valuesFromGeneratedWorkflow(current, result, editing),
      );
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!workflow)
        return createWorkflow(parseWorkflowDefinitionCreate(values, projectId));
      const revision = parseWorkflowAuthoringRevision(values, workflow);
      await appendWorkflowRevision(workflow.workflow.id, revision);
      await updateWorkflow(workflow.workflow.id, {
        name: values.name,
        description: values.description.trim() || null,
        trustState: values.trustState,
      });
      return getWorkflow(workflow.workflow.id);
    },
    onSuccess: (saved) => {
      onSaved(saved);
      onOpenChange(false);
    },
  });

  const set = <Key extends keyof WorkflowAuthoringValues>(
    key: Key,
    value: WorkflowAuthoringValues[Key],
  ) => setValues((current) => ({ ...current, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit workflow" : "Create workflow"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Saving appends an immutable revision; the previous revision remains available for audit and recovery."
              : "Create a constrained, data-only workflow. Every graph and permission field is validated before persistence."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Name</span>
              <Input
                value={values.name}
                onChange={(event) => set("name", event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Slug</span>
              <Input
                disabled={editing}
                value={values.slug}
                onChange={(event) => set("slug", event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Scope</span>
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                disabled={editing}
                value={values.scope}
                onChange={(event) =>
                  set("scope", event.target.value as WorkflowScope)
                }
              >
                <option value="project">Project</option>
                <option value="personal">Personal</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">Trust state</span>
              <select
                className="h-10 rounded-md border bg-background px-3 text-sm"
                value={values.trustState}
                onChange={(event) =>
                  set("trustState", event.target.value as WorkflowTrustState)
                }
              >
                <option value="untrusted">Untrusted</option>
                <option value="modified">Modified</option>
                <option value="trusted">Trusted</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Description</span>
            <textarea
              className="min-h-20 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={values.description}
              onChange={(event) => set("description", event.target.value)}
            />
          </label>

          <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
            Graph validation rejects cycles, duplicate keys, unknown node
            configuration fields, unsafe permission mismatches, unbounded repeat
            nodes, and invalid predicates. Workflow JSON is data, never
            executable JavaScript.
          </div>

          <div className="grid gap-3 rounded-lg border p-4">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <WandSparkles className="size-4" /> Generate with Codex
              </h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Codex works in a new read-only thread and returns a validated,
                untrusted preview. Review the populated JSON before saving.
              </p>
              {generationSeed ? (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  Conversion source: {generationSeed.label}. Source is treated
                  as inert text and is never executed.
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Source</span>
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={generationSource}
                  onChange={(event) =>
                    setGenerationSource(
                      event.target.value as WorkflowDefinitionGenerationSource,
                    )
                  }
                >
                  <option value="task">Task</option>
                  <option value="chat">Selected agent</option>
                  <option value="runbook">Runbook</option>
                  <option value="demonstration">Demonstrated process</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Codex runtime</span>
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={generationChatId}
                  onChange={(event) => setGenerationChatId(event.target.value)}
                >
                  {chats.map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="grid gap-1.5 text-sm">
              <span className="font-medium">
                {generationSource === "chat"
                  ? "Generation instructions"
                  : "Source material"}
              </span>
              <textarea
                className="min-h-24 rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder={
                  generationSource === "chat"
                    ? "Describe which process in the selected agent should become a workflow."
                    : "Describe or paste the process Codex should turn into a workflow."
                }
                value={generationPrompt}
                onChange={(event) => setGenerationPrompt(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={
                  generate.isPending ||
                  !generationChatId ||
                  !generationPrompt.trim()
                }
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <WandSparkles className="size-4" />
                )}
                Generate preview
              </Button>
              {!chats.length ? (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  Create a project agent to select a Codex runtime.
                </span>
              ) : null}
              {generationResult ? (
                <span className="text-xs text-muted-foreground">
                  Preview from thread{" "}
                  {generationResult.codexThreadId.slice(0, 8)} ·{" "}
                  {generationResult.measuredUsage.totalTokens.toLocaleString()}{" "}
                  tokens
                </span>
              ) : null}
            </div>
            {generate.error ? (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorText(generate.error)}
              </p>
            ) : null}
          </div>

          <JsonField
            label="Graph"
            rows={18}
            value={values.graphText}
            onChange={(value) => set("graphText", value)}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <JsonField
              label="Declared input schema"
              value={values.declaredInputsText}
              onChange={(value) => set("declaredInputsText", value)}
            />
            <JsonField
              label="Declared output schema"
              value={values.declaredOutputsText}
              onChange={(value) => set("declaredOutputsText", value)}
            />
            <JsonField
              label="Default input"
              value={values.defaultsText}
              onChange={(value) => set("defaultsText", value)}
            />
            <JsonField
              label="Permission requirements"
              value={values.permissionsText}
              onChange={(value) => set("permissionsText", value)}
            />
          </div>
          {save.error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorText(save.error)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {editing ? "Append revision" : "Create workflow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
