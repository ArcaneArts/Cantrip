import type {
  ChatMessage,
  ModelProfileSummary,
  ModelProviderAccountSummary,
  ModelProviderSummary,
} from "@cantrip/protocol";
import { BarChart3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  providerWeeklyAvailability,
  providerWeeklyRemainingPercent,
  providerCreditsText,
} from "@/components/settings/provider-usage-display";
import { ClaudeAccountUsage } from "@/components/settings/claude-account-usage";
import { ProviderUsageBar } from "@/components/settings/provider-usage-bar";
import { cn } from "@/lib/utils";

export interface ContextUsageSummary {
  contextWindowTokens: number;
  remainingPercent: number;
  remainingTokens: number;
  usedPercent: number;
  usedTokens: number;
}

const numberFormat = new Intl.NumberFormat();
const percentageFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const resetDateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

export function latestContextUsage(
  messages: readonly ChatMessage[],
): ContextUsageSummary | null {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (!message) continue;
    for (
      let itemIndex = message.content.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const item = message.content[itemIndex];
      if (item?.type !== "activity") continue;
      if (item.activity.type === "contextCompaction") return null;
      if (item.activity.type !== "usage") continue;
      if (item.activity.modelContextWindow === null) return null;
      const contextWindowTokens = item.activity.modelContextWindow;
      const usedTokens = item.activity.last.totalTokens;
      const remainingTokens = Math.max(0, contextWindowTokens - usedTokens);
      return {
        contextWindowTokens,
        remainingPercent: clampPercent(
          (remainingTokens / contextWindowTokens) * 100,
        ),
        remainingTokens,
        usedPercent: clampPercent((usedTokens / contextWindowTokens) * 100),
        usedTokens,
      };
    }
  }
  return null;
}

export function selectedQuotaProvider(
  model: ModelProfileSummary | undefined,
  providers: readonly ModelProviderSummary[],
  modelRouteId: string | null = null,
): ModelProviderSummary | null {
  const runtimeRoute = modelRouteId
    ? model?.routes.find(({ id }) => id === modelRouteId)
    : undefined;
  const selectedRoute =
    runtimeRoute ??
    model?.routes.reduce<ModelProfileSummary["routes"][number] | null>(
      (selected, route) => {
        if (!route.enabled) return selected;
        return !selected || route.position < selected.position
          ? route
          : selected;
      },
      null,
    );
  if (!selectedRoute) return null;
  const provider = providers.find(({ id }) => id === selectedRoute.providerId);
  return provider?.kind === "chatgpt" ||
    provider?.kind === "grok" ||
    provider?.kind === "claude-code"
    ? provider
    : null;
}

export function quotaProviderLabel(provider: ModelProviderSummary): string {
  if (provider.kind === "claude-code") return "Claude Code";
  return provider.kind === "grok" ? "SuperGrok" : "ChatGPT";
}

export function signedInQuotaAccounts(
  provider: ModelProviderSummary,
  workerId: string | null = null,
): ModelProviderAccountSummary[] {
  return provider.accounts
    .filter(
      (account) =>
        account.enabled &&
        (provider.kind === "claude-code"
          ? Boolean(account.boundWorkerId) &&
            (!workerId || account.boundWorkerId === workerId) &&
            account.workerBindings.some(
              (binding) =>
                binding.workerId === account.boundWorkerId &&
                binding.authState === "signed-in",
            )
          : account.credentialState === "signed-in"),
    )
    .sort((left, right) => left.position - right.position);
}

export function selectedQuotaAccount(
  provider: ModelProviderSummary,
  providerAccountId: string | null,
  workerId: string | null = null,
): ModelProviderAccountSummary | null {
  if (provider.kind === "claude-code" && providerAccountId) {
    return (
      provider.accounts.find(
        (account) =>
          account.id === providerAccountId &&
          account.enabled &&
          account.boundWorkerId &&
          (!workerId || account.boundWorkerId === workerId),
      ) ?? null
    );
  }
  const accounts = signedInQuotaAccounts(provider, workerId);
  if (provider.kind === "claude-code" && workerId) return accounts[0] ?? null;
  if (!providerAccountId) return accounts.length === 1 ? accounts[0]! : null;
  return accounts.find(({ id }) => id === providerAccountId) ?? null;
}

