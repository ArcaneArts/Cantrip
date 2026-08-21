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
} from "@/components/settings/provider-usage-display";
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

export function selectedChatGptProvider(
  model: ModelProfileSummary | undefined,
  providers: readonly ModelProviderSummary[],
): ModelProviderSummary | null {
  const primaryRoute = model?.routes.reduce<
    ModelProfileSummary["routes"][number] | null
  >((selected, route) => {
    if (!route.enabled) return selected;
    return !selected || route.position < selected.position ? route : selected;
  }, null);
  if (!primaryRoute) return null;
  const provider = providers.find(({ id }) => id === primaryRoute.providerId);
  return provider?.kind === "chatgpt" ? provider : null;
}

export function signedInQuotaAccounts(
  provider: ModelProviderSummary,
): ModelProviderAccountSummary[] {
  return provider.accounts
    .filter(
      (account) => account.enabled && account.credentialState === "signed-in",
    )
    .sort((left, right) => left.position - right.position);
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

function availabilityTone(remainingPercent: number | null) {
  if (remainingPercent === null) return "bg-muted-foreground/35";
  if (remainingPercent <= 10) return "bg-destructive";
  if (remainingPercent <= 25) return "bg-amber-500";
  return "bg-emerald-500";
}

function contextRingTone(remainingPercent: number | null) {
  if (remainingPercent === null) return "text-muted-foreground/60";
  if (remainingPercent <= 10) return "text-destructive";
  if (remainingPercent <= 25) return "text-amber-500";
  return "text-muted-foreground";
}

function quotaAvailabilityText(provider: ModelProviderSummary) {
  const availability = providerWeeklyAvailability(provider.accounts);
  if (!availability) return "7-day quota is not reporting yet";
  const accountLabel = `${availability.signedInAccountCount} ${
    availability.signedInAccountCount === 1 ? "account" : "accounts"
  }`;
  if (availability.reportedAccountCount !== availability.signedInAccountCount) {
    return `${Math.round(availability.availablePercent)}% total 7-day available · ${availability.reportedAccountCount} of ${accountLabel} reporting`;
  }
  return `${Math.round(availability.availablePercent)}% total 7-day available across ${accountLabel}`;
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

function QuotaSummary({ provider }: { provider: ModelProviderSummary }) {
  return (
    <div className="grid gap-0.5 border-t pt-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        ChatGPT quota
      </p>
      <p className="text-xs leading-5">{quotaAvailabilityText(provider)}</p>
    </div>
  );
}

function AccountQuotaRow({
  account,
}: {
  account: ModelProviderAccountSummary;
}) {
  const remainingPercent =
    account.weeklyUsageUsedPercent === null
      ? null
      : providerWeeklyRemainingPercent(account.weeklyUsageUsedPercent);
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{account.label}</p>
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums">
          {remainingPercent === null
            ? "Unavailable"
            : `${formattedPercent(remainingPercent)}% left`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${account.label} 7-day quota remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPercent ?? undefined}
        aria-valuetext={
          remainingPercent === null
            ? "Unavailable"
            : `${formattedPercent(remainingPercent)}% remaining`
        }
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            availabilityTone(remainingPercent),
          )}
          style={{ width: `${remainingPercent ?? 0}%` }}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {formatQuotaReset(account.weeklyUsageResetsAt)}
      </p>
    </div>
  );
}

function QuotaDialog({
  onOpenChange,
  open,
  provider,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
  provider: ModelProviderSummary;
}) {
  const accounts = signedInQuotaAccounts(provider);
  const availability = providerWeeklyAvailability(provider.accounts);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>ChatGPT 7-day usage</DialogTitle>
          <DialogDescription>
            Quota available to the selected model through {provider.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">Total available</p>
              <p className="text-xs text-muted-foreground">
                {availability
                  ? `${availability.reportedAccountCount} of ${availability.signedInAccountCount} signed-in ${availability.signedInAccountCount === 1 ? "account" : "accounts"} reporting`
                  : `${accounts.length} signed-in ${accounts.length === 1 ? "account" : "accounts"}`}
              </p>
            </div>
            <span className="text-xl font-semibold tabular-nums">
              {availability
                ? `${Math.round(availability.availablePercent)}%`
                : "—"}
            </span>
          </div>
          {accounts.length ? (
            <div className="grid gap-2">
              {accounts.map((account) => (
                <AccountQuotaRow key={account.id} account={account} />
              ))}
            </div>
          ) : (
            <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              No enabled, signed-in ChatGPT accounts are available.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ContextUsageRing({
  messages,
  model,
  providers,
}: {
  messages: readonly ChatMessage[];
  model: ModelProfileSummary | undefined;
  providers: readonly ModelProviderSummary[];
}) {
  const usage = useMemo(() => latestContextUsage(messages), [messages]);
  const chatGptProvider = useMemo(
    () => selectedChatGptProvider(model, providers),
    [model, providers],
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
  const quotaLabel = chatGptProvider
    ? `, ${quotaAvailabilityText(chatGptProvider)}`
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
            aria-label={`${contextLabel}${quotaLabel}`}
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
          {chatGptProvider ? (
            <>
              <QuotaSummary provider={chatGptProvider} />
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
      {chatGptProvider ? (
        <QuotaDialog
          open={quotaDialogOpen}
          provider={chatGptProvider}
          onOpenChange={setQuotaDialogOpen}
        />
      ) : null}
    </>
  );
}
