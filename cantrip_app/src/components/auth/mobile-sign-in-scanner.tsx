import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { mobileSignInQrPayloadSchema } from "@cantrip/protocol";
import { Camera, Loader2, QrCode } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { exchangeMobileSignInGrant } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import {
  getServerConnections,
  normalizeServerUrl,
  saveServerConnection,
  selectServerConnection,
  testServerConnection,
} from "@/lib/server-connections";

type MobileSignInScannerProps = {
  className?: string;
};

export function MobileSignInScanner({ className }: MobileSignInScannerProps) {
  const [open, setOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [scanAttempt, setScanAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const acceptingRef = useRef(false);

  const acceptPayload = useCallback(async (raw: string) => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    controlsRef.current?.stop();
    setCameraError(null);
    setStatus("Verifying server and signing in…");
    try {
      const payload = mobileSignInQrPayloadSchema.parse(JSON.parse(raw));
      if (Date.parse(payload.expiresAt) <= Date.now()) {
        throw new Error("This mobile sign-in code has expired.");
      }
      const serverUrl = normalizeServerUrl(payload.serverUrl);
      const bootstrap = await testServerConnection(serverUrl);
      if (bootstrap.server.id !== payload.serverId) {
        throw new Error("The QR code does not match the responding server.");
      }
      await exchangeMobileSignInGrant(serverUrl, { code: payload.code });

      const existing = getServerConnections().find(
        (connection) => connection.url === serverUrl,
      );
      const connection =
        existing ??
        saveServerConnection({ name: payload.serverName, url: serverUrl });
      selectServerConnection(connection.id);
      window.location.reload();
    } catch (scanError) {
      setStatus(null);
      setCameraError(errorMessage(scanError));
      acceptingRef.current = false;
      setScanAttempt((attempt) => attempt + 1);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      controlsRef.current?.stop();
      controlsRef.current = null;
      acceptingRef.current = false;
      setCameraError(null);
      setStatus(null);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera scanning is unavailable in this app environment.");
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    const reader = new BrowserQRCodeReader();
    let cancelled = false;
    void reader
      .decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: "environment" } } },
        video,
        (result, _error, controls) => {
          controlsRef.current = controls;
          if (result) void acceptPayload(result.getText());
        },
      )
      .then((controls) => {
        if (cancelled) controls.stop();
        else controlsRef.current = controls;
      })
      .catch((error) => {
        if (!cancelled) setCameraError(errorMessage(error));
      });
    return () => {
      cancelled = true;
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
  }, [acceptPayload, open, scanAttempt]);

  return (
    <>
      <Button
        className={className}
        onClick={() => setOpen(true)}
        type="button"
        variant="outline"
      >
        <QrCode className="size-4" /> Scan sign-in QR
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan a Cantrip sign-in code</DialogTitle>
            <DialogDescription>
              On a signed-in Cantrip device, open the server menu and choose
              Sign in mobile device.
            </DialogDescription>
          </DialogHeader>
          <div className="relative aspect-square overflow-hidden rounded-xl bg-black">
            <video
              className="size-full object-cover"
              muted
              playsInline
              ref={videoRef}
            />
            <div className="pointer-events-none absolute inset-[14%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
            {status ? (
              <div className="absolute inset-0 grid place-items-center bg-black/75 p-6 text-center text-sm text-white">
                <span className="grid justify-items-center gap-3">
                  <Loader2 className="size-6 animate-spin" /> {status}
                </span>
              </div>
            ) : null}
          </div>
          {cameraError ? (
            <p className="text-sm leading-5 text-destructive">{cameraError}</p>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Camera className="size-3.5" /> Point the camera at the QR code.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