export function formatQuotaReset(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${resetDateFormat.format(date)}`;
}

function formattedPercent(value: number) {
  return percentageFormat.format(value);
}

function contextRingTone(remainingPercent: number | null) {
  if (remainingPercent === null) return "text-muted-foreground/60";
  if (remainingPercent <= 10) return "text-destructive";
  if (remainingPercent <= 25) return "text-amber-500";
  return "text-muted-foreground";
}

function quotaAvailabilityText(
  provider: ModelProviderSummary,
  availableResetCredits?: ReadonlyMap<string, number>,
) {
  const availability = providerWeeklyAvailability(
    provider.accounts,
    provider.kind === "chatgpt" ? availableResetCredits : undefined,
  );
  if (!availability) return "7-day quota is not reporting yet";
  const accountLabel = `${availability.signedInAccountCount} ${
    availability.signedInAccountCount === 1 ? "account" : "accounts"
  }`;
  const resetLabel = availability.bankedResetCount
    ? ` · Includes ${availability.bankedResetCount} banked ${availability.bankedResetCount === 1 ? "reset" : "resets"}`
    : "";
  if (availability.reportedAccountCount !== availability.signedInAccountCount) {
    return `${Math.round(availability.availablePercent)}% total 7-day available · ${availability.reportedAccountCount} of ${accountLabel} reporting${resetLabel}`;
  }
  return `${Math.round(availability.availablePercent)}% total 7-day available across ${accountLabel}${resetLabel}`;
}

function ContextSummary({ usage }: { usage: ContextUsageSummary | null }) {
  return (
    <div className="grid gap-0.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Context
      </p>
      {usage ? (
        <>
          <p className="text-sm font-semibold tabular-nums">
            {formattedPercent(usage.remainingPercent)}% left
          </p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {numberFormat.format(usage.usedTokens)} /{" "}
            {numberFormat.format(usage.contextWindowTokens)} tokens used
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Available after the model reports token usage
        </p>
      )}
    </div>
  );
}

function QuotaSummary({
  availableResetCredits,
  provider,
  selectedAccount,
}: {
  availableResetCredits?: ReadonlyMap<string, number>;
  provider: ModelProviderSummary;
  selectedAccount: ModelProviderAccountSummary | null;
}) {
  return (
    <div className="grid gap-0.5 border-t pt-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {quotaProviderLabel(provider)} quota
      </p>
      {provider.kind !== "claude-code" ? (
        <p className="text-xs leading-5">
          {quotaAvailabilityText(provider, availableResetCredits)}
        </p>
      ) : null}
      {selectedAccount ? (
        <div className="flex min-w-0 items-baseline justify-between gap-3 pt-1 text-xs">
          <span className="shrink-0 text-muted-foreground">
            Current account
          </span>
          <span className="truncate font-medium" title={selectedAccount.label}>
            {selectedAccount.label}
          </span>
        </div>
      ) : null}
      {provider.kind === "chatgpt" && selectedAccount ? (
        <p className="pt-1 text-xs font-medium tabular-nums">
          {providerCreditsText(selectedAccount.credits)}
        </p>
      ) : null}
      {provider.kind === "claude-code" ? (
        selectedAccount ? (
          <div className="pt-1.5">
            <ClaudeAccountUsage
              providerId={provider.id}
              accountId={selectedAccount.id}
              showPlan={false}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No Claude Code account selected.
          </p>
        )
      ) : selectedAccount ? (
        <div className="pt-1.5">
          <ProviderUsageBar
            label="7-day quota"
            remainingPercent={
              selectedAccount.weeklyUsageUsedPercent === null
                ? null
                : providerWeeklyRemainingPercent(
                    selectedAccount.weeklyUsageUsedPercent,
                  )
            }
            resetText={formatQuotaReset(selectedAccount.weeklyUsageResetsAt)}
          />
        </div>
      ) : null}
    </div>
  );
}

function AccountQuotaDetails({
  account,
  showCredits,
}: {
  account: ModelProviderAccountSummary;
  showCredits: boolean;
}) {
  const remainingPercent =
    account.weeklyUsageUsedPercent === null
      ? null
      : providerWeeklyRemainingPercent(account.weeklyUsageUsedPercent);
  return (
    <>
      {showCredits ? (
        <p className="text-xs tabular-nums text-muted-foreground">
          {providerCreditsText(account.credits)}
        </p>
      ) : null}
      <ProviderUsageBar
        label="7-day quota"
        remainingPercent={remainingPercent}
        resetText={formatQuotaReset(account.weeklyUsageResetsAt)}
      />
    </>
  );
}

function QuotaDialog({
  availableResetCredits,
  onOpenChange,
  open,
  provider,
  workerId,
  selectedAccount,
}: {
  availableResetCredits?: ReadonlyMap<string, number>;
  onOpenChange(open: boolean): void;
  open: boolean;
  provider: ModelProviderSummary;
  workerId: string | null;
  selectedAccount: ModelProviderAccountSummary | null;
}) {
  const accounts = signedInQuotaAccounts(provider, workerId);
  const claude = provider.kind === "claude-code";
  if (
    claude &&
    selectedAccount &&
    !accounts.some(({ id }) => id === selectedAccount.id)
  ) {
    accounts.unshift(selectedAccount);
  }
  const availability = providerWeeklyAvailability(
    provider.accounts,
    provider.kind === "chatgpt" ? availableResetCredits : undefined,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {quotaProviderLabel(provider)}{" "}
            {claude ? "subscription usage" : "7-day usage"}
          </DialogTitle>
          <DialogDescription>
            Quota available to the selected model through {provider.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {!claude ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Total available</p>
                <p className="text-xs text-muted-foreground">
                  {availability
                    ? `${availability.reportedAccountCount} of ${availability.signedInAccountCount} signed-in ${availability.signedInAccountCount === 1 ? "account" : "accounts"} reporting${availability.bankedResetCount ? ` · Includes ${availability.bankedResetCount} banked ${availability.bankedResetCount === 1 ? "reset" : "resets"}` : ""}`
                    : `${accounts.length} signed-in ${accounts.length === 1 ? "account" : "accounts"}`}
                </p>
              </div>
              <span className="shrink-0 text-xl font-semibold tabular-nums">
                {availability
                  ? `${Math.round(availability.availablePercent)}%`
                  : "—"}
              </span>
            </div>
          ) : null}
          {accounts.length ? (
            <ul className="divide-y divide-border" role="list">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="grid min-w-0 gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <p className="text-sm font-medium break-words">
                    {account.label}
                  </p>
                  {claude ? (
                    <ClaudeAccountUsage
                      providerId={provider.id}
                      accountId={account.id}
                    />
                  ) : (
                    <AccountQuotaDetails
                      account={account}
                      showCredits={provider.kind === "chatgpt"}
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No enabled, signed-in {quotaProviderLabel(provider)} accounts are
              available.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ContextUsageRing({
  availableResetCredits,
  messages,
  model,
  modelRouteId = null,
  providerAccountId = null,
  providers,
  workerId = null,
}: {
  availableResetCredits?: ReadonlyMap<string, number>;
  messages: readonly ChatMessage[];
  model: ModelProfileSummary | undefined;
  modelRouteId?: string | null;
  providerAccountId?: string | null;
  providers: readonly ModelProviderSummary[];
  workerId?: string | null;
}) {
  const usage = useMemo(() => latestContextUsage(messages), [messages]);
  const quotaProvider = useMemo(
    () => selectedQuotaProvider(model, providers, modelRouteId),
    [model, modelRouteId, providers],
  );
  const quotaAccount = useMemo(
    () =>
      quotaProvider
        ? selectedQuotaAccount(quotaProvider, providerAccountId, workerId)
        : null,
    [providerAccountId, quotaProvider, workerId],
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerType = useRef<string | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setPopoverOpen(false);
      closeTimer.current = null;
    }, 160);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  const contextLabel = usage
    ? `${formattedPercent(usage.remainingPercent)}% context left, ${numberFormat.format(usage.usedTokens)} of ${numberFormat.format(usage.contextWindowTokens)} tokens used`
    : "Context usage unavailable";
  const quotaLabel = quotaProvider
    ? quotaProvider.kind === "claude-code"
      ? ", Claude Code quota"
      : `, ${quotaAvailabilityText(quotaProvider, availableResetCredits)}`
    : "";
  const accountLabel = quotaAccount
    ? `, current account ${quotaAccount.label}${quotaProvider?.kind === "chatgpt" ? `, ${providerCreditsText(quotaAccount.credits)}` : ""}`
    : "";

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setPopoverOpen(true);
  };
  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") scheduleClose();
  };

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverAnchor asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={`${contextLabel}${quotaLabel}${accountLabel}`}
            aria-expanded={popoverOpen}
            aria-haspopup="dialog"
            onBlur={scheduleClose}
            onClick={() => {
              if (
                lastPointerType.current === null ||
                lastPointerType.current === "mouse"
              ) {
                setPopoverOpen(true);
              } else {
                setPopoverOpen((current) => !current);
              }
              lastPointerType.current = null;
            }}
            onFocus={() => {
              if (
                lastPointerType.current === null ||
                lastPointerType.current === "mouse"
              ) {
                cancelClose();
                setPopoverOpen(true);
              }
            }}
            onPointerDown={(event) => {
              lastPointerType.current = event.pointerType;
            }}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className={cn(
                "size-[18px] -rotate-90",
                contextRingTone(usage?.remainingPercent ?? null),
              )}
            >
              <circle
                cx="10"
                cy="10"
                r="7.5"
                pathLength="100"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-border"
                strokeDasharray={usage ? undefined : "3 3"}
              />
              {usage ? (
                <circle
                  cx="10"
                  cy="10"
                  r="7.5"
                  pathLength="100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={`${usage.usedPercent} 100`}
                />
              ) : null}
            </svg>
          </Button>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-64 space-y-2.5 p-3"
          onBlurCapture={scheduleClose}
          onFocusCapture={cancelClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        >
          <ContextSummary usage={usage} />
          {quotaProvider ? (
            <>
              <QuotaSummary
                availableResetCredits={availableResetCredits}
                provider={quotaProvider}
                selectedAccount={quotaAccount}
              />
              <div className="flex justify-start border-t pt-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="-ml-2 h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => {
                    cancelClose();
                    setPopoverOpen(false);
                    setQuotaDialogOpen(true);
                  }}
                >
                  <BarChart3 className="size-3.5" />
                  Account details
                </Button>
              </div>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
      {quotaProvider ? (
        <QuotaDialog
          availableResetCredits={availableResetCredits}
          open={quotaDialogOpen}
          provider={quotaProvider}
          selectedAccount={quotaAccount}
          workerId={workerId}
          onOpenChange={setQuotaDialogOpen}
        />
      ) : null}
    </>
  );
}
