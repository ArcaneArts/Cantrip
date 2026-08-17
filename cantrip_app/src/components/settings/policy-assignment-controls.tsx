import type {
  EffectivePolicySummary,
  PolicyAssignmentList,
  PolicySummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Settings2, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getProjectEffectivePolicies,
  getProjectPolicyAssignments,
  getWorkspacePolicyAssignments,
  updateProjectPolicyAssignments,
  updateWorkspacePolicyAssignments,
} from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export type PolicyAssignmentScope =
  | { kind: "project"; id: string; name: string }
  | { kind: "workspace"; id: string; name: string };

export interface PolicyAssignmentPresentation {
  checked: boolean;
  disabled: boolean;
  detail: string;
  sourceLabels: string[];
}

export function policyAssignmentPresentation(
  policy: PolicySummary,
  directlyAssigned: boolean,
  effective: EffectivePolicySummary | undefined,
  scopeKind: PolicyAssignmentScope["kind"],
): PolicyAssignmentPresentation {
  const inheritedWorkspaces =
    effective?.sources.flatMap((source) =>
      source.type === "workspace" ? [source.workspaceName] : [],
    ) ?? [];
  const inherited = inheritedWorkspaces.length > 0;
  const activeMandatory = policy.enabled && policy.mandatory;
  const checked = directlyAssigned || activeMandatory || inherited;
  const disabled =
    !policy.enabled ||
    activeMandatory ||
    (scopeKind === "project" && inherited && !directlyAssigned);
  const sourceLabels = [
    ...(policy.mandatory ? ["Mandatory"] : []),
    ...(directlyAssigned
      ? [scopeKind === "project" ? "Direct" : "Assigned here"]
      : []),
    ...inheritedWorkspaces.map((name) => `Inherited · ${name}`),
    ...(!policy.enabled ? ["Disabled"] : []),
  ];

  let detail = "Available to assign.";
  if (!policy.enabled) {
    detail = directlyAssigned
      ? "The assignment is retained, but the policy is disabled in root Settings."
      : "Disabled in root Settings and currently inactive.";
  } else if (activeMandatory) {
    detail = "Applies to every project. Change Mandatory in root Settings.";
  } else if (scopeKind === "project" && inherited && directlyAssigned) {
    detail = `Assigned directly and inherited from ${inheritedWorkspaces.join(", ")}.`;
  } else if (scopeKind === "project" && inherited) {
    detail = `Inherited from ${inheritedWorkspaces.join(", ")}. Manage it from Workspace Settings.`;
  } else if (directlyAssigned) {
    detail =
      scopeKind === "project"
        ? "Assigned directly to this project."
        : "Assigned to every project visible in this workspace.";
  }

  return { checked, disabled, detail, sourceLabels };
}

function assignmentQueryKey(scope: PolicyAssignmentScope) {
  return [
    scope.kind === "project"
      ? "project-policy-assignments"
      : "workspace-policy-assignments",
    scope.id,
  ] as const;
}

export function PolicyAssignmentControls({
  onEditPolicy,
  onManagePolicies,
  scope,
}: {
  onEditPolicy?(policyId: string): void;
  onManagePolicies?(): void;
  scope: PolicyAssignmentScope;
}) {
  const queryClient = useQueryClient();
  const queryKey = assignmentQueryKey(scope);
  const assignments = useQuery({
    queryKey,
    queryFn: () =>
      scope.kind === "project"
        ? getProjectPolicyAssignments(scope.id)
        : getWorkspacePolicyAssignments(scope.id),
  });
  const effective = useQuery({
    enabled: scope.kind === "project",
    queryKey: ["effective-policies", scope.id],
    queryFn: () => getProjectEffectivePolicies(scope.id),
  });
  const replace = useMutation({
    mutationFn: (policyIds: string[]) => {
      const collectionVersion = assignments.data?.collectionVersion;
      if (!collectionVersion) throw new Error("Policy assignments are stale.");
      const input = { collectionVersion, policyIds };
      return scope.kind === "project"
        ? updateProjectPolicyAssignments(scope.id, input)
        : updateWorkspacePolicyAssignments(scope.id, input);
    },
    onSuccess: (next) => {
      queryClient.setQueryData<PolicyAssignmentList>(queryKey, next);
      void queryClient.invalidateQueries({ queryKey: ["policies"] });
      void queryClient.invalidateQueries({ queryKey: ["effective-policies"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey });
      if (scope.kind === "project") {
        void queryClient.invalidateQueries({
          queryKey: ["effective-policies", scope.id],
        });
      }
    },
  });

  if (assignments.isLoading && !assignments.data) {
    return (
      <div
        role="status"
        aria-label="Loading policy assignments"
        className="grid min-h-36 place-items-center text-muted-foreground"
      >
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const direct = new Set(assignments.data?.directPolicyIds ?? []);
  const effectiveByKey = new Map(
    (effective.data?.policies ?? []).map((policy) => [policy.key, policy]),
  );
  const policies = assignments.data?.policies ?? [];
  const requestError = assignments.error ?? effective.error ?? replace.error;

  return (
    <section aria-label={`${scope.name} policy assignments`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold">Policies</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {scope.kind === "project"
              ? "Assign project-specific policies and review inherited sources."
              : "Assigned policies reach every project visible in this workspace."}
          </p>
        </div>
        {onManagePolicies ? (
          <Button size="sm" variant="ghost" onClick={onManagePolicies}>
            <Settings2 className="size-4" /> Manage policy content
          </Button>
        ) : null}
      </div>

      {requestError ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {errorMessage(
            requestError,
            "Policy assignments could not be loaded.",
          )}
        </p>
      ) : null}

      <div className="divide-y border-y">
        {policies.map((policy) => {
          const presentation = policyAssignmentPresentation(
            policy,
            direct.has(policy.id),
            effectiveByKey.get(policy.key),
            scope.kind,
          );
          return (
            <div
              key={policy.id}
              className="grid gap-2 px-3 py-3 transition-colors hover:bg-muted/40 sm:grid-cols-[1.25rem_minmax(10rem,0.7fr)_minmax(14rem,1fr)_2rem] sm:items-center sm:gap-3"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                aria-label={`${presentation.checked ? "Remove" : "Assign"} ${policy.name}`}
                checked={presentation.checked}
                disabled={presentation.disabled || replace.isPending}
                onChange={(event) => {
                  const policyIds = new Set(direct);
                  if (event.target.checked) policyIds.add(policy.id);
                  else policyIds.delete(policy.id);
                  replace.mutate(
                    policies.flatMap(({ id }) =>
                      policyIds.has(id) ? [id] : [],
                    ),
                  );
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{policy.name}</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {policy.key}
                </p>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap gap-1">
                  {presentation.sourceLabels.length ? (
                    presentation.sourceLabels.map((label) => (
                      <Badge
                        key={label}
                        variant="outline"
                        className="text-[9px]"
                      >
                        {label}
                      </Badge>
                    ))
                  ) : (
                    <Badge variant="outline" className="text-[9px]">
                      Available
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {presentation.detail}
                </p>
              </div>
              {onEditPolicy ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 justify-self-end"
                  onClick={() => onEditPolicy(policy.id)}
                >
                  <Pencil className="size-3.5" />
                  <span className="sr-only">
                    Edit {policy.name} in root Settings
                  </span>
                </Button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
        {!policies.length ? (
          <div className="grid min-h-36 place-items-center px-4 text-center text-sm text-muted-foreground">
            <div>
              <ShieldCheck className="mx-auto mb-2 size-5" />
              Create policies in root Settings before assigning them.
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
