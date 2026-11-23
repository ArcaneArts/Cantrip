// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { MobileSignInScanner } from "./mobile-sign-in-scanner";

const decodeFromStream = vi.hoisted(() => vi.fn());

vi.mock("@zxing/browser", () => ({
  BrowserQRCodeReader: class {
    decodeFromStream = decodeFromStream;
  },
}));

vi.mock("@/lib/api", () => ({ exchangeMobileSignInGrant: vi.fn() }));

it("attaches the browser camera after the dialog mounts its video", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const stream = { getTracks: () => [] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const stop = vi.fn();
  decodeFromStream.mockResolvedValue({ stop });
  const previousMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  try {
    await act(async () => root.render(<MobileSignInScanner />));
    await act(async () => host.querySelector("button")?.click());

    const video = document.querySelector("video");
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(decodeFromStream).toHaveBeenCalledExactlyOnceWith(
      stream,
      video,
      expect.any(Function),
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (previousMediaDevices)
      Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
  }
  expect(stop).toHaveBeenCalledOnce();
});
