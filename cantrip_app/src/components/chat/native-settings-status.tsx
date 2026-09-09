import { Button } from "@/components/ui/button";
import { useNativeSettingsState } from "./use-native-settings-state";

/** Native confirmation is displayed separately from the editable requested
 * configuration. Opening this view never starts or reconfigures the session. */
export function NativeSettingsStatus({ chatId }: { chatId: string }) {
  const { state, confirmed, decryptionError, refresh } = useNativeSettingsState(
    chatId,
    true,
  );
  const pending = state.data?.pending.length ?? 0;
  const uncertain =
    state.data?.pending.some((request) => request.status === "uncertain") ??
    false;
  const status = state.data?.desiredStatus;
  const error = state.error ?? decryptionError ?? refresh.error;
  return (
    <section
      className="space-y-2 rounded-lg border p-3 text-xs"
      aria-label="Confirmed session settings"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Last confirmed session settings</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? "Reading…" : "Refresh from session"}
        </Button>
      </div>
      {confirmed ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
          <dt>Model</dt>
          <dd className="break-all">{confirmed.model}</dd>
          <dt>Reasoning</dt>
          <dd>{confirmed.effort ?? "Default"}</dd>
          <dt>Service tier</dt>
          <dd>{confirmed.serviceTier ?? "Default"}</dd>
          <dt>Mode</dt>
          <dd>
            {confirmed.collaborationMode.mode === "plan" ? "Plan" : "Default"}
          </dd>
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {state.isPending
            ? "Reading settings…"
            : "No readable session settings have been confirmed yet."}
        </p>
      )}
      {pending > 0 ? (
        <p role="status">
          {uncertain
            ? "Some requested changes have an unconfirmed outcome."
            : `${pending} ${pending === 1 ? "change is" : "changes are"} awaiting confirmation.`}
        </p>
      ) : null}
      {status === "rejected" ? (
        <p role="status">The latest requested change was rejected.</p>
      ) : null}
      {status === "uncertain" && pending === 0 ? (
        <p role="status">
          The latest requested change has an unconfirmed outcome.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          Session settings could not be read. The last confirmed values may be
          out of date.
        </p>
      ) : null}
    </section>
  );
}
