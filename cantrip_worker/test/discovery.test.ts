import { describe, expect, it } from "vitest";

import {
  assessCodexRuntime,
  CODEX_CORE_METHODS,
  CODEX_OPTIONAL_METHODS,
  discoverCodexVersion,
  parseCodexSemanticVersion,
  parseExperimentalFeaturePage,
  parseInitializeResponse,
} from "../src/codex/discovery.js";

const initialize = {
  experimentalApi: true,
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex_cli_rs/0.146.1",
};

const availableMethods = Object.fromEntries(
  [...CODEX_CORE_METHODS, ...CODEX_OPTIONAL_METHODS].map((method) => [
    method,
    "available" as const,
  ]),
);

describe("Codex runtime discovery", () => {
  it("returns null when the configured binary is unavailable", async () => {
    await expect(
      discoverCodexVersion("/definitely/missing/cantrip-codex"),
    ).resolves.toBeNull();
  });

  it("parses the installed CLI version without depending on its prefix", () => {
    expect(parseCodexSemanticVersion("codex-cli 0.146.1")).toBe("0.146.1");
    expect(parseCodexSemanticVersion("0.146.9")).toBe("0.146.9");
    expect(parseCodexSemanticVersion("development build")).toBeNull();
  });

  it("reports a fully negotiated runtime as compatible", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.146.1",
      initialize,
      methods: availableMethods,
      features: [
        {
          name: "goals",
          stage: "stable",
          enabled: true,
          defaultEnabled: true,
        },
      ],
    });

    expect(report).toMatchObject({
      compatibility: "compatible",
      version: { semantic: "0.146.1" },
      methods: { "turn/start": "available" },
      features: [{ name: "goals", enabled: true }],
      degradedReasons: [],
    });
  });

  it("reports a configured-but-untested runtime as incompatible", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.145.0",
      initialize,
      methods: availableMethods,
    });

    expect(report.compatibility).toBe("incompatible");
    expect(report.degradedReasons.join(" ")).toContain("outside");
  });

  it("reports a missing runtime without claiming capabilities", () => {
    expect(
      assessCodexRuntime({ versionRaw: null, initialize: null }),
    ).toMatchObject({
      compatibility: "missing",
      version: null,
      initialize: null,
      methods: {},
      features: [],
    });
  });

  it("keeps core turns available when an optional method is missing", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.146.1",
      initialize,
      methods: { ...availableMethods, "plugin/list": "unavailable" },
    });

    expect(report.compatibility).toBe("partial");
    expect(report.methods["turn/start"]).toBe("available");
    expect(report.methods["plugin/list"]).toBe("unavailable");
  });

  it("rejects partial discovery when a core method is unavailable", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.146.1",
      initialize,
      methods: { ...availableMethods, "turn/start": "unavailable" },
    });

    expect(report.compatibility).toBe("incompatible");
    expect(report.degradedReasons.join(" ")).toContain("turn/start");
  });

  it("validates generated initialize and feature response shapes", () => {
    expect(
      parseInitializeResponse(
        {
          userAgent: "codex_cli_rs/0.146.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
        true,
      ),
    ).toEqual(initialize);
    expect(
      parseExperimentalFeaturePage({
        data: [
          {
            name: "hooks",
            stage: "stable",
            displayName: null,
            description: null,
            announcement: null,
            enabled: true,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      data: [
        {
          name: "hooks",
          stage: "stable",
          enabled: true,
          defaultEnabled: true,
        },
      ],
      nextCursor: null,
    });
    expect(
      parseExperimentalFeaturePage({
        data: [{ name: "hooks", stage: "future" }],
        nextCursor: null,
      }),
    ).toBeNull();
  });
});
