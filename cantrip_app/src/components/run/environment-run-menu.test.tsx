import type { RunEnvironmentSummary } from "@cantrip/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EnvironmentRunMenu } from "./environment-run-menu";

const runId = "00000000-0000-4000-8000-000000000030";
const actionId = "a".repeat(64);
const revision = "b".repeat(64);

const environment: RunEnvironmentSummary = {
  worktreeId: "worktree-one",
  inspection: {
    platform: "linux",
    canonical: {
      relativePath: ".codex/environments/environment.toml",
      sourceControlState: "ignored",
    },
    configured: true,
    valid: true,
    configurations: [
      {
        relativePath: ".codex/environments/environment.toml",
        revision,
        version: 1,
        name: "Spectral Lab",
        sourceControlState: "ignored",
        setup: null,
        actions: [
          {
            id: actionId,
            name: "Run Spectral Lab",
            icon: "run",
            command: "dotnet run",
            platform: "linux",
            configurationPath: ".codex/environments/environment.toml",
            sourceIndex: 0,
          },
        ],
        diagnostics: [],
      },
    ],
    diagnostics: [],
  },
  setup: null,
  run: {
    id: runId,
    projectId: "project-one",
    worktreeId: "worktree-one",
    workerId: "worker-one",
    actionId,
    configurationRevision: revision,
    state: "running",
    terminalId: runId,
    exitCode: null,
    signal: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    startedAt: "2026-08-21T12:00:00.000Z",
    endedAt: null,
    updatedAt: "2026-08-21T12:00:00.000Z",
  },
};

describe("EnvironmentRunMenu", () => {
  it("exposes the project Environment control and latest Run state", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRunMenu
        environment={environment}
        loading={false}
        mutationPending={false}
        onConfigure={() => {}}
        onOpen={() => {}}
        onStart={() => {}}
        onStop={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Environment and Run actions"');
    expect(markup).toContain(">Environment<");
    expect(markup).toContain('aria-label="Latest Run running"');
  });

  it("keeps the compact control accessible and reflects pending work", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRunMenu
        compact
        environment={environment}
        loading={false}
        mutationPending
        onConfigure={() => {}}
        onOpen={() => {}}
        onStart={() => {}}
        onStop={() => {}}
      />,
    );

    expect(markup).toContain("Environment");
    expect(markup).toContain("animate-spin");
  });
});
