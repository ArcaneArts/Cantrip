import { useEffect, useState } from "react";
import type { NativeSettingsBinding } from "@cantrip/protocol";
import type { ClientSessionIdentitySnapshot } from "@/lib/client-session";
import { clientSessionIdentityMatches } from "@/lib/client-session";
import { clientEncryption } from "@/lib/client-encryption";
import { openModelProviderAccountWireSummary } from "@/lib/protected-secrets";
import { Button } from "@/components/ui/button";
import type { useRuntimeHandoff } from "./use-runtime-handoff";

export function NativeRuntimeHandoffEditor({
  controller,
  binding,
  identity,
  disabled,
}: {
  controller: ReturnType<typeof useRuntimeHandoff>;
  binding: NativeSettingsBinding;
  identity: ClientSessionIdentitySnapshot;
  disabled: boolean;
}) {
  const { query, latest, active, busy, error, unconfirmed, run } = controller;
  const [providerId, setProviderId] = useState("");
  const [routeId, setRouteId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const providers = query.data?.providers ?? [];
  const provider = providers.find((entry) => entry.id === providerId);
  const sourceProvider = providers.find((entry) =>
    entry.models.some((model) => model.routeId === binding.modelRouteId),
  );
  const sourceAccount = binding.providerAccountId;
  useEffect(() => {
    let live = true;
    const encryption = clientEncryption.getSnapshot();
    setLabels({});
    void Promise.all(
      providers
        .flatMap((provider) => provider.accounts)
        .map(async (wire) => {
          try {
            const account = await openModelProviderAccountWireSummary(wire);
            return [account.id, account.label] as const;
          } catch {
            return [
              wire.id,
              `Account ${wire.position + 1} (${wire.id})`,
            ] as const;
          }
        }),
    ).then((entries) => {
      if (
        live &&
        clientSessionIdentityMatches(identity) &&
        clientEncryption.getSnapshot() === encryption
      )
        setLabels(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [query.data?.providers, identity]);
  useEffect(() => {
    setProviderId("");
    setRouteId("");
    setAccountId("");
  }, [binding.bindingId, identity]);
  const valid =
    provider?.models.some((model) => model.routeId === routeId) &&
    (!provider.requiresAccount ||
      provider.accounts.some((account) => account.id === accountId)) &&
    !(
      provider.id === sourceProvider?.id &&
      (provider.requiresAccount ? accountId : null) === sourceAccount
    );
  const locked =
    disabled ||
    busy ||
    active ||
    Boolean(unconfirmed) ||
    Boolean(query.error) ||
    query.data?.binding?.bindingId !== binding.bindingId;
  const destination = providers.find((entry) =>
    entry.models.some((model) => model.routeId === latest?.targetModelRouteId),
  );
  return (
    <section
      aria-label="Change session provider"
      className="space-y-2 border-t pt-3 text-sm"
    >
      <p className="font-medium">Provider and account</p>
      <p className="text-xs text-muted-foreground">
        Move this conversation to another provider or account. History and
        session settings are retained. Start the transfer when the agent is
        idle; queued messages wait for it to finish.
      </p>
      <p className="text-xs">
        Current: {sourceProvider?.name ?? "Current provider"}
        {sourceAccount ? ` · ${labels[sourceAccount] ?? sourceAccount}` : ""}
      </p>
      <label className="block">
        Provider
        <select
          aria-label="Transfer provider"
          className="w-full rounded border bg-background p-2"
          value={providerId}
          disabled={locked}
          onChange={(event) => {
            setProviderId(event.target.value);
            setRouteId("");
            setAccountId("");
          }}
        >
          <option value="">Choose provider</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      {provider?.requiresAccount ? (
        <label className="block">
          Account
          <select
            aria-label="Transfer account"
            className="w-full rounded border bg-background p-2"
            value={accountId}
            disabled={locked}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">Choose account</option>
            {provider.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {labels[account.id] ??
                  `Account ${account.position + 1} (${account.id})`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block">
        Destination model
        <select
          aria-label="Transfer model"
          className="w-full rounded border bg-background p-2"
          value={routeId}
          disabled={locked || !provider}
          onChange={(event) => setRouteId(event.target.value)}
        >
          <option value="">Choose model</option>
          {provider?.models.map((model) => (
            <option key={model.routeId} value={model.routeId}>
              {model.profileName} · {model.name}
              {provider.models.filter(
                (other) =>
                  other.name === model.name &&
                  other.profileName === model.profileName,
              ).length > 1
                ? ` (${model.routeId})`
                : ""}
            </option>
          ))}
        </select>
      </label>
      <Button
        disabled={locked || !valid}
        onClick={() =>
          void run("start", {
            routeId,
            accountId: provider?.requiresAccount ? accountId : null,
          })
        }
      >
        Transfer conversation
      </Button>
      {latest ? (
        <p role="status" className="text-xs">
          {latest.cancelRequested && active
            ? "Cancelling transfer"
            : {
                preparing: "Preparing transfer",
                prepared: "Transfer prepared",
                committed: "Completing transfer",
                completed: "Transfer completed",
                cancelled: "Transfer cancelled",
              }[latest.phase]}
          {destination ? ` · ${destination.name}` : ""}
          {latest.errorCode ? ` · ${latest.errorCode}` : ""}
        </p>
      ) : null}
      {unconfirmed ? (
        <p role="status" className="text-xs">
          The transfer request is unconfirmed. Retry uses the same request.
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? query.error?.message}
        </p>
      ) : null}
      {active || unconfirmed ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run("retry")}
        >
          Retry transfer
        </Button>
      ) : null}
      {active && latest?.phase !== "committed" && !latest?.cancelRequested ? (
        <Button
          variant="outline"
          disabled={busy || Boolean(unconfirmed)}
          onClick={() => void run("cancel")}
        >
          Cancel transfer
        </Button>
      ) : null}
      <Button
        variant="outline"
        disabled={busy || query.isFetching}
        onClick={() => void query.refetch()}
      >
        Refresh transfer status
      </Button>
    </section>
  );
}
