import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";

import {
  codexRuntimeReportSchema,
  NATIVE_SUBAGENT_PROTOCOL_VERSION,
  type CodexRuntimeFeature,
  type CodexRuntimeMethodState,
  type CodexRuntimeReport,
} from "@cantrip/protocol";

import {
  initializeCodexRpcClient,
  spawnCodexRpcClient,
  type CodexRpcClient,
} from "./rpc-client.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

export const TESTED_CODEX_RANGE = ">=0.153.0 <0.154.0";

export function nativeSubagentCapabilityForRuntime(input: {
  compatible: boolean;
  features: CodexRuntimeFeature[];
}) {
  const stableFeature = input.features.find(
    ({ name, stage }) => name === "multi_agent" && stage === "stable",
  );
  const available = input.compatible && Boolean(stableFeature);
  return {
    available,
    protocolVersion: available ? NATIVE_SUBAGENT_PROTOCOL_VERSION : null,
    reason: available
      ? null
      : input.compatible
        ? "The installed Codex runtime does not advertise stable native multi-agent support."
        : "The installed Codex runtime is not compatible with native subagents.",
  } as const;
}

export const CODEX_CORE_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/list",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const;

export const CODEX_CUSTOMIZATION_METHODS = {
  collaboration: ["collaborationMode/list"],
  goals: ["thread/goal/get", "thread/goal/set", "thread/goal/clear"],
  hooks: ["hooks/list"],
  skills: ["skills/list", "skills/config/write", "skills/extraRoots/set"],
  mcp: [
    "mcpServerStatus/list",
    "mcpServer/oauth/login",
    "mcpServer/resource/read",
    "config/mcpServer/reload",
  ],
  plugins: ["plugin/list", "plugin/read", "plugin/install", "plugin/uninstall"],
  externalImports: [
    "externalAgentConfig/detect",
    "externalAgentConfig/import",
    "externalAgentConfig/import/readHistories",
    "externalAgentConfig/import/recordHistory",
  ],
  configuration: ["config/read"],
} as const;

export const CODEX_EXPERIMENTAL_WORKFLOW_METHODS = {
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
} as const;

export const CODEX_OPTIONAL_METHODS = [
  "account/login/start",
  "thread/compact/start",
  "model/list",
  "experimentalFeature/list",
  "permissionProfile/list",
  "app/list",
  ...Object.values(CODEX_CUSTOMIZATION_METHODS).flat(),
  ...Object.values(CODEX_EXPERIMENTAL_WORKFLOW_METHODS).flat(),
] as const;

const PROBED_METHODS = [...CODEX_CORE_METHODS, ...CODEX_OPTIONAL_METHODS];
const FEATURE_STAGES = new Set<CodexRuntimeFeature["stage"]>([
  "beta",
  "underDevelopment",
  "stable",
  "deprecated",
  "removed",
]);

interface ProbeInitialize {
  experimentalApi: boolean;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
}

interface RuntimeAssessmentInput {
  versionRaw: string | null;
  initialize: ProbeInitialize | null;
  methods?: Record<string, CodexRuntimeMethodState>;
  features?: CodexRuntimeFeature[];
  errors?: string[];
}

export function codexMethodsAvailable(
  report: CodexRuntimeReport,
  methods: readonly string[],
): boolean {
  return methods.every((method) => report.methods[method] === "available");
}

export function codexFeatureUsable(
  report: CodexRuntimeReport,
  name: string,
): boolean {
  const feature = report.features.find((candidate) => candidate.name === name);
  return Boolean(
    feature?.enabled &&
    feature.stage !== "deprecated" &&
    feature.stage !== "removed",
  );
}

