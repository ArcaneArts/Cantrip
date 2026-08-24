import type { TerminalSummary } from "@cantrip/protocol";
import type { RunConfigurationRuntime } from "@cantrip/protocol/run-configuration-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunTerminalOutput, RunTerminalView } from "./run-terminal-view";

const timestamp = "2026-08-24T12:00:00.000Z";
const projectId = "92be40dc-a153-42fe-8e7f-253722497dcf";
const configurationId = "939b7162-c264-4896-bfd5-9c04e8f3442c";
const worktreeId = "56757255-c342-4cd2-b320-5e61621ca248";
const runtimeId = "cb5c9480-3c2e-4522-b75b-431cf36a89c2";

const terminal: TerminalSummary = {
  id: runtimeId,
  projectId,
  kind: "run-configuration",
  title: "Development server",
  position: 0,
  status: "running",
  activeWorkerId: "worker-one",
  worktreeId,
  linkedChatId: null,
  runConfigurationId: configurationId,
  runConfigurationRuntimeId: runtimeId,
  directoryPath: null,
  service: { enabled: false, command: "" },
  createdAt: timestamp,
  updatedAt: timestamp,
};

function runtime(
  state: RunConfigurationRuntime["state"],
): RunConfigurationRuntime {
  return {
    id: runtimeId,
    projectId,
    configurationId,
    worktreeId,
    workerId: "worker-one",
    terminalId: runtimeId,
    definitionRevision: "a".repeat(64),
    codexEnvironmentRevision: null,
    generation: 2,
    requestedOperationId: "4e733087-881c-4506-a41f-ed6a78f89ad5",
    state,
    startedAt: timestamp,
    endedAt: state === "exited" ? timestamp : null,
    exitCode: state === "exited" ? 0 : null,
    signal: null,
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function renderView(
  state: RunConfigurationRuntime["state"],
  definitionAvailable: boolean,
  availability: {
    launchAvailable?: boolean | null;
    launchProblem?: string | null;
    stopAvailable?: boolean | null;
    stopProblem?: string | null;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    [
      "run-configuration-runtime-output",
      projectId,
      configurationId,
      worktreeId,
      2,
    ],
    { data: "ready\r\n", generation: 2, truncated: false },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RunTerminalView
        definitionAvailable={definitionAvailable}
        launchAvailable={
          "launchAvailable" in availability
            ? (availability.launchAvailable ?? null)
            : definitionAvailable
        }
        launchProblem={availability.launchProblem}
        runtime={runtime(state)}
        stopAvailable={
          "stopAvailable" in availability
            ? (availability.stopAvailable ?? null)
            : true
        }
        stopProblem={availability.stopProblem}
        targetLabel="Primary"
        terminal={{
          ...terminal,
          status: state === "running" ? "running" : "exited",
        }}
      />
    </QueryClientProvider>,
  );
}

function renderedButton(markup: string, label: string): string {
  const button = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
    .map(([value]) => value)
    .find((value) => value.includes(label));
  if (!button) throw new Error(`Expected a ${label} button.`);
  return button;
}

describe("Run terminal surface", () => {
  it("exposes a read-only output host with no input element or editable path", () => {
    const markup = renderToStaticMarkup(
      <RunTerminalOutput output="ready\r\n" />,
    );
    expect(markup).toContain('data-run-terminal-readonly="true"');
    expect(markup).not.toMatch(/<(?:input|textarea)\b/iu);
    expect(markup).not.toContain("contenteditable");
  });

  it("shows live output controls only while active", () => {
    const running = renderView("running", true);
    const exited = renderView("exited", true);

    expect(running).toContain('data-run-terminal-readonly="true"');
    expect(running).toContain("Restart");
    expect(running).toContain("Stop");
    expect(exited).not.toContain("data-run-terminal-readonly");
    expect(exited).toContain("Exited with code 0");
    expect(exited).toContain("Start");
  });

  it("disables restart after external definition deletion but keeps stop", () => {
    const markup = renderView("running", false);
    expect(markup).toContain("Restart is disabled");
    expect(renderedButton(markup, "Restart")).toContain("disabled=");
    expect(renderedButton(markup, "Stop")).not.toContain("disabled=");
  });

  it("blocks an unavailable idle target with its actionable reason", () => {
    const markup = renderView("exited", true, {
      launchAvailable: false,
      launchProblem: "Worker is offline.",
      stopAvailable: false,
      stopProblem: "Worker is offline.",
    });
    expect(markup).toContain("Run is unavailable: Worker is offline.");
    expect(renderedButton(markup, "Start")).toContain("disabled=");
  });

  it("keeps idle launch disabled while target availability reloads", () => {
    const markup = renderView("exited", true, { launchAvailable: null });
    expect(markup).toContain("Checking target availability…");
    expect(renderedButton(markup, "Start")).toContain("disabled=");
  });

  it("blocks restart but preserves stop for an invalid captured generation", () => {
    const markup = renderView("running", true, {
      launchAvailable: false,
      launchProblem: "Run configuration is invalid: Target missing.",
      stopAvailable: true,
    });
    expect(markup).toContain(
      "Restart is disabled: Run configuration is invalid: Target missing.",
    );
    expect(renderedButton(markup, "Restart")).toContain("disabled=");
    expect(renderedButton(markup, "Stop")).not.toContain("disabled=");
  });

  it("blocks both active controls when the target worker is offline", () => {
    const markup = renderView("running", true, {
      launchAvailable: false,
      launchProblem: "Worker is offline.",
      stopAvailable: false,
      stopProblem: "Worker is offline.",
    });
    expect(markup).toContain(
      "Restart and Stop are disabled: Worker is offline.",
    );
    expect(renderedButton(markup, "Restart")).toContain("disabled=");
    expect(renderedButton(markup, "Stop")).toContain("disabled=");
  });
});
