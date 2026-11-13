import {
  actualProjectReplicas,
  replicaProductJobEvents,
} from "./actual-project-replicas.mjs";
import { actualProjectWorktrees } from "./actual-project-worktrees.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal } from "./project-target-state.mjs";
import { actualProjectAdministration } from "./actual-project-administration.mjs";
import {
  assertOfflineRemoteSurface,
  prepareActualRemoteSurface,
  actualRemoteSurface,
} from "./actual-remote-surfaces-client.mjs";
import { actualProjectInsights } from "./actual-project-insights-client.mjs";
import {
  prepareActualComputerUse,
  actualComputerUse,
} from "./actual-computer-use-client.mjs";
import {
  actualOperationalStatus,
  operationalProductToken,
} from "./actual-operational-status-client.mjs";
import {
  actualWorkerLogs,
  actualWorkerLogsDisconnected,
} from "./actual-worker-logs-client.mjs";
import { actualTaskClient } from "./actual-task-client.mjs";
import { interruptTaskGoalTransferDependency } from "./task-goal-transfer-dependency-outage.mjs";
import { interruptTaskGoalTransferPeer } from "./task-goal-transfer-peer-outage.mjs";
import { actualTaskLabelClient } from "./actual-task-label-client.mjs";
import { actualInlineChatLabels } from "./actual-inline-chat-labels.mjs";
import { actualAgentInteractionCancel } from "./actual-agent-interaction-cancel.mjs";
import { actualProviderAuthClient } from "./actual-provider-auth-client.mjs";
import { actualProjectChatClient } from "./actual-project-chat-client.mjs";
import { providerTestBoundary } from "./provider-test-boundary.mjs";
import { observePostgresErrors } from "./postgres-error-observation.mjs";
import { actualGithubConversion } from "./actual-github-conversion.mjs";
import { actualWorkspaceDiscovery } from "./actual-workspace-discovery.mjs";
import {
  actualWorkerProjectSurfaces,
  retainedWorkerProjectSurfaces,
} from "./actual-worker-project-surfaces.mjs";
// Existing browser encryption/project APIs -> real server -> full built worker.
// Filesystem assertions inspect only disposable test directories. No transport,
// command handler, crypto adapter or repository implementation is substituted.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  actualProjectGitViews,
  retainedProjectGitViews,
} from "./actual-project-git-views.mjs";
import { createRequire } from "node:module";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createPasswordKdfParameters } from "../../packages/crypto/src/index.ts";
import { loadStoredWorkerCredential } from "../../cantrip_worker/src/credential-store.ts";
import { deriveManagedFolderLocation } from "../../cantrip_worker/src/managed-folders.ts";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";
import {
  buildRustServer,
  buildRustExample,
  buildWorkerCli,
  buildDesktopDirectProbe,
  repositoryRoot,
} from "./build.mjs";
import { eventually, launchActualWorker } from "./full-worker.mjs";
import { HttpFixture } from "./http-fixture.mjs";
import { SharedProductFixture } from "./shared-product-fixture.mjs";
import { verifySharedProductRolling } from "./shared-product-rolling.mjs";
import { verifySharedProductOfflineShutdown } from "./shared-product-offline-shutdown.mjs";
import { actualNativeInflightClient } from "./actual-native-inflight-client.mjs";
import { SingleProductFixture } from "./single-product-fixture.mjs";
import { ProfileRuntimeFixture } from "./profile-runtime-fixture.mjs";
import { profileAgentInterruption } from "./profile-agent-interruption.mjs";
import { actualSingleInflightClient } from "./actual-single-inflight-client.mjs";
import { actualWorkerInflightClient } from "./actual-worker-inflight-client.mjs";
import { actualTaskGoalWorkerInflightClient } from "./actual-task-goal-worker-inflight-client.mjs";
import { actualModelOperationsClient } from "./actual-model-operations-client.mjs";
import { actualCantripOsClient } from "./actual-cantrip-os-client.mjs";
import {
  actualProviderCatalogClient,
  assertProviderCatalogSummary,
} from "./actual-provider-catalog-client.mjs";
import { nativeAgentInterruption } from "./native-agent-interruption.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { actualTerminalServices } from "./actual-terminal-services.mjs";
import { actualWorkerLinkRenewal } from "./actual-worker-link-renewal.mjs";
import {
  actualWorkerFileDocuments,
  retainedWorkerFileDocument,
} from "./actual-worker-file-documents.mjs";
import {
  actualWorkspaceClient,
  retainedWorkspaceClient,
} from "./actual-workspace-client.mjs";
import { actualNativeDirectProbe } from "./actual-native-direct-probe.mjs";
import {
  prepareTunnelLink,
  seedTunnelLink,
  actualWorkerTunnelLink,
} from "./actual-worker-tunnel-link.mjs";
import { actualWorkerTunnelRelay } from "./actual-worker-tunnel-relay.mjs";
import { actualWorkerBrowserDiscovery } from "./actual-worker-browser-discovery.mjs";
import {
  prepareProjectShares,
  prepareExistingScratch,
  seedExistingScratch,
  finishProjectShares,
  liveWorkerShareRestart,
} from "./actual-worker-project-shares.mjs";
import {
  prepareBrowserSurface,
  actualWorkerBrowserSurface,
} from "./actual-worker-browser-surface.mjs";

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const sharedPair = option("--server-pair");
assert.ok(
  !process.argv.includes("--replica-redis-outage") ||
    (sharedPair && process.argv.includes("--replicas")),
  "Replica Redis interruption requires --server-pair and --replicas",
);
const postgresOutage = option("--inflight-peer") === "postgres";
const modelPostgresOutage = process.argv.includes(
  "--model-operation-postgres-outage",
);
const settleModelWhilePostgresOffline = process.argv.includes(
  "--model-operation-postgres-offline-settlement",
);
assert.ok(
  !settleModelWhilePostgresOffline || modelPostgresOutage,
  "Offline settlement requires --model-operation-postgres-outage",
);
const modelRedisOutage = process.argv.includes(
  "--model-operation-redis-outage",
);
const modelServerLoss = process.argv.includes("--model-operation-server-loss");
assert.ok(
  !modelPostgresOutage ||
    (process.argv.includes("--model-operations") &&
      databaseMode === "postgres" &&
      !modelServerLoss),
  "Model-operation PostgreSQL interruption requires --model-operations --database postgres and runs separately from server loss",
);
assert.ok(
  !modelRedisOutage ||
    (process.argv.includes("--model-operations") &&
      sharedPair &&
      databaseMode === "postgres" &&
      !modelServerLoss &&
      !modelPostgresOutage),
  "Model-operation Redis interruption requires --model-operations --database postgres --server-pair and runs separately from other faults",
);
const goalLaneDependency = option("--task-goal-lane-dependency");
const taskGoalFirstInputPhase = option("--task-goal-first-input-order");
assert.ok(
  taskGoalFirstInputPhase === undefined ||
    ["claim", "dispatch"].includes(taskGoalFirstInputPhase),
  "Task Goal first-input order expects claim or dispatch",
);
const cantripOsRun = process.argv.includes("--cantrip-os-run");
const cantripOsSurfaces = process.argv.includes("--cantrip-os-surfaces");
const fakeHostDesktopInventory = process.argv.includes(
  "--fake-host-desktop-inventory",
);
assert.ok(!fakeHostDesktopInventory || cantripOsSurfaces);
const cantripOsSourceBackup = process.argv.includes(
  "--cantrip-os-source-backup",
);
const workerLinkRenewal = process.argv.includes("--worker-link-renewal");
const taskGoalTransferFaultMode = option("--task-goal-provider-transfer-fault");
const taskGoalTransferDependency = ["postgres", "redis"].find(
  (dependency) => taskGoalTransferFaultMode === `${dependency}-after-commit`,
);
const taskGoalTransferPeer = ["client", "worker"].find(
  (peer) => taskGoalTransferFaultMode === `${peer}-peer-after-commit`,
);
const taskGoalSharedFault = taskGoalTransferDependency || taskGoalTransferPeer;
const taskGoalTransferredPause = process.argv.includes(
  "--task-goal-transferred-pause",
);
const taskGoalAutonomousTransfer =
  Boolean(taskGoalSharedFault) ||
  taskGoalTransferredPause ||
  process.argv.includes("--task-goal-autonomous-provider-transfer");
assert.ok(
  taskGoalTransferFaultMode === undefined ||
    taskGoalSharedFault ||
    ["cancel-prepared", "worker-after-commit"].includes(
      taskGoalTransferFaultMode,
    ),
  "Task Goal transfer fault expects cancel-prepared, worker-after-commit, postgres-after-commit, redis-after-commit, client-peer-after-commit, or worker-peer-after-commit",
);
assert.ok(
  !taskGoalSharedFault || sharedPair,
  "Shared Task Goal transfer interruption requires --server-pair",
);
const taskGoalProviderTransfer =
  Boolean(taskGoalTransferFaultMode) ||
  taskGoalAutonomousTransfer ||
  process.argv.includes("--task-goal-provider-transfer");
const runTaskProduct =
  process.argv.includes("--tasks") ||
  Boolean(taskGoalFirstInputPhase) ||
  taskGoalProviderTransfer;
