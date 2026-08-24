import type { RunConfigurationProviderValidation } from "@cantrip/protocol/run-configuration-definitions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RunConfigurationValidationStatus } from "./run-configuration-validation-status";

const validation: RunConfigurationProviderValidation = {
  configurationId: "00000000-0000-4000-8000-000000000051",
  provider: "rust",
  platform: "darwin",
  effectiveCommand: "cargo run --package api --bin server",
  valid: true,
  diagnostics: [],
};

describe("Run configuration validation status", () => {
  it("shows local and pending states without stale worker results", () => {
    const local = renderToStaticMarkup(
      <RunConfigurationValidationStatus
        error={null}
        localErrors={[
          "target.name: String must contain at least 1 character(s)",
        ]}
        onRediscover={null}
        onRetry={vi.fn()}
        pending={false}
        validation={null}
      />,
    );
    expect(local).toContain("Finish the draft to validate it on Primary");
    expect(local).toContain("target.name");

    const pending = renderToStaticMarkup(
      <RunConfigurationValidationStatus
        error={null}
        localErrors={[]}
        onRediscover={null}
        onRetry={vi.fn()}
        pending
        validation={null}
      />,
    );
    expect(pending).toContain("Validating this draft on Primary");
  });

  it("shows the validated worker platform", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationValidationStatus
        error={null}
        localErrors={[]}
        onRediscover={null}
        onRetry={vi.fn()}
        pending={false}
        validation={validation}
      />,
    );
    expect(html).toContain("Validated on Primary for macOS");
    expect(html).toContain("text-emerald-700");
  });

  it("renders missing-target diagnostics with rediscovery", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationValidationStatus
        error={null}
        localErrors={[]}
        onRediscover={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        validation={{
          ...validation,
          valid: false,
          diagnostics: [
            {
              severity: "error",
              code: "cargo-target-missing",
              message: "Cargo package api no longer contains binary server.",
              relativePath: "Cargo.toml",
              field: "target.name",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Primary cannot run this target on macOS");
    expect(html).toContain(
      "Cargo package api no longer contains binary server.",
    );
    expect(html).toContain("target.name");
    expect(html).toContain("Rediscover target");
  });

  it("explains when Primary validation is unavailable", () => {
    const html = renderToStaticMarkup(
      <RunConfigurationValidationStatus
        error={new Error("offline")}
        localErrors={[]}
        onRediscover={null}
        onRetry={vi.fn()}
        pending={false}
        validation={null}
      />,
    );
    expect(html).toContain("Primary could not validate this draft");
    expect(html).toContain("Retry validation");
    expect(html).toContain('role="alert"');
  });
});
