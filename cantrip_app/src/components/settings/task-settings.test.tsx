import { settingsBundleSchema } from "@cantrip/protocol";
import { taskWorkerSummarySchema } from "@cantrip/protocol/task-scheduling";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskSettings, taskWorkerCapabilityLabel } from "./task-settings";

const settings = settingsBundleSchema.parse({
  preferences: {
    theme: "system",
    highContrast: false,
    proMode: false,
    proModeOpacity: 80,
    sidebarWidth: 288,
    desktopFrameRate: 30,
    desktopStreamQuality: "adaptive",
    defaultModelId: "model-grok",
  },
  providers: [
    {
      id: "provider-grok",
      name: "Grok",
      kind: "grok",
      baseUrl: "https://api.x.ai/v1",
      hasApiKey: false,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
  ],
  models: [
    {
      id: "model-grok",
      name: "Grok 4.6",
      canonicalModelId: "grok-4.6",
      routingPolicy: "priority",
      routes: [
        {
          id: "route-grok",
          providerId: "provider-grok",
          providerName: "Grok",
          modelName: "grok-4.6",
          enabled: true,
          position: 0,
        },
      ],
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
  ],
});

const worker = taskWorkerSummarySchema.parse({
  id: "00000000-0000-4000-8000-000000000401",
  name: "Primary Tasks",
  enabled: true,
  modelConfiguration: {
    modelId: "model-grok",
    reasoningEffort: "xhigh",
  },
  maxConcurrency: 4,
  allowsPlanGoal: true,
  continuityFamily: "grok",
  continuityFamilyOverride: null,
  position: 0,
  activeTaskCount: 2,
  rowVersion: 1,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
});

function renderTaskSettings(workers: TaskWorkerSummary[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["settings"], settings);
  queryClient.setQueryData(["task-workers"], workers);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <TaskSettings />
    </QueryClientProvider>,
  );
}

type TaskWorkerSummary = typeof worker;

describe("Task Worker settings", () => {
  it("keeps Task execution inert until the user adds a worker", () => {
    const markup = renderTaskSettings();
    expect(markup).toContain("No Task Workers configured");
    expect(markup).toContain("Task queues remain idle");
    expect(markup).toContain("Add Task Worker");
  });

  it("shows configured order, capability, and global capacity", () => {
    const markup = renderTaskSettings([worker]);
    expect(markup).toContain('aria-label="Edit Primary Tasks"');
    expect(markup).toContain("Grok 4.6 · xhigh");
    expect(markup).toContain("Direct + Plan + Goal");
    expect(markup).toContain("2/4 active");
    expect(markup).toContain('aria-label="Move Primary Tasks up"');
    expect(taskWorkerCapabilityLabel(worker)).toBe("Direct + Plan + Goal");
  });
});