const providerAuth = process.argv.includes("--provider-auth");
const taskLabel = process.argv.includes("--task-label");
const inlineChatLabels = process.argv.includes("--inline-chat-labels");
const approvalCancellation = process.argv.includes("--approval-cancellation");
const remoteSurfaces = process.argv.includes("--remote-surfaces");
const computerUseProduct = process.argv.includes("--computer-use");
const fakeComputerUse = process.argv.includes("--computer-use-fake-capture");
assert.ok(!fakeComputerUse || computerUseProduct);
assert.ok(!workerLinkRenewal || !sharedPair);
const cliWorktreeAcquire = process.argv.includes("--cli-worktree-acquire");
const gitProjectChat =
  cliWorktreeAcquire || process.argv.includes("--chat-controls");
const singleProduct =
  cliWorktreeAcquire ||
  cantripOsRun ||
  cantripOsSurfaces ||
  cantripOsSourceBackup ||
  workerLinkRenewal ||
  providerAuth ||
  taskLabel ||
  inlineChatLabels ||
  approvalCancellation ||
  process.argv.includes("--production-server") ||
  process.argv.includes("--native-task-goal-worker-recovery") ||
  process.argv.includes("--native-worker-recovery") ||
  process.argv.includes("--native-single-recovery") ||
  process.argv.includes("--native-single-agent-recovery") ||
  process.argv.includes("--model-operations") ||
  process.argv.includes("--provider-catalog") ||
  process.argv.includes("--cantrip-os") ||
  process.argv.includes("--cantrip-os-system");
const selectedRuntime = option("--runtime");
assert.ok(!selectedRuntime || ["node", "rust"].includes(selectedRuntime));
const runtimeCases = sharedPair
  ? (sharedPair === "all"
      ? ["node/node", "node/rust", "rust/node", "rust/rust"]
      : [sharedPair]
    ).map((value) => {
      const pair = value.split("/");
      assert.ok(
        pair.length === 2 &&
          pair.every((kind) => ["node", "rust"].includes(kind)),
      );
      assert.equal(
        databaseMode,
        "postgres",
        "shared product runs require their own shared PostgreSQL database",
      );
      return pair;
    })
  : selectedRuntime
    ? [[selectedRuntime]]
    : [["node"], ["rust"]];
const needsRemoteSurface =
  process.argv.includes("--surfaces") || remoteSurfaces;
const workerLinkRoute = option("--worker-link-route") ?? "relay";
const reportPath = option("--report");
const liveTaskDiagnostics =
  process.argv.includes("--task-diagnostics") ||
  process.argv.includes("--postgres-errors");
const fullServerLogs =
  cantripOsSurfaces ||
  cantripOsSourceBackup ||
  workerLinkRenewal ||
  liveTaskDiagnostics ||
  process.argv.includes("--project-insights") ||
  process.argv.includes("--operational-status") ||
  process.argv.includes("--worker-logs") ||
  remoteSurfaces ||
  computerUseProduct ||
  process.argv.includes("--project-administration") ||
  gitProjectChat;
const surfaceFixtureRequests = [];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-actual-folder-"));
const fakeCuaLauncher =
  fakeComputerUse || fakeHostDesktopInventory
    ? path.join(root, "fake-cua")
    : null;
