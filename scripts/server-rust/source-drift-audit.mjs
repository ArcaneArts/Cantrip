// Build the current TypeScript protocol before this read-only development audit.
// Paired source edits and equal generated schemas do not prove runtime parity.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import * as protocol from "../../packages/protocol/dist/index.js";
import {
  buildContractManifest,
  runMcpContractRoots,
  surfaceMcpContractRoots,
  cliContractRoots,
  projectExportContractRoots,
  chatAttachmentContractRoots,
  workerManagementContractRoots,
  workerOperationContractRoots,
  projectAdministrationContractRoots,
  chatControlContractRoots,
  operationalStatusContractRoots,
  workerLogContractRoots,
} from "./contracts.mjs";
import { repositoryRoot } from "./build.mjs";

const { values } = parseArgs({
  options: {
    baseline: { type: "string", default: "951b108cc" },
    head: { type: "string", default: "HEAD" },
    report: { type: "string" },
  },
});
const git = (...args) =>
  execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
const commits = git(
  "log",
  "--first-parent",
  "--format=%H%x00%s",
  `${values.baseline}..${values.head}`,
  "--",
  "cantrip_server/src",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [commit, subject] = line.split("\0");
    const files = git("diff", "--name-only", `${commit}^`, commit).split("\n");
    return {
      commit,
      subject,
      nodeFiles: files.filter((file) => file.startsWith("cantrip_server/src/")),
      rustCoreFiles: files.filter((file) =>
        file.startsWith("cantrip_server_rs/src/"),
      ),
    };
  });
const generatedContracts = [];
for (const [file, roots] of [
  ["security.json", undefined],
  ["mcp-run.json", runMcpContractRoots],
  ["mcp-surface.json", surfaceMcpContractRoots],
  ["cli.json", cliContractRoots],
  ["project-exports.json", projectExportContractRoots],
  ["chat-attachments.json", chatAttachmentContractRoots],
  ["worker-management.json", workerManagementContractRoots],
  ["worker-operations.json", workerOperationContractRoots],
  ["project-administration.json", projectAdministrationContractRoots],
  ["chat-control.json", chatControlContractRoots],
  ["operational-status.json", operationalStatusContractRoots],
  ["worker-logs.json", workerLogContractRoots],
  ["endpoint-providers.json", null],
]) {
  const raw = await readFile(
    path.join(repositoryRoot, "cantrip_server_rs/contracts", file),
  );
  const tracked = JSON.parse(raw);
  const current =
    roots === null
      ? Object.fromEntries(
          Object.entries(protocol.providerDefinitions).filter(([kind]) =>
            protocol.isWorkerEndpointProviderKind(kind),
          ),
        )
      : buildContractManifest(roots);
  generatedContracts.push({
    file,
    match: isDeepStrictEqual(current, tracked),
    sha256: createHash("sha256").update(raw).digest("hex"),
    ...(roots === null
      ? {}
      : {
          roots: Object.keys(current.roots).length,
          nodes: current.nodes.length,
        }),
  });
}
const inventoryRaw = await readFile(
  path.join(repositoryRoot, "docs/security/server-route-inventory.json"),
);
const inventory = JSON.parse(inventoryRaw);
const report = {
  schemaVersion: 1,
  head: git("rev-parse", values.head),
  baseline: git("rev-parse", values.baseline),
  interpretation:
    "Source pairing locates candidates for behavior testing. Matching generated contracts do not prove custom validators, route responses, persistence, recovery or packaging. Build the current protocol before running this audit.",
  nodeChangingCommits: commits.length,
  commitsWithRustCoreEdits: commits.filter(
    (commit) => commit.rustCoreFiles.length,
  ).length,
  commits,
  generatedContracts,
  inventory: {
    sha256: createHash("sha256").update(inventoryRaw).digest("hex"),
    summary: inventory.summary,
  },
  contractsMatch: generatedContracts.every((contract) => contract.match),
};
if (values.report) {
  await mkdir(path.dirname(values.report), { recursive: true });
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      report: values.report,
      head: report.head,
      nodeChangingCommits: report.nodeChangingCommits,
      commitsWithRustCoreEdits: report.commitsWithRustCoreEdits,
      contractsMatch: report.contractsMatch,
    }),
  );
} else console.log(JSON.stringify(report, null, 2));
if (!report.contractsMatch) process.exitCode = 1;
