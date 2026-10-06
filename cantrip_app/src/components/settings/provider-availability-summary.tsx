import type {
  ModelProviderAccountSummary,
  ModelProviderKind,
} from "@cantrip/protocol";

import {
  providerTotalCreditsText,
  providerWeeklyAvailability,
} from "./provider-usage-display";

export function ProviderAvailabilitySummary({
  accounts,
  availableResetCredits,
  kind,
}: {
  accounts: ModelProviderAccountSummary[];
  availableResetCredits?: ReadonlyMap<string, number>;
  kind: ModelProviderKind;
}) {
  const availability = providerWeeklyAvailability(
    accounts,
    kind === "chatgpt" ? availableResetCredits : undefined,
  );
  if (!availability) return null;

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {kind === "chatgpt"
            ? "Total maximum 7-day available"
            : "Total 7-day available"}
        </p>
        <p className="text-xs text-muted-foreground">
          {availability.reportedAccountCount ===
          availability.signedInAccountCount
            ? `Across ${availability.signedInAccountCount} signed-in ${availability.signedInAccountCount === 1 ? "account" : "accounts"}`
            : `${availability.reportedAccountCount} of ${availability.signedInAccountCount} signed-in accounts reporting`}
          {availability.bankedResetCount
            ? ` · Includes ${availability.bankedResetCount} banked ${availability.bankedResetCount === 1 ? "reset" : "resets"}`
            : ""}
        </p>
      </div>
      <div className="text-right tabular-nums">
        <p className="text-xl font-semibold">
          {Math.round(availability.availablePercent)}%
        </p>
        {kind === "chatgpt" ? (
          <p className="text-xs text-muted-foreground">
            {providerTotalCreditsText(accounts)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
