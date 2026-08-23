import { describe, expect, it } from "vitest";

import {
  assessCodexRuntime,
  CODEX_CORE_METHODS,
  CODEX_CUSTOMIZATION_METHODS,
  CODEX_EXPERIMENTAL_WORKFLOW_METHODS,
  CODEX_OPTIONAL_METHODS,
  codexFeatureUsable,
  codexMethodsAvailable,
  discoverCodexVersion,
  parseCodexSemanticVersion,
  parseExperimentalFeaturePage,
  parseInitializeResponse,
} from "../src/codex/discovery.js";

const initialize = {
  experimentalApi: true,
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex_cli_rs/0.149.0",
};

const availableMethods = Object.fromEntries(
  [...CODEX_CORE_METHODS, ...CODEX_OPTIONAL_METHODS].map((method) => [
    method,
    "available" as const,
  ]),
);

describe("Codex runtime discovery", () => {
  it("probes every native customization capability family without duplicates", () => {
    expect(CODEX_CUSTOMIZATION_METHODS).toMatchObject({
      collaboration: ["collaborationMode/list"],
      goals: ["thread/goal/get", "thread/goal/set", "thread/goal/clear"],
      hooks: ["hooks/list"],
      skills: expect.arrayContaining([
        "skills/list",
        "skills/config/write",
        "skills/extraRoots/set",
      ]),
      mcp: expect.arrayContaining([
        "mcpServerStatus/list",
        "mcpServer/oauth/login",
        "config/mcpServer/reload",
      ]),
      plugins: [
        "plugin/list",
        "plugin/read",
        "plugin/install",
        "plugin/uninstall",
      ],
      externalImports: expect.arrayContaining([
        "externalAgentConfig/detect",
        "externalAgentConfig/import",
      ]),
    });
    expect(CODEX_EXPERIMENTAL_WORKFLOW_METHODS).toEqual({
      diagnostics: ["server/diagnostics"],
      promptQueue: [
        "thread/queue/add",
        "thread/queue/list",
        "thread/queue/update",
        "thread/queue/delete",
        "thread/queue/reorder",
        "thread/queue/start",
      ],
      history: ["thread/revert"],
    });
    expect(new Set(CODEX_OPTIONAL_METHODS).size).toBe(
      CODEX_OPTIONAL_METHODS.length,
    );
  });

  it("requires usable feature stages and every requested method", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.149.0",
      initialize,
      methods: availableMethods,
      features: [
        {
          name: "plugins",
          stage: "stable",
          enabled: true,
          defaultEnabled: true,
        },
        {
          name: "legacy_plugins",
          stage: "removed",
          enabled: true,
          defaultEnabled: false,
        },
      ],
    });

    expect(codexFeatureUsable(report, "plugins")).toBe(true);
    expect(codexFeatureUsable(report, "legacy_plugins")).toBe(false);
    expect(codexFeatureUsable(report, "missing")).toBe(false);
    expect(
      codexMethodsAvailable(report, CODEX_CUSTOMIZATION_METHODS.plugins),
    ).toBe(true);
    expect(codexMethodsAvailable(report, ["plugin/unknown"])).toBe(false);
  });

  it("returns null when the configured binary is unavailable", async () => {
    await expect(
      discoverCodexVersion("/definitely/missing/cantrip-codex"),
    ).resolves.toBeNull();
  });

  it("parses the installed CLI version without depending on its prefix", () => {
    expect(parseCodexSemanticVersion("codex-cli 0.149.0")).toBe("0.149.0");
    expect(parseCodexSemanticVersion("0.149.9")).toBe("0.149.9");
    expect(parseCodexSemanticVersion("development build")).toBeNull();
  });

  it("reports a fully negotiated runtime as compatible", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.149.0",
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
      version: { semantic: "0.149.0" },
      methods: { "turn/start": "available" },
      features: [{ name: "goals", enabled: true }],
      degradedReasons: [],
    });
  });

  it("reports a configured-but-untested runtime as incompatible", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.148.0",
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
      versionRaw: "codex-cli 0.149.0",
      initialize,
      methods: { ...availableMethods, "plugin/list": "unavailable" },
    });

    expect(report.compatibility).toBe("partial");
    expect(report.methods["turn/start"]).toBe("available");
    expect(report.methods["plugin/list"]).toBe("unavailable");
  });

  it("reports one unavailable customization mutation without hiding reads", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.149.0",
      initialize,
      methods: {
        ...availableMethods,
        "skills/config/write": "unavailable",
      },
    });

    expect(report).toMatchObject({
      compatibility: "partial",
      methods: {
        "skills/list": "available",
        "skills/config/write": "unavailable",
      },
    });
    expect(report.degradedReasons.join(" ")).toContain("skills/config/write");
  });

  it("rejects partial discovery when a core method is unavailable", () => {
    const report = assessCodexRuntime({
      versionRaw: "codex-cli 0.149.0",
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
          userAgent: "codex_cli_rs/0.149.0",
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
