import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TaskInferenceRouteChangeRequest } from "@cantrip/protocol";
import { ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getTaskInferenceRoute,
  changeTaskInferenceRoute,
} from "@/lib/api/tasks";
import { CantripApiError } from "@/lib/api-client";
import { clientEncryption } from "@/lib/client-encryption";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
  clientSessionIdentityMatches,
} from "@/lib/client-session";
import { openModelProviderAccountWireSummary } from "@/lib/protected-secrets";
import { errorMessage } from "@/lib/error-message";

/** A control for an existing canonical input. No drafts or prompts are copied,
 * and HTTP uncertainty retains the exact request identity for explicit retry. */
export function TaskQueuedProviderTransfer({
  chatId,
  revision,
  queued,
  visible,
}: {
  chatId: string;
  revision: number;
  queued: boolean;
  visible: boolean;
}) {
  const client = useQueryClient();
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot);
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const unlocked = encryption.status === "ready";
  const [open, setOpen] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] =
    useState<TaskInferenceRouteChangeRequest | null>(null);
  const [providerId, setProviderId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const guard = useRef(false);
  const lifetime = useRef(0);
  useEffect(
    () =>
      onClientSessionIdentityChanged(() =>
        setIdentity(getClientSessionIdentitySnapshot()),
      ),
    [],
  );
  useEffect(() => {
    lifetime.current++;
    guard.current = false;
    setOpen(false);
    setTracking(false);
    setBusy(false);
    setError(null);
    setUnconfirmed(null);
    setProviderId("");
    setRouteId("");
    setAccountId("");
    setLabels({});
    return () => {
      lifetime.current++;
    };
  }, [chatId, identity, unlocked]);
  const enabled = Boolean(
    identity &&
    unlocked &&
    visible &&
    (open || tracking || busy || unconfirmed),
  );
  const query = useQuery({
    queryKey: ["task-inference-route", chatId, identity, unlocked],
    enabled,
    queryFn: ({ signal }) => getTaskInferenceRoute(chatId, identity!, signal),
    retry: false,
    refetchOnMount: "always",
  });
  // Canonical Task invalidations already update the parent revision. There is
  // no idle polling or provider-wide refresh timer for this control.
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    if (enabled) void query.refetch();
  }, [revision, enabled, query.refetch]);
  const latest = query.data?.latest;
  useEffect(() => {
    if (!latest) return;
    setTracking(latest.phase === "draining");
    if (latest.operationId === unconfirmed?.operationId) {
      setUnconfirmed(null);
      setError(null);
    }
  }, [latest?.operationId, latest?.phase, unconfirmed?.operationId]);
  const providers = query.data?.providers;
  useEffect(() => {
    let live = true;
    setLabels({});
    if (!unlocked || !identity) return;
    const snapshot = clientEncryption.getSnapshot();
    void Promise.all(
      (providers ?? [])
        .flatMap((provider) => provider.accounts)
        .map(async (wire) => {
          try {
            const account = await openModelProviderAccountWireSummary(wire);
            return [account.id, account.label] as const;
          } catch {
            return [wire.id, `Account ${wire.position + 1}`] as const;
          }
        }),
    ).then((entries) => {
      if (
        live &&
        clientSessionIdentityMatches(identity) &&
        clientEncryption.getSnapshot() === snapshot
      )
        setLabels(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [providers, identity, unlocked]);
  const provider = providers?.find((entry) => entry.id === providerId);
  const active = latest?.phase === "draining";
  const source = query.data?.source;
  const retargeted =
    latest?.phase === "completed" &&
    latest.inputOperationId === source?.operationId;
  const currentRoute = retargeted
    ? latest.targetModelRouteId
    : source?.modelRouteId;
  const currentAccount = retargeted
    ? latest.targetProviderAccountId
    : source?.providerAccountId;
  const locked =
    busy ||
    active ||
    Boolean(unconfirmed) ||
    !source ||
    !identity ||
    !unlocked ||
    Boolean(query.error);
  const valid =
    provider?.models.some((model) => model.routeId === routeId) &&
    (!provider.requiresAccount ||
      provider.accounts.some((account) => account.id === accountId)) &&
    !(
      routeId === currentRoute &&
      (provider?.requiresAccount ? accountId : null) === currentAccount
    );
  const run = async () => {
    if (
      guard.current ||
      !identity ||
      !unlocked ||
      (!unconfirmed && (!source || !valid || !query.data))
    )
      return;
    guard.current = true;
    setBusy(true);
    setError(null);
    const version = lifetime.current;
    const current = () =>
      version === lifetime.current && clientSessionIdentityMatches(identity);
    const input = unconfirmed ?? {
      operationId: crypto.randomUUID(),
      inputOperationId: source!.operationId,
      expectedRevision: query.data!.revision,
      targetModelRouteId: routeId,
      targetProviderAccountId: provider!.requiresAccount ? accountId : null,
    };
    setUnconfirmed(input);
    try {
      await changeTaskInferenceRoute(chatId, identity, input);
      if (current()) {
        setUnconfirmed(null);
        setTracking(true);
        await query.refetch();
        void client.invalidateQueries({ queryKey: ["task", chatId] });
        void client.invalidateQueries({ queryKey: ["task-dashboard", chatId] });
      }
    } catch (error) {
      if (current()) {
        if (
          error instanceof CantripApiError &&
          [400, 403, 404, 409].includes(error.status)
        )
          setUnconfirmed(null);
        setError(errorMessage(error));
        await query.refetch();
      }
    } finally {
      if (current()) {
        guard.current = false;
        setBusy(false);
      }
    }
  };
  if (!queued && !tracking && !unconfirmed && !open) return null;
  return (
    <div className="py-2 text-sm">
      <Button
        variant="ghost"
        size="sm"
        disabled={!identity || !unlocked}
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeft className="size-4" />
        {active ? "Changing queued provider" : "Change queued provider"}
      </Button>
      {active ? (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for the previous worker command to settle. The Task will then
          queue with the selected provider.
        </p>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Queued Task provider</DialogTitle>
            <DialogDescription>
              Choose a provider, account, and model for the saved Task input. It
              keeps its content and queues for the destination when the previous
              command settles. Pause and Stop still apply.
            </DialogDescription>
          </DialogHeader>
          {query.isPending ? <p role="status">Loading providers…</p> : null}
          {query.error ? (
            <p role="alert">
              {errorMessage(query.error)}{" "}
              <Button variant="ghost" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </p>
          ) : null}
          {query.data && !source && !active ? (
            <p>
              This input has already started or is no longer eligible to change
              providers.
            </p>
          ) : null}
          {source ? (
            <p className="text-xs text-muted-foreground">
              Current:{" "}
              {providers?.find((entry) =>
                entry.models.some((model) => model.routeId === currentRoute),
              )?.name ?? "Selected provider"}
              {currentAccount
                ? ` · ${labels[currentAccount] ?? currentAccount}`
                : ""}
            </p>
          ) : null}
          <label>
            Provider
            <select
              aria-label="Task destination provider"
              className="mt-1 w-full rounded border bg-background p-2"
              disabled={locked}
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                setRouteId("");
                setAccountId("");
              }}
            >
              <option value="">Choose provider</option>
              {providers?.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {provider?.requiresAccount ? (
            <label>
              Account
              <select
                aria-label="Task destination account"
                className="mt-1 w-full rounded border bg-background p-2"
                disabled={locked}
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">Choose account</option>
                {provider.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {labels[account.id] ?? `Account ${account.position + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Model
            <select
              aria-label="Task destination model"
              className="mt-1 w-full rounded border bg-background p-2"
              disabled={locked || !provider}
              value={routeId}
              onChange={(event) => setRouteId(event.target.value)}
            >
              <option value="">Choose model</option>
              {provider?.models.map((model) => (
                <option key={model.routeId} value={model.routeId}>
                  {model.profileName} · {model.name}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={locked || !valid} onClick={() => void run()}>
            Change provider
          </Button>
          {latest ? (
            <p role="status" className="text-xs text-muted-foreground">
              {latest.phase === "draining"
                ? "Waiting for worker settlement"
                : latest.phase === "completed"
                  ? "Provider change saved. The Task continues through the normal queue."
                  : "Provider change retired because this input is no longer current."}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {unconfirmed ? (
            <div className="text-xs">
              <p>
                The request has not been confirmed. Retry checks the same
                provider change.
              </p>
              <Button
                variant="outline"
                disabled={busy || !identity || !unlocked}
                onClick={() => void run()}
              >
                Retry same request
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