const appRoot = path.join(repositoryRoot, "cantrip_app");
const appRequire = createRequire(path.join(appRoot, "package.json"));
const { createServer } = await import(
  pathToFileURL(appRequire.resolve("vite")).href
);
const report = {
  suite: "actual-browser-server-worker-folders",
  databaseMode,
  serverPair: sharedPair ?? null,
  completeReplacement: false,
  scope:
    "Existing browser account encryption, project and protected repository APIs; full worker startup, real managed/existing folders, failure/retry, reconnect and retained server state. Optional --worktrees exercises actual local Git create/lock/unlock/reconcile/remove/prune, retained identity and real Run process retirement before deletion, with only disposable catalog classification seeded. Optional --replicas uses two full workers for direct local Git attachment, replay, restart and detach; --github-replicas adds real public gh clone/fetch and managed checkout deletion. Optional --github-conversion uses the existing encrypted APIs and full worker to link matching public history in a fresh managed folder, preserve dirty bytes and identities, and restart without SQL seeding or command substitutions. Optional --tasks uses existing encrypted Task APIs, the full production worker and bundled Codex for direct execution, planning, native Goal completion, failure/retry, paused admissions and retained restart; only public model HTTP responses are controlled. Optional --project-chats exercises retained Agent creation and usage, real managed native preparation, encrypted turns, completed canonical history, native Goal tools, exact restart retention and Goal clear; only public model HTTP responses are controlled. Optional --chat-controls adds real native compaction and continuation, dirty Git worktree/lane release, encrypted system-message replay and exact committed restart retention to the existing Agent/worktree flows. Optional --chat-customizations adds actual skills, extra roots, MCP and bound permission configuration with native restart recovery. Optional --skill-settings adds actual project/account skill files, audiences, encrypted recovery deletion and retained restart. Optional --mcp-settings uses an acceptance-only owned worker home and the existing encrypted browser SDK for MCP CRUD, full discovery, copy, native resource access and restart. Shared --server-pair runs exercise production peers on private shared PostgreSQL/Redis with the browser and full worker on opposite peers; --rolling-servers replaces application and worker-owner peers without restarting that worker. Optional --native-shared-agent-recovery interrupts actual Agent/Goal execution on the selected --agent-crash-peer while retaining native authority and the original full worker. Full UI, packaged/platform, worker/native-process loss, long-outage/Redis TLS and whole replacement acceptance remain separate.",
  runtimes: [],
  cliWorktreeAcquireScope: cliWorktreeAcquire
    ? "Packaged CLI, full worker and native Agent turn on an attached local Git checkout. Only project catalog classification and local model replies are supplied by the fixture."
    : null,
  operationalStatusScope: process.argv.includes("--operational-status")
    ? "Existing browser getSystemHealth, authenticated Prometheus and full worker/Live before and after retained server restart. Shared peers additionally exercise actual Redis stop/restart, readiness and cached coordination collectors without replacing the worker. Active-job failover, TLS deployment and supported-platform/package acceptance remain separate."
    : null,
  workerLinkRenewalScope: workerLinkRenewal
    ? "Browser SDK, production servers, full Node worker and native LOCAL broker verifier. Real lease extensions, worker and server process kills, old authority rejection and explicit release."
    : null,
  providerAuthScope: providerAuth
    ? "Browser provider-account SDK, production server, and full worker with isolated legacy credential files. Includes native Codex logout and worker-local Grok logout."
    : null,
  taskLabelScope: taskLabel
    ? "Existing browser Task APIs, production server, full worker, and native Codex stateless labeling through a disposable model HTTP endpoint."
    : null,
  inlineChatLabelScope: inlineChatLabels
    ? "Existing browser Chat and Agent APIs, production server, full worker and native initial labeling through disposable model HTTP endpoints."
    : null,
  approvalCancellationScope: approvalCancellation
    ? "Production serving paths, browser SDK, full worker, and actual native Codex approval with an isolated database write failure and a normal approval control."
    : null,
  taskDiagnostics: liveTaskDiagnostics
    ? "Development SQL fixture executable; unchanged production startup, routes, worker and native runtime. Failed Task runs retain scoped read-only database snapshots before teardown."
    : null,
};
let vite, browser, postgres, failure, surfaceRepositoryBinary;
async function flow(
  fixture,
  result,
  cliBinary,
  nativeProbeBinary,
  directBrokerBinary,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const taskOutcomeOrderKind = ["goal", "round"].find((kind) =>
    process.argv.includes(`--task-${kind}-outcome-order`),
  );
  const taskOutcomeOrder = taskOutcomeOrderKind
    ? {
        kind: taskOutcomeOrderKind,
        file: path.join(
          root,
          fixture.kind,
          `task-${taskOutcomeOrderKind}-outcome-order.json`,
        ),
      }
    : undefined;
  const goalLaneFault =
    goalLaneDependency || process.argv.includes("--task-goal-lane-owner-loss")
      ? path.join(root, fixture.kind, "goal-lane-observation.json")
      : undefined;
  const taskGoalFirstInputOrder = taskGoalFirstInputPhase
    ? path.join(root, fixture.kind, "task-goal-first-input-order.json")
    : undefined;
  const taskGoalTransferFaultFile = taskGoalTransferFaultMode
    ? path.join(root, fixture.kind, "task-goal-handoff-fault.json")
    : undefined;
  const errors = [],
    requests = [];
  result.requests = requests;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith("/api/projects") ||
      pathname.startsWith("/api/cantrip-os") ||
      pathname.startsWith("/api/run-configuration-runtimes/") ||
      pathname.startsWith("/api/model-operations/") ||
      pathname.startsWith("/api/chats/") ||
      pathname.startsWith("/api/skills") ||
      pathname.startsWith("/api/settings/mcp-") ||
      pathname.startsWith("/api/settings/providers") ||
      pathname.startsWith("/api/skill-audiences") ||
      pathname.startsWith("/api/agent-requests") ||
      pathname.startsWith("/api/tasks/") ||
      pathname.startsWith("/api/tunnel") ||
      pathname.startsWith("/api/project-shares/") ||
      pathname.endsWith("/repository-operation") ||
      pathname.endsWith("/encryption/refresh")
    )
      requests.push({
        method: request.method(),
        pathname,
        body: request.postData(),
      });
  });
  const canonicalDataDirectory = path.join(root, fixture.kind, "worker");
  const dataDirectory = process.argv.includes("--skill-settings")
    ? path.join(root, fixture.kind, "worker-path-alias")
    : canonicalDataDirectory;
  if (dataDirectory !== canonicalDataDirectory) {
    await mkdir(canonicalDataDirectory, { recursive: true });
    // SkillManager returns lexical account paths; native discovery returns
    // canonical paths. Exercise that real rejection on every platform instead
    // of accidentally depending on macOS's /var alias.
    await symlink(
      await realpath(canonicalDataDirectory),
      dataDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  const existingPath = path.join(root, fixture.kind, "private-existing-folder");
  const missingPath = path.join(root, fixture.kind, "private-repaired-folder");
  const workerId = "actual-folder-worker";
  const providerBoundary = process.argv.includes("--provider-test")
    ? await providerTestBoundary(
        path.join(root, fixture.kind, "provider-test-boundary"),
      )
    : undefined;
  let worker, tunnel, productFailed;
  const startWorker = async (
    enrollmentCode,
    { providerTest = false, environment = {} } = {},
  ) => {
    const isolateHome =
      workerLinkRenewal ||
      taskGoalProviderTransfer ||
      providerAuth ||
      taskLabel ||
      inlineChatLabels ||
      approvalCancellation ||
      remoteSurfaces ||
      cantripOsSurfaces ||
      computerUseProduct ||
      [
        "--mcp-settings",
        "--terminals",
        "--terminal-direct",
        "--project-administration",
      ].some((flag) => process.argv.includes(flag));
    const homeDirectory = isolateHome
      ? path.join(dataDirectory, "mcp-test-home")
      : undefined;
    if (homeDirectory) await mkdir(homeDirectory, { recursive: true });
    const backupResponseDirectory = path.join(
      dataDirectory,
      "test-backup-responses",
    );
    if (cantripOsSourceBackup)
      await mkdir(backupResponseDirectory, { recursive: true });
    worker = launchActualWorker(
      fixture.workerFixture ?? fixture,
      dataDirectory,
      {
        cliBinary,
        enrollmentCode,
        workerId,
        homeDirectory,
        environment: {
          ...(workerLinkRenewal ||
          providerAuth ||
          taskLabel ||
          inlineChatLabels ||
          approvalCancellation ||
          remoteSurfaces ||
          computerUseProduct ||
          cantripOsSurfaces
            ? { CANTRIP_LOG_LEVEL: "debug" }
            : {}),
          ...(fakeCuaLauncher ? { CANTRIP_CUA_BIN: fakeCuaLauncher } : {}),
          ...(providerTest ? providerBoundary?.environment : {}),
          ...(cantripOsSourceBackup
            ? {
                CANTRIP_TEST_BACKUP_RESPONSE_DIRECTORY: backupResponseDirectory,
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS,
                  "--import=" +
                    new URL("./os-backup-response-fault.mjs", import.meta.url)
                      .href,
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          ...(goalLaneFault
            ? {
                CANTRIP_TEST_GOAL_LANE_OWNER_LOSS: goalLaneFault,
                ...(goalLaneDependency
                  ? { CANTRIP_TEST_GOAL_LANE_DEPENDENCY: goalLaneDependency }
                  : {}),
                CANTRIP_TEST_GOAL_LANE_WORKER_ENTRY: path.resolve(
                  process.env.CANTRIP_TEST_WORKER_PACKAGE ??
                    path.join(repositoryRoot, "cantrip_worker"),
                  "dist/index.js",
                ),
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS,
                  "--import=" +
                    new URL(
                      "./worker-goal-lane-owner-loss.mjs",
                      import.meta.url,
                    ).href,
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          ...(taskOutcomeOrder
            ? {
                CANTRIP_TEST_TASK_ROUND_ORDER_FILE: taskOutcomeOrder.file,
                CANTRIP_TEST_TASK_OUTCOME_ORDER_KIND: taskOutcomeOrder.kind,
                CANTRIP_TEST_TASK_ROUND_ORDER_WORKER_ENTRY: path.resolve(
                  process.env.CANTRIP_TEST_WORKER_PACKAGE ??
                    path.join(repositoryRoot, "cantrip_worker"),
                  "dist/index.js",
                ),
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS,
                  "--import=" +
                    new URL("./worker-task-round-order.mjs", import.meta.url)
                      .href,
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          ...(taskGoalFirstInputOrder
            ? {
                CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_FILE:
                  taskGoalFirstInputOrder,
                CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_PHASE:
                  taskGoalFirstInputPhase,
                CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_WORKER_ENTRY: path.resolve(
                  process.env.CANTRIP_TEST_WORKER_PACKAGE ??
                    path.join(repositoryRoot, "cantrip_worker"),
                  "dist/index.js",
                ),
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS,
                  "--import=" +
                    new URL(
                      "./worker-task-goal-first-input-order.mjs",
                      import.meta.url,
                    ).href,
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          ...(taskGoalTransferFaultFile
            ? {
                CANTRIP_TEST_TASK_GOAL_HANDOFF_FILE: taskGoalTransferFaultFile,
                CANTRIP_TEST_TASK_GOAL_HANDOFF_SOURCE:
                  taskGoalAutonomousTransfer ? "autonomous" : "first-input",
                ...(taskGoalSharedFault
                  ? { CANTRIP_TEST_TASK_GOAL_HANDOFF_RELEASE: "1" }
                  : {}),
                CANTRIP_TEST_TASK_GOAL_HANDOFF_ACTION:
                  taskGoalTransferFaultMode === "cancel-prepared"
                    ? "prepared"
                    : "commit",
                CANTRIP_TEST_TASK_GOAL_HANDOFF_WORKER_ENTRY: path.resolve(
                  process.env.CANTRIP_TEST_WORKER_PACKAGE ??
                    path.join(repositoryRoot, "cantrip_worker"),
                  "dist/index.js",
                ),
                NODE_OPTIONS: [
                  process.env.NODE_OPTIONS,
                  "--import=" +
                    new URL(
                      "./worker-task-goal-handoff-fault.mjs",
                      import.meta.url,
                    ).href,
                ]
                  .filter(Boolean)
                  .join(" "),
              }
            : {}),
          ...environment,
        },
        traceShutdown:
          process.argv.includes("--trace-worker-shutdown") ||
          process.argv.includes("--replicas") ||
          process.argv.includes("--worktrees") ||
          process.argv.includes("--project-administration"),
        ...(needsRemoteSurface
          ? {
              chromiumExecutable: chromium.executablePath(),
              chromiumTraceDirectory: path.resolve(".qa/rust-server"),
            }
          : {}),
      },
    );
    await worker.ready();
    if (sharedPair) await fixture.assertRemoteWorker(workerId);
    return worker;
  };
  const stopWorker = async () => {
    if (!worker) return;
    const current = worker;
    worker = undefined;
    try {
      result.workerStops.push(await current.close());
    } finally {
      result.workerDiagnostics.push(current.diagnostics());
    }
  };
  const crashWorker = async () => {
    const current = worker;
    assert.ok(current);
    const ended = once(current.child, "close");
    assert.equal(current.child.kill("SIGKILL"), true);
    const [code, signal] = await ended;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    worker = undefined;
    result.workerStops.push({
      code,
      signal,
      intentionalInterruption: "SIGKILL",
    });
    result.workerDiagnostics.push(current.diagnostics());
  };
  const workers = () => page.evaluate(() => window.folderWorkers.getWorkers());
  const job = (id) =>
    page.evaluate((id) => window.folderApi.getProjectFolderSetupJob(id), id);
  const waitJob = (id, state) =>
    eventually(
      () => job(id),
      (job) => assert.equal(job.state, state),
    );
  const create = (name, existingPath) =>
    page.evaluate(
      ({ name, existingPath, workerId }) =>
        window.folderCrypto.createManagedFolderProject({
          name,
          workerId,
          ...(existingPath ? { existingPath } : {}),
        }),
      { name, existingPath, workerId },
    );
  const watch = async (id) => {
    await page.evaluate(
      (id) =>
        window.folderLive.retainScope({ kind: "project", projectId: id }) &&
        undefined,
      id,
    );
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
  };
  const filesystem = async (id) => {
    const target = deriveManagedFolderLocation(dataDirectory, id).target;
    assert.equal((await stat(target)).isDirectory(), true);
    return normalizeProjectSourcePath(await realpath(target));
  };
  const openedProject = async (id, name, actualPath, sourceKind = "folder") => {
    const projects = await page.evaluate(() =>
      window.folderCrypto.getProjects(),
    );
    const project = projects.find((project) => project.id === id);
    (result.openedProjects ??= []).push(project);
    assert.ok(project);
    assert.equal(project.name, name);
    assert.equal(project.setupStatus, "ready");
    assert.equal(project.source.path, actualPath);
    assert.equal(project.source.sourceKind, sourceKind);
    return project;
  };
  try {
    await mkdir(existingPath, { recursive: true });
    await writeFile(
      path.join(existingPath, "retained.txt"),
      "Existing user file remains intact.\n",
    );
    if (
      process.argv.includes("--project-surfaces") ||
      process.argv.includes("--worktrees") ||
      gitProjectChat ||
      process.argv.includes("--replicas") ||
      process.argv.includes("--project-administration")
    ) {
      execFileSync("git", ["init", "--initial-branch=main", existingPath]);
      execFileSync("git", ["-C", existingPath, "add", "retained.txt"]);
      execFileSync("git", [
        "-C",
        existingPath,
        "-c",
        "user.name=Cantrip Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "Disposable fixture",
      ]);
    }
    await page.goto(vite.resolvedUrls.local[0] + "__actual_folder_fixture");
    const enrollment = await page.evaluate(
      async ({ serverUrl, password, passwordKdf, workerId }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        window.folderWorkers = await import("/src/lib/api/worker-wire.ts");
        window.folderApi = await import("/src/lib/api/project-replicas.ts");
        window.folderWire = await import("/src/lib/api/projects.ts");
        window.folderCrypto = await import("/src/lib/project-encryption.ts");
        window.folderRequest = (await import("/src/lib/api-client.ts")).request;
        await servers.initializeServerConnections();
        const saved = await servers.saveServerConnection({
          name: "Disposable folder server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const bootstrap = await account.getServerBootstrap();
        const registered = await account.registerAccount({
          email: "folders@example.invalid",
          displayName: "Private folder owner",
          password,
        });
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: registered.currentUser,
          csrfToken: registered.csrfToken,
          expiresAt: registered.expiresAt,
        });
        window.folderIdentity = {
          ownerId: registered.currentUser.id,
          serverId: bootstrap.server.id,
        };
        const { prepareClientEncryption } =
          await import("/src/lib/account-encryption.ts");
        const access = await prepareClientEncryption({
          authMode: "accounts",
          identity: window.folderIdentity,
          password,
          passwordKdf,
        });
        if (access.status !== "ready")
          throw new Error(
            "Browser encryption did not initialize: " + access.status,
          );
        const { AppLiveClient, appLiveWebSocketUrl } =
          await import("/src/lib/app-live-client.ts");
        window.folderEvents = [];
        window.folderLive = new AppLiveClient({
          client: {
            id: "actual-folder-browser",
            name: "Folder acceptance",
            version: "1",
          },
          storage: localStorage,
          storageKey: "actual-folder-resume",
          url: appLiveWebSocketUrl(serverUrl, location.origin),
          onEvent: (event) => window.folderEvents.push(event),
          onResync: async () => {
            await window.folderWire.getProjectWireList();
          },
        });
        window.folderLive.retainScope({ kind: "current-user" });
        window.folderLive.start();
        return (
          await import("/src/lib/api/workers.ts")
        ).createWorkerEnrollmentCode({
          label: workerId,
          expiresInSeconds: 300,
        });
      },
      {
        serverUrl: fixture.server.origin,
        password,
        workerId,
        passwordKdf: createPasswordKdfParameters({
          memoryKiB: 8192,
          iterations: 1,
        }),
      },
    );
    result.steps.push(
      "existing browser initializes account, session and durable endpoint encryption",
    );
    if (process.argv.includes("--postgres-errors"))
      await observePostgresErrors(fixture, page);
    await startWorker(enrollment.code);
    await eventually(workers, (workers) => {
      assert.equal(workers.length, 1);
      assert.equal(workers[0].workerId, workerId);
      assert.equal(workers[0].online, true);
      assert.equal(workers[0].managedFolders.attachExisting, true);
      assert.ok(workers[0].encryption.principalId);
    });
    if (process.argv.includes("--tunnels"))
      await page.evaluate(async (workerId) => {
        await (
          await import("/src/lib/api/tunnels.ts")
        ).ensureTunnelWorker(workerId);
      }, workerId);
    result.steps.push(
      "full worker enrolls, advertises folder capabilities and registers encryption principal",
    );
    const credential = loadStoredWorkerCredential(
      dataDirectory,
      (fixture.workerFixture ?? fixture).server.origin,
    );
    assert.ok(credential);
    if (providerAuth) {
      await actualProviderAuthClient({
        page,
        workerId,
        workerDirectory: dataDirectory,
        diagnostics: () => worker.diagnostics(),
        result,
      });
      assert.deepEqual(errors, []);
      return;
    }
    if (nativeProbeBinary)
      await actualNativeDirectProbe({
        page,
        workerId,
        binary: nativeProbeBinary,
        result,
      });
    const names = [
      "Private fresh 🍄 folder",
      "Private attached 🌲 folder",
      "Private repaired 🌙 folder",
      "Private resumed 🌤 folder",
    ];
    const created = await create(names[0]);
    assert.equal(created.name, names[0]);
    const firstJob = await waitJob(created.id, "succeeded");
    assert.equal(firstJob.attempt, 1);
    const first = await openedProject(
      created.id,
      names[0],
      await filesystem(created.id),
    );
    assert.equal(first.source.ownershipKind, "cantrip");
    assert.equal(
      result.workerStops.length,
      0,
      "the first repository operation needs no worker restart",
    );
    assert.ok(
      requests.some(
        (request) =>
          request.pathname.endsWith("/encryption/refresh") &&
          JSON.parse(request.body).component === "repository-content",
      ),
      "existing browser repository API authorizes and refreshes its key",
    );
    assert.deepEqual(
      loadStoredWorkerCredential(
        dataDirectory,
        (fixture.workerFixture ?? fixture).server.origin,
      ),
      credential,
    );
    result.steps.push(
      "existing browser repository flow authorizes and refreshes its grant without restarting the worker",
    );
    result.steps.push(
      "existing project client encrypts label and full worker creates a real managed directory",
    );
    if (taskLabel) {
      await actualTaskLabelClient({
        fixture,
        page,
        projectId: first.id,
        workerId,
        startWorker,
        stopWorker,
        diagnostics: () => worker.diagnostics(),
        result,
      });
      assert.deepEqual(errors, []);
      return;
    }
    if (inlineChatLabels) {
      await actualInlineChatLabels({
        fixture,
        page,
        projectId: first.id,
        workerId,
        stopWorker,
        diagnostics: () => worker.diagnostics(),
        result,
      });
      assert.deepEqual(errors, []);
      return;
    }
    if (approvalCancellation) {
      await actualAgentInteractionCancel({
        fixture,
        page,
        projectId: first.id,
        projectRoot: first.source.path,
        workerId,
        startWorker,
        stopWorker,
        diagnostics: () => worker.diagnostics(),
        result,
        requests,
        repositoryBinary: surfaceRepositoryBinary,
      });
      assert.deepEqual(errors, []);
      return;
    }
    const attached = await create(names[1], existingPath);
    await waitJob(attached.id, "succeeded");
    const opened = await openedProject(
      attached.id,
      names[1],
      normalizeProjectSourcePath(await realpath(existingPath)),
      process.argv.includes("--project-surfaces") ||
        process.argv.includes("--worktrees") ||
        gitProjectChat ||
        process.argv.includes("--replicas") ||
        process.argv.includes("--project-administration")
        ? "git"
        : "folder",
    );
    assert.equal(opened.folderManagement, "external");
    // Source summaries retain the existing source-row ownership default;
    // external folder management is separately recorded on the project/root.
    assert.equal(opened.source.ownershipKind, "cantrip");
    assert.equal(
      await readFile(path.join(existingPath, "retained.txt"), "utf8"),
      "Existing user file remains intact.\n",
    );
    result.steps.push(
      "actual protected repository operations attach existing folder and preserve its user file",
    );
    const repaired = await create(names[2], missingPath);
    const failed = await waitJob(repaired.id, "failed");
    assert.deepEqual(failed.error, {
      code: "existing-path-missing",
      retryable: false,
    });
    await watch(repaired.id);
    await mkdir(missingPath);
    await page.evaluate(
      ({ id, revision }) =>
        window.folderApi.retryProjectFolderSetup(id, revision),
      { id: repaired.id, revision: failed.stateRevision },
    );
    const retried = await waitJob(repaired.id, "succeeded");
    assert.equal(retried.attempt, 2);
    await openedProject(
      repaired.id,
      names[2],
      normalizeProjectSourcePath(await realpath(missingPath)),
    );
    await eventually(
      () => page.evaluate(() => window.folderEvents),
      (events) => {
        assert.deepEqual(
          events
            .filter(
              (event) =>
                event.scope.projectId === repaired.id &&
                event.resource === "project-folder-setup-job",
            )
            .map((event) => event.revision),
          [4, 6],
        );
      },
    );
    result.steps.push(
      "real missing-path failure is retained and explicit browser retry succeeds after worker path repair",
    );
    await stopWorker();
    await eventually(workers, (workers) =>
      assert.equal(workers[0].online, false),
    );
    const resumed = await create(names[3]);
    const blocked = await waitJob(resumed.id, "blocked");
    assert.deepEqual(blocked.error, {
      code: "worker-offline",
      retryable: true,
    });
    await watch(resumed.id);
    await startWorker();
    const completed = await waitJob(resumed.id, "succeeded");
    assert.equal(completed.attempt, 2);
    await openedProject(resumed.id, names[3], await filesystem(resumed.id));
    await eventually(
      () => page.evaluate(() => window.folderEvents),
      (events) =>
        assert.ok(
          events.some(
            (event) =>
              event.resource === "worktree" &&
              event.scope.projectId === resumed.id,
          ),
        ),
    );
    result.steps.push(
      "offline folder job resumes on actual worker reconnect and existing AppLiveClient receives completion",
    );
    if (workerLinkRenewal)
      await actualWorkerLinkRenewal({
        page,
        workerId,
        getWorker: () => worker,
        startWorker,
        crashWorker,
        restartServer: () => fixture.restart({ crash: true }),
        binary: directBrokerBinary,
        result,
      });
    if (
      process.argv.includes("--terminals") ||
      process.argv.includes("--terminal-direct")
    )
      await actualTerminalServices({
        page,
        projectId: created.id,
        directory: await filesystem(created.id),
        workerId,
        cliBinary,
        workerDataDirectory: dataDirectory,
        startWorker,
        stopWorker,
        result,
        workerLinks: process.argv.includes("--worker-links"),
        workerLinkRoute,
        directBrokerBinary,
      });
    // The preceding terminal offline case intentionally stops the worker.
    // Subsequent document/browser flows use the worker through the public API.
    if (
      (needsRemoteSurface ||
        computerUseProduct ||
        process.argv.includes("--project-shares") ||
        process.argv.includes("--file-documents") ||
        process.argv.includes("--workspaces") ||
        process.argv.includes("--project-surfaces")) &&
      !worker
    )
      await startWorker();
    const fileDocuments =
      process.argv.includes("--file-documents") ||
      process.argv.includes("--workspaces")
        ? await actualWorkerFileDocuments({
            page,
            projectId: created.id,
            workerId,
            directory: await filesystem(created.id),
            result,
          })
        : undefined;
    const projectSurfaces = process.argv.includes("--project-surfaces")
      ? await actualWorkerProjectSurfaces({
          page,
          projectId: created.id,
          workerId,
          directory: await filesystem(created.id),
          result,
        })
      : undefined;
    const gitView = projectSurfaces
      ? await actualProjectGitViews({ page, projectId: attached.id, result })
      : undefined;
    const workspace = process.argv.includes("--workspaces")
      ? await actualWorkspaceClient({ page, document: fileDocuments, result })
      : undefined;
    const surface = process.argv.includes("--surfaces")
      ? await prepareBrowserSurface(
          page,
          vite.resolvedUrls.local[0],
          created.id,
          workerId,
        )
      : undefined;
    if (surface) {
      result.steps.push(
        "existing client creates a browser with encrypted title and state through the product route",
      );
      // The production OS scan must finish before opening the later tunnel's
      // exact-payload peer, which deliberately records every received byte.
      await actualWorkerBrowserDiscovery({ page, surface, workerId, result });
    }
    if (process.argv.includes("--tunnels"))
      tunnel = await prepareTunnelLink(page, created.id, workerId);
    const projectShares = process.argv.includes("--project-shares")
      ? await prepareProjectShares({
          page,
          project: first,
          workerId,
          result,
          requests,
        })
      : undefined;
    if (process.argv.includes("--project-insights"))
      await actualProjectInsights({
        page,
        projectId: created.id,
        workerId,
        directory: await filesystem(created.id),
        result,
        phase: "connected",
      });
    // Capture after optional resource creation commits its project updates.
    const computerUse = computerUseProduct
      ? await prepareActualComputerUse({
          page,
          projectId: created.id,
          workerId,
          result,
          fakeCapture: fakeComputerUse,
        })
      : undefined;
    const legacySurface = remoteSurfaces
      ? await prepareActualRemoteSurface({
          page,
          projectId: created.id,
          workerId,
          origin: vite.resolvedUrls.local[0],
          protocolUrl: `/@fs${pathToFileURL(path.join(repositoryRoot, "packages/protocol/src/index.ts")).pathname}`,
          result,
        })
      : undefined;
    const wire = await page.evaluate(() =>
      window.folderWire.getProjectWireList(),
    );
    assert.equal(wire.length, 4);
    for (const project of wire) {
      assert.match(project.source.path, /^ctrr_[A-Za-z0-9_-]{43}$/);
      assert.match(project.source.displayPath, /^ctrr_[A-Za-z0-9_-]{43}$/);
      assert.equal(project.nameProtection.classification.recordKind, "project");
      assert.equal(project.nameProtection.protectedLabel.formatVersion, 1);
      assert.equal(
        project.nameProtection.protectedLabel.envelope.algorithm,
        "AES-256-GCM",
      );
      assert.equal(project.name, undefined);
    }
    const publicRequests = JSON.stringify(requests);
    for (const secret of [
      ...names,
      existingPath,
      missingPath,
      dataDirectory,
      ...(legacySurface ? [legacySurface.token, legacySurface.url] : []),
      ...(computerUse ? [computerUse.title] : []),
      ...(surface
        ? [surface.token, surface.url, "Private WorkerLink browser"]
        : []),
    ])
      assert.equal(
        publicRequests.includes(secret),
        false,
        "server requests must retain endpoint opacity",
      );
    result.steps.push(
      "server receives opaque labels, encrypted repository operations and routing handles without private names or paths",
    );
    if (process.argv.includes("--operational-status"))
      await actualOperationalStatus({
        fixture,
        page,
        worker,
        result,
        databaseMode,
        phase: "connected",
        secrets: [...names, existingPath, missingPath],
      });
    if (process.argv.includes("--worker-logs"))
      await actualWorkerLogs({
        page,
        fixture,
        workerId,
        result,
        phase: "connected",
      });
    await stopWorker();
    if (legacySurface) {
      await eventually(workers, (values) =>
        assert.equal(
          values.find((entry) => entry.workerId === workerId)?.online,
          false,
        ),
      );
      result.legacySurfaceOffline = await assertOfflineRemoteSurface(
        page,
        legacySurface,
      );
    }
    if (process.argv.includes("--worker-logs"))
      await actualWorkerLogsDisconnected({ page, result, phase: "connected" });
    const scratch = projectShares
      ? await prepareExistingScratch(dataDirectory)
      : undefined;
    await page.evaluate(() => window.folderLive.stop());
    const retainedPort =
      computerUse ||
      surface ||
      legacySurface ||
      tunnel ||
      projectShares ||
      fileDocuments ||
      projectSurfaces ||
      process.argv.includes("--worktrees") ||
      process.argv.includes("--project-administration") ||
      process.argv.includes("--replicas") ||
      process.argv.includes("--github-conversion") ||
      runTaskProduct ||
      singleProduct ||
      process.argv.includes("--project-chats") ||
      gitProjectChat ||
      process.argv.includes("--operational-status") ||
      process.argv.includes("--worker-logs") ||
      process.argv.includes("--project-insights") ||
      process.argv.includes("--workspace-discovery")
        ? Number(new URL(fixture.server.origin).port)
        : 0;
    // Retain a generous diagnostic deadline for both implementations. Earlier
    // reference runs retained a zero-byte connection beyond this whole window;
    // production idle-connection cleanup now has separate real-socket tests.
    // Record actual duration instead of treating the deadline as an observed timeout.
    const shutdownStarted = Date.now();
    await fixture.close({ shutdownTimeoutMs: 105000 });
    result.serverRestartShutdownMs = Date.now() - shutdownStarted;
    if (tunnel)
      await seedTunnelLink(fixture, root, surfaceRepositoryBinary, tunnel);
    if (scratch)
      await seedExistingScratch({
        fixture,
        root,
        executable: surfaceRepositoryBinary,
        page,
        scratch,
        workerId,
      });
    await fixture.start({ port: retainedPort });
    const retained = await page.evaluate(
      async ({ serverUrl, password }) => {
        const servers = await import("/src/lib/server-connections.ts");
        const account = await import("/src/lib/api/account.ts");
        const session = await import("/src/lib/client-session.ts");
        const saved = await servers.saveServerConnection({
          name: "Retained folder server",
          url: serverUrl,
        });
        await servers.selectServerConnection(saved.id);
        const current = await account.getAuthSession();
        const bootstrap = await account.getServerBootstrap();
        session.setClientSession({
          authMode: "accounts",
          serverId: bootstrap.server.id,
          user: current.currentUser,
          csrfToken: current.csrfToken,
          expiresAt: current.expiresAt,
        });
        if (
          bootstrap.server.id !== window.folderIdentity.serverId ||
          current.currentUser.id !== window.folderIdentity.ownerId
        )
          throw new Error("Retained server/account identity changed");
        const { prepareClientEncryption } =
          await import("/src/lib/account-encryption.ts");
        const access = await prepareClientEncryption({
          authMode: "accounts",
          identity: window.folderIdentity,
          password,
        });
        if (access.status !== "ready")
          throw new Error("Retained encryption was not ready");
        const projects = await window.folderWire.getProjectWireList();
        const { decodePrivateDisplayLabelForClient } =
          await import("/src/lib/private-label-encryption.ts");
        const labels = await Promise.all(
          projects.map((project) =>
            decodePrivateDisplayLabelForClient({
              identity: window.folderIdentity,
              opaque: project.nameProtection,
              recordKind: "project",
              rowId: project.id,
            }),
          ),
        );
        return { projects, labels };
      },
      { serverUrl: fixture.server.origin, password },
    );
    assert.deepEqual(retained.projects, wire);
    assert.deepEqual(retained.labels, names);
    if (workspace) await retainedWorkspaceClient({ page, workspace, result });
    if (
      surface ||
      legacySurface ||
      computerUse ||
      tunnel ||
      projectShares ||
      fileDocuments ||
      projectSurfaces ||
      process.argv.includes("--replicas")
    ) {
      await startWorker();
      if (computerUse)
        await actualComputerUse({
          page,
          prepared: computerUse,
          result,
          phase: "retained",
        });
      if (projectSurfaces)
        await retainedWorkerProjectSurfaces({
          page,
          surface: projectSurfaces,
          result,
        });
      if (gitView)
        await retainedProjectGitViews({ page, view: gitView, result });
      if (fileDocuments)
        await retainedWorkerFileDocument({
          page,
          workerId,
          document: fileDocuments,
          result,
        });
      if (legacySurface)
        await actualRemoteSurface({
          page,
          surface: legacySurface,
          result,
          diagnostics: () => worker.diagnostics(),
        });
      if (surface)
        await actualWorkerBrowserSurface({
          page,
          surface,
          workerId,
          result,
          route: workerLinkRoute,
        });
      if (tunnel)
        await actualWorkerTunnelLink({
          page,
          tunnel,
          result,
          route: workerLinkRoute,
        });
      if (tunnel)
        await actualWorkerTunnelRelay({ page, tunnel, result, fixture });
      if (projectShares)
        await finishProjectShares({
          page,
          prepared: projectShares,
          scratch,
          result,
          requests,
        });
      if (projectShares)
        await liveWorkerShareRestart({
          page,
          fixture,
          project: first,
          workerId,
          worker,
          result,
          requests,
        });
      await stopWorker();
    }
    for (const project of retained.projects)
      assert.equal((await job(project.id)).state, "succeeded");
    result.steps.push(
      "server restart retains identity, encrypted labels, source handles and all completed job states",
    );
    if (
      process.argv.includes("--operational-status") ||
      process.argv.includes("--worker-logs") ||
      process.argv.includes("--project-insights")
    ) {
      await startWorker();
      await page.evaluate(() => window.folderLive.start());
      await eventually(workers, (values) =>
        assert.equal(values[0].online, true),
      );
      if (process.argv.includes("--operational-status"))
        await actualOperationalStatus({
          fixture,
          page,
          worker,
          result,
          databaseMode,
          phase: "restarted",
          secrets: [...names, existingPath, missingPath],
        });
      if (process.argv.includes("--worker-logs"))
        await actualWorkerLogs({
          page,
          fixture,
          workerId,
          result,
          phase: "restarted",
        });
      if (process.argv.includes("--project-insights"))
        await actualProjectInsights({
          page,
          projectId: created.id,
          workerId,
          directory: await filesystem(created.id),
          result,
          phase: "restarted",
        });
      await stopWorker();
      if (process.argv.includes("--worker-logs"))
        await actualWorkerLogsDisconnected({
          page,
          result,
          phase: "restarted",
        });
      await page.evaluate(() => window.folderLive.stop());
    }
    result.projects = wire.map((project) => ({
      originKind: project.originKind,
      setupStatus: project.setupStatus,
      ownershipKind: project.source.ownershipKind,
      capabilities: project.capabilities,
    }));
    if (process.argv.includes("--replicas"))
      await actualProjectReplicas({
        page,
        fixture,
        root,
        projectId: attached.id,
        directory: normalizeProjectSourcePath(await realpath(existingPath)),
        startWorker,
        stopWorker,
        cliBinary,
        result,
      });
    if (
      process.argv.includes("--worktrees") ||
      process.argv.includes("--chat-controls")
    )
      await actualProjectWorktrees({
        page,
        fixture,
        root,
        executable: surfaceRepositoryBinary,
        projectId: attached.id,
        directory: normalizeProjectSourcePath(await realpath(existingPath)),
        startWorker,
        stopWorker,
        result,
      });
    if (process.argv.includes("--workspace-discovery"))
      await actualWorkspaceDiscovery({
        page,
        fixture,
        dataDirectory,
        workerId,
        startWorker,
        stopWorker,
        result,
      });
    if (process.argv.includes("--github-conversion"))
      await actualGithubConversion({
        page,
        fixture,
        dataDirectory,
        workerId,
        startWorker,
        stopWorker,
        result,
      });
    if (process.argv.includes("--native-single-recovery")) {
      if (!worker) await startWorker();
      await actualSingleInflightClient({
        fixture,
        page,
        projectId: first.id,
        workerId,
        worker,
        dataDirectory,
        requests,
        result,
      });
    }
    if (process.argv.includes("--native-task-goal-worker-recovery")) {
      if (worker) await stopWorker();
      await actualTaskGoalWorkerInflightClient({
        fixture,
        page,
        projectId: first.id,
        workerId,
        dataDirectory,
        getWorker: () => worker,
        startWorker,
        stopWorker,
        crashWorker,
        requests,
        result,
      });
    }
    if (process.argv.includes("--native-worker-recovery")) {
      if (worker) await stopWorker();
      await actualWorkerInflightClient({
        operationKind: option("--worker-recovery-kind") ?? "direct",
        fixture,
        page,
        projectId: first.id,
        workerId,
        dataDirectory,
        getWorker: () => worker,
        startWorker,
        stopWorker,
        crashWorker,
        requests,
        result,
      });
    }
    if (process.argv.includes("--native-inflight-recovery")) {
      if (!worker) await startWorker();
      await actualNativeInflightClient({
        fixture,
        page,
        projectId: first.id,
        workerId,
        worker,
        dataDirectory,
        postgresCluster: postgres?.cluster,
        requests,
        result,
      });
    }
    if (runTaskProduct)
      await actualTaskClient({
        page,
        fixture,
        projectId: first.id,
        workerId,
        startWorker,
        stopWorker,
        result,
        requests,
        taskOutcomeOrder,
        taskGoalFirstInputOrder,
        taskGoalTransferWorkerData: taskGoalProviderTransfer
          ? dataDirectory
          : undefined,
        taskGoalAutonomousTransfer,
        taskGoalTransferredPause,
        taskGoalTransferFault: taskGoalTransferFaultFile
          ? {
              mode: taskGoalTransferFaultMode,
              file: taskGoalTransferFaultFile,
              ...(taskGoalSharedFault
                ? {
                    interruptAfterCommit: (held, interruption) => {
                      const context = {
                        fixture,
                        workerId,
                        worker,
                        file: taskGoalTransferFaultFile,
                        held,
                        interruption,
                      };
                      return taskGoalTransferPeer
                        ? interruptTaskGoalTransferPeer({
                            ...context,
                            peer: taskGoalTransferPeer,
                          })
                        : interruptTaskGoalTransferDependency({
                            ...context,
                            dependency: taskGoalTransferDependency,
                            cluster: postgres?.cluster,
                          });
                    },
                  }
                : {}),
              restartWorker: async (previousPid) => {
                assert.equal(worker.child.pid, previousPid);
                await crashWorker();
                return (await startWorker()).child.pid;
              },
            }
          : undefined,
        goalLaneScenario:
          goalLaneFault || process.argv.includes("--task-goal-recovered-lane")
            ? {
                faultFile: goalLaneFault,
                dependency: goalLaneDependency,
                cluster: postgres?.cluster,
              }
            : undefined,
      });
    if (cliWorktreeAcquire) {
      if (worker) await stopWorker();
      const port = Number(new URL(fixture.server.origin).port);
      await fixture.close();
      const repository = await repositoryFixture({
        kind: fixture.kind,
        root: path.join(root, fixture.name),
        executable: surfaceRepositoryBinary,
        databaseMode: fixture.databaseMode,
        databaseUrl: fixture.environment.DATABASE_URL,
      });
      try {
        // The browser attached a real local Git checkout. Seed only the
        // catalog classification used by existing worktree acceptance.
        await repository.seed(
          `UPDATE projects SET origin_kind='github',folder_management=NULL,git_capability=true,github_capability=true,worktree_policy='agent-managed',github_repository_blind_index='actual-cli-worktree-fixture' WHERE id=${literal(attached.id)}`,
        );
      } finally {
        await repository.close();
      }
      await fixture.start({ port });
    }
    if (
      process.argv.includes("--project-chats") ||
      gitProjectChat ||
      process.argv.includes("--native-single-agent-recovery") ||
      process.argv.includes("--native-shared-agent-recovery")
    ) {
      if (worker) await stopWorker();
      await actualProjectChatClient({
        page,
        fixture,
        projectId: gitProjectChat ? attached.id : first.id,
        projectRoot: gitProjectChat ? opened.source.path : first.source.path,
        ...(cliWorktreeAcquire ? { cliWorktreeAcquire: cliBinary } : {}),
        workerDataDirectory: dataDirectory,
        workerId,
        startWorker,
        stopWorker,
        result,
        requests,
        providerBoundary,
        ...(process.argv.includes("--native-single-agent-recovery") ||
        process.argv.includes("--native-shared-agent-recovery")
          ? {
              interruptNativeStream: (process.argv.includes(
                "--profile-runtime-recovery",
              )
                ? profileAgentInterruption
                : nativeAgentInterruption)({
                fixture,
                page,
                projectId: first.id,
                workerId,
                getWorker: () => worker,
                dataDirectory,
                result,
                ...(process.argv.includes("--native-shared-agent-recovery")
                  ? { peer: option("--agent-crash-peer") ?? "client" }
                  : {}),
              }),
            }
          : {}),
      });
    }
    if (
      cantripOsRun ||
      cantripOsSurfaces ||
      cantripOsSourceBackup ||
      process.argv.includes("--cantrip-os") ||
      process.argv.includes("--cantrip-os-system")
    ) {
      if (!worker) await startWorker();
      await actualCantripOsClient({
        runProjectId: cantripOsRun ? first.id : undefined,
        surfaceProjectId: cantripOsSurfaces ? first.id : undefined,
        fakeHostDesktopInventory,
        backupProjectId: cantripOsSourceBackup ? first.id : undefined,
        page,
        fixture,
        root,
        dataDirectory,
        workerId,
        startWorker,
        stopWorker,
        crashWorker,
        result,
      });
    }
    if (process.argv.includes("--provider-catalog")) {
      if (!worker) await startWorker();
      await actualProviderCatalogClient({
        page,
        fixture,
        root,
        dataDirectory,
        workerId,
        cliBinary,
        startWorker,
        stopWorker,
        requests,
        result,
      });
    }
    if (process.argv.includes("--model-operations")) {
      if (modelServerLoss) assert.ok(fixture instanceof SingleProductFixture);
      if (!worker) await startWorker();
      await actualModelOperationsClient({
        page,
        fixture,
        workerId,
        startWorker,
        stopWorker,
        crashWorker,
        workerProcessForInterruption:
          modelServerLoss || modelPostgresOutage || modelRedisOutage
            ? () => worker?.child
            : undefined,
        postgresOutage: modelPostgresOutage ? postgres.cluster : undefined,
        settleModelWhilePostgresOffline,
        redisOutage: modelRedisOutage,
        requests,
        result,
      });
    }
    if (process.argv.includes("--rolling-servers")) {
      if (!worker) await startWorker();
      await verifySharedProductRolling({
        fixture,
        page,
        projectId: first.id,
        workerId,
        directory: await filesystem(first.id),
        dataDirectory,
        worker,
        credential,
        result,
      });
    }
    if (process.argv.includes("--redis-offline-shutdown")) {
      if (!worker) await startWorker();
      await verifySharedProductOfflineShutdown({
        fixture,
        worker,
        workerId,
        result,
      });
    }
    result.requests = requests;
    if (process.argv.includes("--project-administration")) {
      if (!worker) await startWorker();
      await actualProjectAdministration({
        page,
        fixture,
        root,
        executable: surfaceRepositoryBinary,
        workerId,
        workerDataDirectory: dataDirectory,
        attached: opened,
        existingPath,
        create,
        waitJob,
        filesystem,
        startWorker,
        stopWorker,
        result,
      });
    }
    result.events = await page.evaluate(() => window.folderEvents);
    assert.deepEqual(errors, []);
  } catch (error) {
    productFailed = true;
    throw error;
  } finally {
    if (providerBoundary) {
      result.providerBoundaryDiagnostics = {
        failures: providerBoundary.failures,
        requests: providerBoundary.requests,
        tunnels: providerBoundary.tunnels,
        blockedTunnels: providerBoundary.blockedTunnels,
        discoveryProbes: providerBoundary.discoveryProbes,
      };
    }
    const cleanup = [
      ["worker", stopWorker],
      ["tunnel", () => tunnel?.close()],
      ["provider boundary", () => providerBoundary?.close()],
      [
        "browser context",
        async () => {
          await page.evaluate(() => window.folderLive?.stop()).catch(() => {});
          await context.close();
        },
      ],
    ];
    let firstCleanupError;
    for (const [resource, close] of cleanup) {
      try {
        await close();
      } catch (error) {
        firstCleanupError ??= error;
        (result.productCleanupFailures ??= []).push({
          resource,
          message: error.message,
          stack: error.stack,
          code: error.code,
          signal: error.signal,
          killed: error.killed,
        });
      }
    }
    if (!productFailed && firstCleanupError) throw firstCleanupError;
  }
}
try {
  if (fakeCuaLauncher) {
    const binary = path.resolve(
      process.env.CANTRIP_TEST_CUA_BIN ??
        path.join(repositoryRoot, "cantrip_worker/bin/cantrip-cua"),
    );
    const quotedBinary = "'" + binary.replaceAll("'", "'\\''") + "'";
    await writeFile(
      fakeCuaLauncher,
      `#!/bin/sh\nexec ${quotedBinary} --backend fake\n`,
      {
        mode: 0o700,
      },
    );
  }
  const usesNative = runtimeCases.some((kinds) => kinds.includes("rust"));
  const executable = !usesNative
    ? undefined
    : liveTaskDiagnostics
      ? await buildRustExample("http-sql-fixture")
      : (process.env.CANTRIP_TEST_SERVER_BINARY ?? (await buildRustServer()));
  if (
    approvalCancellation ||
    process.argv.includes("--tunnels") ||
    process.argv.includes("--project-shares") ||
    process.argv.includes("--worktrees") ||
    gitProjectChat ||
    process.argv.includes("--project-administration")
  )
    surfaceRepositoryBinary = !usesNative
      ? undefined
      : (process.env.CANTRIP_TEST_PROJECT_REPOSITORY_BINARY ??
        (await buildRustExample("project-repository-fixture")));
  const cliBinary =
    process.env.CANTRIP_TEST_CLI_BIN ?? (await buildWorkerCli());
  const nativeProbeBinary = process.argv.includes("--native-probe")
    ? await buildDesktopDirectProbe()
    : undefined;
  const directBrokerBinary =
    process.argv.includes("--terminal-direct") || workerLinkRenewal
      ? (process.env.CANTRIP_TEST_DESKTOP_BROKER_BINARY ??
        (await buildRustExample("desktop-direct-broker")))
      : undefined;
  vite = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, "vite.config.ts"),
    cacheDir: path.join(root, "vite"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    // These optional workspace imports otherwise trigger a Vite page reload
    // halfway through a cold acceptance run, discarding its real client state.
    optimizeDeps: {
      include: [
        "@capacitor/network",
        "@tauri-apps/api/dpi",
        "@tauri-apps/api/webviewWindow",
        "@tauri-apps/api/window",
      ],
    },
    plugins: [
      {
        name: "actual-folder-client",
        configureServer(server) {
          server.middlewares.use(
            "/__actual_surface_fixture",
            (request, response) => {
              surfaceFixtureRequests.push({
                path: request.url,
                method: request.method,
                at: Date.now(),
              });
              response.setHeader("content-type", "text/html");
              response.end(
                "<!doctype html><html><body style='background:linear-gradient(45deg,#f82,#28f);height:100vh'><h1>Private remote browser</h1><script>const n=Number(sessionStorage.loads||0)+1;sessionStorage.loads=n;document.title=location.pathname.split('/').pop()+':'+n;</script></body></html>",
              );
            },
          );
          server.middlewares.use(
            "/__actual_folder_fixture",
            async (_request, response, next) => {
              try {
                const html = await server.transformIndexHtml(
                  "/__actual_folder_fixture",
                  "<!doctype html><html><title>Actual folder client</title><body>Disposable folder acceptance</body></html>",
                );
                response.setHeader("content-type", "text/html");
                response.end(html);
              } catch (error) {
                next(error);
              }
            },
          );
        },
      },
    ],
  });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CANTRIP_TEST_BROWSER_BINARY || undefined,
  });
  if (databaseMode !== "pglite")
    postgres = await postgresFixture(path.join(root, "postgres"), {
      restartable:
        postgresOutage ||
        modelPostgresOutage ||
        goalLaneDependency === "postgres" ||
        Boolean(taskGoalTransferDependency),
    });
  for (const kinds of runtimeCases) {
    const kind = kinds[0];
    const fixtureOptions = {
      kind,
      executable,
      root,
      name: sharedPair ? "actual-folder-" + kinds.join("-") : "actual-folder",
      databaseMode,
      providerAuthDrain: true,
      liveSqlFixture: liveTaskDiagnostics,
      environment: {
        CANTRIP_AUTH_MODE: "accounts",
        // Retained-session product flows use the normal server lifetime. The
        // short HTTP fixture lifetime can expire during an emulated restart.
        CANTRIP_SESSION_TTL_SECONDS: String(30 * 24 * 60 * 60),
        ...(process.argv.includes("--operational-status")
          ? { CANTRIP_METRICS_TOKEN: operationalProductToken }
          : {}),
        ...(cantripOsSurfaces
          ? { CANTRIP_WORKER_LINK_RELAY_ONLY: "true" }
          : workerLinkRenewal
            ? {
                CANTRIP_WORKER_LINK_RELAY_ONLY: "false",
                CANTRIP_WORKER_LINK_LOCAL_ENABLED: "true",
                CANTRIP_WORKER_LINK_LAN_ENABLED: "true",
                CANTRIP_WORKER_LINK_WAN_ENABLED: "false",
              }
            : process.argv.includes("--worker-links")
              ? workerLinkRoute === "relay"
                ? { CANTRIP_WORKER_LINK_RELAY_ONLY: "true" }
                : {
                    CANTRIP_WORKER_LINK_RELAY_ONLY: "false",
                    CANTRIP_WORKER_LINK_LOCAL_ENABLED: "false",
                    CANTRIP_WORKER_LINK_LAN_ENABLED: "true",
                    CANTRIP_WORKER_LINK_WAN_ENABLED: "false",
                  }
              : {}),
        CANTRIP_APP_ORIGINS: `http://127.0.0.1:5173,${new URL(vite.resolvedUrls.local[0]).origin}`,
      },
    };
    const fixture = sharedPair
      ? await SharedProductFixture.create({
          ...fixtureOptions,
          clientKind: kinds[0],
          workerKind: kinds[1],
          databaseUrl: await postgres.database(),
        })
      : process.argv.includes("--profile-runtime-recovery")
        ? new ProfileRuntimeFixture({
            ...fixtureOptions,
            nativeAssets: option("--native-assets"),
            profileConverter: option("--profile-converter"),
            profileSnapshotProbe: option("--profile-snapshot-probe"),
            createProfileDatabase: () => postgres.database(),
            samePostgres: process.argv.includes("--profile-same-postgres"),
          })
        : singleProduct
          ? new SingleProductFixture(fixtureOptions)
          : new HttpFixture(fixtureOptions);
    if (postgres && !sharedPair) {
      if (kind === "node" || databaseMode === "postgres")
        fixture.environment.DATABASE_URL = await postgres.database();
      else
        fixture.environment.CANTRIP_POSTGRES_BIN_DIR =
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR;
    }
    const result = {
      kind: sharedPair ? kinds.join("/") : kind,
      steps: [],
      workerStops: [],
      workerDiagnostics: [],
    };
    report.runtimes.push(result);
    if (fixture instanceof ProfileRuntimeFixture) {
      result.profileRuntimeTransfers = fixture.transfers;
      result.profileRuntimeGenerations = fixture.generations;
    }
    if (fullServerLogs) {
      const start = fixture.start.bind(fixture);
      fixture.start = async (...args) => {
        await start(...args);
        for (const peer of fixture.peers ?? [fixture]) {
          const child = peer.server.child;
          const observation = {
            kind: peer.kind,
            pid: child.pid,
            command: child.spawnfile,
            arguments: child.spawnargs.slice(1),
          };
          try {
            const bytes = await readFile(child.spawnfile);
            observation.executableSha256 = createHash("sha256")
              .update(bytes)
              .digest("hex");
            observation.executableBytes = bytes.length;
          } catch (error) {
            observation.executableObservationError = error.message;
          }
          (result.serverProcesses ??= []).push(observation);
        }
        const generation = (result.serverDiagnosticFiles ??= []).length + 1;
        const file = path.join(root, `${kind}-server-${generation}.stderr.log`);
        appendFileSync(file, "");
        result.serverDiagnosticFiles.push(file);
        fixture.server.child.stderr.on("data", (chunk) =>
          appendFileSync(file, chunk),
        );
      };
    }
    const close = fixture.close.bind(fixture);
    fixture.close = async (...args) => {
      const server = fixture.server;
      try {
        return await close(...args);
      } finally {
        if (server) {
          const observation = {
            exit: {
              code: server.child.exitCode,
              signal: server.child.signalCode,
            },
            stages: server.events.filter(
              (event) => event.event === "server.shutdown.stage",
            ),
            diagnostics: server.diagnostics(),
          };
          if (fullServerLogs) {
            try {
              observation.fullDiagnostics = await readFile(
                result.serverDiagnosticFiles.at(-1),
                "utf8",
              );
            } catch (cause) {
              observation.diagnosticFileError = cause.message;
            }
          }
          (result.serverShutdowns ??= []).push(observation);
        }
      }
    };
    let productFailed = false;
    try {
      await fixture.start();
      await flow(
        fixture,
        result,
        cliBinary,
        nativeProbeBinary,
        directBrokerBinary,
      );
    } catch (error) {
      productFailed = true;
      throw error;
    } finally {
      try {
        if (sharedPair) await fixture.dispose();
        else await fixture.close();
      } catch (error) {
        result.serverCleanupFailure = {
          message: error.message,
          stack: error.stack,
        };
        if (!productFailed) throw error;
      } finally {
        if (sharedPair) result.sharedServerGenerations = fixture.generations;
        else if (fixture.generations)
          result.singleServerGenerations = fixture.generations;
      }
    }
  }
  for (const runtime of report.runtimes.slice(1)) {
    assert.deepEqual(runtime.steps, report.runtimes[0].steps);
    assert.deepEqual(runtime.projects, report.runtimes[0].projects);
    if (providerAuth)
      assert.deepEqual(runtime.providerAuth, report.runtimes[0].providerAuth);
    if (taskLabel)
      assert.deepEqual(
        runtime.taskLabel.summary,
        report.runtimes[0].taskLabel.summary,
      );
    if (inlineChatLabels)
      assert.deepEqual(
        runtime.inlineChatLabels.summary,
        report.runtimes[0].inlineChatLabels.summary,
      );
    if (approvalCancellation)
      assert.deepEqual(
        runtime.approvalCancellation.summary,
        report.runtimes[0].approvalCancellation.summary,
      );
    if (
      cantripOsRun ||
      cantripOsSurfaces ||
      cantripOsSourceBackup ||
      process.argv.includes("--cantrip-os") ||
      process.argv.includes("--cantrip-os-system")
    )
      assert.deepEqual(
        runtime.cantripOs.summary,
        report.runtimes[0].cantripOs.summary,
      );
    if (process.argv.includes("--provider-catalog"))
      assertProviderCatalogSummary(
        runtime.providerCatalog.summary,
        report.runtimes[0].providerCatalog.summary,
      );
    if (process.argv.includes("--model-operations"))
      assert.deepEqual(
        runtime.modelOperations.summary,
        report.runtimes[0].modelOperations.summary,
      );
    if (process.argv.includes("--native-single-recovery"))
      assert.deepEqual(
        runtime.singleInflight.summary,
        report.runtimes[0].singleInflight.summary,
      );
    if (process.argv.includes("--native-task-goal-worker-recovery"))
      assert.deepEqual(
        runtime.taskGoalWorkerInflight.summary,
        report.runtimes[0].taskGoalWorkerInflight.summary,
      );
    if (process.argv.includes("--native-worker-recovery"))
      assert.deepEqual(
        runtime.workerInflight.summary,
        report.runtimes[0].workerInflight.summary,
      );
    if (process.argv.includes("--native-inflight-recovery"))
      assert.deepEqual(
        runtime.nativeInflight.summary,
        report.runtimes[0].nativeInflight.summary,
      );
    if (process.argv.includes("--native-shared-agent-recovery"))
      assert.deepEqual(
        runtime.sharedAgentInflight.summary,
        report.runtimes[0].sharedAgentInflight.summary,
      );
    if (process.argv.includes("--tasks")) {
      const { chatId: currentId, ...current } = runtime.taskExecution;
      const { chatId: baselineId, ...baseline } =
        report.runtimes[0].taskExecution;
      assert.ok(currentId && baselineId);
      assert.deepEqual(current, baseline);
    }
    if (process.argv.includes("--chat-customizations"))
      assert.deepEqual(
        runtime.chatCustomizationSummary,
        report.runtimes[0].chatCustomizationSummary,
      );
    if (process.argv.includes("--mcp-settings"))
      assert.deepEqual(
        runtime.mcpSettingsSummary,
        report.runtimes[0].mcpSettingsSummary,
      );
    if (process.argv.includes("--skill-settings"))
      assert.deepEqual(
        runtime.skillSettingsSummary,
        report.runtimes[0].skillSettingsSummary,
      );
    if (process.argv.includes("--provider-test")) {
      assert.deepEqual(
        runtime.nativeProviderProbeResults,
        report.runtimes[0].nativeProviderProbeResults,
      );
      assert.deepEqual(
        runtime.providerConnectionSummary,
        report.runtimes[0].providerConnectionSummary,
      );
    }
    if (
      process.argv.includes("--github-conversion") ||
      process.argv.includes("--workspace-discovery")
    )
      assert.deepEqual(
        runtime.githubConversionSummary,
        report.runtimes[0].githubConversionSummary,
      );
    if (process.argv.includes("--workspace-discovery"))
      assert.deepEqual(
        runtime.workspaceDiscoverySummary,
        report.runtimes[0].workspaceDiscoverySummary,
      );
    if (process.argv.includes("--github-replicas"))
      assert.deepEqual(
        runtime.githubReplicaSummary,
        report.runtimes[0].githubReplicaSummary,
      );
    if (process.argv.includes("--replicas")) {
      assert.deepEqual(
        replicaProductJobEvents(runtime),
        replicaProductJobEvents(report.runtimes[0]),
      );
    }
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await browser?.close();
  await vite?.close();
  await postgres?.close();
  if (failure || process.argv.includes("--keep-fixture")) {
    report.fixtureRoot = root;
    console.error("Retained full-worker fixture:", root);
  } else {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failure = error;
      report.fixtureRoot = root;
      report.failure = { message: error.message, stack: error.stack };
      report.cleanupFailure = {
        code: error.code,
        syscall: error.syscall,
        path: error.path,
      };
      console.error("Retained full-worker fixture after cleanup failed:", root);
    }
  }
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    report.surfaceFixtureRequests = surfaceFixtureRequests;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(
    JSON.stringify({
      suite: report.suite,
      databaseMode,
      runtimes: report.runtimes.map((runtime) => ({
        kind: runtime.kind,
        steps: runtime.steps.length,
        stoppedWorkers: runtime.workerStops.length,
      })),
      ...(failure ? { failure: report.failure } : {}),
    }),
  );
}
if (failure) throw failure;
