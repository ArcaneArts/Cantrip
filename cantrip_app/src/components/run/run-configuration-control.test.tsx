import type { ProjectWorktreeSummary, WorkerSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RunConfigurationListInventory } from "@/lib/run-configuration-api";

import { MobileProjectHeader } from "../mobile/mobile-project-header";
import { RunConfigurationControl } from "./run-configuration-control";

const configurationId = "00000000-0000-4000-8000-000000000001";
const worktree = {
  id: "primary",
  projectSourceId: "source",
  projectId: "project",
  rootKind: "git-worktree",
  workerId: "worker",
  name: "Primary",
  path: "/project",
  displayPath: "/project",
  isPrimary: true,
  isDefault: true,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: "main",
  head: "abc",
  detached: false,
  locked: false,
  lockReason: null,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies ProjectWorktreeSummary;
const inventory = {
  directory: ".cantrip/run-configurations",
  diagnostics: [],
  entries: [
    {
      relativePath: `.cantrip/run-configurations/${configurationId}.json`,
      revision: "a".repeat(64),
      id: configurationId,
      status: "ready",
      diagnostics: [],
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Development server",
        provider: "shell",
        workingDirectory: ".",
        target: { kind: "command", command: "pnpm dev" },
        commandOverride: null,
        arguments: [],
        environment: {
          includeCodexEnvironment: true,
          files: [],
          variables: [],
          secrets: [],
        },
        beforeLaunch: [],
        platformOverrides: {},
        options: { shell: "automatic", login: true },
        stop: { gracePeriodMs: 3_000 },
      },
    },
  ],
  validations: [
    {
      configurationId,
      provider: "shell",
      platform: "linux",
      effectiveCommand: "pnpm dev",
      valid: true,
      diagnostics: [],
    },
  ],
} satisfies RunConfigurationListInventory;
const worker = { workerId: "worker", online: true } as WorkerSummary;

function markup(
  runtimes: RunConfigurationRuntime[] = [],
  listedInventory: RunConfigurationListInventory = inventory,
) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RunConfigurationControl
        editorConfigurationId={null}
        inventory={listedInventory}
        loading={false}
        projectId="project"
        renderEditor={false}
        runtimes={runtimes}
        workers={[worker]}
        worktrees={[worktree]}
        onEditorConfigurationChange={vi.fn()}
        onFocusTerminal={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("Run configuration control", () => {
  it("renders the remembered/default configuration with a green Run action", () => {
    const html = markup();
    expect(html).toContain("Development server");
    expect(html).toContain('aria-label="Run"');
    expect(html).toContain("text-emerald");
    expect(html).not.toContain("Worker Online");
  });

  it("replaces Run with restart and stop while Primary is active", () => {
    const html = markup([
      {
        configurationId,
        worktreeId: worktree.id,
        state: "running",
      } as RunConfigurationRuntime,
    ]);
    expect(html).toContain('aria-label="Restart"');
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Run"');
  });

  it("keeps Stop available when provider validation blocks restart", () => {
    const html = markup(
      [
        {
          configurationId,
          worktreeId: worktree.id,
          state: "running",
        } as RunConfigurationRuntime,
      ],
      {
        ...inventory,
        validations: [
          {
            ...inventory.validations[0]!,
            valid: false,
            diagnostics: [
              {
                severity: "error",
                code: "invalid-target",
                message: "The target is invalid.",
                relativePath: null,
                field: "target",
              },
            ],
          },
        ],
      },
    );
    expect(html).toMatch(/aria-label="Restart"[^>]*disabled=""/u);
    expect(html).not.toMatch(/aria-label="Stop"[^>]*disabled=""/u);
  });

  it("renders the real control inside the compact project header", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <MobileProjectHeader
          actions={
            <RunConfigurationControl
              compact
              editorConfigurationId={null}
              inventory={inventory}
              loading={false}
              projectId="project"
              renderEditor={false}
              runtimes={[]}
              workers={[worker]}
              worktrees={[worktree]}
              onEditorConfigurationChange={vi.fn()}
              onFocusTerminal={vi.fn()}
            />
          }
          context="ArcaneArts/Cantrip"
          title="Cantrip"
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-slot="mobile-project-header-actions"');
    expect(html).toContain('data-run-configuration-control="true"');
    expect(html).toContain("Development server");
    expect(html).toContain('aria-label="Run"');
  });
});
