// Actual Node algorithms and filesystem contracts; all paths belong to caller.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as reference from "../../tests/reference-node-worker/src/codex/discovery.ts";
import { codexRpcExitMessage } from "../../tests/reference-node-worker/src/codex/rpc-client.ts";
import { redactCodexDiagnosticPayload } from "../../tests/reference-node-worker/src/codex/diagnostic-redaction.ts";
import { verifyCodexInstallation } from "../../tests/reference-node-worker/src/codex/bundled-runtime.ts";
export async function verifyPure({ native, same, root }) {
  same(
    await native({ op: "methods" }),
    {
      core: [...reference.CODEX_CORE_METHODS],
      optional: [...reference.CODEX_OPTIONAL_METHODS],
    },
    "authoritative method lists",
  );
  for (const value of [
    "codex-cli 0.166.0",
    " v0.166.0",
    "0.166.1-beta+build",
    "prefix\n0.166.2 suffix",
    "00.0166.000",
    "0.165.99",
    "1.166.0",
    "0.166.0.0",
    "0.166",
    "0.166.",
    "0.166.0x2",
    "0.166.-0",
    "０.166.0",
    "0.166.9999999999999999999999999999999999",
    "\ud800 0.166.0",
  ]) {
    same(
      await native({ op: "semantic", value }),
      reference.parseCodexSemanticVersion(value),
      "semantic extraction",
    );
    same(
      await native({ op: "tested", value }),
      reference.isTestedCodexVersion(value),
      "tested minor and coercion",
    );
  }
  const initialize = {
    userAgent: "fixture",
    platformFamily: "unix",
    platformOs: "macos",
    experimentalApi: true,
  };
  for (const value of [
    null,
    {},
    { ...initialize, userAgent: "" },
    { ...initialize, platformOs: [] },
    initialize,
  ])
    same(
      await native({ op: "initialize", value, experimental: true }),
      reference.parseInitializeResponse(value, true),
      "initialize validation",
    );
  const stable = {
    name: "multi_agent",
    stage: "stable",
    enabled: false,
    defaultEnabled: false,
  };
  for (const value of [
    null,
    {},
    { data: [], nextCursor: null },
    { data: [stable], nextCursor: "next" },
    { data: [{ ...stable, stage: "other" }], nextCursor: null },
    { data: [stable] },
  ])
    same(
      await native({ op: "features", value }),
      reference.parseExperimentalFeaturePage(value),
      "feature page validation",
    );
  const methods = Object.fromEntries(
    [...reference.CODEX_CORE_METHODS, ...reference.CODEX_OPTIONAL_METHODS].map(
      (method) => [method, "available"],
    ),
  );
  for (const value of [
    { versionRaw: null, initialize: null },
    { versionRaw: "unparseable", initialize: null, errors: ["same", "same"] },
    { versionRaw: "codex-cli 0.165.9", initialize, methods },
    {
      versionRaw: "codex-cli 0.166.0",
      initialize,
      methods,
      features: [stable],
    },
    {
      versionRaw: "codex-cli 0.166.0",
      initialize: { ...initialize, experimentalApi: false },
      methods,
    },
    {
      versionRaw: "codex-cli 0.166.0",
      initialize,
      methods: {
        ...methods,
        "thread/start": "unknown",
        "plugin/list": "unavailable",
      },
      features: [stable],
    },
    {
      versionRaw: "codex-cli 0.166.0",
      initialize,
      methods,
      features: [
        { ...stable, name: "z" },
        { ...stable, name: "ä" },
        { ...stable, name: "A" },
        stable,
      ],
    },
  ]) {
    const report = reference.assessCodexRuntime(value);
    same(
      await native({ op: "assess", value }),
      report,
      "runtime compatibility assessment",
    );
    same(
      await native({
        op: "methods.available",
        report,
        methods: ["thread/start", "plugin/list"],
      }),
      reference.codexMethodsAvailable(report, ["thread/start", "plugin/list"]),
      "method availability",
    );
    same(
      await native({ op: "feature.usable", report, value: "multi_agent" }),
      reference.codexFeatureUsable(report, "multi_agent"),
      "enabled usable feature",
    );
  }
  for (const tail of [
    "",
    "one\r\nlast\r\n",
    "\u001b[31merror\u001b[0m",
    "\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u001b\\",
    'fatal: OPENAI_API_KEY="private-key" Bearer hidden https://user:password@example.invalid --token=secret',
    "emoji😀".repeat(500),
  ])
    same(
      await native({ op: "exit", status: "code 1", tail }),
      codexRpcExitMessage(1, null, tail),
      "bounded redacted final stderr line",
    );
  const privateValue = {
    Token: "private",
    "ACCESS-TOKEN": "private",
    credentialEnvelope: { token: "private" },
    plain: "Bearer hidden custom-secret",
    extra: ["custom-secret", { safe: "okay" }],
  };
  same(
    await native({
      op: "redact",
      value: privateValue,
      secrets: ["custom-secret", ""],
    }),
    redactCodexDiagnosticPayload(privateValue, new Set(["custom-secret", ""])),
    "structured and explicit-secret redaction",
  );
  let deep = "leaf";
  for (let i = 0; i < 23; i++) deep = { nested: deep };
  same(
    await native({ op: "redact", value: deep }),
    redactCodexDiagnosticPayload(deep),
    "diagnostic depth limit",
  );

  const bundle = path.join(root, "bundle");
  await mkdir(bundle);
  const binary = path.join(bundle, "codex"),
    manifestPath = path.join(bundle, "codex-runtime.json");
  await writeFile(binary, "owned fixture artifact");
  const base = {
    schemaVersion: 1,
    component: "codex-cli",
    version: "0.166.0",
    upstream: {
      repository: "https://example.invalid/codex",
      ref: "fixture",
      commit: "a".repeat(40),
    },
    buildRecipeVersion: 6,
    skillTemplatesSha256: "b".repeat(64),
    entrypoint: "codex",
    artifacts: [
      { path: "codex", sha256: "not enforced by reference verifier" },
    ],
    target: "darwin-arm64",
    profile: "release",
  };
  const install = { binary, manifestPath, source: "bundle" };
  for (const patch of [
    {},
    { schemaVersion: 2 },
    { entrypoint: "../codex" },
    { artifacts: [] },
    { artifacts: [{ path: "codex" }, { path: "codex" }] },
    { buildRecipeVersion: 7 },
    { skillTemplatesSha256: "missing" },
    { target: "linux-arm64" },
    { artifacts: [{ path: "codex" }, { path: "absent" }] },
  ]) {
    await writeFile(manifestPath, JSON.stringify({ ...base, ...patch }));
    let expected;
    try {
      expected = {
        ok: true,
        value: await verifyCodexInstallation(install, "darwin", "arm64"),
      };
    } catch (error) {
      expected = { ok: false, error: error.message };
    }
    same(
      await native(
        {
          op: "verify",
          ...install,
          cwd: root,
          platform: "darwin",
          architecture: "arm64",
        },
        true,
      ),
      expected,
      "actual manifest contract",
    );
  }
  same(
    await native({ op: "verify", binary, manifestPath: null, cwd: root }),
    null,
    "unmanaged installation verification",
  );
  assert.equal(
    reference.nativeSubagentCapabilityForRuntime({
      compatible: true,
      features: [stable],
    }).available,
    true,
    "reference availability uses stable capability independent of enabled flag",
  );
}
