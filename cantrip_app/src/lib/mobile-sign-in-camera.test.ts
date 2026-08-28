import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeScanner = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  scanBarcode: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: nativeScanner.isNativePlatform },
}));

vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: nativeScanner.scanBarcode },
  CapacitorBarcodeScannerCameraDirection: { BACK: 1 },
  CapacitorBarcodeScannerScanOrientation: { ADAPTIVE: 3 },
  CapacitorBarcodeScannerTypeHint: { QR_CODE: 0 },
}));

import {
  cameraRequestErrorMessage,
  CameraRequestTimeoutError,
  requestQrCamera,
  scanNativeQrCode,
  shouldUseNativeQrScanner,
} from "./mobile-sign-in-camera";

function cameraStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

describe("mobile sign-in camera", () => {
  beforeEach(() => {
    nativeScanner.isNativePlatform.mockReset();
    nativeScanner.scanBarcode.mockReset();
  });

  it("uses the native scanner inside installed mobile apps", () => {
    nativeScanner.isNativePlatform.mockReturnValue(true);

    expect(shouldUseNativeQrScanner()).toBe(true);
    expect(nativeScanner.isNativePlatform).toHaveBeenCalledOnce();
  });

  it("opens the native rear camera for QR codes", async () => {
    nativeScanner.scanBarcode.mockResolvedValue({
      ScanResult: "  signed-payload  ",
      format: 0,
    });

    await expect(scanNativeQrCode()).resolves.toBe("signed-payload");
    expect(nativeScanner.scanBarcode).toHaveBeenCalledWith({
      cameraDirection: 1,
      cancelButtonAccessibilityLabel: "Cancel QR scan",
      hint: 0,
      scanInstructions: "Scan a Cantrip sign-in code",
      scanOrientation: 3,
      torchButtonOffAccessibilityLabel: "Turn flashlight on",
      torchButtonOnAccessibilityLabel: "Turn flashlight off",
    });
  });

  it("treats an empty native scan as cancellation", async () => {
    nativeScanner.scanBarcode.mockResolvedValue({ ScanResult: "", format: 0 });

    await expect(scanNativeQrCode()).resolves.toBeNull();
  });

  it("requests the rear camera immediately", async () => {
    const stream = cameraStream();
    const getUserMedia = vi.fn(() => Promise.resolve(stream));

    const request = requestQrCamera({
      getUserMedia,
    } as unknown as MediaDevices);

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    await expect(request).resolves.toBe(stream);
  });

  it("falls back to any camera when facing-mode constraints fail", async () => {
    const stream = cameraStream();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("unsupported", "OverconstrainedError"),
      )
      .mockResolvedValueOnce(stream);

    await expect(
      requestQrCamera({ getUserMedia } as unknown as MediaDevices),
    ).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: true,
    });
  });

  it("turns a stalled permission request into actionable feedback", async () => {
    vi.useFakeTimers();
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => undefined));
    const request = requestQrCamera(
      { getUserMedia } as unknown as MediaDevices,
      100,
    );
    const rejection = expect(request).rejects.toBeInstanceOf(
      CameraRequestTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    vi.useRealTimers();
  });

  it("explains denied camera permission", () => {
    expect(
      cameraRequestErrorMessage(
        new DOMException("Permission denied", "NotAllowedError"),
      ),
    ).toMatch(/Allow Camera/);
  });
});
