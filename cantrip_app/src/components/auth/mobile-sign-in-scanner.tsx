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
  cameraRequestErrorMessage,
  requestQrCamera,
  scanNativeQrCode,
  shouldUseNativeQrScanner,
  stopCameraStream,
} from "@/lib/mobile-sign-in-camera";
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
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const cameraRequestRef = useRef<Promise<MediaStream> | null>(null);
  const acceptingRef = useRef(false);
  const nativeScanner = shouldUseNativeQrScanner();

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
        (await saveServerConnection({
          name: payload.serverName,
          url: serverUrl,
        }));
      await selectServerConnection(connection.id);
      window.location.reload();
    } catch (scanError) {
      setStatus(null);
      setCameraError(errorMessage(scanError));
      acceptingRef.current = false;
    }
  }, []);

  const startCamera = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    acceptingRef.current = false;
    setCameraError(null);

    if (nativeScanner) {
      cameraRequestRef.current = null;
      setOpen(false);
      setStatus(null);
      void scanNativeQrCode()
        .then((raw) => {
          if (!raw) return;
          setOpen(true);
          void acceptPayload(raw);
        })
        .catch((error) => {
          setStatus(null);
          setCameraError(cameraRequestErrorMessage(error));
          setOpen(true);
        });
      return;
    }

    setStatus("Requesting camera access…");
    setOpen(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraRequestRef.current = null;
      setStatus(null);
      setCameraError("Camera scanning is unavailable in this app environment.");
      return;
    }
    // Start getUserMedia in the click handler so mobile browsers retain the
    // user gesture while deciding whether to show their permission prompt.
    const cameraRequest = requestQrCamera(navigator.mediaDevices);
    void cameraRequest.catch(() => undefined);
    cameraRequestRef.current = cameraRequest;
    setCameraAttempt((attempt) => attempt + 1);
  }, [acceptPayload, nativeScanner]);

  useEffect(() => {
    if (!open) {
      controlsRef.current?.stop();
      controlsRef.current = null;
      acceptingRef.current = false;
      setCameraError(null);
      setStatus(null);
      return;
    }
    const video = videoRef.current;
    const cameraRequest = cameraRequestRef.current;
    if (!video || !cameraRequest) return;
    const reader = new BrowserQRCodeReader();
    let cancelled = false;
    let stream: MediaStream | null = null;
    let controls: IScannerControls | null = null;
    void cameraRequest
      .then(async (cameraStream) => {
        stream = cameraStream;
        if (cancelled) {
          stopCameraStream(cameraStream);
          return null;
        }
        setStatus("Starting camera…");
        return reader.decodeFromStream(
          cameraStream,
          video,
          (result, _error, scannerControls) => {
            controls = scannerControls;
            controlsRef.current = scannerControls;
            if (result) void acceptPayload(result.getText());
          },
        );
      })
      .then((scannerControls) => {
        if (!scannerControls) return;
        controls = scannerControls;
        if (cancelled) scannerControls.stop();
        else {
          controlsRef.current = scannerControls;
          setStatus(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(null);
          setCameraError(cameraRequestErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
      controls?.stop();
      if (!controls && stream) stopCameraStream(stream);
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [acceptPayload, cameraAttempt, open]);

  return (
    <>
      <Button
        className={className}
        onClick={startCamera}
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
          {nativeScanner ? (
            <div className="grid min-h-36 place-items-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
              {status ? (
                <span className="grid justify-items-center gap-3">
                  <Loader2 className="size-6 animate-spin" /> {status}
                </span>
              ) : (
                <Camera className="size-8" />
              )}
            </div>
          ) : (
            <div className="relative aspect-square overflow-hidden rounded-xl bg-black">
              <video
                className="size-full object-cover"
                autoPlay
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
          )}
          {cameraError ? (
            <div className="grid gap-3">
              <p className="text-sm leading-5 text-destructive">
                {cameraError}
              </p>
              <Button onClick={startCamera} type="button" variant="outline">
                <Camera className="size-4" /> Try camera again
              </Button>
            </div>
          ) : !nativeScanner && status?.startsWith("Requesting") ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Approve the browser camera prompt. If no prompt appears, allow
              Camera for this site in the browser settings, then reopen the
              scanner.
            </p>
          ) : !nativeScanner ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Camera className="size-3.5" /> Point the camera at the QR code.
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
