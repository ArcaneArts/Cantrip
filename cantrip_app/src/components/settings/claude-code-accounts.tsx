import type {
  ModelProviderAccountSummary,
  ModelProviderSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  createModelProviderAccount,
  deleteModelProviderAccount,
  getClaudeCodeAccountStatus,
  getClaudeCodeAccountUsage,
  refreshProviderModelCatalog,
  reorderModelProviderAccounts,
} from "@/lib/api/models";

import { ClaudeCodeLoginTerminal } from "./claude-code-login-terminal";
import {
  providerCatalogQueryKey,
  useProviderCatalog,
} from "./use-provider-catalog";

const usageQueryKey = (providerId: string, accountId: string) =>
  ["claude-account-usage", providerId, accountId] as const;

function ClaudeAccountUsage({
  providerId,
  accountId,
}: {
  providerId: string;
  accountId: string;
}) {
  const usage = useQuery({
    queryKey: usageQueryKey(providerId, accountId),
    queryFn: () => getClaudeCodeAccountUsage(providerId, accountId),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (!usage.data) {
    return (
      <p className="text-xs text-muted-foreground">
        {usage.isPending
          ? "Loading subscription usage…"
          : "Subscription usage unavailable."}
      </p>
    );
  }
  return (
    <div
      className="mt-1 space-y-0.5 text-xs text-muted-foreground"
      aria-label="Subscription usage"
    >
      {usage.data.subscriptionType ? (
        <p className="capitalize">Claude {usage.data.subscriptionType}</p>
      ) : null}
      {usage.data.windows.map(({ label, usedPercent, resetText }) => (
        <p key={label}>
          {label} · {usedPercent}% used
          {resetText ? ` · Resets ${resetText}` : ""}
        </p>
      ))}
      {usage.isError ? <p>Showing previously reported usage.</p> : null}
    </div>
  );
}

export function ClaudeCodeAccounts({
  provider,
  workers,
  onEdit,
  onRemove,
}: {
  provider: ModelProviderSummary;
  workers: readonly WorkerSummary[];
  onEdit(): void;
  onRemove(): void;
}) {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [login, setLogin] = useState<ModelProviderAccountSummary | null>(null);
  const [removing, setRemoving] = useState<ModelProviderAccountSummary | null>(
    null,
  );
  const [label, setLabel] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refresh = () => client.invalidateQueries({ queryKey: ["settings"] });
  const revision = provider.connectionRevision ?? provider.updatedAt;
  const catalog = useProviderCatalog(provider.id, null, true, revision);
  const refreshModels = useMutation({
    mutationFn: () => refreshProviderModelCatalog(provider.id),
    onSuccess: (result) => {
      client.setQueryData(
        providerCatalogQueryKey(provider.id, null, revision),
        result,
      );
    },
  });
  const fetchedCatalog =
    catalog.isSuccess && !catalog.isPlaceholderData ? catalog.dataUpdatedAt : 0;
  useEffect(() => {
    if (fetchedCatalog)
      void client.invalidateQueries({ queryKey: ["settings"] });
  }, [client, fetchedCatalog]);
  const availableModels = new Set(
    catalog.data?.availability
      .filter((entry) => entry.state === "available")
      .map((entry) => entry.providerModelId),
  ).size;
  const create = useMutation({
    mutationFn: () =>
      createModelProviderAccount(provider.id, {
        label,
        boundWorkerId: workerId,
      }),
    onSuccess: (account) => {
      setAdding(false);
      setLogin(account);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (account: ModelProviderAccountSummary) =>
      deleteModelProviderAccount(provider.id, account.id),
    onSuccess: () => {
      setRemoving(null);
      void refresh();
      void client.invalidateQueries({
        queryKey: ["provider-catalog", provider.id],
      });
    },
  });
  const status = useMutation({
    mutationFn: (account: ModelProviderAccountSummary) =>
      getClaudeCodeAccountStatus(provider.id, account.id),
    onSuccess: (_result, account) => {
      void refresh();
      void client.invalidateQueries({
        queryKey: usageQueryKey(provider.id, account.id),
      });
    },
  });
  const prefer = useMutation({
    mutationFn: (account: ModelProviderAccountSummary) => {
      const ids = provider.accounts.map(({ id }) => id);
      const first = provider.accounts.findIndex(
        (candidate) =>
          candidate.boundWorkerId === account.boundWorkerId &&
          candidate.enabled,
      );
      const index = ids.indexOf(account.id);
      if (first < 0 || index < 0 || index === first) return Promise.resolve();
      const preferred = ids[first];
      if (!preferred) return Promise.resolve();
      ids[first] = account.id;
      ids[index] = preferred;
      return reorderModelProviderAccounts(provider.id, ids);
    },
    onSuccess: refresh,
  });
  const operationError = status.error ?? prefer.error;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-medium">{provider.name}</h2>
          <p className="text-xs text-muted-foreground">
            Claude Code accounts are stored on their worker.
          </p>
          <p className="text-xs text-muted-foreground">
            {catalog.isFetching || refreshModels.isPending
              ? "Refreshing model catalog…"
              : catalog.isError && !catalog.data
                ? "Model catalog unavailable"
                : `${availableModels} available ${availableModels === 1 ? "model" : "models"}${catalog.data?.servedStale ? " · cached" : ""}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={catalog.isFetching || refreshModels.isPending}
            onClick={() => refreshModels.mutate()}
          >
            Refresh models
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit provider
          </Button>
          {provider.accounts.length === 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
              Remove provider
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              create.reset();
              setLabel("");
              setWorkerId(workers.find(({ online }) => online)?.workerId ?? "");
              setAdding(true);
            }}
          >
            Add account
          </Button>
        </div>
      </div>
      {provider.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Claude Code accounts.
        </p>
      ) : null}
      {provider.accounts.map((account) => {
        const worker = workers.find(
          (candidate) => candidate.workerId === account.boundWorkerId,
        );
        const auth = account.workerBindings.find(
          (binding) => binding.workerId === account.boundWorkerId,
        )?.authState;
        const description = !worker?.online
          ? "Worker offline"
          : auth === "signed-in"
            ? "Signed in"
            : auth === "failed"
              ? "Subscription sign-in required"
              : "Signed out";
        const preferred =
          provider.accounts.find(
            (candidate) =>
              candidate.boundWorkerId === account.boundWorkerId &&
              candidate.enabled,
          )?.id === account.id;
        return (
          <div
            key={account.id}
            className="flex flex-wrap items-center justify-between gap-2 border-t pt-3"
          >
            <div className="min-w-0">
              <p className="break-words text-sm">{account.label}</p>
              <p className="text-xs text-muted-foreground">
                {worker?.name ?? account.boundWorkerId} · {description}
                {preferred ? " · Preferred on this worker" : ""}
              </p>
              {worker?.online && account.enabled && auth === "signed-in" ? (
                <ClaudeAccountUsage
                  providerId={provider.id}
                  accountId={account.id}
                />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!worker?.online || !account.enabled}
                onClick={() => setLogin(account)}
              >
                {auth === "signed-in" ? "Sign in again" : "Sign in"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!worker?.online || status.isPending}
                onClick={() => status.mutate(account)}
              >
                Check status
              </Button>
              {!preferred && account.enabled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={prefer.isPending}
                  onClick={() => prefer.mutate(account)}
                >
                  Prefer on this worker
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  remove.reset();
                  setRemoving(account);
                }}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      {operationError ? (
        <p role="alert" className="text-sm text-destructive">
          {operationError.message}
        </p>
      ) : null}
      {refreshModels.error ? (
        <p role="alert" className="text-sm text-destructive">
          {refreshModels.error.message}
        </p>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Claude Code account</DialogTitle>
            <DialogDescription>
              Choose the worker that will use this Claude subscription.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <label className="grid gap-1.5 text-sm">
              Account label
              <Input
                required
                maxLength={160}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Worker
              <select
                required
                className="rounded border bg-background p-2"
                value={workerId}
                onChange={(event) => setWorkerId(event.target.value)}
              >
                <option value="">Select worker</option>
                {workers.map((worker) => (
                  <option
                    key={worker.workerId}
                    value={worker.workerId}
                    disabled={!worker.online}
                  >
                    {worker.name}
                    {worker.online ? "" : " (offline)"}
                  </option>
                ))}
              </select>
            </label>
            {create.error ? (
              <p role="alert" className="text-sm text-destructive">
                {create.error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                disabled={create.isPending}
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!workerId || !label.trim() || create.isPending}
              >
                Add and sign in
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(login)}
        onOpenChange={(open) => {
          if (!open) setLogin(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sign in to Claude Code</DialogTitle>
            <DialogDescription>{login?.label}</DialogDescription>
          </DialogHeader>
          {login?.boundWorkerId ? (
            <ClaudeCodeLoginTerminal
              key={`${login.id}:${attempt}`}
              providerId={provider.id}
              accountId={login.id}
              workerId={login.boundWorkerId}
              onSignedIn={() => {
                setLogin(null);
                void refresh();
                void client.invalidateQueries({
                  queryKey: usageQueryKey(provider.id, login.id),
                });
                refreshModels.mutate();
              }}
            />
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => setLogin(null)}
            >
              Close
            </Button>
            <Button
              variant="outline"
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Claude Code account</DialogTitle>
            <DialogDescription>
              Remove {removing?.label} and its sign-in from the worker.
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p role="alert" className="text-sm text-destructive">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={remove.isPending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              Remove account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
