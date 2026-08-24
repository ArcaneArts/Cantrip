import type { RunConfigurationDetectionCandidate } from "@cantrip/protocol/run-configuration-definitions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createNodeRunConfigurationDocument } from "@/lib/run-configuration-editor-model";

import { RunConfigurationTargetPickerList } from "./run-configuration-target-picker";

const current = createNodeRunConfigurationDocument(
  "00000000-0000-4000-8000-000000000031",
);
current.name = "Run web";
current.target = { kind: "packageScript", script: "dev" };
current.options.packageManager = "pnpm";

const alternate = createNodeRunConfigurationDocument(
  "00000000-0000-4000-8000-000000000032",
);
alternate.name = "Run API";
alternate.workingDirectory = "packages/api";
alternate.target = { kind: "entry", path: "packages/api/server.js" };
alternate.options.packageManager = "pnpm";

const candidates: RunConfigurationDetectionCandidate[] = [
  {
    provider: "node",
    confidence: "high",
    reason: "The root package defines the dev script.",
    effectiveCommand: "pnpm run dev",
    document: current,
  },
  {
    provider: "node",
    confidence: "medium",
    reason: "The API package declares server.js as an entrypoint.",
    effectiveCommand: "node packages/api/server.js",
    document: alternate,
  },
];

describe("Run configuration target picker", () => {
  it("renders searchable worker candidates with target, path, confidence, and command context", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationTargetPickerList
        candidates={candidates}
        current={current}
        diagnostics={[]}
        error={null}
        fetching={false}
        onChoose={vi.fn()}
      />,
    );

    expect(html).toContain("Search targets, commands, and paths");
    expect(html).toContain("Package script: dev");
    expect(html).toContain("Entrypoint: packages/api/server.js");
    expect(html).toContain("pnpm run dev");
    expect(html).toContain("packages/api");
    expect(html).toContain("medium");
    expect(html).toContain("text-emerald-600");
  });

  it("shows bounded discovery progress and diagnostics", () => {
    const loading = renderToStaticMarkup(
      <RunConfigurationTargetPickerList
        candidates={[]}
        current={current}
        diagnostics={[]}
        error={null}
        fetching
        onChoose={vi.fn()}
      />,
    );
    expect(loading).toContain("Discovering targets");

    const warning = renderToStaticMarkup(
      <RunConfigurationTargetPickerList
        candidates={[]}
        current={current}
        diagnostics={[
          {
            severity: "warning",
            code: "scan-bounded",
            message: "Only the first bounded targets were inspected.",
            relativePath: null,
            field: "target",
          },
        ]}
        error={null}
        fetching={false}
        onChoose={vi.fn()}
      />,
    );
    expect(warning).toContain("Only the first bounded targets were inspected.");
  });
});
