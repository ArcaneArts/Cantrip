import { describe, expect, it } from "vitest";

import {
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
  isCodeWorkbenchReadyMessage,
} from "./code-workbench-frame";

describe("Cantrip Code workbench frame readiness", () => {
  it("adds a per-mount nonce without changing the attachment binding", () => {
    const mount = createCodeWorkbenchFrameMount(
      "http://127.0.0.1:43123/code/capability/?existing=value",
      "mount_nonce_1234567890",
    );
    const parsed = new URL(mount.url);

    expect(parsed.pathname).toBe("/code/capability/");
    expect(parsed.searchParams.get("existing")).toBe("value");
    expect(parsed.searchParams.get("cantripFrameNonce")).toBe(
      "mount_nonce_1234567890",
    );
    expect(mount.origin).toBe("http://127.0.0.1:43123");
  });

  it("rejects malformed nonces before mounting a frame", () => {
    expect(() =>
      createCodeWorkbenchFrameMount("http://127.0.0.1/code/", "too short"),
    ).toThrow("frame nonce is invalid");
  });

  it("requires the exact source, origin, nonce, type, and version", () => {
    const mount = createCodeWorkbenchFrameMount(
      "http://127.0.0.1:43123/code/",
      "mount_nonce_1234567890",
    );
    const frameWindow = {} as Window;
    const event = {
      data: {
        nonce: mount.nonce,
        type: "cantrip-code.workbench-ready",
        version: 1,
      },
      origin: mount.origin,
      source: frameWindow,
    };

    expect(isCodeWorkbenchReadyEvent(event, frameWindow, mount)).toBe(true);
    expect(
      isCodeWorkbenchReadyEvent(
        { ...event, source: {} as Window },
        frameWindow,
        mount,
      ),
    ).toBe(false);
    expect(
      isCodeWorkbenchReadyEvent(
        { ...event, origin: "http://127.0.0.1:9999" },
        frameWindow,
        mount,
      ),
    ).toBe(false);
    expect(
      isCodeWorkbenchReadyMessage(
        { ...event.data, nonce: "another_nonce_123456" },
        mount.nonce,
      ),
    ).toBe(false);
    expect(
      isCodeWorkbenchReadyMessage({ ...event.data, version: 2 }, mount.nonce),
    ).toBe(false);
  });

  it("keeps the failed stage and initiating reason in user-visible errors", () => {
    expect(
      codeWorkbenchStageError("presentation", new TypeError("Load failed"))
        .message,
    ).toBe("Cantrip Code editor presentation failed: Load failed");
    expect(codeWorkbenchStageError("workbench").message).toBe(
      "Cantrip Code workbench did not become ready.",
    );
  });
});
