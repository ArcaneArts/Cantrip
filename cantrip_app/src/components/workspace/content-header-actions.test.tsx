import type { CodeRuntimeStatus } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CodeHeaderState } from "@/components/code/code-view";
import type { ExplorerHeaderState } from "@/components/explorer/explorer-view";
import type { GitHistoryHeaderState } from "@/components/git/git-history";

import {
  ContentHeaderActions,
  ExplorerFileCloseButton,
} from "./content-header-actions";

const runtime = {
  sessionId: "session-1",
  workspaceUri: "file:///worker/project.code-workspace",
  status: "running",
  editorBuild: {
    version: "1.109.5-cantrip.1",
    upstreamRevision: "a".repeat(40),
    patchset: 1,
    fingerprint: "b".repeat(64),
  },
  processInstanceId: "process-1",
  bridgeConnected: true,
  dirtyEditors: [],
  workbench: {
    activeEditor: null,
    git: null,
    conflicts: [],
    savePolicy: "always",
    agentStatus: "idle",
  },
  startedAt: "2026-08-11T12:00:00.000Z",
  lastActivityAt: "2026-08-11T12:00:00.000Z",
  lastError: null,
} satisfies CodeRuntimeStatus;

function gitHeader(canPush = true): GitHistoryHeaderState {
  return {
    branch: "main",
    canPush,
    commitsLoaded: 100,
    head: "abcdef12",
    isFetching: false,
    issueCount: 2,
    issueState: "open",
    isGitActionPending: false,
    section: "history",
    pull: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
  };
}

function codeHeader(): CodeHeaderState {
  return {
    attachmentExpiresAt: null,
    error: null,
    isBusy: false,
    runtime,
    status: "running",
    reload: vi.fn(),
    restart: vi.fn(),
    saveAll: vi.fn(),
    stop: vi.fn(),
  };
}

function explorerHeader(): ExplorerHeaderState {
  return {
    back: vi.fn(),
    canEdit: true,
    canVisual: false,
    directoryPath: "src/App.tsx",
    dirty: true,
    fileMode: "edit",
    isFetching: false,
    isSaving: false,
    refresh: vi.fn(),
    save: vi.fn(),
    selectedPath: "src/App.tsx",
    setFileMode: vi.fn(),
  };
}

describe("ContentHeaderActions", () => {
  it("renders the complete desktop action set with labeled Git actions", () => {
    const markup = renderToStaticMarkup(
      <ContentHeaderActions
        git={gitHeader()}
        explorer={explorerHeader()}
        code={{ header: codeHeader() }}
        terminalService={{ active: true, open: vi.fn() }}
        terminalCommandPalette={{ active: true, open: vi.fn() }}
        popout={{ error: null, pending: false, open: vi.fn() }}
        chat={{
          consoleActive: false,
          consolePending: false,
          inspectCustomizations: vi.fn(),
          relocation: {
            active: true,
            available: true,
            open: false,
            problem: false,
            show: vi.fn(),
          },
          toggleConsole: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("Pull</button>");
    expect(markup).toContain("Push</button>");
    expect(markup).not.toContain('title="Back to files"');
    expect(markup).toContain('title="Edit mode"');
    expect(markup).not.toContain("Preview</button>");
    expect(markup).not.toContain("Edit</button>");
    expect(markup).toContain("Unsaved");
    expect(markup).toContain('title="Save file"');
    expect(markup).toContain('title="Refresh Explorer"');
    expect(markup).toContain('title="Save all editors"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('title="Configure terminal service"');
    expect(markup.indexOf("Configure terminal service")).toBeLessThan(
      markup.indexOf("Run a project command"),
    );
    expect(markup).toContain('title="Open this tab in a new window"');
    expect(markup).toContain('title="Inspect Codex customizations"');
    expect(markup).toContain('title="View agent move progress"');
    expect(markup).toContain('title="Show Codex console"');
  });

  it("renders the Explorer file close action independently for the left title cluster", () => {
    const markup = renderToStaticMarkup(
      <ExplorerFileCloseButton header={explorerHeader()} />,
    );

    expect(markup).toContain('title="Close file"');
    expect(markup).toContain(">Close file</span>");
    expect(
      renderToStaticMarkup(
        <ExplorerFileCloseButton
          header={{ ...explorerHeader(), selectedPath: null }}
        />,
      ),
    ).toBe("");
  });

  it("labels the structured Explorer mode as Visual", () => {
    const markup = renderToStaticMarkup(
      <ContentHeaderActions
        explorer={{
          ...explorerHeader(),
          canVisual: true,
          fileMode: "visual",
        }}
      />,
    );

    expect(markup).toContain('title="Visual mode"');
  });

  it("uses icon-only Git actions in the compact variant", () => {
    const markup = renderToStaticMarkup(
      <ContentHeaderActions compact git={gitHeader()} />,
    );

    expect(markup).toContain(">Fetch and pull</span>");
    expect(markup).toContain(">Push</span>");
    expect(markup).not.toContain("Pull</button>");
    expect(markup).not.toContain("Push</button>");
  });

  it("omits unavailable actions and exposes Code runtime errors", () => {
    const failedCode = codeHeader();
    failedCode.error = "Editor connection failed.";
    const markup = renderToStaticMarkup(
      <ContentHeaderActions
        git={gitHeader(false)}
        code={{ header: failedCode }}
      />,
    );

    expect(markup).not.toContain('title="Push local commits"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Editor connection failed.");
  });
});
