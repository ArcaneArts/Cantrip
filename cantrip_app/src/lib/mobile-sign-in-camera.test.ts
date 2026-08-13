import { describe, expect, it, vi } from "vitest";

import {
  cameraRequestErrorMessage,
  CameraRequestTimeoutError,
  requestQrCamera,
} from "./mobile-sign-in-camera";

function cameraStream(): MediaStream {
  return { getTracks: () => [] } as unknown as MediaStream;
}

describe("mobile sign-in camera", () => {
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
