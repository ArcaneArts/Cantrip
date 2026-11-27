import type {
  ModelProviderAccountSummary,
  ModelProviderSummary,
} from "@cantrip/protocol";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  providerCreditsText,
  providerWeeklyAvailability,
  providerWeeklyRemainingPercent,
} from "./provider-usage-display";
import { ProviderUsageBar } from "./provider-usage-bar";

const countFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const resetDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function ProviderAccountGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
      {children}
    </div>
  );
}

export function ProviderAccountCard({
  label,
  detail,
  status,
  children,
  actions,
}: {
  label: string;
  detail?: string | null;
  status: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article className="flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card/30 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">
            {label}
          </h3>
          {detail ? (
            <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {detail}
            </p>
          ) : null}
        </div>
        <p
          className={
            status === "Signed in"
              ? "shrink-0 text-xs text-emerald-500"
              : "text-right text-xs text-muted-foreground"
          }
        >
          {status}
        </p>
      </div>
      {children}
      <div className="mt-auto flex flex-wrap items-center justify-end gap-1 border-t pt-2">
        {actions}
      </div>
    </article>
  );
}

function AccountQuota({
  account,
  chatGpt,
  resetCredits,
}: {
  account: ModelProviderAccountSummary;
  chatGpt: boolean;
  resetCredits: ReadonlyMap<string, number>;
}) {
  const signedIn = account.enabled && account.credentialState === "signed-in";
  const current =
    signedIn && account.weeklyUsageUsedPercent !== null
      ? providerWeeklyRemainingPercent(account.weeklyUsageUsedPercent)
      : null;
  const resets = signedIn && chatGpt ? resetCredits.get(account.id) : undefined;
  const total = chatGpt
    ? (providerWeeklyAvailability([account], resetCredits)?.availablePercent ??
      null)
    : null;
  const partialTotal = current === null || resets === undefined;
  const resetAt =
    signedIn && account.weeklyUsageResetsAt
      ? Date.parse(account.weeklyUsageResetsAt)
      : NaN;
  return (
    <>
      {chatGpt ? (
        <div>
          <p className="text-xs text-muted-foreground">Usage left</p>
          <p className="mt-1 text-2xl leading-none font-semibold tracking-tight tabular-nums">
            {total === null ? (
              "—"
            ) : (
              <>
                {partialTotal ? <span aria-label="At least">≥</span> : null}
                {countFormat.format(total)}%
              </>
            )}
          </p>
        </div>
      ) : null}
      <ProviderUsageBar
        label="Current 7-day quota"
        remainingPercent={current}
      />
      <dl
        className={
          chatGpt
            ? "grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-xs"
            : "text-xs"
        }
      >
        {chatGpt ? (
          <div>
            <dt className="text-muted-foreground">Resets available</dt>
            <dd className="mt-1 font-medium tabular-nums">{resets ?? "—"}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted-foreground">Next reset</dt>
          <dd className="mt-1 font-medium">
            {Number.isFinite(resetAt) ? (
              <time dateTime={account.weeklyUsageResetsAt!}>
                {resetDateFormat.format(resetAt)}
              </time>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
    </>
  );
}

export function SubscriptionAccountCards({
  provider,
  availableResetCredits,
  onManage,
}: {
  provider: ModelProviderSummary;
  availableResetCredits: ReadonlyMap<string, number>;
  onManage(accountId: string): void;
}) {
  const chatGpt = provider.kind === "chatgpt";
  if (!provider.accounts.length)
    return <p className="text-sm text-muted-foreground">No accounts yet.</p>;

  return (
    <ProviderAccountGrid>
      {provider.accounts.map((account) => {
        const status = !account.enabled
          ? "Disabled"
          : account.credentialState === "signed-in"
            ? "Signed in"
            : "Signed out";
        const detail = [
          account.planType,
          chatGpt && account.credits
            ? providerCreditsText(account.credits)
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <ProviderAccountCard
            key={account.id}
            label={account.label}
            detail={detail}
            status={status}
            actions={
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Manage ${account.label}`}
                onClick={() => onManage(account.id)}
              >
                Manage
              </Button>
            }
          >
            <AccountQuota
              account={account}
              chatGpt={chatGpt}
              resetCredits={availableResetCredits}
            />
          </ProviderAccountCard>
        );
      })}
    </ProviderAccountGrid>
  );
}
