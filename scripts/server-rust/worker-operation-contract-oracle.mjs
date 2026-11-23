// Execute Source's exact schemas and error rendering, including custom checks.
import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
const project = "11111111-1111-4111-8111-000000000001";
const samples = {
  cantripVersionSchema: [{ major: 1, minor: 2, patch: 3, version: "1.2.3" }],
  codeGraphActionAcknowledgementSchema: [
    {
      jobId: project,
      action: "sync",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      status: "queued",
    },
  ],
  managedWebRuntimeActionRequestSchema: [
    { component: "playwright", action: "retry" },
  ],
  managedWebRuntimeActionResultSchema: [
    {
      accepted: true,
      component: "playwright",
      action: "retry",
      status: p.unavailableManagedWebRuntimeCapabilities.browser,
    },
  ],
  codeGraphProjectStatusSchema: [
    {
      projectId: project,
      worktreeId: "source-main",
      state: "ready",
      lastIndexedAt: null,
      lastSuccessfulSyncAt: null,
      fileCount: null,
      nodeCount: null,
      edgeCount: null,
      pendingChanges: null,
      statusMessage: null,
      job: null,
    },
  ],
};
const name = process.argv[2],
  cases = [...vectorCases(name, samples[name])];
function add(input) {
  input = JSON.parse(JSON.stringify(input));
  const result = outcome(p[name], input);
  cases.push({
    input,
    outcome: result,
    ...(result.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
}
if (name === "cantripVersionSchema") {
  for (const number of [
    -0,
    0,
    1,
    999999,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    0.5,
  ])
    for (const version of [
      `${number}.0.0`,
      "01.0.0",
      "1.2.3",
      "1.2.3\n",
      "1.2.3\u2028",
      "1.2.3\u2029",
      "١.٢.٣",
      "1.2.3-beta",
      "",
    ])
      add({ major: number, minor: 0, patch: 0, version, unknown: true });
}
if (name === "managedWebRuntimeActionRequestSchema")
  for (const component of ["playwright", "searxng", "unknown", null])
    for (const action of [
      "check-update",
      "retry",
      "reinstall",
      "clear-cache",
      "clear-profiles",
      "unknown",
      null,
    ]) {
      add({ component, action });
      add({ component, action, unknown: true });
    }
if (name === "managedWebRuntimeActionResultSchema") {
  // Source validates both fields independently; do not invent a pairing check.
  add({ ...samples[name][0], component: "searxng" });
  add({ ...samples[name][0], unknown: true });
}
console.log(JSON.stringify({ cases }));
