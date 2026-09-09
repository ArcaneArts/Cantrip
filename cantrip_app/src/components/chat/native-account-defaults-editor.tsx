import { useEffect, useRef, useState } from "react";
import type {
  NativeAccountDefaultsResult,
  NativeAccountDefaultsValues,
  NativeSettingsBinding,
} from "@cantrip/protocol";
import { Button } from "@/components/ui/button";
import { nativeAccountDefaults } from "@/lib/native-account-defaults";
import type { ClientSessionIdentitySnapshot } from "@/lib/client-session";

/** Explicit account action. Opening the model picker never reads or writes defaults. */
export function NativeAccountDefaultsEditor({
  binding,
  identity,
  values,
}: {
  binding: NativeSettingsBinding;
  identity: ClientSessionIdentitySnapshot;
  values: NativeAccountDefaultsValues;
}) {
  const [result, setResult] = useState<NativeAccountDefaultsResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    lifetime.current++;
    pending.current = false;
    setResult(null);
    setBusy(false);
    setError(null);
    return () => {
      lifetime.current++;
    };
  }, [binding.bindingId, identity]);
  const run = async (write: boolean) => {
    if (pending.current) return;
    const version = result?.snapshot?.version;
    if (write && !version) return;
    const current = lifetime.current;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await nativeAccountDefaults({
        binding,
        identity,
        operationId: crypto.randomUUID(),
        ...(write ? { write: { expectedVersion: version!, values } } : {}),
      });
      if (lifetime.current === current) setResult(next);
    } catch {
      if (lifetime.current === current) {
        setResult(null);
        setError(
          write
            ? "The write was not confirmed. Read current defaults before making another change."
            : "Could not read this account’s native defaults. Try reading again.",
        );
      }
    } finally {
      if (lifetime.current === current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <div className="space-y-2 border-t pt-3 text-xs">
      <p className="font-medium">Native account defaults</p>
      <p className="text-muted-foreground">
        Save model, reasoning and service tier to this account’s native
        configuration on this worker. Existing chats keep their selections.
        Cantrip’s new-chat model choice remains separate.
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void run(false)}>
        Read account defaults
      </Button>
      {result?.snapshot ? (
        <>
          <p>
            Saved: {result.snapshot.stored.model ?? "Inherited model"} ·{" "}
            {result.snapshot.stored.model_reasoning_effort ??
              "Inherited reasoning"}{" "}
            · {result.snapshot.stored.service_tier ?? "Inherited tier"}
          </p>
          <p>
            Save selection: {values.model ?? "Inherited model"} ·{" "}
            {values.model_reasoning_effort ?? "Inherited reasoning"} ·{" "}
            {values.service_tier ?? "Inherited tier"}
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run(true)}
          >
            Save selection as account defaults
          </Button>
        </>
      ) : null}
      {result?.write ? (
        <p role="status">
          {result.verification === "confirmed"
            ? "Saved and verified in the account configuration."
            : result.verification === "changed"
              ? "Saved; another edit changed the configuration before readback. Review the current defaults."
              : "Saved, but readback failed. Read account defaults to verify."}
          {result.write.status === "okOverridden"
            ? " Another configuration layer overrides one or more defaults."
            : ""}
        </p>
      ) : null}
      {result?.verification === "rejected" ? (
        <p role="alert" className="text-destructive">
          Native configuration rejected the change. Read account defaults before
          trying again.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
