import {
  runConfigurationAuthoringSnapshotSchema,
  type RunConfigurationAuthoringSnapshot,
} from "@cantrip/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunEnvironmentSettings } from "./run-environment-settings";

function snapshot(
  overrides: Partial<RunConfigurationAuthoringSnapshot> = {},
): RunConfigurationAuthoringSnapshot {
  return runConfigurationAuthoringSnapshotSchema.parse({
    relativePath: ".codex/environments/environment.toml",
    sourceControlState: "tracked",
    revision: "a".repeat(64),
    document: {
      version: 1,
      name: "Spectral Lab",
      setup: {
        default: "dotnet restore",
        win32: "dotnet restore .\\SpectralLab.slnx",
        darwin: null,
        linux: null,
      },
      actions: [
        {
          name: "Run Spectral Lab",
          icon: "run",
          command: "dotnet run",
          platform: "win32",
        },
      ],
    },
    editingError: null,
    inspection: {
      platform: "win32",
      canonical: {
        relativePath: ".codex/environments/environment.toml",
        sourceControlState: "tracked",
      },
      configured: true,
      valid: true,
      configurations: [],
      diagnostics: [],
    },
    ...overrides,
  });
}

function render(snapshotValue: RunConfigurationAuthoringSnapshot) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["run-configuration-authoring", "project-1"],
    snapshotValue,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RunEnvironmentSettings projectId="project-1" workerOnline />
    </QueryClientProvider>,
  );
}

describe("RunEnvironmentSettings", () => {
  it("presents the canonical path, Git state, setup variants, and actions", () => {
    const markup = render(snapshot());

    expect(markup).toContain(".codex/environments/environment.toml");
    expect(markup).toContain("tracked");
    expect(markup).toContain("Windows setup");
    expect(markup).toContain("macOS setup");
    expect(markup).toContain("Run actions");
    expect(markup).toContain("Cantrip does not change .gitignore");
    expect(markup).toContain('class="w-full space-y-6"');
    expect(markup).not.toContain("max-w-5xl");
  });

  it("requires an explicit replacement before normalizing unsupported fields", () => {
    const markup = render(
      snapshot({
        document: null,
        editingError:
          "The environment contains fields the Environment editor cannot preserve.",
      }),
    );

    expect(markup).toContain("cannot preserve");
    expect(markup).toContain("Replace with editable v1 template");
  });
});
