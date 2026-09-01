import { Loader2, LockKeyhole } from "lucide-react";
import { useState } from "react";

import { SessionFrame } from "@/components/auth/session-frame";
import { ServerSwitcher } from "@/components/servers/server-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function EncryptionDeviceRecoveryScreen({
  deviceLabel,
  error,
  onRecover,
}: {
  deviceLabel: "browser" | "installation";
  error: string | null;
  onRecover(password: string): Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [recovering, setRecovering] = useState(false);
  return (
    <SessionFrame>
      <form
        className="space-y-5 rounded-2xl border bg-card p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!password || recovering) return;
          setRecovering(true);
          void onRecover(password).finally(() => setRecovering(false));
        }}
      >
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div>
            <h1 className="font-semibold">Recover this {deviceLabel}</h1>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              This {deviceLabel} no longer has a usable encrypted device
              registration. Confirm your account password to authorize its new
              installation key and restore access to the existing data.
            </p>
          </div>
        </div>
        <label className="block space-y-2 text-sm">
          <span>Account password</span>
          <Input
            autoComplete="current-password"
            autoFocus
            disabled={recovering}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          Cantrip preserved the server encryption profile and did not create a
          blank replacement account.
        </p>
        <div className="flex items-center gap-2">
          <Button disabled={!password || recovering} type="submit">
            {recovering ? <Loader2 className="animate-spin" /> : null}
            Recover access
          </Button>
          <div className="min-w-0 flex-1">
            <ServerSwitcher
              currentUserName="Switch server"
              workerName="Device recovery required"
            />
          </div>
        </div>
      </form>
    </SessionFrame>
  );
}
