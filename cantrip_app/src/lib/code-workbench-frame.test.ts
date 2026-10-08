import { describe, expect, it } from "vitest";

import {
  CodeWorkbenchFrameLoadTracker,
  codeWorkbenchFrameFailure,
  codeWorkbenchStageError,
  createCodeWorkbenchFrameMount,
  isCodeWorkbenchReadyEvent,
  isCodeWorkbenchReadyMessage,
} from "./code-workbench-frame";

describe("Cantrip Code workbench frame readiness", () => {
  it("distinguishes a same-frame document reload from a fresh mount", () => {
    const loads = new CodeWorkbenchFrameLoadTracker();

    expect(loads.observe("mount_nonce_1234567890")).toBe(false);
    expect(loads.observe("mount_nonce_1234567890")).toBe(true);
    expect(loads.observe("replacement_nonce_1234567890")).toBe(false);
    expect(loads.observe("replacement_nonce_1234567890")).toBe(true);
  });

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

  it.each([400, 404, 502, 503, 599])(
    "reports an exact frame's HTTP %s document failure",
    (statusCode) => {
      const mount = createCodeWorkbenchFrameMount(
        "http://127.0.0.1:43123/code/",
      );
      const frameWindow = {} as Window;
      const failure = codeWorkbenchFrameFailure(
        {
          data: {
            type: "cantrip-code.frame-load-failed",
            version: 1,
            nonce: mount.nonce,
            statusCode,
          },
          origin: mount.origin,
          source: frameWindow,
        },
        frameWindow,
        mount,
      );
      expect(failure).toMatchObject({ stage: "frame" });
      expect(failure?.message).toContain(`HTTP ${statusCode}`);
    },
  );

  it("ignores stale, foreign, or malformed document failures", () => {
    const mount = createCodeWorkbenchFrameMount("http://127.0.0.1:43123/code/");
    const frameWindow = {} as Window;
    const data = {
      type: "cantrip-code.frame-load-failed",
      version: 1,
      nonce: mount.nonce,
      statusCode: 503,
    };
    const event = { data, origin: mount.origin, source: frameWindow };
    for (const invalid of [
      { ...event, source: {} as Window },
      { ...event, source: null },
      { ...event, origin: "http://127.0.0.1:9999" },
      ...[
        null,
        { ...data, nonce: "another_nonce_123456" },
        { ...data, version: 2 },
        { ...data, type: "cantrip-code.workbench-ready" },
        { ...data, statusCode: 200 },
        { ...data, statusCode: 399 },
        { ...data, statusCode: 600 },
        { ...data, statusCode: 503.5 },
        { ...data, statusCode: "503" },
        { ...data, unexpected: true },
      ].map((data) => ({ ...event, data })),
    ]) {
      expect(codeWorkbenchFrameFailure(invalid, frameWindow, mount)).toBeNull();
    }
    expect(codeWorkbenchFrameFailure(event, null, mount)).toBeNull();
    expect(isCodeWorkbenchReadyMessage(data, mount.nonce)).toBe(false);
  });
});
