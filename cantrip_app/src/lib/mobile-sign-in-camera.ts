const cameraRequestTimeoutMs = 12_000;

export class CameraRequestTimeoutError extends Error {
  constructor() {
    super(
      "The browser did not respond to the camera request. Allow Camera for this site in browser settings, then try again.",
    );
    this.name = "CameraRequestTimeoutError";
  }
}

function errorName(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("name" in error)) return null;
  return typeof error.name === "string" ? error.name : null;
}

export function stopCameraStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function requestWithTimeout(
  mediaDevices: MediaDevices,
  constraints: MediaStreamConstraints,
  timeoutMs: number,
): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timeout = globalThis.setTimeout(() => {
      expired = true;
      reject(new CameraRequestTimeoutError());
    }, timeoutMs);
    void mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        globalThis.clearTimeout(timeout);
        if (expired) stopCameraStream(stream);
        else resolve(stream);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timeout);
        if (!expired) reject(error);
      },
    );
  });
}

export async function requestQrCamera(
  mediaDevices: MediaDevices,
  timeoutMs = cameraRequestTimeoutMs,
): Promise<MediaStream> {
  try {
    return await requestWithTimeout(
      mediaDevices,
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      timeoutMs,
    );
  } catch (error) {
    if (errorName(error) !== "OverconstrainedError") {
      throw error;
    }
    return requestWithTimeout(
      mediaDevices,
      { audio: false, video: true },
      timeoutMs,
    );
  }
}

export function cameraRequestErrorMessage(error: unknown): string {
  if (error instanceof CameraRequestTimeoutError) return error.message;
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was blocked. Allow Camera for this site in browser settings, then try again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "NotReadableError":
    case "AbortError":
      return "The camera could not start. Close other apps using it, then try again.";
    default:
      break;
  }
  return error instanceof Error
    ? error.message
    : "The camera could not start. Check this site's camera permission and try again.";
}
