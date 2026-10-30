import * as p from "../../packages/protocol/dist/index.js";
import { projectLabel } from "./security-fixtures.mjs";
import { discoveryWireFixtures } from "./discovery-wire-fixtures.mjs";
import { vectorCases, outcome } from "./security-oracle.mjs";
const name = process.argv[2],
  samples = discoveryWireFixtures(projectLabel);
const cases = [...vectorCases(name, samples[name])];
const add = (input) => {
  const value = outcome(p[name], input);
  cases.push({
    input,
    outcome: value,
    ...(value.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
};
if (
  [
    "workspaceRepositoryCandidateSummarySchema",
    "workspaceRepositoryImportValidationResultSchema",
    "workspaceRepositoryDiscoveryWorkerResultSchema",
  ].includes(name)
) {
  const base = samples[name][0];
  for (const classification of [
    "unclassified",
    "local-git",
    "github-accessible",
    "github-unavailable",
    "unsupported",
  ])
    for (const diagnosticCode of [
      null,
      "bare-repository",
      "origin-unavailable",
    ])
      for (const hasGithub of [false, true])
        for (const hasOrigin of [false, true]) {
          const value = structuredClone(base);
          const candidate = value.candidates ? value.candidates[0] : value;
          candidate.classification = classification;
          candidate.diagnosticCode = diagnosticCode;
          const handle = "ctrr_" + "A".repeat(43);
          candidate.github = hasGithub
            ? { repositoryId: handle, nameWithOwner: handle, url: handle }
            : null;
          candidate[
            name === "workspaceRepositoryCandidateSummarySchema"
              ? "originUrlHandle"
              : "originUrl"
          ] = hasOrigin ? handle : null;
          add(value);
        }
}
if (name === "workspaceRepositoryCandidateSummarySchema") {
  for (const importState of [
    "pending",
    "queued",
    "importing",
    "imported",
    "blocked",
    "failed",
    "skipped",
  ])
    for (const importError of [
      null,
      { code: "worker-offline", retryable: true },
    ])
      for (const projectId of [null, samples[name][0].id])
        add({ ...samples[name][0], importState, importError, projectId });
}
console.log(JSON.stringify({ schema: name, cases }));
