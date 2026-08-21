import type { DesktopUpdateActiveWorkSummary } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { DesktopUpdateClient } from "@/lib/desktop-update";
import {
  DesktopUpdateDialogBody,
  DesktopUpdateSettings,
  DesktopUpdateStatusMessage,
  desktopUpdateFlowReducer,
  initialDesktopUpdateFlowState,
  type DesktopUpdateFlowState,
} from "./desktop-update-settings";

const release = {
  currentVersion: "1.2.3",
  version: "1.3.0",
  publishedAt: "2026-08-16T12:00:00.000Z",
  releaseNotes:
    "## Highlights\n\n- Faster startup\n- Safer updates\n\n<script>bad()</script>",
};

const activeWork: DesktopUpdateActiveWorkSummary = {
  activeChats: 1,
  queuedPrompts: 2,
  terminalServices: 1,
  backgroundJobs: 3,
};

function availableState(): DesktopUpdateFlowState {
  return desktopUpdateFlowReducer(initialDesktopUpdateFlowState("1.2.3"), {
    type: "check-available",
    release,
  });
}

function mockClient(): DesktopUpdateClient {
  return {
    cancel: vi.fn(async () => true),
    capability: vi.fn(async () => ({
      available: true,
      installedVersion: "1.2.3",
      reason: null,
    })),
    check: vi.fn(async () => ({
      status: "available" as const,
      installedVersion: "1.2.3",
      release,
    })),
    getActiveWork: vi.fn(async () => activeWork),
    install: vi.fn(async () => ({ version: "1.3.0" })),
    isSupportedEnvironment: vi.fn(() => true),
    listen: vi.fn(async () => () => undefined),
    status: vi.fn(async () => ({
      phase: "idle" as const,
      release: null,
    })),
  };
}

describe("desktop update settings", () => {
  it("does not check or download while rendering the manual control", () => {
    const client = mockClient();
    const markup = renderToStaticMarkup(
      <DesktopUpdateSettings
        capability={{
          available: true,
          installedVersion: "1.2.3",
          reason: null,
        }}
        client={client}
      />,
    );

    expect(markup).toContain("Check for updates");
    expect(markup).toContain("Installed version 1.2.3");
    expect(client.check).not.toHaveBeenCalled();
    expect(client.getActiveWork).not.toHaveBeenCalled();
    expect(client.install).not.toHaveBeenCalled();
  });

  it("shows a concise up-to-date result", () => {
    const current = desktopUpdateFlowReducer(
      initialDesktopUpdateFlowState("1.2.3"),
      { type: "check-current", installedVersion: "1.2.3" },
    );
    expect(
      renderToStaticMarkup(<DesktopUpdateStatusMessage state={current} />),
    ).toContain("Cantrip is up to date.");
  });

  it("renders available metadata and safe Markdown release notes", () => {
    const markup = renderToStaticMarkup(
      <DesktopUpdateDialogBody state={availableState()} />,
    );

    expect(markup).toContain("1.2.3");
    expect(markup).toContain("1.3.0");
    expect(markup).toContain("Highlights");
    expect(markup).toContain("Faster startup");
    expect(markup).toContain(
      'data-elite-global="desktop-update-release-notes"',
    );
    expect(markup).not.toContain("<script>");
  });

  it("cancels before download without entering an install state", () => {
    const cancelled = desktopUpdateFlowReducer(availableState(), {
      type: "reset",
    });
    expect(cancelled.stage).toBe("idle");
    expect(cancelled.release).toBeNull();
    expect(cancelled.downloadedBytes).toBeNull();
  });

  it("starts download only after the explicit install event", () => {
    const available = availableState();
    expect(available.stage).toBe("available");
    expect(available.downloadedBytes).toBeNull();

    const installing = desktopUpdateFlowReducer(available, {
      type: "install-started",
    });
    expect(installing.stage).toBe("downloading");
    expect(installing.downloadedBytes).toBe(0);
  });

  it("requires confirmation when active local work exists", () => {
    const confirming = desktopUpdateFlowReducer(
      desktopUpdateFlowReducer(availableState(), {
        type: "active-work-started",
      }),
      { type: "active-work-confirmation", activeWork },
    );
    const markup = renderToStaticMarkup(
      <DesktopUpdateDialogBody state={confirming} />,
    );

    expect(confirming.stage).toBe("confirm-active-work");
    expect(markup).toContain("Active local work will stop");
    expect(markup).toContain("1 active chat");
    expect(markup).toContain("2 queued prompts");
    expect(markup).toContain("3 background jobs");
  });

  it("shows byte progress and each protected install phase", () => {
    let state = desktopUpdateFlowReducer(availableState(), {
      type: "install-started",
    });
    state = desktopUpdateFlowReducer(state, {
      type: "progress",
      progress: {
        phase: "downloading",
        downloadedBytes: 512,
        totalBytes: 1024,
        message: "Downloading…",
        restartingCurrentVersion: false,
      },
    });
    expect(
      renderToStaticMarkup(<DesktopUpdateDialogBody state={state} />),
    ).toContain("50%");

    for (const phase of ["verifying", "installing", "restarting"] as const) {
      state = desktopUpdateFlowReducer(state, {
        type: "progress",
        progress: {
          phase,
          downloadedBytes: null,
          totalBytes: null,
          message: null,
          restartingCurrentVersion: false,
        },
      });
      expect(state.stage).toBe(phase);
    }
  });

  it("surfaces actionable errors and permits an explicit retry", () => {
    const failed = desktopUpdateFlowReducer(availableState(), {
      type: "failed",
      context: "install",
      error: {
        code: "update_signature_invalid",
        message: "The downloaded update failed signature verification.",
        retryable: true,
      },
    });
    expect(
      renderToStaticMarkup(<DesktopUpdateDialogBody state={failed} />),
    ).toContain("failed signature verification");

    const retrying = desktopUpdateFlowReducer(failed, {
      type: "check-started",
    });
    expect(retrying.stage).toBe("checking");
    expect(retrying.error).toBeNull();
  });
});
