import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir } from "node:fs/promises";
import readline from "node:readline";
import { promisify } from "node:util";

import {
  codexRuntimeReportSchema,
  type CodexRuntimeFeature,
  type CodexRuntimeMethodState,
  type CodexRuntimeReport,
} from "@cantrip/protocol";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

export const TESTED_CODEX_RANGE = ">=0.146.0 <0.147.0";

export const CODEX_CORE_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
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

export const CODEX_OPTIONAL_METHODS = [
  "thread/compact/start",
  "model/list",
  "experimentalFeature/list",
  "permissionProfile/list",
  "app/list",
  ...Object.values(CODEX_CUSTOMIZATION_METHODS).flat(),
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

interface RpcError {
  code: number;
  message: string;
}

interface RpcResponse {
  error?: RpcError;
  id: number;
  result?: unknown;
}

interface PendingProbeRequest {
  reject(error: Error): void;
  resolve(response: RpcResponse): void;
  timeout: ReturnType<typeof setTimeout>;
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
    minor === 146 &&
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
    features: [...(input.features ?? [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
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

class AppServerProbe {
  readonly #pending = new Map<number, PendingProbeRequest>();
  #nextId = 1;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", (error) => this.rejectAll(error));
    child.once("exit", (code, signal) =>
      this.rejectAll(
        new Error(
          `Codex app-server probe exited (${signal ?? `code ${String(code)}`}).`,
        ),
      ),
    );
  }

  request(method: string, params: unknown): Promise<RpcResponse> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex capability probe ${method} timed out.`));
      }, PROBE_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  close(): void {
    this.rejectAll(new Error("Codex app-server probe closed."));
    this.child.kill("SIGINT");
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const message = objectValue(value);
    if (!message || typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    const error = objectValue(message.error);
    pending.resolve({
      id: message.id,
      result: message.result,
      ...(error &&
      typeof error.code === "number" &&
      typeof error.message === "string"
        ? { error: { code: error.code, message: error.message } }
        : {}),
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function spawnProbe(binary: string, codexHome: string): AppServerProbe {
  return new AppServerProbe(
    spawn(binary, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

async function initializeProbe(
  probe: AppServerProbe,
  experimentalApi: boolean,
): Promise<{ initialize: ProbeInitialize | null; error: string | null }> {
  const response = await probe.request("initialize", {
    clientInfo: {
      name: "cantrip_compatibility_probe",
      title: "Cantrip Compatibility Probe",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi,
      requestAttestation: false,
    },
  });
  if (response.error) {
    return { initialize: null, error: response.error.message };
  }
  const initialize = parseInitializeResponse(response.result, experimentalApi);
  if (!initialize) {
    return {
      initialize: null,
      error: "Codex returned an invalid initialize response.",
    };
  }
  probe.notify("initialized", {});
  return { initialize, error: null };
}

async function probeFeaturePages(probe: AppServerProbe): Promise<{
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
  const probe = spawnProbe(binary, codexHome);
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
