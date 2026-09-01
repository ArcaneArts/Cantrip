import { Download, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { SessionFrame } from "@/components/auth/session-frame";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";

export function AnonymousRecoverySetupScreen({
  onConfirm,
  onSave,
}: {
  onConfirm(): Promise<void>;
  onSave(): Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <SessionFrame>
      <div className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div>
            <h1 className="font-semibold">Save anonymous recovery</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              This recovery file is the only way to restore anonymous private
              data if this installation key is lost. Anyone with the file can
              access that data, so keep it somewhere private and durable.
            </p>
          </div>
        </div>
        <Button
          className="w-full"
          disabled={saving || confirming}
          onClick={() => {
            setSaving(true);
            setError(null);
            void onSave()
              .then(() => setSaved(true))
              .catch((saveError) => setError(errorMessage(saveError)))
              .finally(() => setSaving(false));
          }}
          type="button"
          variant="outline"
        >
          {saving ? <Loader2 className="animate-spin" /> : <Download />}
          {saved ? "Save another copy" : "Save recovery file"}
        </Button>
        <label className="flex items-start gap-2 text-sm">
          <input
            checked={acknowledged}
            className="mt-0.5 size-4 accent-primary"
            disabled={!saved || confirming}
            onChange={(event) => setAcknowledged(event.target.checked)}
            type="checkbox"
          />
          <span>I saved the recovery file somewhere I can access later.</span>
        </label>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          disabled={!saved || !acknowledged || confirming}
          onClick={() => {
            setConfirming(true);
            setError(null);
            void onConfirm()
              .catch((confirmError) => setError(errorMessage(confirmError)))
              .finally(() => setConfirming(false));
          }}
          type="button"
        >
          {confirming ? <Loader2 className="animate-spin" /> : null}
          Continue to Cantrip
        </Button>
      </div>
    </SessionFrame>
  );
}