interface FeaturePage {
  data: CodexRuntimeFeature[];
  nextCursor: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseCodexSemanticVersion(raw: string): string | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/u.exec(raw.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function isTestedCodexVersion(semantic: string): boolean {
  const [major, minor, patch, extra] = semantic.split(".").map(Number);
  return (
    extra === undefined &&
    major === 0 &&
    minor === 153 &&
    patch !== undefined &&
    Number.isInteger(patch) &&
    patch >= 0
  );
}

export function parseInitializeResponse(
  value: unknown,
  experimentalApi: boolean,
): ProbeInitialize | null {
  const candidate = objectValue(value);
  if (
    !candidate ||
    typeof candidate.userAgent !== "string" ||
    candidate.userAgent.length === 0 ||
    typeof candidate.platformFamily !== "string" ||
    candidate.platformFamily.length === 0 ||
    typeof candidate.platformOs !== "string" ||
    candidate.platformOs.length === 0
  ) {
    return null;
  }
  return {
    userAgent: candidate.userAgent,
    platformFamily: candidate.platformFamily,
    platformOs: candidate.platformOs,
    experimentalApi,
  };
}

export function parseExperimentalFeaturePage(
  value: unknown,
): FeaturePage | null {
  const candidate = objectValue(value);
  if (
    !candidate ||
    !Array.isArray(candidate.data) ||
    !(candidate.nextCursor === null || typeof candidate.nextCursor === "string")
  ) {
    return null;
  }
  const data: CodexRuntimeFeature[] = [];
  for (const value of candidate.data) {
    const feature = objectValue(value);
    if (
      !feature ||
      typeof feature.name !== "string" ||
      feature.name.length === 0 ||
      typeof feature.stage !== "string" ||
      !FEATURE_STAGES.has(feature.stage as CodexRuntimeFeature["stage"]) ||
      typeof feature.enabled !== "boolean" ||
      typeof feature.defaultEnabled !== "boolean"
    ) {
      return null;
    }
    data.push({
      name: feature.name,
      stage: feature.stage as CodexRuntimeFeature["stage"],
      enabled: feature.enabled,
      defaultEnabled: feature.defaultEnabled,
    });
  }
  return {
    data,
    nextCursor: candidate.nextCursor as string | null,
  };
}

export function assessCodexRuntime(
  input: RuntimeAssessmentInput,
): CodexRuntimeReport {
  if (!input.versionRaw) {
    return codexRuntimeReportSchema.parse({
      adapter: "app-server",
      compatibility: "missing",
      version: null,
      testedRange: TESTED_CODEX_RANGE,
      initialize: null,
      methods: {},
      features: [],
      degradedReasons: [
        "The configured Codex binary was not found or did not report a version.",
      ],
    });
  }

  const semantic = parseCodexSemanticVersion(input.versionRaw);
  const methods = Object.fromEntries(
    PROBED_METHODS.map((method) => [
      method,
      input.methods?.[method] ?? "unknown",
    ]),
  );
  const reasons = [...(input.errors ?? [])];
  if (!semantic) {
    reasons.unshift(
      `Could not parse a semantic version from ${JSON.stringify(input.versionRaw)}.`,
    );
  } else if (!isTestedCodexVersion(semantic)) {
    reasons.unshift(
      `Codex ${semantic} is outside Cantrip's tested range ${TESTED_CODEX_RANGE}.`,
    );
  }
  if (!input.initialize) {
    reasons.push(
      "Codex app-server did not complete a valid initialize handshake.",
    );
  }
  const unavailableCore = CODEX_CORE_METHODS.filter(
    (method) => methods[method] !== "available",
  );
  if (unavailableCore.length > 0) {
    reasons.push(
      `Required App Server methods are unavailable or unverified: ${unavailableCore.join(", ")}.`,
    );
  }
  const unavailableOptional = CODEX_OPTIONAL_METHODS.filter(
    (method) => methods[method] !== "available",
  );
  if (unavailableOptional.length > 0) {
    reasons.push(
      `Optional App Server methods are unavailable or unverified: ${unavailableOptional.join(", ")}.`,
    );
  }
  if (input.initialize && !input.initialize.experimentalApi) {
    reasons.push(
      "The runtime initialized without the experimental API capability.",
    );
  }

  const incompatible =
    !semantic ||
    !isTestedCodexVersion(semantic) ||
    !input.initialize ||
    unavailableCore.length > 0;
  const partial =
    !incompatible &&
    (unavailableOptional.length > 0 || !input.initialize?.experimentalApi);
  const features = [...(input.features ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return codexRuntimeReportSchema.parse({
    adapter: "app-server",
    compatibility: incompatible
      ? "incompatible"
      : partial
        ? "partial"
        : "compatible",
    version: semantic ? { raw: input.versionRaw, semantic } : null,
    testedRange: TESTED_CODEX_RANGE,
    initialize: input.initialize,
    methods,
    features,
    nativeSubagents: nativeSubagentCapabilityForRuntime({
      compatible: !incompatible,
      features,
    }),
    degradedReasons: [...new Set(reasons)],
  });
}

export async function discoverCodexVersion(
  binary: string,
): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
      timeout: 5_000,
    });
    const version = `${stdout}${stderr}`.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

async function initializeProbe(
  probe: CodexRpcClient,
  experimentalApi: boolean,
): Promise<{ initialize: ProbeInitialize | null; error: string | null }> {
  let result: unknown;
  try {
    result = await initializeCodexRpcClient(probe, {
      name: "cantrip_compatibility_probe",
      title: "Cantrip Compatibility Probe",
      version: "0.0.0",
      experimentalApi,
    });
  } catch (error) {
    return {
      initialize: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const initialize = parseInitializeResponse(result, experimentalApi);
  if (!initialize) {
    return {
      initialize: null,
      error: "Codex returned an invalid initialize response.",
    };
  }
  return { initialize, error: null };
}

async function probeFeaturePages(probe: CodexRpcClient): Promise<{
  features: CodexRuntimeFeature[];
  state: CodexRuntimeMethodState;
  errors: string[];
}> {
  const features: CodexRuntimeFeature[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const response = await probe.request("experimentalFeature/list", {
      cursor,
      limit: 100,
    });
    if (response.error) {
      if (response.error.code !== -32601) errors.push(response.error.message);
      return {
        features,
        state: response.error.code === -32601 ? "unavailable" : "unknown",
        errors,
      };
    }
    const page = parseExperimentalFeaturePage(response.result);
    if (!page) {
      errors.push(
        "Codex returned an invalid experimentalFeature/list response.",
      );
      return { features, state: "unknown", errors };
    }
    features.push(...page.data);
    cursor = page.nextCursor;
    if (!cursor) return { features, state: "available", errors };
  }
  errors.push("Codex feature discovery exceeded the 20-page safety limit.");
  return { features, state: "unknown", errors };
}

async function runCapabilityProbe(
  binary: string,
  codexHome: string,
  experimentalApi: boolean,
): Promise<{
  initialize: ProbeInitialize | null;
  methods: Record<string, CodexRuntimeMethodState>;
  features: CodexRuntimeFeature[];
  errors: string[];
}> {
  const probe = spawnCodexRpcClient(binary, codexHome, {
    requestTimeoutMs: PROBE_TIMEOUT_MS,
  });
  try {
    const initialized = await initializeProbe(probe, experimentalApi);
    if (!initialized.initialize) {
      return {
        initialize: null,
        methods: {},
        features: [],
        errors: initialized.error ? [initialized.error] : [],
      };
    }
    const methods: Record<string, CodexRuntimeMethodState> = {
      initialize: "available",
    };
    const featureProbe = experimentalApi
      ? await probeFeaturePages(probe)
      : { features: [], state: "unavailable" as const, errors: [] };
    methods["experimentalFeature/list"] = featureProbe.state;
    for (const method of PROBED_METHODS) {
      if (method === "initialize" || method === "experimentalFeature/list") {
        continue;
      }
      try {
        const response = await probe.request(method, false);
        methods[method] =
          response.error?.code === -32601 ? "unavailable" : "available";
      } catch (error) {
        methods[method] = "unknown";
        featureProbe.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return {
      initialize: initialized.initialize,
      methods,
      features: featureProbe.features,
      errors: featureProbe.errors,
    };
  } finally {
    probe.close();
  }
}

export async function discoverCodexRuntime(
  binary: string,
  codexHome: string,
): Promise<CodexRuntimeReport> {
  const versionRaw = await discoverCodexVersion(binary);
  if (!versionRaw) {
    return assessCodexRuntime({ versionRaw: null, initialize: null });
  }
  await mkdir(codexHome, { recursive: true });
  try {
    let probe = await runCapabilityProbe(binary, codexHome, true);
    if (!probe.initialize) {
      const stableProbe = await runCapabilityProbe(binary, codexHome, false);
      probe = {
        ...stableProbe,
        errors: [...probe.errors, ...stableProbe.errors],
      };
    }
    return assessCodexRuntime({ versionRaw, ...probe });
  } catch (error) {
    return assessCodexRuntime({
      versionRaw,
      initialize: null,
      errors: [error instanceof Error ? error.message : String(error)],
    });
  }
}
