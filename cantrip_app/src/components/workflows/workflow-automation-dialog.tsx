import type {
  WorkflowAutomationTrigger,
  WorkflowDefinitionDetail,
} from "@cantrip/protocol/workflows";
import { useMutation } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
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
import { createWorkflowAutomationTrigger } from "@/lib/api";

type AutomationType = WorkflowAutomationTrigger["type"];

const automationBudget = {
  maxNodes: 100,
  maxAttemptsPerNode: 3,
  maxParallelism: 4,
  maxTokens: null,
  maxDurationMs: 3_600_000,
  maxNodeDurationMs: 900_000,
  maxEstimatedCostUsd: null,
};

export function canWorkflowUseUnattendedTriggers(
  workflow: WorkflowDefinitionDetail,
): boolean {
  return Boolean(
    workflow.revision &&
    workflow.workflow.trustState === "trusted" &&
    workflow.revision.trustState === "trusted" &&
    workflow.revision.permissionRequirements.approvalMode === "preauthorized" &&
    workflow.revision.nodes.every(
      ({ permissionRequirements }) =>
        permissionRequirements.approvalMode === "preauthorized",
    ),
  );
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function positiveInteger(value: string, minimum: number, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The automation could not be created.";
}

export function WorkflowAutomationDialog({
  onCreated,
  onOpenChange,
  open,
  projectId,
  workflow,
}: {
  onCreated(trigger: WorkflowAutomationTrigger): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  projectId: string;
  workflow: WorkflowDefinitionDetail;
}) {
  const [type, setType] = useState<AutomationType>("schedule");
  const [name, setName] = useState("Scheduled workflow");
  const [intervalSeconds, setIntervalSeconds] = useState("3600");
  const [catchUpPolicy, setCatchUpPolicy] = useState<"once" | "skip">("once");
  const [offlinePolicy, setOfflinePolicy] = useState<"pause" | "queue">(
    "pause",
  );
  const [webhookCredential, setWebhookCredential] = useState("");
  const [gitEvent, setGitEvent] = useState<"push" | "pull-request">("push");
  const [branchPattern, setBranchPattern] = useState("main");
  const [command, setCommand] = useState("run-workflow");
  const allowed = canWorkflowUseUnattendedTriggers(workflow);

  useEffect(() => {
    if (!open) return;
    setType("schedule");
    setName(`Automate ${workflow.workflow.name}`);
    setIntervalSeconds("3600");
    setCatchUpPolicy("once");
    setOfflinePolicy("pause");
    setWebhookCredential("");
    setGitEvent("push");
    setBranchPattern("main");
    setCommand(workflow.workflow.slug);
  }, [open, workflow.workflow.name, workflow.workflow.slug]);

  const create = useMutation({
    mutationFn: async () => {
      const revision = workflow.revision;
      if (!revision || !allowed) {
        throw new Error(
          "Unattended triggers require a trusted, fully preauthorized revision.",
        );
      }
      const common = {
        workflowRevisionId: revision.id,
        projectId,
        name: name.trim(),
        enabled: false,
        structuredInput: revision.defaults,
        budget: automationBudget,
        permissionManifest: revision.permissionRequirements,
        selectedModelRouteId: null,
        selectedPermissionProfileId: null,
      };
      if (!common.name) throw new Error("Automation name is required.");
      switch (type) {
        case "schedule":
          return createWorkflowAutomationTrigger({
            ...common,
            type,
            configuration: {
              intervalSeconds: positiveInteger(
                intervalSeconds,
                60,
                "Schedule interval",
              ),
              startAt: null,
              catchUpPolicy,
              offlinePolicy,
            },
          });
        case "api":
          return createWorkflowAutomationTrigger({
            ...common,
            type,
            configuration: {
              minimumIntervalSeconds: positiveInteger(
                intervalSeconds,
                1,
                "Minimum interval",
              ),
            },
          });
        case "webhook": {
          if (webhookCredential.length < 16) {
            throw new Error(
              "Webhook credentials must contain at least 16 characters.",
            );
          }
          return createWorkflowAutomationTrigger({
            ...common,
            type,
            configuration: {
              minimumIntervalSeconds: positiveInteger(
                intervalSeconds,
                1,
                "Minimum interval",
              ),
              credentialHash: await sha256Hex(webhookCredential),
            },
          });
        }
        case "git":
          return createWorkflowAutomationTrigger({
            ...common,
            type,
            configuration: {
              event: gitEvent,
              branchPattern: branchPattern.trim(),
              minimumIntervalSeconds: positiveInteger(
                intervalSeconds,
                1,
                "Minimum interval",
              ),
            },
          });
        case "saved-command":
          return createWorkflowAutomationTrigger({
            ...common,
            type,
            configuration: {
              command: command.trim(),
              minimumIntervalSeconds: positiveInteger(
                intervalSeconds,
                1,
                "Minimum interval",
              ),
            },
          });
      }
    },
    onSuccess: (trigger) => {
      setWebhookCredential("");
      onCreated(trigger);
      onOpenChange(false);
    },
  });

  const updateOpen = (nextOpen: boolean) => {
    if (!nextOpen) setWebhookCredential("");
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={updateOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add workflow automation</DialogTitle>
          <DialogDescription>
            Create a disabled trigger pinned to revision{" "}
            {workflow.revision?.revision ?? "—"}. Review it below, then enable
            it explicitly from the workflow center. The trigger snapshots this
            revision's structured defaults.
          </DialogDescription>
        </DialogHeader>

        {!allowed ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
            Trust this definition and revision and set every stage to
            preauthorized before creating unattended automation.
          </p>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
            <ShieldCheck className="size-4" /> Trusted and fully preauthorized
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Trigger type</span>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={type}
              onChange={(event) => {
                const next = event.target.value as AutomationType;
                setType(next);
                setIntervalSeconds(next === "schedule" ? "3600" : "1");
              }}
            >
              <option value="schedule">Schedule</option>
              <option value="api">Cantrip API</option>
              <option value="webhook">Scoped webhook</option>
              <option value="git">Git / GitHub event</option>
              <option value="saved-command">Saved command</option>
            </select>
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">
              {type === "schedule"
                ? "Interval (seconds, minimum 60)"
                : "Minimum delivery interval (seconds)"}
            </span>
            <Input
              min={type === "schedule" ? 60 : 1}
              type="number"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
            />
          </label>

          {type === "schedule" ? (
            <>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Missed intervals</span>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={catchUpPolicy}
                  onChange={(event) =>
                    setCatchUpPolicy(event.target.value as "once" | "skip")
                  }
                >
                  <option value="once">Run once on recovery</option>
                  <option value="skip">Skip overdue runs</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Worker offline</span>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={offlinePolicy}
                  onChange={(event) =>
                    setOfflinePolicy(event.target.value as "pause" | "queue")
                  }
                >
                  <option value="pause">Pause delivery</option>
                  <option value="queue">Queue a durable run</option>
                </select>
              </label>
            </>
          ) : null}

          {type === "webhook" ? (
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Webhook credential</span>
              <Input
                autoComplete="new-password"
                type="password"
                value={webhookCredential}
                onChange={(event) => setWebhookCredential(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Hashed in this client; only the SHA-256 hash is sent or stored.
              </span>
            </label>
          ) : null}

          {type === "git" ? (
            <>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Event</span>
                <select
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  value={gitEvent}
                  onChange={(event) =>
                    setGitEvent(event.target.value as "push" | "pull-request")
                  }
                >
                  <option value="push">Push</option>
                  <option value="pull-request">Pull request</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-medium">Branch pattern</span>
                <Input
                  value={branchPattern}
                  onChange={(event) => setBranchPattern(event.target.value)}
                  placeholder="main or release/*"
                />
              </label>
            </>
          ) : null}

          {type === "saved-command" ? (
            <label className="grid gap-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Command key</span>
              <Input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="release-now"
              />
              <span className="font-mono text-xs text-muted-foreground">
                /command/{command || "command-key"}
              </span>
            </label>
          ) : null}
        </div>

        {create.error ? (
          <p className="text-sm text-destructive">{errorText(create.error)}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => updateOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!allowed || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Create disabled trigger
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
