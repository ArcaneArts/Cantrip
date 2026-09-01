import { Loader2, LockKeyhole, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { SessionFrame } from "@/components/auth/session-frame";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";

export function AnonymousRecoveryRequiredScreen({
  message,
  onImport,
  onRetry,
  reason,
}: {
  message: string;
  onImport(text: string): Promise<void>;
  onRetry(): void;
  reason:
    | "anonymous-binding-missing"
    | "anonymous-device-missing"
    | "legacy-device-corrupt"
    | "legacy-device-unsupported";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const title =
    reason === "legacy-device-unsupported"
      ? "Legacy device migration required"
      : reason === "legacy-device-corrupt"
        ? "Legacy device recovery required"
        : "Anonymous recovery required";
  return (
    <SessionFrame>
      <div className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <h1 className="font-semibold">{title}</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {message}
            </p>
          </div>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Import the recovery file saved for this anonymous server. Cantrip
          preserved the existing encryption profile and did not create blank
          replacement data. Without the installation key or recovery file,
          anonymous encrypted data is cryptographically unrecoverable.
        </p>
        <input
          ref={inputRef}
          accept=".cantrip-recovery.json,.json,application/json"
          className="hidden"
          type="file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setImporting(true);
            setError(null);
            void file
              .text()
              .then(onImport)
              .catch((importError) => setError(errorMessage(importError)))
              .finally(() => setImporting(false));
          }}
        />
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={importing}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {importing ? <Loader2 className="animate-spin" /> : <Upload />}
            Import recovery file
          </Button>
          <Button disabled={importing} onClick={onRetry} variant="outline">
            Check again
          </Button>
          <div className="min-w-0 flex-1">
            <ServerSwitcher
              currentUserName="Switch server"
              workerName="Recovery required"
            />
          </div>
        </div>
      </div>
    </SessionFrame>
  );
}
