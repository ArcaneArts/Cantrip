import {
  mobileSignInQrPayloadSchema,
  type MobileSignInGrantCreateResult,
} from "@cantrip/protocol";
import { Copy, Loader2, QrCode, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createMobileSignInGrant } from "@/lib/api";
import { getClientSession } from "@/lib/client-session";
import { errorMessage } from "@/lib/error-message";
import {
  getActiveServerConnection,
  normalizeServerUrl,
} from "@/lib/server-connections";

type MobileSignInQrDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
};

function initialServerUrl(): string {
  const active = getActiveServerConnection();
  if (active.url) return active.url;
  if (typeof window === "undefined") return "";
  return ["http:", "https:"].includes(window.location.protocol)
    ? window.location.origin
    : "";
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
}

export function MobileSignInQrDialog({
  open,
  onOpenChange,
}: MobileSignInQrDialogProps) {
  const session = getClientSession();
  const active = getActiveServerConnection();
  const requestedForOpen = useRef(false);
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [grant, setGrant] = useState<MobileSignInGrantCreateResult | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const requestGrant = async () => {
    setLoading(true);
    setError(null);
    try {
      setGrant(await createMobileSignInGrant());
      setNow(Date.now());
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      requestedForOpen.current = false;
      setGrant(null);
      setError(null);
      return;
    }
    if (requestedForOpen.current) return;
    requestedForOpen.current = true;
    void requestGrant();
  }, [open]);

  useEffect(() => {
    if (!open || !grant) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [grant, open]);

  const normalizedUrl = useMemo(() => {
    try {
      return normalizeServerUrl(serverUrl);
    } catch {
      return null;
    }
  }, [serverUrl]);
  const secondsRemaining = grant
    ? Math.max(0, Math.ceil((Date.parse(grant.expiresAt) - now) / 1_000))
    : 0;
  const payload =
    grant && session && normalizedUrl && secondsRemaining > 0
      ? JSON.stringify(
          mobileSignInQrPayloadSchema.parse({
            type: "cantrip.mobile-sign-in",
            version: 1,
            serverId: session.serverId,
            serverName: active.name,
            serverUrl: normalizedUrl,
            code: grant.code,
            expiresAt: grant.expiresAt,
          }),
        )
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in a mobile device</DialogTitle>
          <DialogDescription>
            Open Cantrip on the phone and scan this code. The code grants one
            new session, expires after two minutes, and cannot be reused.
          </DialogDescription>
        </DialogHeader>

        <label className="grid gap-2 text-sm">
          Server address reachable by the phone
          <Input
            inputMode="url"
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://cantrip.example"
            value={serverUrl}
          />
        </label>
        {normalizedUrl && isLoopbackUrl(normalizedUrl) ? (
          <p className="text-xs leading-5 text-amber-500">
            Loopback addresses point back to the phone. Enter this server's LAN
            or public HTTPS address before scanning.
          </p>
        ) : null}
        {serverUrl && !normalizedUrl ? (
          <p className="text-xs text-destructive">
            Enter an HTTP or HTTPS server origin without a path.
          </p>
        ) : null}

        <div className="grid min-h-64 place-items-center rounded-xl bg-white p-5">
          {loading ? (
            <Loader2 className="size-6 animate-spin text-black/60" />
          ) : payload ? (
            <QRCodeSVG
              bgColor="#ffffff"
              fgColor="#000000"
              level="M"
              size={224}
              value={payload}
            />
          ) : (
            <QrCode className="size-10 text-black/30" />
          )}
        </div>

        {grant ? (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {secondsRemaining > 0
                ? `Expires in ${secondsRemaining}s`
                : "Code expired"}
            </span>
            <Button
              className="h-7 px-2 text-xs"
              onClick={() => void navigator.clipboard.writeText(grant.code)}
              type="button"
              variant="ghost"
            >
              <Copy className="size-3.5" /> Copy code
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button
            disabled={loading}
            onClick={() => void requestGrant()}
            type="button"
            variant="outline"
          >
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            New code
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
