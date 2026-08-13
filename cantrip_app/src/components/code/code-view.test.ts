import { describe, expect, it } from "vitest";

import { CantripApiError } from "@/lib/api";

import {
  codeWorkbenchFrameClassName,
  codeReconnectDelayMs,
  isDarkCodeAppearance,
  isCodeAttachmentUnavailableMessage,
  isCodeSessionUnavailableError,
  isCodeWorkbenchReady,
} from "./code-view";

describe("Cantrip Code reconnect delay", () => {
  it("backs off quickly and caps retries", () => {
    expect(codeReconnectDelayMs(0)).toBe(1_000);
    expect(codeReconnectDelayMs(1)).toBe(2_000);
    expect(codeReconnectDelayMs(3)).toBe(8_000);
    expect(codeReconnectDelayMs(8)).toBe(15_000);
  });

  it("treats negative attempts as the first retry", () => {
    expect(codeReconnectDelayMs(-4)).toBe(1_000);
  });

  it("recognizes only the isolated surface recovery message", () => {
    expect(
      isCodeAttachmentUnavailableMessage({
        type: "cantrip-code-attachment-unavailable-v1",
      }),
    ).toBe(true);
    expect(
      isCodeAttachmentUnavailableMessage({
        type: "cantrip-code-attachment-unavailable-v2",
      }),
    ).toBe(false);
    expect(isCodeAttachmentUnavailableMessage(null)).toBe(false);
  });

  it("recovers only from a worker that forgot an existing Code session", () => {
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code session session-1 is not open.", 502),
      ),
    ).toBe(true);
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code failed to start.", 502),
      ),
    ).toBe(false);
    expect(
      isCodeSessionUnavailableError(
        new CantripApiError("Cantrip Code session session-1 is not open.", 409),
      ),
    ).toBe(false);
  });

  it("reveals only the bridge-connected attachment session", () => {
    const runtime = {
      sessionId: "session-1",
      status: "running" as const,
      editorBuild: {
        version: "1.109.5",
        upstreamRevision: "revision",
        patchset: 1,
        fingerprint: "fingerprint",
      },
      processInstanceId: "process-1",
      bridgeConnected: true,
      dirtyEditors: [],
      workbench: {
        activeEditor: null,
        git: null,
        conflicts: [],
        savePolicy: "always" as const,
        agentStatus: "idle" as const,
      },
      startedAt: "2026-08-11T08:00:00.000Z",
      lastActivityAt: "2026-08-11T08:00:01.000Z",
      lastError: null,
    };

    expect(isCodeWorkbenchReady(runtime, "session-1")).toBe(true);
    expect(isCodeWorkbenchReady(runtime, "session-2")).toBe(false);
    expect(
      isCodeWorkbenchReady({ ...runtime, bridgeConnected: false }, "session-1"),
    ).toBe(false);
  });

  it("keeps every dark appearance behind a dark startup surface", () => {
    expect(isDarkCodeAppearance("dark")).toBe(true);
    expect(isDarkCodeAppearance("high-contrast-dark")).toBe(true);
    expect(isDarkCodeAppearance("pro-dark")).toBe(true);
    expect(isDarkCodeAppearance("pro-high-contrast-dark")).toBe(true);
    expect(isDarkCodeAppearance("light")).toBe(false);
    expect(isDarkCodeAppearance("high-contrast-light")).toBe(false);
    expect(isDarkCodeAppearance("pro-light")).toBe(false);
    expect(isDarkCodeAppearance("pro-high-contrast-light")).toBe(false);
  });

  it("keeps the covered workbench render-active while blocking input", () => {
    const covered = codeWorkbenchFrameClassName(false);

    expect(covered).toContain("pointer-events-none");
    expect(covered).not.toContain("opacity-0");
    expect(covered).not.toContain("hidden");
    expect(codeWorkbenchFrameClassName(true)).not.toContain(
      "pointer-events-none",
    );
  });
});
