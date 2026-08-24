import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverSourcePath = resolve(repositoryRoot, "cantrip_server/src");
const appPath = resolve(serverSourcePath, "app.ts");
const schemaPath = resolve(serverSourcePath, "db/schema.ts");
const protocolPath = resolve(repositoryRoot, "packages/protocol/src/index.ts");
const endpointContentProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/endpoint-content.ts",
);
const liveProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/live.ts",
);
const tunnelDataPlaneProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/tunnel-data-plane.ts",
);
const surfaceStreamProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/surface-stream.ts",
);
const repositoryOperationProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/repository-operation.ts",
);
const automationProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/automations.ts",
);
const workflowProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/workflows.ts",
);
const clientApiPath = resolve(repositoryRoot, "cantrip_app/src/lib/api.ts");
const clientAutomationEncryptionPath = resolve(
  repositoryRoot,
  "cantrip_app/src/lib/project-automation-encryption.ts",
);
const clientAutomationSettingsPath = resolve(
  repositoryRoot,
  "cantrip_app/src/components/projects/project-automations-settings.tsx",
);
const clientWorkflowApiPath = resolve(
  repositoryRoot,
  "cantrip_app/src/lib/workflow-api.ts",
);
const clientWorkflowEncryptionPath = resolve(
  repositoryRoot,
  "cantrip_app/src/lib/workflow-encryption.ts",
);
const clientWorkflowTriggerEncryptionPath = resolve(
  repositoryRoot,
  "cantrip_app/src/lib/workflow-trigger-encryption.ts",
);
const workerPath = resolve(repositoryRoot, "cantrip_worker/src/index.ts");
const workerAutomationEncryptionPath = resolve(
  repositoryRoot,
  "cantrip_worker/src/automation-encryption.ts",
);
const workerRoutingPath = resolve(
  repositoryRoot,
  "cantrip_worker/src/routing-registry.ts",
);
const remoteSurfaceStreamProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/remote-surface-stream.ts",
);
const remoteSurfaceTransportPath = resolve(
  repositoryRoot,
  "cantrip_app/src/lib/use-remote-surface-transport.ts",
);
const remoteSurfaceManagerPath = resolve(
  repositoryRoot,
  "cantrip_worker/src/remote-surface-manager.ts",
);
const remoteSurfaceRelayPath = resolve(
  repositoryRoot,
  "cantrip_server/src/remote-surfaces/relay.ts",
);
const repositoryFiles = [
  "encryption-registry.ts",
  "project-automations.ts",
  "repository.ts",
  "tab-layouts.ts",
  "workflow-runs.ts",
  "workflow-triggers.ts",
  "workflows.ts",
].map((file) => resolve(repositoryRoot, "cantrip_server/src/db", file));
const inventoryPath = resolve(
  repositoryRoot,
  "docs/security/server-route-inventory.json",
);
const encryptionPlanPath = resolve(repositoryRoot, "docs/ENCRYPTION.md");

const CONTENT_CLASSIFICATIONS = new Set([
  "endpoint-protected",
  "hashed-validator",
  "minimized-operational-metadata",
  "intentionally-public-control-plane",
  "worker-local",
  "tracked-rollout-gap",
]);

// These digests deliberately freeze the reviewed set of server-bound
// contracts. Adding a route, worker command, live resource, or CLI command
// requires reviewing its content classification and updating the matching
// digest; regenerating the inventory alone cannot silently accept it.
const REVIEWED_CONTRACT_DIGESTS = {
  agentOperations:
    "499e1068b6698d4c02a1bce0d8cece079586bdc8852b406a2b8e261aeee5577a",
  applicationRoutes:
    "21dd9aeb49b3197384c1c0345e73b504a198e47f6bc51620d610e3e581c15119",
  clientControlCommands:
    "01a782577811c682e042075b47fe39a20b9f0f7e591db99243cbab517b2fca08",
  cliCommands:
    "c60e6813bbd3b2ed4df9a4b2377d8b1db15dafcf9c16fef4034cb0739fe88ad5",
  liveResources:
    "e0d8d028aad8247d7111b25b002989e944cc0df1a006a436fc6978da350524f9",
  workerCommands:
    "6716ab3a1581e8658fdf782c99708e8b8b4af886832d7c371ecab5fd59d38ba2",
  tunnelFrameKinds:
    "27d422d79d199318f4c3d662192f7b35dc1b878bc4f13c7dd5c58a5f2e7edae8",
};

const DURABLE_TABLE_CLASSIFICATIONS = {
  systemState: "intentionally-public-control-plane",
  users: "intentionally-public-control-plane",
  accountLicenseWhitelist: "intentionally-public-control-plane",
  userSessions: "hashed-validator",
  mobileSignInGrants: "hashed-validator",
  auditEvents: "minimized-operational-metadata",
  workerEnrollmentCodes: "hashed-validator",
  modelProviders: "endpoint-protected",
  modelProviderAccounts: "endpoint-protected",
  modelProviderAccountWorkers: "intentionally-public-control-plane",
  providerQuotaObservations: "minimized-operational-metadata",
  providerModels: "intentionally-public-control-plane",
  providerModelCatalogSnapshots: "minimized-operational-metadata",
  providerModelAvailability: "minimized-operational-metadata",
  providerCatalogSyncStates: "minimized-operational-metadata",
  providerModelSuppressions: "intentionally-public-control-plane",
  modelProfiles: "intentionally-public-control-plane",
  modelRoutes: "intentionally-public-control-plane",
  userSettings: "intentionally-public-control-plane",
  policyOwnerStates: "intentionally-public-control-plane",
  policies: "endpoint-protected",
  workers: "intentionally-public-control-plane",
  workerCredentials: "hashed-validator",
  accountEncryptionProfiles: "endpoint-protected",
  encryptionPrincipals: "endpoint-protected",
  encryptionKeyGrants: "endpoint-protected",
  projects: "endpoint-protected",
  tunnels: "endpoint-protected",
  tunnelAttachments: "minimized-operational-metadata",
  mcpServers: "endpoint-protected",
  projectWorkspaces: "endpoint-protected",
  projectWorkspaceMemberships: "intentionally-public-control-plane",
  projectPolicyAssignments: "intentionally-public-control-plane",
  workspacePolicyAssignments: "intentionally-public-control-plane",
  tabGroups: "endpoint-protected",
  tabGroupMembers: "intentionally-public-control-plane",
  projectSources: "endpoint-protected",
  projectWorktrees: "endpoint-protected",
  worktreeSetupJobs: "minimized-operational-metadata",
  projectFolderSetupJobs: "minimized-operational-metadata",
  projectGithubConversionJobs: "minimized-operational-metadata",
  projectReplicaJobs: "minimized-operational-metadata",
  gitOperations: "endpoint-protected",
  runInstances: "minimized-operational-metadata",
  chats: "endpoint-protected",
  tasks: "endpoint-protected",
  taskPlanningRounds: "endpoint-protected",
  terminals: "endpoint-protected",
  explorers: "endpoint-protected",
  codeTabs: "endpoint-protected",
  codeSessions: "intentionally-public-control-plane",
  codeSettingsProfiles: "endpoint-protected",
  browsers: "endpoint-protected",
  remoteSurfaces: "endpoint-protected",
  projectViews: "endpoint-protected",
  chatRuntimeSessions: "intentionally-public-control-plane",
  chatExecutionLanes: "intentionally-public-control-plane",
  agentInteractionRequests: "endpoint-protected",
  chatMessages: "endpoint-protected",
  tokenUsageRecords: "minimized-operational-metadata",
  modelBehaviorObservations: "minimized-operational-metadata",
  chatAttachments: "endpoint-protected",
  chatAttachmentReplicas: "intentionally-public-control-plane",
  chatRelocationJobs: "minimized-operational-metadata",
  chatImportJobs: "minimized-operational-metadata",
  chatRelocationSnapshots: "endpoint-protected",
  queuedPrompts: "endpoint-protected",
  projectAutomations: "endpoint-protected",
  projectAutomationRuns: "endpoint-protected",
  workflowDefinitions: "endpoint-protected",
  workflowRevisions: "endpoint-protected",
  workflowRevisionNodes: "intentionally-public-control-plane",
  workflowRevisionEdges: "intentionally-public-control-plane",
  workflowRuns: "endpoint-protected",
  workflowAutomationTriggers: "endpoint-protected",
  workflowTriggerDeliveries: "endpoint-protected",
  workflowRunNodes: "endpoint-protected",
  workflowRunNodeDependencies: "intentionally-public-control-plane",
  workflowRunNodeItems: "endpoint-protected",
  workflowNodeAttempts: "endpoint-protected",
  workflowWorktreeLeases: "minimized-operational-metadata",
  projectBranchLeases: "minimized-operational-metadata",
  workflowRunEvents: "endpoint-protected",
  workflowApprovalGates: "endpoint-protected",
  accountStorageUsageCurrent: "minimized-operational-metadata",
  accountStorageUsageSnapshots: "minimized-operational-metadata",
  accountStorageReconciliationLeases: "minimized-operational-metadata",
  accountBandwidthUsageBuckets: "minimized-operational-metadata",
  accountBandwidthFlushes: "minimized-operational-metadata",
};

const prohibitedTaskProtocolSymbols = new Set([
  "TaskContinuationStart",
  "TaskDetail",
  "TaskDraftUpdate",
  "TaskFinalizerResult",
  "TaskGoalObjectiveProtectedContent",
  "TaskGoalSnapshot",
  "TaskImplementationDashboard",
  "TaskMessageProtectedContent",
  "TaskOperationStart",
  "TaskPlanUpdate",
  "TaskPlannerResult",
  "TaskPlanningRound",
  "TaskPlanningRoundProtectedContent",
  "TaskProtectedContent",
  "TaskQuestion",
  "TaskQuestionAnswer",
  "taskContinuationStartSchema",
  "taskDetailSchema",
  "taskDraftUpdateSchema",
  "taskFinalizerOutputJsonSchema",
  "taskFinalizerResultSchema",
  "taskGoalObjectiveProtectedContentSchema",
  "taskGoalSnapshotSchema",
  "taskImplementationDashboardSchema",
  "taskLastErrorSchema",
  "taskMessageProtectedContentSchema",
  "taskOperationStartSchema",
  "taskPlanUpdateSchema",
  "taskPlannerOutputJsonSchema",
  "taskPlannerResultSchema",
  "taskPlanningRoundListSchema",
  "taskPlanningRoundProtectedContentSchema",
  "taskPlanningRoundSchema",
  "taskProtectedContentSchema",
  "taskQuestionAnswerListSchema",
  "taskQuestionAnswerSchema",
  "taskQuestionListSchema",
  "taskQuestionOptionSchema",
  "taskQuestionSchema",
]);

const prohibitedPolicyProtocolSymbols = new Set([
  "AgentPolicyContext",
  "EffectivePolicyList",
  "EffectivePolicySummary",
  "PolicyAssignmentList",
  "PolicyCliListResult",
  "PolicyCliReadResult",
  "PolicyCreate",
  "PolicyDetail",
  "PolicyList",
  "PolicyProtectedBodyContent",
  "PolicyProtectedSummaryContent",
  "PolicySummary",
  "PolicyUpdate",
  "agentPolicyContextSchema",
  "effectivePolicyListSchema",
  "effectivePolicySummarySchema",
  "policyAssignmentListSchema",
  "policyCliListResultSchema",
  "policyCliReadResultSchema",
  "policyCreateSchema",
  "policyDetailSchema",
  "policyListSchema",
  "policyProtectedBodyContentSchema",
  "policyProtectedSummaryContentSchema",
  "policySummarySchema",
  "policyUpdateSchema",
]);

const prohibitedPrivateDisplayLabelProtocolSymbols = new Set([
  "BrowserCreate",
  "BrowserSummary",
  "BrowserUpdate",
  "ChatCreate",
  "ChatFork",
  "ChatSummary",
  "ChatUpdate",
  "CodeTabCreate",
  "CodeTabSummary",
  "CodeTabUpdate",
  "ExplorerCreate",
  "ExplorerSummary",
  "ExplorerUpdate",
  "ProjectSummary",
  "ProjectTabLayoutSummary",
  "ProjectViewCreate",
  "ProjectViewSummary",
  "ProjectViewUpdate",
  "RemoteDesktopCreate",
  "RemoteDesktopSummary",
  "RemoteSurfaceCreate",
  "RemoteSurfaceSummary",
  "RemoteSurfaceUpdate",
  "TabGroupSummary",
  "TabGroupUpdate",
  "TerminalCreate",
  "TerminalSummary",
  "TerminalUpdate",
  "browserCreateSchema",
  "browserListSchema",
  "browserSummarySchema",
  "browserUpdateSchema",
  "chatCreateSchema",
  "chatForkSchema",
  "chatListSchema",
  "chatSummarySchema",
  "chatUpdateSchema",
  "codeTabCreateSchema",
  "codeTabListSchema",
  "codeTabSummarySchema",
  "codeTabUpdateSchema",
  "explorerCreateSchema",
  "explorerListSchema",
  "explorerSummarySchema",
  "explorerUpdateSchema",
  "projectListSchema",
  "projectSummarySchema",
  "projectTabLayoutSummarySchema",
  "projectViewCreateSchema",
  "projectViewListSchema",
  "projectViewSummarySchema",
  "projectViewUpdateSchema",
  "remoteDesktopCreateSchema",
  "remoteDesktopListSchema",
  "remoteDesktopSummarySchema",
  "remoteSurfaceCreateSchema",
  "remoteSurfaceListSchema",
  "remoteSurfaceSummarySchema",
  "remoteSurfaceUpdateSchema",
  "tabGroupSummarySchema",
  "tabGroupUpdateSchema",
  "terminalCreateSchema",
  "terminalListSchema",
  "terminalSummarySchema",
  "terminalUpdateSchema",
]);

const prohibitedSurfacePrivateStateProtocolSymbols = new Set([
  "BrowserCreate",
  "BrowserSummary",
  "BrowserUpdate",
  "ExplorerSummary",
  "ExplorerViewStateUpdate",
  "RemoteDesktopFleet",
  "RemoteDesktopFleetWorker",
  "RemoteDesktopSummary",
  "RemoteDesktopTarget",
  "RemoteDesktopTargetInventory",
  "RemoteSurfaceSummary",
  "TerminalCreate",
  "TerminalServiceConfiguration",
  "TerminalSummary",
  "browserCreateSchema",
  "browserListSchema",
  "browserSummarySchema",
  "browserUpdateSchema",
  "explorerListSchema",
  "explorerSummarySchema",
  "explorerViewStateUpdateSchema",
  "remoteBrowserClientMessageSchema",
  "remoteBrowserServerMessageSchema",
  "remoteDesktopFleetSchema",
  "remoteDesktopFleetWorkerSchema",
  "remoteDesktopListSchema",
  "remoteDesktopServerMessageSchema",
  "remoteDesktopSummarySchema",
  "remoteDesktopTargetInventorySchema",
  "remoteDesktopTargetSchema",
  "remoteSurfaceListSchema",
  "remoteSurfaceSummarySchema",
  "terminalCreateSchema",
  "terminalListSchema",
  "terminalServiceConfigurationSchema",
  "terminalSummarySchema",
]);

const prohibitedSurfacePrivateStateContentSymbols = new Set([
  "BrowserPrivateStateProtectedContent",
  "ExplorerPrivateStateProtectedContent",
  "RemoteDesktopPrivateInventoryProtectedContent",
  "RemoteDesktopPrivateStateProtectedContent",
  "SurfacePrivateStateProtectedContent",
  "TerminalPrivateStateProtectedContent",
  "browserPrivateStateProtectedContentSchema",
  "explorerPrivateStateProtectedContentSchema",
  "remoteDesktopPrivateInventoryProtectedContentSchema",
  "remoteDesktopPrivateStateProtectedContentSchema",
  "surfacePrivateStateProtectedContentSchema",
  "terminalPrivateStateProtectedContentSchema",
]);

const prohibitedSurfaceStreamContentSymbols = new Set([
  "ExplorerOperationRequestContent",
  "ExplorerOperationResultContent",
  "SurfaceOperationOutcomeContent",
  "explorerOperationRequestContentSchema",
  "explorerOperationResultContentSchema",
  "surfaceOperationOutcomeContentSchema",
  "terminalInputContentSchema",
  "terminalOutputContentSchema",
  "terminalSnapshotContentSchema",
  "terminalSnapshotRequestContentSchema",
]);

const prohibitedRepositoryOperationContentSymbols = new Set([
  "RepositoryOperationOutcomeContent",
  "RepositoryOperationRequestContent",
  "RepositoryOperationType",
  "repositoryOperationContextSchema",
  "repositoryOperationOutcomeContentSchema",
  "repositoryOperationRequestContentSchema",
  "repositoryOperationTypeSchema",
]);

const prohibitedSurfacePrivateStateFields = [
  "directoryPath",
  "serviceCommand",
  "selectedPath",
  "initialUrl",
  "currentUrl",
  "navigatedUrl",
  "desktopTarget",
  "targetInventory",
  "launchingApplication",
];

const privateDisplayLabelTables = [
  ["projects", "name"],
  ["chats", "title"],
  ["terminals", "title"],
  ["explorers", "title"],
  ["codeTabs", "title"],
  ["browsers", "title"],
  ["remoteSurfaces", "title"],
  ["projectViews", "title"],
  ["tabGroups", "title"],
];

const surfacePrivateStateTables = [
  ["terminals", ["directoryPath", "serviceCommand"]],
  ["explorers", ["selectedPath"]],
  ["browsers", ["url"]],
  ["remoteSurfaces", []],
];

async function typescriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return typescriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function namedImportsFrom(sourceText, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(
    `import\\s+(?:type\\s+)?\\{([\\s\\S]*?)\\}\\s+from\\s+["']${escaped}["']`,
    "gu",
  );
  return [...sourceText.matchAll(expression)].flatMap((match) =>
    match[1]
      .split(",")
      .map((entry) =>
        entry
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u, 1)[0]
          ?.trim(),
      )
      .filter(Boolean),
  );
}

async function taskProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const taskProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const taskImports = namedImportsFrom(sourceText, "@cantrip/protocol/tasks");
    if (taskImports.length > 0) taskProtocolSources.push(relativeFile);
    for (const symbol of taskImports) {
      if (prohibitedTaskProtocolSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited trusted Task symbol ${symbol}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu,
    )) {
      const target = match[1];
      if (
        target === "@cantrip/crypto" ||
        target.startsWith("@cantrip/crypto/") ||
        /(?:^|\/)packages\/crypto(?:\/|$)/u.test(target) ||
        /(?:^|\/)cantrip_(?:app|worker)\/src\/.*(?:encryption|task-operation)/u.test(
          target,
        )
      ) {
        failures.push(
          `${relativeFile}:${lineForOffset(sourceText, match.index)} imports trusted endpoint code (${target})`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\bdecryptTask[A-Z][A-Za-z0-9_]*/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references ${match[0]}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the Task E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    productionCryptoImports: 0,
    prohibitedTrustedTaskImports: 0,
    taskProtocolSources: [...new Set(taskProtocolSources)].sort(),
  };
}

async function policyProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const opaqueProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const policyImports = namedImportsFrom(
      sourceText,
      "@cantrip/protocol/policies",
    );
    if (
      policyImports.some((symbol) =>
        /(?:Encrypted|Opaque|Wire).*(?:Policy)|Policy.*(?:Encrypted|Opaque|Wire)/u.test(
          symbol,
        ),
      )
    ) {
      opaqueProtocolSources.push(relativeFile);
    }
    if (!relativeFile.endsWith("/policies/templates.ts")) {
      for (const symbol of policyImports) {
        if (prohibitedPolicyProtocolSymbols.has(symbol)) {
          failures.push(
            `${relativeFile}: prohibited trusted policy symbol ${symbol}`,
          );
        }
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:buildAgentPolicyContext|buildEncryptedAgentPolicyContext|decryptPolicy(?:Body|Summary)Content|openPolicy(?:Cli|Wire))[A-Za-z0-9_]*/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted policy code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the policy E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    prohibitedTrustedPolicyImports: 0,
    opaqueProtocolSources: [...new Set(opaqueProtocolSources)].sort(),
  };
}

async function privateDisplayLabelProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const opaqueProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const protocolImports = namedImportsFrom(sourceText, "@cantrip/protocol");
    if (
      protocolImports.some(
        (symbol) =>
          /(?:Wire|Encrypted|Opaque)/u.test(symbol) &&
          /(?:Browser|Chat|CodeTab|Explorer|Project|Remote|TabGroup|Terminal)/u.test(
            symbol,
          ),
      )
    ) {
      opaqueProtocolSources.push(relativeFile);
    }
    for (const symbol of protocolImports) {
      if (prohibitedPrivateDisplayLabelProtocolSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited trusted private-label symbol ${symbol}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:decodePrivateDisplayLabelForClient|decryptPrivateDisplayLabel|encodePrivateDisplayLabelForClient)\b/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted private-label code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the private-display-label E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    productionCryptoImports: 0,
    prohibitedTrustedLabelImports: 0,
    opaqueProtocolSources: [...new Set(opaqueProtocolSources)].sort(),
  };
}

async function surfacePrivateStateProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const opaqueProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const protocolImports = namedImportsFrom(sourceText, "@cantrip/protocol");
    const contentImports = namedImportsFrom(
      sourceText,
      "@cantrip/protocol/surface-private-state",
    );
    if (
      [...protocolImports, ...contentImports].some((symbol) =>
        /(?:Encrypted|Opaque|Wire).*(?:Browser|Explorer|Remote|Surface|Terminal)|SurfacePrivateStateOpaque/u.test(
          symbol,
        ),
      )
    ) {
      opaqueProtocolSources.push(relativeFile);
    }
    for (const symbol of protocolImports) {
      if (prohibitedSurfacePrivateStateProtocolSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited trusted surface-state symbol ${symbol}`,
        );
      }
    }
    for (const symbol of contentImports) {
      if (prohibitedSurfacePrivateStateContentSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited protected surface-state content symbol ${symbol}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu,
    )) {
      const target = match[1];
      if (
        target === "@cantrip/crypto" ||
        target.startsWith("@cantrip/crypto/") ||
        /(?:^|\/)packages\/crypto(?:\/|$)/u.test(target) ||
        /(?:^|\/)cantrip_(?:app|worker)\/src\/.*(?:surface-private-state|browser-private-state|desktop-private-state|terminal-private-state)/u.test(
          target,
        )
      ) {
        failures.push(
          `${relativeFile}:${lineForOffset(sourceText, match.index)} imports trusted surface-state endpoint code (${target})`,
        );
      }
    }
    for (const field of prohibitedSurfacePrivateStateFields) {
      const expression = new RegExp(`\\b${field}\\b`, "gu");
      for (const match of sourceText.matchAll(expression)) {
        failures.push(
          `${relativeFile}:${lineForOffset(sourceText, match.index)} references protected surface-state field ${field}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:decodeSurfacePrivateStateForClient|decodeSurfacePrivateStateForWorker|decryptSurfacePrivateState|encodeSurfacePrivateStateForClient|encodeSurfacePrivateStateForWorker|encryptSurfacePrivateState|openBrowserPersistentPrivateState|openRemoteDesktopPersistentPrivateState|openTerminalPrivateState)\b/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted surface-state endpoint code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the surface-private-state E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    productionCryptoImports: 0,
    prohibitedTrustedSurfaceStateImports: 0,
    opaqueProtocolSources: [...new Set(opaqueProtocolSources)].sort(),
  };
}

async function surfaceStreamProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const opaqueProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const imports = namedImportsFrom(
      sourceText,
      "@cantrip/protocol/surface-stream",
    );
    if (imports.length > 0) opaqueProtocolSources.push(relativeFile);
    for (const symbol of imports) {
      if (prohibitedSurfaceStreamContentSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited trusted surface-stream content symbol ${symbol}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:decryptSurfaceStreamPayload|encryptSurfaceStreamPayload|open(?:Client|Worker)SurfaceStreamContent|protect(?:Client|Worker)SurfaceStreamContent)\b/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted surface-stream endpoint code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the surface-stream E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    prohibitedTrustedSurfaceStreamImports: 0,
    opaqueProtocolSources: [...new Set(opaqueProtocolSources)].sort(),
  };
}

async function repositoryOperationProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  const opaqueProtocolSources = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    const imports = namedImportsFrom(
      sourceText,
      "@cantrip/protocol/repository-operation",
    );
    if (imports.length > 0) opaqueProtocolSources.push(relativeFile);
    for (const symbol of imports) {
      if (prohibitedRepositoryOperationContentSymbols.has(symbol)) {
        failures.push(
          `${relativeFile}: prohibited trusted repository-operation symbol ${symbol}`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:open|protect)(?:Worker)?RepositoryOperationContent\b/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted repository-operation endpoint code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the repository-operation E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    prohibitedTrustedRepositoryOperationImports: 0,
    opaqueProtocolSources: [...new Set(opaqueProtocolSources)].sort(),
  };
}

async function remoteSurfaceStreamProductionDependencyAudit() {
  const files = await typescriptFiles(serverSourcePath);
  const failures = [];
  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const relativeFile = file.slice(repositoryRoot.length + 1);
    for (const match of sourceText.matchAll(
      /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu,
    )) {
      const target = match[1];
      if (
        target === "@cantrip/protocol/remote-surface-stream" ||
        /(?:^|\/)packages\/protocol\/src\/remote-surface-stream(?:\.js|\.ts)?$/u.test(
          target,
        ) ||
        /(?:^|\/)cantrip_(?:app|worker)\/src\/remote-surface-stream-encryption/u.test(
          target,
        )
      ) {
        failures.push(
          `${relativeFile}:${lineForOffset(sourceText, match.index)} imports trusted Remote Surface stream code (${target})`,
        );
      }
    }
    for (const match of sourceText.matchAll(
      /\b(?:decodeRemoteSurfaceProtectedPayload|decryptRemoteSurfaceStreamPayload|encodeRemoteSurfaceProtectedPayload|encryptRemoteSurfaceStreamPayload|openRemoteSurfaceStreamPayload|openWorkerRemoteSurfaceStreamPayload|protectRemoteSurfaceStreamPayload|protectWorkerRemoteSurfaceStreamPayload|remoteSurfaceStreamAssociatedData)\b/gu,
    )) {
      failures.push(
        `${relativeFile}:${lineForOffset(sourceText, match.index)} references trusted Remote Surface stream code (${match[0]})`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cantrip Server crossed the Remote Surface stream E2EE boundary:\n${failures.join("\n")}`,
    );
  }
  return {
    productionCryptoImports: 0,
    prohibitedTrustedRemoteSurfaceStreamImports: 0,
  };
}
function routeBoundary(path) {
  if (path === "/api" || path === "/api/bootstrap" || path === "/version") {
    return "public-bootstrap";
  }
  if (
    path === "/api/auth/login" ||
    path === "/api/auth/register" ||
    path === "/api/auth/session"
  ) {
    return "public-authentication";
  }
  if (path.startsWith("/api/workflow-hooks/")) return "external-credential";
  if (
    path.endsWith("/connect") &&
    path.startsWith("/api/tunnel-attachments/")
  ) {
    return "external-credential";
  }
  if (path.startsWith("/api/internal/")) return "worker-control";
  return "application-principal";
}

function ownerEvidence(path, text) {
  if (path === "/api" || path === "/api/bootstrap" || path === "/version")
    return "public";
  if (path.startsWith("/api/auth/")) return "session-boundary";
  if (path.startsWith("/api/workflow-hooks/")) return "webhook-credential";
  if (
    path.endsWith("/connect") &&
    path.startsWith("/api/tunnel-attachments/")
  ) {
    return "attachment-credential";
  }
  if (path.startsWith("/api/internal/")) return "worker-credential";
  if (
    text.includes("applicationOwnerId(") ||
    text.includes("principalOwnerId(") ||
    text.includes("request.principal")
  ) {
    return "request-principal";
  }
  if (text.includes("LOCAL_USER_ID")) return "legacy-local-owner";
  return "delegated-or-missing-review";
}

function skipSpace(text, start) {
  let cursor = start;
  while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function matchingDelimiter(text, start, open, close) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    const next = text[cursor + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        cursor += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        cursor += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      cursor += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  throw new Error(`Could not find ${close} for delimiter at byte ${start}.`);
}

function parseRoutes(sourceText) {
  const routes = [];
  const routeStart = /\bapp\.(delete|get|head|patch|post|put)\b/gu;
  for (const match of sourceText.matchAll(routeStart)) {
    const method = match[1];
    const start = match.index;
    let cursor = skipSpace(sourceText, start + match[0].length);
    if (sourceText[cursor] === "<") {
      cursor = skipSpace(
        sourceText,
        matchingDelimiter(sourceText, cursor, "<", ">") + 1,
      );
    }
    if (sourceText[cursor] !== "(") {
      throw new Error(`Could not parse server route near byte ${start}.`);
    }
    const end = matchingDelimiter(sourceText, cursor, "(", ")");
    const text = sourceText.slice(start, end + 1);
    const pathMatch = text.match(
      /^app\.[a-z]+(?:\s*<[\s\S]*?>)?\s*\(\s*(["'])([^"']+)\1/u,
    );
    const templatePathMatch = text.match(
      /^app\.[a-z]+(?:\s*<[\s\S]*?>)?\s*\(\s*`([^`]+)`/u,
    );
    const paths = pathMatch
      ? [pathMatch[2]]
      : templatePathMatch?.[1].includes("${action}")
        ? ["suspend", "resume"].map((action) =>
            templatePathMatch[1].replace("${action}", action),
          )
        : [];
    if (paths.length === 0) {
      throw new Error(
        `Server route at ${sourceText.slice(0, start).split("\n").length} does not use a static path.`,
      );
    }
    for (const path of paths) {
      routes.push({
        boundary: routeBoundary(path),
        line: sourceText.slice(0, start).split("\n").length,
        method: method.toUpperCase(),
        ownerEvidence: ownerEvidence(path, text),
        path,
        source: text,
        transport: /\bwebsocket\s*:\s*true\b/u.test(text)
          ? "websocket"
          : "http",
      });
    }
  }
  return routes;
}

function taskRouteBoundaryAudit(routes) {
  const requirements = [
    [
      "POST",
      "/api/projects/:projectId/tasks",
      "encryptedTaskCreateSchema",
      "opaque-create",
    ],
    ["GET", "/api/tasks/:chatId", "taskOpaqueSummarySchema", "opaque-read"],
    [
      "GET",
      "/api/tasks/:chatId/dashboard",
      "taskImplementationOpaqueDashboardSchema",
      "opaque-dashboard",
    ],
    [
      "PATCH",
      "/api/tasks/:chatId/draft",
      "taskOpaqueMutationSchema",
      "opaque-mutation",
    ],
    [
      "PATCH",
      "/api/tasks/:chatId/plan",
      "taskOpaqueMutationSchema",
      "opaque-mutation",
    ],
    [
      "POST",
      "/api/tasks/:chatId/plan",
      "taskEncryptedOperationStartSchema",
      "encrypted-operation",
    ],
    [
      "POST",
      "/api/tasks/:chatId/continue",
      "taskEncryptedOperationStartSchema",
      "encrypted-operation",
    ],
    [
      "POST",
      "/api/tasks/:chatId/begin-implementation",
      "taskEncryptedOperationStartSchema",
      "encrypted-operation",
    ],
    [
      "POST",
      "/api/tasks/:chatId/retry",
      "taskEncryptedOperationStartSchema",
      "encrypted-operation",
    ],
    [
      "GET",
      "/api/chats/:chatId/messages",
      "listTaskMessages",
      "opaque-task-history",
    ],
  ];
  const plaintextGuardedRoutes = [
    ["POST", "/api/chats/:chatId/console"],
    ["POST", "/api/chats/:chatId/fork"],
    ["POST", "/api/chats/:chatId/goal"],
    ["POST", "/api/chats/:chatId/messages"],
    ["GET", "/api/chats/:chatId/queue"],
    ["POST", "/api/chats/:chatId/queue"],
    ["POST", "/api/chats/:chatId/sync"],
    ["POST", "/api/chats/:chatId/turns"],
    ["PATCH", "/api/queued-prompts/:promptId"],
    ["POST", "/api/queued-prompts/:promptId/steer"],
  ];
  const contracts = [];
  for (const [method, path, marker, contract] of requirements) {
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route || !route.source.includes(marker)) {
      throw new Error(
        `Task E2EE route contract is missing ${method} ${path} (${marker}).`,
      );
    }
    contracts.push({ contract, method, path });
  }
  for (const [method, path] of plaintextGuardedRoutes) {
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route || !/experience\s*===\s*"task"/u.test(route.source)) {
      throw new Error(
        `Plaintext Task ingress guard is missing from ${method} ${path}.`,
      );
    }
    contracts.push({
      contract: "rejects-plaintext-task-ingress",
      method,
      path,
    });
  }
  return contracts.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

function privateDisplayLabelRouteBoundaryAudit(routes) {
  const requirements = [
    ["GET", "/api/projects", "projectWireListSchema", "opaque-list"],
    [
      "POST",
      "/api/projects/from-folder",
      "encryptedManagedFolderProjectCreateSchema",
      "encrypted-create",
    ],
    [
      "POST",
      "/api/projects/from-github",
      "encryptedGithubProjectCreateSchema",
      "encrypted-create",
    ],
    [
      "GET",
      "/api/projects/:projectId/chats",
      "chatWireListSchema",
      "opaque-list",
    ],
    [
      "GET",
      "/api/projects/:projectId/archived-chats",
      "archivedChatWireListSchema",
      "opaque-archive-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/chats",
      "encryptedChatCreateSchema",
      "encrypted-create",
    ],
    [
      "POST",
      "/api/projects/:projectId/tasks",
      "encryptedTaskCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/chats/:chatId",
      "encryptedChatUpdateSchema",
      "encrypted-update",
    ],
    [
      "POST",
      "/api/chats/:chatId/fork",
      "encryptedChatForkSchema",
      "encrypted-copy",
    ],
    [
      "POST",
      "/api/chats/:chatId/restore",
      "chatWireSummarySchema",
      "opaque-restore",
    ],
    [
      "POST",
      "/api/chats/:chatId/console",
      "encryptedLinkedConsoleCreateSchema",
      "encrypted-create",
    ],
    [
      "GET",
      "/api/projects/:projectId/terminals",
      "terminalWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/terminals",
      "encryptedTerminalCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/terminals/:terminalId",
      "encryptedTerminalUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/explorers",
      "explorerWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/explorers",
      "encryptedExplorerCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/explorers/:explorerId",
      "encryptedExplorerUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/code-tabs",
      "codeTabWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/code-tabs",
      "encryptedCodeTabCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/code-tabs/:codeTabId",
      "encryptedCodeTabUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/browsers",
      "browserWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/browsers",
      "encryptedBrowserCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/browsers/:browserId",
      "encryptedBrowserUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/remote-desktops",
      "remoteDesktopWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/remote-desktops",
      "encryptedRemoteDesktopCreateSchema",
      "encrypted-create",
    ],
    [
      "GET",
      "/api/remote-desktops/:desktopId",
      "remoteDesktopWireSummarySchema",
      "opaque-read",
    ],
    [
      "GET",
      "/api/projects/:projectId/remote-surfaces",
      "remoteSurfaceWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/remote-surfaces",
      "encryptedRemoteSurfaceCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/remote-surfaces/:surfaceId",
      "encryptedRemoteSurfaceUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/views",
      "projectViewWireListSchema",
      "opaque-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/views",
      "encryptedProjectViewCreateSchema",
      "encrypted-create",
    ],
    [
      "PATCH",
      "/api/project-views/:viewId",
      "encryptedProjectViewUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/tab-groups",
      "projectTabLayoutWireSummarySchema",
      "opaque-layout",
    ],
    [
      "PATCH",
      "/api/projects/:projectId/tab-groups/:groupId",
      "encryptedTabGroupUpdateSchema",
      "encrypted-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/execution-targets",
      "executionTargetWireCatalogSchema",
      "opaque-target-catalog",
    ],
  ];
  const contracts = [];
  for (const [method, path, marker, contract] of requirements) {
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route || !route.source.includes(marker)) {
      throw new Error(
        `Private-label E2EE route contract is missing ${method} ${path} (${marker}).`,
      );
    }
    contracts.push({ contract, method, path });
  }
  return contracts.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

function surfacePrivateStateRouteBoundaryAudit(routes) {
  const requirements = [
    [
      "GET",
      "/api/projects/:projectId/terminals",
      "terminalWireListSchema",
      "opaque-terminal-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/terminals",
      "encryptedTerminalCreateSchema",
      "encrypted-terminal-create",
    ],
    [
      "PATCH",
      "/api/terminals/:terminalId",
      "encryptedTerminalUpdateSchema",
      "opaque-terminal-update",
    ],
    [
      "PUT",
      "/api/terminals/:terminalId/service",
      "encryptedTerminalServiceConfigurationSchema",
      "encrypted-service-configuration",
    ],
    [
      "GET",
      "/api/terminals/:terminalId/script-commands",
      "stateProtection: context.stateProtection",
      "opaque-script-discovery",
    ],
    [
      "POST",
      "/api/terminals/:terminalId/direct",
      "stateProtection: context.stateProtection",
      "opaque-direct-open",
    ],
    [
      "GET",
      "/api/terminals/:terminalId/connect",
      "stateProtection: context.stateProtection",
      "opaque-terminal-open",
    ],
    [
      "GET",
      "/api/projects/:projectId/explorers",
      "explorerWireListSchema",
      "opaque-explorer-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/explorers",
      "encryptedExplorerCreateSchema",
      "encrypted-explorer-create",
    ],
    [
      "PATCH",
      "/api/explorers/:explorerId",
      "encryptedExplorerUpdateSchema",
      "opaque-explorer-update",
    ],
    [
      "PATCH",
      "/api/explorers/:explorerId/worktree",
      "encryptedExplorerWorktreeUpdateSchema",
      "encrypted-selection-reset",
    ],
    [
      "PATCH",
      "/api/explorers/:explorerId/view-state",
      "encryptedExplorerViewStateUpdateSchema",
      "encrypted-selection-update",
    ],
    [
      "GET",
      "/api/projects/:projectId/browsers",
      "browserWireListSchema",
      "opaque-browser-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/browsers",
      "encryptedBrowserCreateSchema",
      "encrypted-browser-create",
    ],
    [
      "PATCH",
      "/api/browsers/:browserId",
      "encryptedBrowserUpdateSchema",
      "encrypted-browser-update",
    ],
    [
      "POST",
      "/api/browsers/:browserId/tunnel",
      "browserTunnelWireRequestSchema",
      "opaque-tunnel-configuration",
    ],
    [
      "GET",
      "/api/projects/:projectId/remote-desktops",
      "remoteDesktopWireListSchema",
      "opaque-desktop-list",
    ],
    [
      "GET",
      "/api/projects/:projectId/remote-desktop-fleet",
      "inventoryProtection: inventory.stateProtection",
      "opaque-desktop-inventory",
    ],
    [
      "GET",
      "/api/remote-desktops/:desktopId",
      "remoteDesktopWireSummarySchema",
      "opaque-desktop-read",
    ],
    [
      "PATCH",
      "/api/remote-desktops/:desktopId",
      "encryptedRemoteDesktopUpdateSchema",
      "encrypted-desktop-update",
    ],
    [
      "POST",
      "/api/projects/:projectId/remote-desktops",
      "encryptedRemoteDesktopCreateSchema",
      "encrypted-desktop-create",
    ],
    [
      "GET",
      "/api/projects/:projectId/remote-surfaces",
      "remoteSurfaceWireListSchema",
      "opaque-surface-list",
    ],
    [
      "POST",
      "/api/projects/:projectId/remote-surfaces",
      "encryptedRemoteSurfaceCreateSchema",
      "encrypted-surface-create",
    ],
    [
      "PATCH",
      "/api/remote-surfaces/:surfaceId",
      "encryptedRemoteSurfaceUpdateSchema",
      "encrypted-surface-update",
    ],
    [
      "GET",
      "/api/remote-surfaces/:surfaceId/connect",
      "stateProtection: context.surface.stateProtection",
      "opaque-surface-attach",
    ],
    [
      "GET",
      "/api/remote-surfaces/:surfaceId/connect",
      '"Remote Surface could not be opened."',
      "generic-surface-bridge-errors",
    ],
    [
      "GET",
      "/api/projects/:projectId/execution-targets",
      "executionTargetWireCatalogSchema",
      "opaque-id-only-target-catalog",
    ],
    [
      "POST",
      "/api/internal/cli",
      "executeCliCommand",
      "worker-encrypted-browser-navigation",
    ],
  ];
  const contracts = [];
  for (const [method, path, marker, contract] of requirements) {
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route || !route.source.includes(marker)) {
      throw new Error(
        `Surface private-state E2EE route contract is missing ${method} ${path} (${marker}).`,
      );
    }
    contracts.push({ contract, method, path });
  }
  return contracts.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

function surfaceStreamRouteBoundaryAudit(routes, applicationText) {
  const failures = [];
  const requirements = [
    [
      "POST",
      "/api/explorers/:explorerId/operation",
      "surfaceStreamWireRequestSchema",
      "opaque-explorer-operation",
    ],
    [
      "GET",
      "/api/terminals/:terminalId/connect",
      "protectedData: message.data.protectedData",
      "opaque-terminal-websocket",
    ],
    [
      "POST",
      "/api/internal/cli",
      "executeCliCommand",
      "worker-encrypted-surface-cli",
    ],
  ];
  const contracts = [];
  for (const [method, path, marker, contract] of requirements) {
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route || !route.source.includes(marker)) {
      failures.push(
        `Surface-stream route contract is missing ${method} ${path} (${marker}).`,
      );
      continue;
    }
    contracts.push({ contract, method, path });
  }
  for (const path of [
    "/api/explorers/:explorerId/directory",
    "/api/explorers/:explorerId/directory/commits",
    "/api/explorers/:explorerId/file",
    "/api/explorers/:explorerId/media",
  ]) {
    if (routes.some((route) => route.path === path)) {
      failures.push(`Legacy plaintext Explorer route remains: ${path}.`);
    }
  }
  for (const marker of [
    "surfaceStreamWireArgument(call.arguments)",
    'operation: "explorer.list"',
    'operation: "terminal.read"',
    'operation: "terminal.send"',
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`Protected surface CLI relay is missing ${marker}.`);
    }
  }
  if (/send\(\{\s*type:\s*"output",\s*data:/u.test(applicationText)) {
    failures.push("Terminal WebSocket still sends plaintext output data.");
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  return contracts.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method),
  );
}

function repositoryOperationRouteBoundaryAudit(
  routes,
  applicationText,
  protocolText,
  clientText,
  workerText,
) {
  const failures = [];
  const method = "POST";
  const path =
    "/api/projects/:projectId/worktrees/:worktreeId/repository-operation";
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  const workerPath = "/api/workers/:workerId/repository-operation";
  const workerRoute = routes.find(
    (candidate) => candidate.method === method && candidate.path === workerPath,
  );
  for (const marker of [
    "repositoryOperationWireRequestSchema",
    "repositoryOperationWireResponseSchema",
    'type: "repository.operation"',
  ]) {
    if (!route?.source.includes(marker)) {
      failures.push(
        `Protected repository route is missing ${method} ${path} (${marker}).`,
      );
    }
  }
  for (const marker of [
    "repositoryWorkerOperationWireRequestSchema",
    "repositoryOperationWireResponseSchema",
    'type: "repository.operation"',
  ]) {
    if (!workerRoute?.source.includes(marker)) {
      failures.push(
        `Protected worker repository route is missing ${method} ${workerPath} (${marker}).`,
      );
    }
  }
  for (const marker of [
    "repositoryOperationOpaqueSchema",
    "protectedRequest: repositoryOperationOpaqueSchema",
    "protectedResponse: repositoryOperationOpaqueSchema",
  ]) {
    if (!protocolText.includes(marker)) {
      failures.push(`Repository-operation protocol is missing ${marker}.`);
    }
  }
  for (const marker of [
    "runProtectedRepositoryOperation",
    "runProtectedWorkerRepositoryOperation",
    "registerWorkerRepositoryMetadata",
    "resolveWorkerRepositoryMetadata",
    "protectWorkerRepositoryIdentity",
    "protectReplicaRepository",
    "openProjectReplicaJob",
    "encryptedProjectReplicaProvisionCreateSchema",
    "encryptedProjectReplicaSynchronizeCreateSchema",
    "encryptedProjectReplicaRemoveCreateSchema",
    "protectRepositoryOperationContent",
    "openRepositoryOperationContent",
    "getProjectWorktreeWireList",
    "generateProjectWorktreeGitDraft",
    'type: "worktree.status"',
    'type: "git.agent.generate"',
    "Protected path unavailable",
    "/repository-operation",
  ]) {
    if (!clientText.includes(marker)) {
      failures.push(`Client protected repository path is missing ${marker}.`);
    }
  }
  if (clientText.includes("/git/operations")) {
    failures.push(
      "Client still calls a plaintext managed Git operation route.",
    );
  }
  if (clientText.includes("/api/github/")) {
    failures.push("Client still calls a plaintext GitHub catalog route.");
  }
  if (clientText.includes("/checkout")) {
    failures.push(
      "Client still calls the plaintext pull-request checkout route.",
    );
  }
  for (const marker of [
    'case "repository.operation"',
    "repositoryOperationReplay.reserve",
    "openWorkerRepositoryOperationContent",
    "protectWorkerRepositoryOperationContent",
    "cwd: command.cwd",
    "repository: command.repository",
    "repositoryManagedOperations.get",
    "repositoryManagedOperations.put",
    'request.type === "git.operation.current"',
    "routingRegistry.resolveCommand",
    "routingRegistry.protectResult",
    "routingRegistry.protectMetadata",
    "routingRegistry.resolveMetadata",
    "repository-routing.json",
    'request.type === "git.agent.generate"',
    "gitAgentDraftCreateSchema.parse(request.arguments)",
    "GIT_AGENT_INSTRUCTIONS",
    "Protected repository operation failed on the worker.",
  ]) {
    if (!workerText.includes(marker)) {
      failures.push(`Worker protected repository path is missing ${marker}.`);
    }
  }
  for (const marker of [
    "encryptedProjectReplicaProvisionCreateSchema",
    "encryptedProjectReplicaSynchronizeCreateSchema",
    "encryptedProjectReplicaRemoveCreateSchema",
    "input.data.nameWithOwner",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(
        `Server protected repository lifecycle is missing ${marker}.`,
      );
    }
  }
  for (const marker of [
    "legacyGitRoute",
    "legacyHistoryRoute",
    "legacyGithubContentRoute",
    "legacyGithubCatalogRoute",
    "legacyWorktreeStatusRoute",
    "This plaintext repository route was removed",
    "This plaintext Git agent route was removed",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(
        `Server plaintext repository fail-closed guard is missing ${marker}.`,
      );
    }
  }
  if (
    applicationText.includes("repositoryOperationRequestContentSchema") ||
    applicationText.includes("repositoryOperationOutcomeContentSchema")
  ) {
    failures.push(
      "Server application references trusted repository-operation content schemas.",
    );
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return {
    protectedRoute: { contract: "opaque-repository-operation", method, path },
    protectedOperationTypes: enumValues(
      protocolText,
      "repositoryOperationTypeSchema",
    ),
    pendingPlaintextPaths: [],
    protectedDurableEndpointState: [
      "managed Git operation context and output:worker-local",
      "repository path, branch, and status routing:worker-local opaque handles",
      "repository identity and managed-folder bootstrap:blind indexes plus worker-local opaque handles",
      "GitHub catalogs and pull-request checkout:protected worker-scoped relay",
      "Git agent request, repository evidence, and draft:protected worker-scoped relay",
      "legacy Git, History, Issues, PR, and release content routes:fail-closed",
      "legacy GitHub catalog routes:fail-closed",
      "legacy worktree status route:fail-closed",
    ],
  };
}

function methodBody(sourceText, methodName) {
  const expression = new RegExp(
    `^  (?:private\\s+)?async\\s+${methodName}\\s*\\(`,
    "mu",
  );
  const match = expression.exec(sourceText);
  if (!match)
    throw new Error(`Missing audited repository method ${methodName}.`);
  const searchStart = match.index + match[0].length;
  const following = sourceText
    .slice(searchStart)
    .search(/^  (?:private\s+)?async\s+[A-Za-z][A-Za-z0-9_]*\s*\(/mu);
  return sourceText.slice(
    match.index,
    following < 0 ? sourceText.length : searchStart + following,
  );
}

async function taskRepositoryBoundaryAudit() {
  const repositoryPath = resolve(serverSourcePath, "db/repository.ts");
  const automationPath = resolve(serverSourcePath, "db/project-automations.ts");
  const [repositoryText, automationText] = await Promise.all([
    readFile(repositoryPath, "utf8"),
    readFile(automationPath, "utf8"),
  ]);
  const agentOnly = [
    "appendMessage",
    "createQueuedPrompt",
    "updateQueuedPrompt",
  ];
  for (const method of agentOnly) {
    if (
      !/experience\s*!==\s*"agent"/u.test(methodBody(repositoryText, method))
    ) {
      throw new Error(`${method} no longer rejects encrypted Task chats.`);
    }
  }
  const appendTaskMessage = methodBody(repositoryText, "appendTaskMessage");
  if (
    !/experience\s*!==\s*"task"/u.test(appendTaskMessage) ||
    !/content:\s*null/u.test(appendTaskMessage) ||
    !/taskProtectedContent:\s*message\.protectedContent/u.test(
      appendTaskMessage,
    )
  ) {
    throw new Error(
      "appendTaskMessage no longer enforces opaque Task storage.",
    );
  }
  if (
    !/eq\(schema\.chats\.experience,\s*"agent"\)/u.test(
      methodBody(automationText, "target"),
    )
  ) {
    throw new Error("Project automations may target encrypted Task chats.");
  }
  return [
    "appendMessage:agent-only",
    "appendTaskMessage:opaque-task-only",
    "createQueuedPrompt:agent-only",
    "projectAutomation.target:agent-only",
    "updateQueuedPrompt:agent-only",
  ];
}

async function projectAutomationContentBoundaryAudit() {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/project-automations.ts");
  const [
    schemaText,
    repositoryText,
    applicationText,
    protocolText,
    clientText,
    clientSettingsText,
    workerText,
    workerCommandText,
  ] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(repositoryPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(automationProtocolPath, "utf8"),
    readFile(clientAutomationEncryptionPath, "utf8"),
    readFile(clientAutomationSettingsPath, "utf8"),
    readFile(workerAutomationEncryptionPath, "utf8"),
    readFile(workerPath, "utf8"),
  ]);
  const failures = [];
  const initializer = tableInitializer(schemaText, "projectAutomations");
  for (const field of [
    ["protectedName", "protected_name"],
    ["protectedPrompt", "protected_prompt"],
    ["protectedCondition", "protected_condition"],
  ]) {
    const [property, column] = field;
    if (
      !new RegExp(
        `\\b${property}\\s*:\\s*jsonb\\(["']${column}["']\\)[\\s\\S]*?\\.notNull\\(\\)`,
        "u",
      ).test(initializer)
    ) {
      failures.push(
        `projectAutomations: missing required opaque ${column} storage`,
      );
    }
  }
  for (const field of ["name", "prompt", "condition"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
      failures.push(
        `projectAutomations: legacy plaintext ${field} field returned`,
      );
    }
    if (
      new RegExp(`\\b(?:row|input)\\.${field}\\b`, "u").test(repositoryText)
    ) {
      failures.push(
        `project automation repository references plaintext ${field}`,
      );
    }
  }
  for (const symbol of [
    "projectAutomationCreateSchema",
    "projectAutomationUpdateSchema",
    "projectAutomationSchema",
    "projectAutomationListSchema",
  ]) {
    if (new RegExp(`\\b${symbol}\\b`, "u").test(applicationText)) {
      failures.push(`Server application imports trusted ${symbol}.`);
    }
  }
  for (const marker of [
    "encryptedProjectAutomationCreateSchema",
    "encryptedProjectAutomationUpdateSchema",
    "projectAutomationOpaqueContentSchema",
    "projectAutomationWireSchema",
  ]) {
    if (!protocolText.includes(marker)) {
      failures.push(`Automation protocol is missing ${marker}.`);
    }
  }
  if (!clientSettingsText.includes("ensureChatWorkerEncryption")) {
    failures.push(
      "Project automation mutations no longer ensure the worker workflow-content grant.",
    );
  }
  for (const marker of [
    "protectProjectAutomationCreate",
    "protectProjectAutomationUpdate",
    "openProjectAutomationWire",
    'component: "workflow-content"',
  ]) {
    if (!clientText.includes(marker)) {
      failures.push(`Client automation E2EE path is missing ${marker}.`);
    }
  }
  for (const marker of [
    "protectProjectAutomationDispatch",
    "decryptWorkflowContent",
    "evaluateProjectAutomationCondition",
    "protectChatTurn",
  ]) {
    if (!workerText.includes(marker)) {
      failures.push(`Worker automation E2EE path is missing ${marker}.`);
    }
  }
  for (const marker of [
    'case "automation.dispatch.protect"',
    "protectProjectAutomationDispatch",
  ]) {
    if (!workerCommandText.includes(marker)) {
      failures.push(`Worker automation command path is missing ${marker}.`);
    }
  }
  for (const marker of [
    'type: "automation.dispatch.protect"',
    "content: automation.content",
    'text: "Encrypted automation prompt."',
    '"Protected automation dispatch failed."',
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`Server automation relay is missing ${marker}.`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Project-automation content boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["project_automations"],
    guards: [
      "name-prompt-condition:opaque-jsonb-only",
      "condition-evaluation:worker-only",
      "chat-turn-protection:worker-only",
      "server-dispatch-errors:generic-only",
    ],
  };
}

async function workflowCatalogContentBoundaryAudit() {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/workflows.ts");
  const runRepositoryPath = resolve(serverSourcePath, "db/workflow-runs.ts");
  const triggerRepositoryPath = resolve(
    serverSourcePath,
    "db/workflow-triggers.ts",
  );
  const executorPath = resolve(serverSourcePath, "workflows/executor.ts");
  const runTransitionsPath = resolve(
    serverSourcePath,
    "db/workflow-run-transitions.ts",
  );
  const workerExecutionPath = resolve(
    repositoryRoot,
    "cantrip_worker/src/workflow-execution-encryption.ts",
  );
  const workflowCenterPath = resolve(
    repositoryRoot,
    "cantrip_app/src/components/workflows/workflow-center.tsx",
  );
  const [
    schemaText,
    repositoryText,
    applicationText,
    protocolText,
    interactionProtocolText,
    clientApiText,
    clientEncryptionText,
    clientTriggerEncryptionText,
    runRepositoryText,
    triggerRepositoryText,
    runTransitionsText,
    executorText,
    workerExecutionText,
    workerText,
    workflowCenterText,
  ] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(repositoryPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(workflowProtocolPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(clientWorkflowApiPath, "utf8"),
    readFile(clientWorkflowEncryptionPath, "utf8"),
    readFile(clientWorkflowTriggerEncryptionPath, "utf8"),
    readFile(runRepositoryPath, "utf8"),
    readFile(triggerRepositoryPath, "utf8"),
    readFile(runTransitionsPath, "utf8"),
    readFile(executorPath, "utf8"),
    readFile(workerExecutionPath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(workflowCenterPath, "utf8"),
  ]);
  const failures = [];
  const definitionTable = tableInitializer(schemaText, "workflowDefinitions");
  const revisionTable = tableInitializer(schemaText, "workflowRevisions");
  const gateTable = tableInitializer(schemaText, "workflowApprovalGates");
  const runTable = tableInitializer(schemaText, "workflowRuns");
  const eventTable = tableInitializer(schemaText, "workflowRunEvents");
  const triggerTable = tableInitializer(
    schemaText,
    "workflowAutomationTriggers",
  );
  const deliveryTable = tableInitializer(
    schemaText,
    "workflowTriggerDeliveries",
  );
  for (const table of [
    "workflowRuns",
    "workflowRunNodes",
    "workflowRunNodeItems",
    "workflowNodeAttempts",
  ]) {
    const initializer = tableInitializer(schemaText, table);
    for (const column of [
      "protected_input",
      "protected_result",
      "protected_error",
    ]) {
      if (!initializer.includes(`\"${column}\"`)) {
        failures.push(`${table}: missing ${column}`);
      }
    }
  }
  for (const [property, column] of [
    ["protectedPauseReason", "protected_pause_reason"],
    ["protectedCancelReason", "protected_cancel_reason"],
  ]) {
    if (
      !runTable.includes(`${property}:`) ||
      !runTable.includes(`"${column}"`)
    ) {
      failures.push(`workflowRuns: missing ${column}`);
    }
  }
  for (const field of ["pauseReason", "cancelReason"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(runTable)) {
      failures.push(`workflowRuns: plaintext ${field} storage returned`);
    }
  }
  for (const [property, column] of [
    ["publicPayload", "public_payload"],
    ["protectedPayload", "protected_payload"],
  ]) {
    if (
      !eventTable.includes(`${property}:`) ||
      !eventTable.includes(`"${column}"`)
    ) {
      failures.push(`workflowRunEvents: missing ${column}`);
    }
  }
  if (/\\bpayload\\s*:\s*jsonb\(["']payload["']\)/u.test(eventTable)) {
    failures.push("workflowRunEvents: unrestricted plaintext payload returned");
  }
  for (const [property, column] of [
    ["protectedName", "protected_name"],
    ["protectedConfiguration", "protected_configuration"],
    ["protectedInput", "protected_input"],
  ]) {
    if (
      !new RegExp(
        `\\b${property}\\s*:\\s*(?:text|jsonb)\\(["']${column}["']\\)[\\s\\S]*?\\.notNull\\(\\)`,
        "u",
      ).test(triggerTable)
    ) {
      failures.push(`workflowAutomationTriggers: missing required ${column}`);
    }
  }
  for (const field of [
    "name",
    "configuration",
    "structuredInput",
    "lastError",
  ]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(triggerTable)) {
      failures.push(
        `workflowAutomationTriggers: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const [property, column] of [
    ["publicProvenance", "public_provenance"],
    ["protectedPayload", "protected_payload"],
  ]) {
    if (
      !deliveryTable.includes(`${property}:`) ||
      !deliveryTable.includes(`"${column}"`)
    ) {
      failures.push(`workflowTriggerDeliveries: missing ${column}`);
    }
  }
  for (const field of ["triggerProvenance", "errorMessage"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(deliveryTable)) {
      failures.push(
        `workflowTriggerDeliveries: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const [property, column] of [
    ["slugBlindIndex", "slug_blind_index"],
    ["protectedSlug", "protected_slug"],
    ["protectedName", "protected_name"],
    ["protectedDescription", "protected_description"],
    ["protectedProvenance", "protected_provenance"],
  ]) {
    if (
      !new RegExp(
        `\\b${property}\\s*:\\s*(?:text|jsonb)\\(["']${column}["']\\)[\\s\\S]*?\\.notNull\\(\\)`,
        "u",
      ).test(definitionTable)
    ) {
      failures.push(`workflowDefinitions: missing required ${column}`);
    }
  }
  for (const [property, column] of [
    ["protectedProvenance", "protected_provenance"],
    ["contentBlindIndex", "content_blind_index"],
    ["protectedContentHash", "protected_content_hash"],
    ["protectedDefinition", "protected_definition"],
  ]) {
    if (
      !new RegExp(
        `\\b${property}\\s*:\\s*(?:text|jsonb)\\(["']${column}["']\\)[\\s\\S]*?\\.notNull\\(\\)`,
        "u",
      ).test(revisionTable)
    ) {
      failures.push(`workflowRevisions: missing required ${column}`);
    }
  }
  for (const field of ["slug", "name", "description", "provenance"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(definitionTable)) {
      failures.push(
        `workflowDefinitions: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const field of ["definition", "provenance", "contentHash"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(revisionTable)) {
      failures.push(
        `workflowRevisions: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const [property, column] of [
    ["denialPolicy", "denial_policy"],
    ["protectedRequest", "protected_request"],
    ["protectedResponse", "protected_response"],
  ]) {
    if (
      !gateTable.includes(`${property}:`) ||
      !gateTable.includes(`"${column}"`)
    ) {
      failures.push(`workflowApprovalGates: missing ${column}`);
    }
  }
  for (const field of [
    "prompt",
    "permissionManifest",
    "decisionReason",
    "interactionRequestId",
  ]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(gateTable)) {
      failures.push(
        `workflowApprovalGates: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const reference of [
    "schema.workflowDefinitions.slug",
    "schema.workflowDefinitions.name",
    "schema.workflowDefinitions.description",
    "schema.workflowDefinitions.provenance",
    "schema.workflowRevisions.definition",
    "schema.workflowRevisions.provenance",
    "schema.workflowRevisions.contentHash",
  ]) {
    if (
      new RegExp(`${reference.replaceAll(".", "\\.")}\\b`, "u").test(
        repositoryText,
      )
    ) {
      failures.push(`workflow repository: legacy reference ${reference}`);
    }
  }
  for (const reference of [
    "input.graph",
    "input.declaredInputs",
    "input.declaredOutputs",
    "input.defaults",
    "input.permissionRequirements",
    "node.key",
    "node.name",
    "node.configuration",
    "node.inputSchema",
    "node.outputSchema",
    "node.permissionRequirements",
    "edge.sourceOutput",
    "edge.targetInput",
    "edge.condition",
  ]) {
    if (repositoryText.includes(reference)) {
      failures.push(
        `workflow repository: trusted definition reference ${reference}`,
      );
    }
  }
  for (const marker of [
    "protectedDefinition: input.content.protectedDefinition",
    "input.manifest.nodes.map",
    "input.manifest.edges.map",
    'name: "Encrypted workflow node"',
    "declaredInputs: {}",
    "sourceOutput: null",
    "condition: null",
  ]) {
    if (!repositoryText.includes(marker)) {
      failures.push(
        `workflow repository: opaque definition path missing ${marker}`,
      );
    }
  }
  const trustedServerImports = namedImportsFrom(
    applicationText,
    "@cantrip/protocol/workflows",
  );
  for (const symbol of [
    "workflowDefinitionCreateSchema",
    "workflowDefinitionUpdateSchema",
    "workflowRevisionCreateSchema",
    "workflowDefinitionGenerationCreateSchema",
    "workflowRepositoryImportSchema",
    "workflowRepositoryExportSchema",
    "workflowRunSaveRevisionSchema",
    "workflowRunPauseSchema",
    "workflowRunResumeSchema",
    "workflowRunCancelSchema",
    "workflowNodeRetrySchema",
    "workflowAutomationTriggerCreateSchema",
    "workflowAutomationTriggerUpdateSchema",
    "workflowTriggerDeliveryCreateSchema",
    "workflowGitEventDeliveryCreateSchema",
    "workflowAutomationTriggerSchema",
    "workflowAutomationTriggerListSchema",
  ]) {
    if (trustedServerImports.includes(symbol)) {
      failures.push(`Server application imports trusted ${symbol}.`);
    }
  }
  for (const [source, sourceText] of [
    ["application", applicationText],
    ["workflow repository", repositoryText],
    ["workflow run repository", runRepositoryText],
    ["workflow executor", executorText],
  ]) {
    const imports = namedImportsFrom(sourceText, "@cantrip/protocol/workflows");
    for (const symbol of [
      "workflowApprovalGateSchema",
      "workflowGateDecisionSchema",
      "workflowGateNodeConfigurationSchema",
      "workflowGateProtectedRequestSchema",
      "workflowGateProtectedResponseSchema",
    ]) {
      if (imports.includes(symbol)) {
        failures.push(`${source}: imports trusted gate content ${symbol}.`);
      }
    }
  }
  for (const marker of [
    "encryptedWorkflowDefinitionCreateSchema",
    "encryptedWorkflowDefinitionUpdateSchema",
    "encryptedWorkflowRevisionCreateSchema",
    "workflowDefinitionWireSummarySchema",
    "workflowDefinitionWireDetailSchema",
    "workflowRevisionWireSchema",
    "workflowRevisionProtectedDefinitionSchema",
    "workflowRevisionManifestSchema",
    "workflowRevisionWireManifestSchema",
    "encryptedWorkflowRunCreateSchema",
    "encryptedWorkflowRunPauseSchema",
    "encryptedWorkflowRunResumeSchema",
    "encryptedWorkflowRunCancelSchema",
    "encryptedWorkflowNodeRetrySchema",
    "workflowRunWireDetailSchema",
    "protectedWorkflowNodeExecutionRequestSchema",
    "protectedWorkflowNodeExecutionResultSchema",
    "workflowApprovalGateWireSchema",
    "workflowGateProtectedRequestSchema",
    "workflowGateProtectedResponseSchema",
    "encryptedWorkflowGateDecisionSchema",
    "protectedWorkflowGateDecisionRequestSchema",
    "protectedWorkflowGateDecisionResultSchema",
    "outgoingDependencies",
    "selectedDependencyIds",
    "logicalExecutionCount",
    "encryptedWorkflowAutomationTriggerCreateSchema",
    "encryptedWorkflowAutomationTriggerUpdateSchema",
    "workflowAutomationTriggerWireSchema",
    "encryptedWorkflowTriggerDeliveryCreateSchema",
    "encryptedWorkflowGitEventDeliveryCreateSchema",
    "workflowTriggerDeliveryWireResultSchema",
    "protectedWorkflowTriggerPrepareRequestSchema",
    "protectedWorkflowTriggerPrepareResultSchema",
  ]) {
    if (!protocolText.includes(marker)) {
      failures.push(`Workflow protocol is missing ${marker}.`);
    }
  }
  for (const marker of [
    "workflow.node.interaction.requested.protected",
    "workflowRunId: z.string().min(1).optional()",
  ]) {
    if (!interactionProtocolText.includes(marker)) {
      failures.push(`Workflow interaction protocol is missing ${marker}.`);
    }
  }
  for (const marker of [
    "protectWorkflowDefinitionCreate",
    "protectWorkflowDefinitionUpdate",
    "protectWorkflowRevisionCreate",
    "openWorkflowDefinitionWireSummary",
    "openWorkflowDefinitionWireDetail",
    "openWorkflowRevisionWire",
    "protectWorkflowRunCreate",
    "protectWorkflowRunPause",
    "protectWorkflowRunResume",
    "protectWorkflowRunCancel",
    "protectWorkflowNodeRetry",
    "openWorkflowRunWireDetail",
    "protectWorkflowGateDecision",
    "protectWorkflowAutomationTriggerCreate",
    "protectWorkflowAutomationTriggerUpdate",
    "openWorkflowAutomationTriggerWire",
    "protectWorkflowTriggerDelivery",
    "protectWorkflowGitEventDelivery",
    "openWorkflowTriggerDeliveryResult",
  ]) {
    if (!clientApiText.includes(marker)) {
      failures.push(`Client workflow API is missing ${marker}.`);
    }
  }
  for (const marker of [
    'const component = "workflow-content"',
    'field: "slug"',
    'field: "content-hash"',
    'field: "definition"',
    "protectedDefinition",
    "deriveLookupKey",
    "computeBlindLookupTag",
    "encryptWorkflowContent",
    "decryptWorkflowContent",
    "openWorkflowGateWithContext",
    "protectWorkflowGateDecision",
    'field: "pause-reason"',
    'field: "cancel-reason"',
  ]) {
    if (!clientEncryptionText.includes(marker)) {
      failures.push(`Client workflow encryption is missing ${marker}.`);
    }
  }
  for (const marker of [
    "encryptWorkflowContent",
    "decryptWorkflowContent",
    'recordKind: "workflow-trigger"',
    'recordKind: "workflow-delivery"',
    "protectedName",
    "protectedConfiguration",
    "protectedInput",
    "protectedPayload",
    "clearSensitiveBytes",
    "publicConfigurationMatches",
  ]) {
    if (!clientTriggerEncryptionText.includes(marker)) {
      failures.push(`Client workflow trigger encryption is missing ${marker}.`);
    }
  }
  for (const marker of [
    "This plaintext workflow generation path was removed",
    "This plaintext workflow repository scan path was removed",
    "This plaintext workflow repository import path was removed",
    "This plaintext workflow repository export path was removed",
    "This plaintext workflow revision path was removed",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`Workflow fail-closed boundary is missing ${marker}.`);
    }
  }
  for (const marker of [
    "encryptedWorkflowAutomationTriggerCreateSchema",
    "encryptedWorkflowAutomationTriggerUpdateSchema",
    "encryptedWorkflowTriggerDeliveryCreateSchema",
    "encryptedWorkflowGitEventDeliveryCreateSchema",
    "workflowWebhookDeliveryCreateSchema",
    "workflowAutomationTriggerWireSchema",
    "workflowTriggerDeliveryWireResultSchema",
    'type: "workflow.trigger.prepare.protected"',
    "protectedConfiguration: context.trigger.protectedConfiguration",
    "protectedBaseInput: context.trigger.protectedInput",
    "protectedDeliveryPayload: claim.delivery.protectedPayload",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`Protected workflow trigger ingress is missing ${marker}.`);
    }
  }
  for (const marker of [
    "publicConfiguration: input.publicConfiguration",
    "protectedName: input.protectedName",
    "protectedConfiguration: input.protectedConfiguration",
    "protectedInput: input.protectedInput",
    "publicProvenance: provenance",
    "protectedPayload",
    "lastErrorCode",
  ]) {
    if (!triggerRepositoryText.includes(marker)) {
      failures.push(`Workflow trigger repository is missing ${marker}.`);
    }
  }
  for (const marker of [
    "row.configuration",
    "row.structuredInput",
    "row.name",
    "triggerProvenance:",
    "errorMessage:",
  ]) {
    if (triggerRepositoryText.includes(marker)) {
      failures.push(
        `Workflow trigger repository restored plaintext content path ${marker}.`,
      );
    }
  }
  for (const marker of [
    "protectedDefinition: lease.candidate.protectedDefinition",
    "protectedRunInput: lease.candidate.protectedRunInput",
    "outgoingDependencies: lease.candidate.outgoingDependencies",
    "protectedWorkflowNodeExecutionResultSchema.parse",
    'type: "workflow.gate.decide.protected"',
    "openProtectedGateAttempt",
    "decideProtectedGate",
  ]) {
    if (!executorText.includes(marker)) {
      failures.push(`Protected workflow executor is missing ${marker}.`);
    }
  }
  for (const legacyAdvance of [
    ".advanceReadyCollectionNode(",
    ".advanceReadyRepeatUntilNode(",
    ".advanceReadyControlNode(",
  ]) {
    if (executorText.includes(legacyAdvance)) {
      failures.push(
        `Protected workflow executor still calls legacy semantic runtime ${legacyAdvance}.`,
      );
    }
  }
  for (const marker of [
    "decryptWorkflowContent",
    "workflowRevisionProtectedDefinitionSchema",
    "workflowRunProtectedInputSchema",
    "workflowMapNodeConfigurationSchema",
    "workflowPipelineNodeConfigurationSchema",
    "workflowReduceNodeConfigurationSchema",
    "workflowRepeatUntilNodeConfigurationSchema",
    "workflowVerifyNodeConfigurationSchema",
    "workflowConditionNodeConfigurationSchema",
    "workflowGateNodeConfigurationSchema",
    "workflowGateProtectedRequestSchema",
    "workflowGateProtectedResponseSchema",
    "resolveProtectedWorkflowGate",
    "evaluatePredicate",
    "protectedAttemptResult",
    "protectedRunResult",
    "prepareProtectedWorkflowTrigger",
    "workflowTriggerProtectedConfigurationSchema",
    "workflowTriggerProtectedDeliverySchema",
    "workflowTriggerProtectedInputSchema",
    "workflowTriggerBranchMatches",
    "protectedWorkflowTriggerPrepareResultSchema",
    'recordKind: "workflow-delivery"',
    'recordKind: "workflow-run"',
  ]) {
    if (!workerExecutionText.includes(marker)) {
      failures.push(`Worker workflow execution is missing ${marker}.`);
    }
  }
  for (const marker of [
    "protectAgentInteractionRequest",
    'type: "workflow.node.interaction.requested.protected"',
  ]) {
    if (!workerText.includes(marker)) {
      failures.push(`Worker workflow interaction path is missing ${marker}.`);
    }
  }
  for (const marker of [
    "recordEncryptedAgentInteractionRequest",
    "respondToEncryptedInteraction",
  ]) {
    if (!executorText.includes(marker)) {
      failures.push(`Workflow executor interaction path is missing ${marker}.`);
    }
  }
  for (const marker of [
    "workflowExecutor.respondToEncryptedInteraction",
    "resolveLiveEncryptedAgentInteractionRequest",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`Workflow interaction relay is missing ${marker}.`);
    }
  }
  if (applicationText.includes("workflowExecutor.respondToInteraction(")) {
    failures.push(
      "Workflow interaction relay still calls the visible response path.",
    );
  }
  for (const marker of [
    "minimizeWorkflowEventPayload(input.type, input.payload)",
    "publicPayload:",
    "protectedPayload:",
  ]) {
    if (!runTransitionsText.includes(marker)) {
      failures.push(`Workflow event minimization is missing ${marker}.`);
    }
  }
  for (const marker of [
    "input.reason",
    "jsonObject({ event })",
    "canonicalJson(event)",
    "schema.workflowRunEvents.payload",
    "textPreview:",
  ]) {
    if (runRepositoryText.includes(marker)) {
      failures.push(
        `Workflow event/control plaintext path returned: ${marker}.`,
      );
    }
  }
  for (const marker of [
    "AgentInteractionPanel",
    "workflowRunId: selectedRunId!",
    'queryKey: ["workflow-interactions", selectedRunId, "pending"]',
  ]) {
    if (!workflowCenterText.includes(marker)) {
      failures.push(`Workflow interaction client is missing ${marker}.`);
    }
  }
  for (const marker of [
    "structuredInput: {}",
    "protectedInput: input.protectedInput",
    "protectedResult: result.protectedNodeResult",
    "protectedResult: result.protectedAttemptResult",
    "protectedRequest: result.protectedRequest",
    "protectedResponse: input.protectedResponse",
  ]) {
    if (!runRepositoryText.includes(marker)) {
      failures.push(`Workflow run repository is missing ${marker}.`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Workflow-catalog content boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: [
      "workflow_definitions",
      "workflow_revisions",
      "workflow_runs",
      "workflow_run_nodes",
      "workflow_run_node_items",
      "workflow_node_attempts",
      "agent_interaction_requests",
      "workflow_automation_triggers",
      "workflow_trigger_deliveries",
    ],
    guards: [
      "definition-slug-name-description-provenance:opaque-only",
      "revision-provenance-and-content-hash:opaque-only",
      "revision-graph-prompts-config-schemas-defaults-permissions:opaque-only",
      "node-edge-topology:minimized-public-scheduling-manifest",
      "slug-and-content-hash-equality:keyed-blind-index",
      "duplicated-revision-graph:removed",
      "legacy-generation-repository-and-save-routes:fail-closed",
      "agent-run-input-result-error:opaque-client-worker-runtime",
      "map-pipeline-reduce-repeat-verify-condition:worker-only-semantics",
      "collection-values-and-branch-predicates:opaque-to-server",
      "workflow-agent-interactions:interaction-content-client-worker-only",
      "workflow-gate-request-response:workflow-content-client-worker-only",
      "workflow-gate-semantics:worker-authenticated",
      "workflow-control-reasons:workflow-content-client-only",
      "workflow-event-content:protected-or-minimized-public-metadata",
      "workflow-trigger-content:workflow-content-client-worker-only",
      "workflow-delivery-input:operation-bound-client-worker-only",
      "workflow-trigger-routing:minimized-public-scheduling-metadata",
    ],
    remainingPlaintextContent: [],
  };
}

function tableInitializer(sourceText, declarationName) {
  const declaration = sourceText.indexOf(`export const ${declarationName}`);
  if (declaration < 0) throw new Error(`Missing ${declarationName}.`);
  const start = sourceText.indexOf(
    "(",
    sourceText.indexOf("pgTable", declaration),
  );
  if (start < 0)
    throw new Error(`Missing pgTable initializer for ${declarationName}.`);
  const end = matchingDelimiter(sourceText, start, "(", ")");
  return sourceText.slice(start, end + 1);
}

async function policyRepositoryBoundaryAudit() {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/policies.ts");
  const [schemaText, repositoryText, applicationText] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(repositoryPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);
  const failures = [];
  const initializer = tableInitializer(schemaText, "policies");
  for (const [property, column] of [
    ["keyBlindIndex", "key_blind_index"],
    ["protectedSummary", "protected_summary"],
    ["protectedBody", "protected_body"],
  ]) {
    if (
      !new RegExp(
        `\\b${property}\\s*:\\s*(?:text|jsonb)\\(["']${column}["']\\)`,
        "u",
      ).test(initializer)
    ) {
      failures.push(`policies: missing opaque ${column} storage`);
    }
  }
  for (const field of ["key", "name", "summary", "bodyMarkdown"]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
      failures.push(`policies: legacy plaintext ${field} field returned`);
    }
    if (
      new RegExp(`schema\\.policies\\.${field}\\b`, "u").test(repositoryText)
    ) {
      failures.push(`policies: repository references plaintext ${field}`);
    }
  }
  for (const marker of [
    "toPolicySummary",
    "toPolicyDetail",
    "encryptedPolicyCreateSchema",
    "encryptedPolicyUpdateSchema",
    "effectivePolicyWireListSchema",
  ]) {
    if (!repositoryText.includes(marker)) {
      failures.push(`policies: missing opaque repository marker ${marker}`);
    }
  }
  for (const obsolete of [
    "/api/policies/from-template/",
    "/reset-template",
    "buildAgentPolicyContext",
  ]) {
    if (applicationText.includes(obsolete)) {
      failures.push(`application: obsolete plaintext policy path ${obsolete}`);
    }
  }
  for (const marker of [
    'app.post("/api/policies/bootstrap"',
    "encryptedPolicyBootstrapSchema",
    "policyCliWireListResultSchema",
    "policyCliWireReadResultSchema",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`application: missing opaque policy marker ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Policy repository boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["policies"],
    guards: [
      "policies:opaque-summary-and-body-only",
      "policies:blind-key-uniqueness",
      "policy-routes:encrypted-ingress-and-wire-egress",
      "policy-cli:opaque-server-selection",
      "policy-agent-context:worker-only",
    ],
  };
}

async function providerSecretRepositoryBoundaryAudit() {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/repository.ts");
  const workerPath = resolve(repositoryRoot, "cantrip_worker/src/index.ts");
  const clientSecretsPath = resolve(
    repositoryRoot,
    "cantrip_app/src/lib/protected-secrets.ts",
  );
  const [
    schemaText,
    repositoryText,
    applicationText,
    workerText,
    clientSecretsText,
  ] = await Promise.all(
    [schemaPath, repositoryPath, appPath, workerPath, clientSecretsPath].map(
      (path) => readFile(path, "utf8"),
    ),
  );
  const failures = [];
  const providerTable = tableInitializer(schemaText, "modelProviders");
  const accountTable = tableInitializer(schemaText, "modelProviderAccounts");
  const mcpTable = tableInitializer(schemaText, "mcpServers");
  for (const [initializer, marker, description] of [
    [providerTable, "protectedApiKey", "model provider API-key envelope"],
    [accountTable, "protectedCredential", "provider credential envelope"],
    [accountTable, "protectedLabel", "provider account label envelope"],
    [
      accountTable,
      "credentialSubjectBlindIndex",
      "provider credential blind identity",
    ],
    [mcpTable, "protectedConfiguration", "MCP configuration envelope"],
    [mcpTable, "nameBlindIndex", "MCP name blind index"],
  ]) {
    if (!initializer.includes(marker)) {
      failures.push(`schema: missing ${description}`);
    }
  }
  for (const [initializer, fields, table] of [
    [providerTable, ["apiKey", "apiKeyEnvelope"], "modelProviders"],
    [
      accountTable,
      [
        "label",
        "email",
        "credentialEnvelope",
        "credentialSubject",
        "credentialLastRefreshError",
      ],
      "modelProviderAccounts",
    ],
    [
      mcpTable,
      [
        "name",
        "transport",
        "command",
        "args",
        "url",
        "environment",
        "environmentEnvelope",
        "headers",
        "headersEnvelope",
        "environmentHeaders",
        "bearerTokenEnvironmentVariable",
      ],
      "mcpServers",
    ],
  ]) {
    for (const field of fields) {
      if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
        failures.push(`${table}: legacy plaintext ${field} storage returned`);
      }
    }
  }
  for (const reference of [
    "schema.modelProviders.apiKey",
    "schema.modelProviders.apiKeyEnvelope",
    "schema.modelProviderAccounts.credentialEnvelope",
    "schema.modelProviderAccounts.credentialSubject",
    "schema.modelProviderAccounts.label",
    "schema.modelProviderAccounts.email",
    "schema.modelProviderAccounts.credentialLastRefreshError",
    "schema.mcpServers.environmentEnvelope",
    "schema.mcpServers.headersEnvelope",
  ]) {
    if (
      new RegExp(`${reference.replaceAll(".", "\\.")}\\b`, "u").test(
        repositoryText,
      )
    ) {
      failures.push(`repository: legacy reference ${reference}`);
    }
  }
  for (const obsolete of [
    "/access-lease",
    "modelProviderCreateSchema.safeParse(request.body)",
    "mcpServerConfigurationSchema.safeParse(request.body)",
  ]) {
    if (applicationText.includes(obsolete)) {
      failures.push(`application: obsolete plaintext path ${obsolete}`);
    }
  }
  for (const marker of [
    "encryptedModelProviderCreateSchema",
    "encryptedModelProviderUpdateSchema",
    "encryptedModelProviderAccountCreateSchema",
    "encryptedModelProviderAccountUpdateSchema",
    "modelProviderAccountWireSummarySchema",
    "encryptedMcpServerCreateSchema",
    "encryptedMcpServerUpdateSchema",
    "providerCredentialWireRecordSchema",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`application: missing opaque contract ${marker}`);
    }
  }
  for (const marker of [
    "protectProviderAccountLabel",
    "openModelProviderAccountWireSummary",
    'component: "provider-credential"',
    'field: "protected_label"',
  ]) {
    if (!clientSecretsText.includes(marker)) {
      failures.push(
        `client: missing provider-account label boundary ${marker}`,
      );
    }
  }
  for (const marker of [
    "openRuntimeProvider",
    "openMcpServers",
    "protectProviderCredential",
  ]) {
    if (!workerText.includes(marker)) {
      failures.push(`worker: missing trusted secret operation ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Provider/MCP secret repository boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: [
      "model_providers",
      "model_provider_accounts",
      "mcp_servers",
    ],
    guards: [
      "provider-api-keys:opaque-only",
      "provider-oauth-credentials:opaque-worker-refresh",
      "provider-account-labels:client-encrypted",
      "mcp-configurations:opaque-and-blind-indexed",
      "legacy-provider-and-mcp-columns:absent",
    ],
  };
}

async function workspaceNameRepositoryBoundaryAudit() {
  const paths = {
    schema: resolve(serverSourcePath, "db/schema.ts"),
    repository: resolve(serverSourcePath, "db/repository.ts"),
    protocol: protocolPath,
    application: appPath,
    client: resolve(
      repositoryRoot,
      "cantrip_app/src/lib/workspace-encryption.ts",
    ),
    migration: resolve(
      repositoryRoot,
      "cantrip_server/drizzle/0133_lame_rocket_racer.sql",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  const table = tableInitializer(texts.schema, "projectWorkspaces");
  for (const marker of [
    "nameEnvelope",
    "nameBlindIndex",
    "nameFormatVersion",
    "nameKeyRevision",
    "workspace:default:",
  ]) {
    if (!table.includes(marker)) {
      failures.push(`projectWorkspaces: missing opaque marker ${marker}`);
    }
  }
  if (/\bname\s*:\s*text\(/u.test(table)) {
    failures.push("projectWorkspaces: plaintext name column returned");
  }
  for (const marker of [
    "legacyProjectWorkspaceNameSchema",
    'state: z.literal("legacy")',
    "legacyCount",
  ]) {
    if (texts.protocol.includes(marker)) {
      failures.push(`protocol: legacy workspace contract returned (${marker})`);
    }
  }
  for (const marker of [
    "systemDefaultProjectWorkspaceNameSchema",
    "encryptedProjectWorkspaceNameSchema",
  ]) {
    if (!texts.protocol.includes(marker)) {
      failures.push(`protocol: missing workspace wire contract ${marker}`);
    }
  }
  for (const marker of [
    "schema.projectWorkspaces.name",
    "createProjectWorkspace(",
    "updateProjectWorkspace(",
    "listProjectWorkspaces(",
  ]) {
    if (texts.repository.includes(marker)) {
      failures.push(
        `repository: plaintext workspace path returned (${marker})`,
      );
    }
  }
  for (const marker of [
    "encryptedProjectWorkspaceCreateSchema",
    "encryptedProjectWorkspaceUpdateSchema",
    "projectWorkspaceWireSummarySchema",
  ]) {
    if (!texts.application.includes(marker)) {
      failures.push(
        `application: missing encrypted workspace marker ${marker}`,
      );
    }
  }
  for (const marker of ["sealSystemDefault", "encryptName", "decryptPayload"]) {
    if (!texts.client.includes(marker)) {
      failures.push(`client: missing workspace endpoint operation ${marker}`);
    }
  }
  for (const marker of [
    'DELETE FROM "project_workspaces" WHERE "name" IS NOT NULL',
    'DROP COLUMN "name"',
  ]) {
    if (!texts.migration.includes(marker)) {
      failures.push(`migration: missing workspace plaintext cutover ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Workspace-name E2EE boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["project_workspaces"],
    guards: [
      "workspace-names:encrypted-and-blind-indexed",
      "system-default:semantic-sentinel-only",
      "legacy-workspace-plaintext:absent",
      "workspace-routes:encrypted-ingress-and-wire-egress",
    ],
  };
}

async function tunnelConfigurationBoundaryAudit() {
  const paths = {
    schema: resolve(serverSourcePath, "db/schema.ts"),
    repository: resolve(serverSourcePath, "db/repository.ts"),
    application: appPath,
    protocol: protocolPath,
    tunnelProtocol: tunnelDataPlaneProtocolPath,
    client: resolve(
      repositoryRoot,
      "cantrip_app/src/lib/tunnel-content-encryption.ts",
    ),
    worker: resolve(
      repositoryRoot,
      "cantrip_worker/src/tunnel-content-encryption.ts",
    ),
    router: resolve(
      repositoryRoot,
      "cantrip_worker/src/tunnel-destination-router.ts",
    ),
    workerDataProtection: resolve(
      repositoryRoot,
      "cantrip_worker/src/tunnel-data-protection.ts",
    ),
    desktopDataPlane: resolve(
      repositoryRoot,
      "cantrip_app/src-tauri/src/tunnel_forward.rs",
    ),
    broker: resolve(serverSourcePath, "tunnels/broker.ts"),
    migration: resolve(
      repositoryRoot,
      "cantrip_server/drizzle/0145_closed_quasimodo.sql",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  const tunnelTable = tableInitializer(texts.schema, "tunnels");
  const attachmentTable = tableInitializer(texts.schema, "tunnelAttachments");

  for (const marker of [
    "protectedContent",
    "protectedOperationId",
    "protectedRevision",
    "destinationWorkerId",
    "errorCode",
    "tunnels_protected_content_check",
    "tunnels_private_endpoint_content_check",
  ]) {
    if (!tunnelTable.includes(marker)) {
      failures.push(`tunnels: missing protected/minimized field ${marker}`);
    }
  }
  for (const legacy of [
    "name",
    "description",
    "sourceEndpoint",
    "destinationEndpoint",
    "lastError",
  ]) {
    if (new RegExp(`\\b${legacy}\\s*:`, "u").test(tunnelTable)) {
      failures.push(`tunnels: legacy plaintext ${legacy} returned`);
    }
  }
  for (const legacy of ["localHost", "localPort", "lastError"]) {
    if (new RegExp(`\\b${legacy}\\s*:`, "u").test(attachmentTable)) {
      failures.push(`tunnelAttachments: legacy plaintext ${legacy} returned`);
    }
  }
  for (const marker of ["errorCode", "secretHash"]) {
    if (!attachmentTable.includes(marker)) {
      failures.push(`tunnelAttachments: missing minimized field ${marker}`);
    }
  }
  for (const marker of [
    "tunnelUserWireCreateSchema",
    "tunnelUserWireUpdateSchema",
    "tunnelWireSummarySchema",
    "browserTunnelWireRequestSchema",
  ]) {
    if (
      !texts.protocol.includes(marker) ||
      !texts.application.includes(marker)
    ) {
      failures.push(`tunnel routes: missing opaque contract ${marker}`);
    }
  }
  for (const marker of [
    'kind: z.literal("protected-tunnel")',
    "protectedTunnelContentRecordSchema",
    "tunnelDataFrameProtectionSchema",
    'algorithm: z.literal("AES-256-GCM")',
  ]) {
    if (!texts.tunnelProtocol.includes(marker)) {
      failures.push(`tunnel data plane: missing protected target ${marker}`);
    }
  }
  const frameHeaders = declarationInitializer(
    texts.tunnelProtocol,
    "tunnelDataPlaneFrameHeaderSchema",
    "[",
  );
  if (/\bmessage\s*:/u.test(frameHeaders)) {
    failures.push("tunnel control frames: free-form message returned");
  }
  for (const marker of [
    "tunnelProtectedRecord",
    "toTunnelSummary",
    "protectedRecord,",
  ]) {
    if (!texts.repository.includes(marker)) {
      failures.push(`tunnel repository: missing opaque serializer ${marker}`);
    }
  }
  for (const marker of [
    'domain: "tunnel-content"',
    "protectEndpointContent",
    "openEndpointContent",
  ]) {
    if (!texts.client.includes(marker)) {
      failures.push(`tunnel client: missing E2EE operation ${marker}`);
    }
  }
  for (const marker of [
    'domain: "tunnel-content"',
    "openWorkerEndpointContent",
  ]) {
    if (!texts.worker.includes(marker)) {
      failures.push(`tunnel worker: missing E2EE operation ${marker}`);
    }
  }
  for (const marker of [
    'target.kind === "protected-tunnel"',
    "openWorkerTunnelContentRecord",
    "openTunnelDataFrame",
    "sealTunnelDataFrame",
  ]) {
    if (!texts.router.includes(marker)) {
      failures.push(
        `tunnel router: missing protected target handling ${marker}`,
      );
    }
  }
  for (const marker of [
    'createCipheriv("aes-256-gcm"',
    'createDecipheriv("aes-256-gcm"',
    "associatedData",
  ]) {
    if (!texts.workerDataProtection.includes(marker)) {
      failures.push(
        `tunnel worker data plane: missing AEAD boundary ${marker}`,
      );
    }
  }
  for (const marker of [
    "Aes256Gcm",
    "frame_associated_data",
    "seal_data_payload",
    "open_data_payload",
  ]) {
    if (!texts.desktopDataPlane.includes(marker)) {
      failures.push(
        `tunnel desktop data plane: missing AEAD boundary ${marker}`,
      );
    }
  }
  if (
    /@cantrip\/crypto|createDecipher|Aes256Gcm|openTunnelDataFrame/u.test(
      texts.broker,
    )
  ) {
    failures.push("tunnel broker: endpoint decryption dependency returned");
  }
  for (const marker of [
    'TRUNCATE TABLE "tunnels" CASCADE',
    'DROP COLUMN "name"',
    'DROP COLUMN "description"',
    'DROP COLUMN "source_endpoint"',
    'DROP COLUMN "destination_endpoint"',
    'DROP COLUMN "local_host"',
    'DROP COLUMN "local_port"',
  ]) {
    if (!texts.migration.includes(marker)) {
      failures.push(`tunnel migration: missing plaintext cutover ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Tunnel configuration E2EE boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["tunnels", "tunnel_attachments"],
    guards: [
      "presentation-and-tcp-config:opaque",
      "routing-and-counters:minimized",
      "attachment-local-listener:client-only",
      "control-errors:stable-codes-only",
      "destination-worker:opens-protected-target",
      "desktop-worker-tcp-data:endpoint-aead",
      "direct-and-relayed-frames:same-ciphertext-contract",
      "server-broker:ciphertext-only",
      "legacy-tunnel-plaintext:absent",
    ],
  };
}

async function encryptionLedgerClosureAudit() {
  const document = await readFile(encryptionPlanPath, "utf8");
  const section = document
    .split("## Feasibility and rollout ledger", 2)[1]
    ?.split("### Workspace display names", 1)[0];
  if (!section) throw new Error("Encryption ledger section was not found.");
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/u.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(([dataClass]) => dataClass !== "Data class");
  const failures = [];
  const classifications = {
    endpointProtected: 0,
    minimizedOperationalMetadata: 0,
    hashedAuthenticationMaterial: 0,
    plaintextControlPlane: 0,
  };
  for (const cells of rows) {
    if (cells.length !== 6) {
      failures.push(`ledger: malformed row with ${cells.length} cells`);
      continue;
    }
    const [dataClass, currentProtection, rolloutStatus, feasibility] = cells;
    if (
      /\b(?:incomplete|lazy|partial|pending|planned|not started)\b/iu.test(
        rolloutStatus,
      )
    ) {
      failures.push(`${dataClass}: unfinished rollout status ${rolloutStatus}`);
    }
    if (rolloutStatus === "Keep hashed") {
      classifications.hashedAuthenticationMaterial += 1;
    } else if (
      [
        "Intentionally plaintext",
        "Do not encrypt",
        "Usually keep plaintext",
        "No encryption benefit",
      ].includes(rolloutStatus)
    ) {
      classifications.plaintextControlPlane += 1;
    } else if (
      /minimization/iu.test(rolloutStatus) ||
      feasibility === "Intentional metadata"
    ) {
      classifications.minimizedOperationalMetadata += 1;
    } else {
      classifications.endpointProtected += 1;
    }
    if (
      /^Plaintext(?:\/public)?$/u.test(currentProtection) &&
      ![
        "Intentionally plaintext",
        "Do not encrypt",
        "Usually keep plaintext",
        "No encryption benefit",
      ].includes(rolloutStatus)
    ) {
      failures.push(`${dataClass}: plaintext is not explicitly classified`);
    }
  }
  if (rows.length !== 47) {
    failures.push(`ledger: expected 47 classified rows, found ${rows.length}`);
  }
  if (failures.length > 0) {
    throw new Error(`Encryption ledger is not closed:\n${failures.join("\n")}`);
  }
  const remainingSection = document
    .split("## Post-closure review and remaining-work ledger", 2)[1]
    ?.split("## Important web-client limitation", 1)[0];
  if (!remainingSection) {
    throw new Error("Post-closure remaining-work ledger was not found.");
  }
  const remainingRows = remainingSection
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*-+/u.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter(([dataClass]) => dataClass !== "Data class");
  const malformedRemainingRows = remainingRows.filter(
    (cells) => cells.length !== 6,
  );
  if (remainingRows.length === 0 || malformedRemainingRows.length > 0) {
    throw new Error(
      "Post-closure remaining-work ledger is empty or malformed.",
    );
  }
  const plannedRows = remainingRows.filter((cells) =>
    /\b(?:planned|partial|pending|incomplete|not started)\b/iu.test(cells[3]),
  );
  return {
    status: "closed",
    rowCount: rows.length,
    classifications,
    remainingWork: {
      status: plannedRows.length > 0 ? "open" : "closed",
      rowCount: remainingRows.length,
      plannedCount: plannedRows.length,
      plannedDataClasses: plannedRows.map(([dataClass]) => dataClass),
    },
  };
}

async function durableJobStatusBoundaryAudit() {
  const paths = {
    schema: schemaPath,
    protocol: protocolPath,
    repository: resolve(serverSourcePath, "db/repository.ts"),
    migration: resolve(
      repositoryRoot,
      "cantrip_server/drizzle/0148_slim_johnny_blaze.sql",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  const durableJobs = [
    ["projectFolderSetupJobs", "project_folder_setup_jobs", false],
    ["projectGithubConversionJobs", "project_github_conversion_jobs", false],
    ["projectReplicaJobs", "project_replica_jobs", true],
    ["chatRelocationJobs", "chat_relocation_jobs", true],
    ["chatImportJobs", "chat_import_jobs", true],
  ];
  for (const [exportName, tableName, hasProgress] of durableJobs) {
    const table = tableInitializer(texts.schema, exportName);
    for (const legacy of ["lastErrorMessage", "last_error_message"]) {
      if (table.includes(legacy)) {
        failures.push(`${tableName}: free-form durable error field returned`);
      }
    }
    for (const marker of ["lastErrorCode", "errorRetryable"]) {
      if (!table.includes(marker)) {
        failures.push(`${tableName}: missing stable error field ${marker}`);
      }
    }
    if (hasProgress && !table.includes("progress_minimized_check")) {
      failures.push(`${tableName}: minimized progress constraint is missing`);
    }
    if (
      !texts.migration.includes(
        `ALTER TABLE "${tableName}" DROP COLUMN "last_error_message"`,
      )
    ) {
      failures.push(`${tableName}: plaintext error cutover is missing`);
    }
  }

  for (const schemaName of [
    "projectReplicaJobErrorSchema",
    "projectReplicaJobProgressSchema",
    "projectFolderSetupJobErrorSchema",
    "chatRelocationProgressSchema",
    "chatImportProgressSchema",
  ]) {
    const initializer = declarationInitializer(texts.protocol, schemaName, "(");
    if (/\bmessage\s*:/u.test(initializer)) {
      failures.push(`${schemaName}: free-form message returned`);
    }
  }
  for (const schemaName of [
    "projectGithubConversionJobErrorSchema",
    "chatRelocationJobErrorSchema",
    "chatImportJobErrorSchema",
  ]) {
    const declaration = texts.protocol.slice(
      texts.protocol.indexOf(`export const ${schemaName}`),
      texts.protocol.indexOf(
        ";",
        texts.protocol.indexOf(`export const ${schemaName}`),
      ) + 1,
    );
    if (!/omit\(\{\s*message:\s*true,?\s*\}\)/u.test(declaration)) {
      failures.push(`${schemaName}: detailed endpoint error was not minimized`);
    }
  }
  for (const tableName of [
    "project_replica_jobs",
    "chat_relocation_jobs",
    "chat_import_jobs",
  ]) {
    if (
      !texts.migration.includes(
        `UPDATE "${tableName}" SET "progress" = "progress" - 'message'`,
      )
    ) {
      failures.push(`${tableName}: legacy progress scrub is missing`);
    }
  }
  const projectsTable = tableInitializer(texts.schema, "projects");
  if (!projectsTable.includes("projects_setup_error_minimized_check")) {
    failures.push("projects: minimized setup-error constraint is missing");
  }
  if (texts.repository.includes("failGithubProjectSetup")) {
    failures.push("repository: free-form project setup-error writer returned");
  }
  if (failures.length > 0) {
    throw new Error(
      `Durable job-status minimization regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: durableJobs.map(([, tableName]) => tableName),
    guards: [
      "job-errors:stable-code-and-retryable-only",
      "job-progress:stable-stage-percent-timestamp-only",
      "legacy-free-form-job-status:deleted",
    ],
  };
}

async function clientControlNotificationBoundaryAudit() {
  const paths = {
    contentProtocol: resolve(
      repositoryRoot,
      "packages/protocol/src/client-control-content.ts",
    ),
    endpointProtocol: endpointContentProtocolPath,
    encryptionProtocol: resolve(
      repositoryRoot,
      "packages/protocol/src/encryption.ts",
    ),
    liveProtocol: liveProtocolPath,
    server: appPath,
    worker: resolve(
      repositoryRoot,
      "cantrip_worker/src/mcp/client-control-operations.ts",
    ),
    workerEncryption: resolve(
      repositoryRoot,
      "cantrip_worker/src/client-control-content-encryption.ts",
    ),
    client: resolve(repositoryRoot, "cantrip_app/src/App.tsx"),
    clientEncryption: resolve(
      repositoryRoot,
      "cantrip_app/src/lib/client-control-content-encryption.ts",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  for (const marker of [
    "clientNotificationContentSchema",
    "protectedClientNotificationSchema",
    'domain === "client-control-content"',
  ]) {
    if (!texts.contentProtocol.includes(marker)) {
      failures.push(
        `protocol: missing protected notification marker ${marker}`,
      );
    }
  }
  for (const textName of ["endpointProtocol", "encryptionProtocol"]) {
    if (!texts[textName].includes('"client-control-content"')) {
      failures.push(`${textName}: client-control component domain is missing`);
    }
  }
  const notifyStart = texts.liveProtocol.indexOf('kind: z.literal("notify")');
  const notifyEnd = texts.liveProtocol.indexOf(".strict()", notifyStart);
  const notifyContract = texts.liveProtocol.slice(notifyStart, notifyEnd);
  for (const marker of ["workerId", "operationId", "protectedContent"]) {
    if (!notifyContract.includes(marker)) {
      failures.push(`live notification: missing opaque field ${marker}`);
    }
  }
  for (const semantic of ["level", "title", "message"]) {
    if (new RegExp(`\\b${semantic}\\s*:`, "u").test(notifyContract)) {
      failures.push(`live notification: plaintext ${semantic} returned`);
    }
  }
  if (texts.server.includes("cantripMcpClientNotifyInputSchema")) {
    failures.push("server: plaintext notification input schema returned");
  }
  for (const [textName, marker] of [
    ["server", "protectedClientNotificationSchema"],
    ["worker", "protectWorkerClientNotification"],
    ["workerEncryption", 'domain: "client-control-content"'],
    ["client", "openClientNotification"],
    ["clientEncryption", 'domain: "client-control-content"'],
  ]) {
    if (!texts[textName].includes(marker)) {
      failures.push(`${textName}: protected notification path is missing`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Client-control notification E2EE boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    guards: [
      "notification-content:worker-sealed",
      "live-control:opaque-envelope-only",
      "notification-content:client-opened",
    ],
  };
}

async function sessionMetadataMinimizationBoundaryAudit() {
  const paths = {
    schema: schemaPath,
    repository: resolve(serverSourcePath, "db/repository.ts"),
    authentication: resolve(serverSourcePath, "auth/service.ts"),
    migration: resolve(
      repositoryRoot,
      "cantrip_server/drizzle/0149_nebulous_meggan.sql",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  const sessionTable = tableInitializer(texts.schema, "userSessions");
  for (const field of [
    "ipAddressHash",
    "userAgentHash",
    "ip_address_hash",
    "user_agent_hash",
  ]) {
    if (sessionTable.includes(field)) {
      failures.push(`userSessions: retained request fingerprint ${field}`);
    }
  }
  for (const marker of [
    "requestMetadataHash",
    "ipAddressHash",
    "userAgentHash",
  ]) {
    if (`${texts.authentication}\n${texts.repository}`.includes(marker)) {
      failures.push(`session creation: retained request fingerprint ${marker}`);
    }
  }
  for (const column of ["ip_address_hash", "user_agent_hash"]) {
    if (!texts.migration.includes(`DROP COLUMN \"${column}\"`)) {
      failures.push(`session migration: missing DROP COLUMN ${column}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Session metadata minimization boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["user_sessions"],
    guards: [
      "request-ip-fingerprint:absent",
      "user-agent-fingerprint:absent",
      "session-and-csrf-token-hashes:retained-authentication-validators",
      "legacy-fingerprint-columns:dropped",
    ],
  };
}

async function analyticsAuditLogPrivacyBoundaryAudit() {
  const paths = {
    schema: resolve(serverSourcePath, "db/schema.ts"),
    repository: resolve(serverSourcePath, "db/repository.ts"),
    application: appPath,
    logging: resolve(repositoryRoot, "packages/logging/src/records.ts"),
    rotatingLog: resolve(
      repositoryRoot,
      "packages/logging/src/rotating-jsonl.ts",
    ),
  };
  const texts = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const failures = [];
  const schemaTables = {
    auditEvents: ["ipAddressHash", "userAgentHash", "metadata"],
    modelBehaviorObservations: [
      "modelName",
      "providerName",
      "providerModelName",
    ],
    modelProviderAccountWorkers: ["lastError"],
    providerCatalogSyncStates: ["error"],
    providerModelCatalogSnapshots: [
      "providerName",
      "nativeModelId",
      "canonicalModelId",
      "metadata",
    ],
    providerQuotaObservations: [
      "providerName",
      "providerAccountLabel",
      "workerName",
      "limitName",
      "planType",
      "sanitizedRawPayload",
    ],
    tokenUsageRecords: [
      "modelName",
      "providerName",
      "providerModelName",
      "sanitizedRawUsage",
    ],
  };
  for (const [table, fields] of Object.entries(schemaTables)) {
    const initializer = tableInitializer(texts.schema, table);
    for (const field of fields) {
      if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
        failures.push(`${table}: sensitive diagnostic field ${field} returned`);
      }
    }
  }
  for (const marker of [
    "providerTelemetryWireAnalyticsSchema",
    "modelProviderAccountWireSummarySchema",
    "settingsBundleWireSchema",
  ]) {
    if (!texts.application.includes(marker)) {
      failures.push(`application: missing minimized wire contract ${marker}`);
    }
  }
  for (const marker of [
    "minimizeServiceLogRecordInput",
    "Human messages, arbitrary context",
  ]) {
    if (!texts.logging.includes(marker)) {
      failures.push(
        `logging: missing persistent minimization marker ${marker}`,
      );
    }
  }
  if (!texts.rotatingLog.includes("minimizeServiceLogRecordInput(record)")) {
    failures.push("logging: rotating files do not enforce minimization");
  }
  for (const reference of [
    "schema.modelProviderAccounts.label",
    "schema.providerQuotaObservations.providerAccountLabel",
    "schema.providerQuotaObservations.sanitizedRawPayload",
    "schema.tokenUsageRecords.sanitizedRawUsage",
  ]) {
    if (texts.repository.includes(reference)) {
      failures.push(`repository: sensitive persistence reference ${reference}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Analytics/audit/log privacy boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: [
      "audit_events",
      "model_behavior_observations",
      "provider_model_catalog_snapshots",
      "provider_quota_observations",
      "token_usage_records",
    ],
    guards: [
      "analytics:opaque-dimensions-and-counters-only",
      "audits:fixed-columns-without-arbitrary-metadata",
      "persistent-logs:event-coded-allowlist",
      "provider-account-diagnostics:coarse-codes-only",
    ],
  };
}

async function attachmentContentRepositoryBoundaryAudit() {
  const paths = [
    resolve(serverSourcePath, "db/schema.ts"),
    resolve(serverSourcePath, "db/repository.ts"),
    appPath,
    resolve(serverSourcePath, "chat-imports/executor.ts"),
    resolve(serverSourcePath, "chat-relocations/executor.ts"),
    resolve(serverSourcePath, "chats/execution-helpers.ts"),
    resolve(serverSourcePath, "workflows/generation-helpers.ts"),
    protocolPath,
    resolve(repositoryRoot, "cantrip_worker/src/index.ts"),
  ];
  const [
    schemaText,
    repositoryText,
    applicationText,
    importExecutorText,
    relocationExecutorText,
    chatExecutionHelpersText,
    workflowGenerationHelpersText,
    protocolText,
    workerText,
  ] = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const failures = [];
  const initializer = tableInitializer(schemaText, "chatAttachments");
  if (
    !/\bprotectedMetadata\s*:\s*jsonb\(["']protected_metadata["']\)/u.test(
      initializer,
    )
  ) {
    failures.push("chatAttachments: missing protected_metadata JSONB storage");
  }
  for (const field of [
    "fileName",
    "mimeType",
    "kind",
    "source",
    "previewText",
    "sha256",
    "error",
  ]) {
    if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
      failures.push(
        `chatAttachments: legacy plaintext ${field} storage returned`,
      );
    }
  }
  for (const reference of [
    "fileName",
    "mimeType",
    "kind",
    "source",
    "previewText",
    "sha256",
    "error",
  ]) {
    if (
      new RegExp(`schema\\.chatAttachments\\.${reference}\\b`, "u").test(
        repositoryText,
      )
    ) {
      failures.push(`repository: legacy attachment reference ${reference}`);
    }
  }
  for (const marker of [
    "x-cantrip-file-name",
    "x-cantrip-mime-type",
    "x-cantrip-attachment-kind",
    "x-cantrip-attachment-source",
  ]) {
    if (applicationText.includes(marker)) {
      failures.push(
        `application: obsolete plaintext attachment header ${marker}`,
      );
    }
  }
  for (const marker of [
    "attachmentUploadOpaqueSchema",
    "attachmentDownloadOpaqueSchema",
    "chatAttachmentOpaqueListSchema",
    "protectedMetadata: input.data.protectedMetadata",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(
        `application: missing opaque attachment contract ${marker}`,
      );
    }
  }
  const jobText = `${importExecutorText}\n${relocationExecutorText}`;
  for (const marker of [
    "fileName: descriptor.fileName",
    "fileName: item.attachment.fileName",
    "Buffer.from(source.data",
    "Buffer.from(chunk.data",
    "descriptor.sha256",
    "item.sha256",
  ]) {
    if (jobText.includes(marker)) {
      failures.push(`attachment jobs: plaintext relay returned (${marker})`);
    }
  }
  const contentBuilderText = `${chatExecutionHelpersText}\n${workflowGenerationHelpersText}`;
  for (const field of ["fileName", "mimeType", "previewText", "sha256"]) {
    if (
      new RegExp(`\\bitem\\.attachment\\.${field}\\b`, "u").test(
        contentBuilderText,
      )
    ) {
      failures.push(
        `server content builders: protected attachment ${field} returned`,
      );
    }
  }
  for (const marker of [
    'direction: z.enum(["upload", "relay"])',
    'direction: z.enum(["download", "relay"])',
    "protectedMetadata: attachmentProtectedMetadataSchema",
    "chunk: attachmentChunkOpaqueSchema",
  ]) {
    if (!protocolText.includes(marker)) {
      failures.push(
        `worker commands: missing opaque stream contract ${marker}`,
      );
    }
  }
  for (const marker of [
    "openWorkerAttachmentMetadata",
    "openWorkerAttachmentChunk",
    "protectWorkerAttachmentChunk",
  ]) {
    if (!workerText.includes(marker)) {
      failures.push(`worker: missing trusted attachment operation ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Attachment-content repository boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: ["chat_attachments", "queued_prompts"],
    guards: [
      "attachment-metadata:opaque-jsonb-only",
      "attachment-upload-and-download:ciphertext-only",
      "attachment-import-and-relocation:ciphertext-relay",
      "attachment-digest:trusted-endpoint-only",
      "legacy-attachment-columns-and-headers:absent",
    ],
  };
}

async function privateDisplayLabelRepositoryBoundaryAudit() {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/repository.ts");
  const tabLayoutsPath = resolve(serverSourcePath, "db/tab-layouts.ts");
  const secondaryPaths = [
    resolve(serverSourcePath, "db/chat-import-jobs.ts"),
    resolve(serverSourcePath, "db/chat-relocation-jobs.ts"),
    resolve(serverSourcePath, "db/project-automations.ts"),
  ];
  const [schemaText, repositoryText, tabLayoutsText, ...secondaryTexts] =
    await Promise.all(
      [schemaPath, repositoryPath, tabLayoutsPath, ...secondaryPaths].map(
        (path) => readFile(path, "utf8"),
      ),
    );
  const failures = [];
  for (const [table, legacyField] of privateDisplayLabelTables) {
    const initializer = tableInitializer(schemaText, table);
    if (
      !/\bprotectedLabel\s*:\s*jsonb\(["']protected_label["']\)/u.test(
        initializer,
      )
    ) {
      failures.push(`${table}: missing protected_label JSONB storage`);
    }
    if (new RegExp(`\\b${legacyField}\\s*:`, "u").test(initializer)) {
      failures.push(`${table}: legacy plaintext ${legacyField} field returned`);
    }
  }
  const persistenceText = `${repositoryText}\n${tabLayoutsText}`;
  for (const [table, legacyField] of privateDisplayLabelTables) {
    if (
      new RegExp(
        `schema\\.${table}\\.${legacyField}\\b|schema\\.${table}\\[(["'])${legacyField}\\1\\]`,
        "u",
      ).test(persistenceText)
    ) {
      failures.push(`${table}: repository references plaintext ${legacyField}`);
    }
  }
  for (const marker of [
    "toProjectWireSummary",
    "toChatWireSummary",
    "toTerminalWireSummary",
    "toExplorerWireSummary",
    "toCodeTabWireSummary",
    "toBrowserWireSummary",
    "toRemoteSurfaceWireSummary",
    "toRemoteDesktopWireSummary",
    "toProjectViewWireSummary",
  ]) {
    if (!persistenceText.includes(marker)) {
      failures.push(`repository: missing opaque serializer ${marker}`);
    }
  }
  const secondaryText = secondaryTexts.join("\n");
  if (
    !secondaryText.includes("transcript.titleProtection") ||
    !secondaryText.includes("titleProtection: chat.protectedLabel")
  ) {
    failures.push(
      "secondary jobs: import or relocation stopped copying opaque title protection",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Private-label repository boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    coveredTables: privateDisplayLabelTables.map(([table]) => table),
    guards: [
      "covered-tables:protected-label-jsonb-only",
      "repository:wire-only-label-serialization",
      "tab-layouts:opaque-member-and-group-labels",
      "chat-imports:opaque-title-copy",
      "chat-relocations:opaque-title-copy",
    ],
  };
}

function literalValuesInInitializer(sourceText, declarationName, opener) {
  const declaration = sourceText.indexOf(`export const ${declarationName}`);
  if (declaration < 0) throw new Error(`Missing ${declarationName}.`);
  const start = sourceText.indexOf(opener, declaration);
  if (start < 0) throw new Error(`Missing ${opener} for ${declarationName}.`);
  const end = matchingDelimiter(
    sourceText,
    start,
    opener,
    opener === "[" ? "]" : ")",
  );
  return [
    ...sourceText
      .slice(start, end + 1)
      .matchAll(/\bz\.literal\(["']([^"']+)["']\)/gu),
  ].map((match) => match[1]);
}

function enumValues(sourceText, declarationName) {
  const declaration = sourceText.indexOf(`export const ${declarationName}`);
  if (declaration < 0) throw new Error(`Missing ${declarationName}.`);
  const enumCall = sourceText.indexOf("z.enum(", declaration);
  const start = sourceText.indexOf("[", enumCall);
  const end = matchingDelimiter(sourceText, start, "[", "]");
  return [
    ...sourceText.slice(start, end + 1).matchAll(/["']([^"']+)["']/gu),
  ].map((match) => match[1]);
}

function reviewedDigest(values) {
  return createHash("sha256")
    .update([...new Set(values)].sort().join("\n"))
    .digest("hex");
}

function requireReviewedContractSet(kind, values) {
  const actual = reviewedDigest(values);
  const expected = REVIEWED_CONTRACT_DIGESTS[kind];
  if (actual !== expected) {
    throw new Error(
      `Server content boundary has an unreviewed ${kind} set. ` +
        `Expected ${expected}; reviewed candidate is ${actual}.`,
    );
  }
  return actual;
}

function durableTableContentInventory(schemaText) {
  const tables = [
    ...schemaText.matchAll(
      /export const ([A-Za-z][A-Za-z0-9_]*)\s*=\s*pgTable\(\s*["']([^"']+)["']/gu,
    ),
  ].map((match) => ({ exportName: match[1], tableName: match[2] }));
  const discovered = new Set(tables.map(({ exportName }) => exportName));
  const classified = new Set(Object.keys(DURABLE_TABLE_CLASSIFICATIONS));
  const missing = [...discovered].filter((name) => !classified.has(name));
  const stale = [...classified].filter((name) => !discovered.has(name));
  const invalid = Object.entries(DURABLE_TABLE_CLASSIFICATIONS)
    .filter(
      ([, classification]) => !CONTENT_CLASSIFICATIONS.has(classification),
    )
    .map(([name]) => name);
  if (missing.length > 0 || stale.length > 0 || invalid.length > 0) {
    throw new Error(
      [
        "Durable server table content classifications are incomplete.",
        ...(missing.length > 0
          ? [`Unclassified tables: ${missing.sort().join(", ")}`]
          : []),
        ...(stale.length > 0
          ? [`Stale classifications: ${stale.sort().join(", ")}`]
          : []),
        ...(invalid.length > 0
          ? [`Invalid classifications: ${invalid.sort().join(", ")}`]
          : []),
      ].join("\n"),
    );
  }
  return tables
    .map((table) => ({
      ...table,
      classification: DURABLE_TABLE_CLASSIFICATIONS[table.exportName],
    }))
    .sort((left, right) => left.tableName.localeCompare(right.tableName));
}

function applicationRouteContentClassification(route) {
  const key = `${route.method} ${route.path}`;
  if (
    /(?:\/run-environment(?:\/|$)|\/script-commands(?:\/|$))/u.test(route.path)
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "operation-bound Run or discovered-command content",
    };
  }
  if (route.path.endsWith("/customizations/target")) {
    return {
      classification: "intentionally-public-control-plane",
      rationale: "customization worker and resource routing identifiers",
    };
  }
  if (
    /\/skills(?:\/|$)/u.test(route.path) ||
    /\/customizations(?:\/|$)/u.test(route.path)
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "operation-bound customization content",
    };
  }
  if (/\/tunnels(?:\/|$)/u.test(route.path)) {
    return {
      classification: "endpoint-protected",
      rationale: "opaque tunnel configuration and minimized routing metadata",
    };
  }
  if (/^\/api\/auth\//u.test(route.path)) {
    return {
      classification: "hashed-validator",
      rationale: "authentication and session validation boundary",
    };
  }
  if (
    /(?:\/analytics(?:\/|$)|\/audit-events(?:\/|$)|\/token-usage(?:\/|$)|\/telemetry(?:\/|$))/u.test(
      route.path,
    )
  ) {
    return {
      classification: "minimized-operational-metadata",
      rationale: "bounded analytics, audit, or telemetry contract",
    };
  }
  if (
    /(?:\/encryption(?:\/|$)|\/code-settings(?:\/|$)|\/attachments(?:\/|$)|\/chats(?:\/|$)|\/tasks(?:\/|$)|\/workflows(?:\/|$)|\/policies(?:\/|$)|\/mcp-servers(?:\/|$)|\/repository-operation(?:\/|$))/u.test(
      route.path,
    ) ||
    /\b(?:encrypted|protected|opaque|Protection)\b/u.test(route.source)
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "opaque or endpoint-protected route contract",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: `reviewed routing/authorization contract (${key})`,
  };
}

function workerCommandContentClassification(command) {
  if (/^code\.settings\./u.test(command)) {
    return {
      classification: "endpoint-protected",
      rationale: "worker-owned encrypted global Code settings lifecycle",
    };
  }
  if (
    /^(?:project\.run-configurations\.(?:inspect|read-authoring|write)|project\.run-setup\.(?:start|status)|project\.run\.logs|project\.script-commands(?:\.inspect)?)$/u.test(
      command,
    )
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "operation-bound Run or discovered-command content",
    };
  }
  if (command === "project.run-configurations.metadata") {
    return {
      classification: "minimized-operational-metadata",
      rationale: "bounded worktree-readiness metadata without Run semantics",
    };
  }
  if (/^(?:skills\.|customization\.)/u.test(command)) {
    return {
      classification: "endpoint-protected",
      rationale: "operation-bound customization content",
    };
  }
  if (
    /^(?:attachment\.|automation\.|explorer\.|git\.|github\.|policy\.|repository\.|surface\.|task\.|terminal\.|workflow\.)/u.test(
      command,
    )
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "operation-bound protected worker contract",
    };
  }
  if (/^(?:code\.|codegraph\.|project\.|worktree\.)/u.test(command)) {
    return {
      classification: "worker-local",
      rationale: "worker-owned operation with opaque server routing handles",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: "reviewed worker lifecycle or capability contract",
  };
}

function liveResourceContentClassification(resource) {
  if (resource === "tunnel") {
    return {
      classification: "endpoint-protected",
      rationale: "invalidation-only tunnel identifier",
    };
  }
  if (resource === "run") {
    return {
      classification: "minimized-operational-metadata",
      rationale: "Run lifecycle invalidation without semantic content",
    };
  }
  if (resource === "customization") {
    return {
      classification: "endpoint-protected",
      rationale: "customization invalidation without semantic payload",
    };
  }
  if (
    /^(?:chat|task|agent-interaction|terminal|explorer|browser|code-tab|project-view|remote-desktop|workflow-)/u.test(
      resource,
    )
  ) {
    return {
      classification: "endpoint-protected",
      rationale: "invalidations carry opaque IDs or protected summaries",
    };
  }
  if (/(?:job|status|token-usage|git-operation|git-conflict)/u.test(resource)) {
    return {
      classification: "minimized-operational-metadata",
      rationale: "bounded lifecycle invalidation",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: "reviewed invalidation-only resource",
  };
}

function cliCommandContentClassification(command) {
  if (/^run\./u.test(command)) {
    return {
      classification: "endpoint-protected",
      rationale: "worker-opened Run content or bounded lifecycle control",
    };
  }
  if (/^(?:browser|explorer|policy|terminal)\./u.test(command)) {
    return {
      classification: "endpoint-protected",
      rationale: "protected operation or surface stream contract",
    };
  }
  if (/^(?:target|worktree)\./u.test(command)) {
    return {
      classification: "worker-local",
      rationale: "opaque execution target and worker-local repository state",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: "reviewed CLI status contract",
  };
}

function agentOperationContentClassification(operation) {
  if (/^run(?:-|\.)/u.test(operation)) {
    return {
      classification: "endpoint-protected",
      rationale: "worker-opened Run content or bounded lifecycle control",
    };
  }
  if (operation === "client.notify") {
    return {
      classification: "endpoint-protected",
      rationale: "worker-sealed client-control-content notification envelope",
    };
  }
  if (/^(?:browser|explorer|policy|terminal)\./u.test(operation)) {
    return {
      classification: "endpoint-protected",
      rationale: "protected operation or surface stream contract",
    };
  }
  if (/^(?:target|worktree)\./u.test(operation)) {
    return {
      classification: "worker-local",
      rationale: "opaque execution target and worker-local repository state",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: "reviewed operation discovery or client-control contract",
  };
}

function clientControlContentClassification(command) {
  return command === "notify"
    ? {
        classification: "endpoint-protected",
        rationale: "operation-bound client-control-content ciphertext",
      }
    : {
        classification: "intentionally-public-control-plane",
        rationale: "short-lived opaque focus/materialization identifiers",
      };
}

function tunnelFrameContentClassification(kind) {
  if (kind === "data") {
    return {
      classification: "endpoint-protected",
      rationale:
        "direct and relayed TCP payloads use endpoint-authenticated tunnel ciphertext",
    };
  }
  if (kind === "connect") {
    return {
      classification: "endpoint-protected",
      rationale: "destination TCP configuration is an opaque tunnel record",
    };
  }
  if (["close", "error", "rejected"].includes(kind)) {
    return {
      classification: "minimized-operational-metadata",
      rationale: "stable lifecycle/error code without free-form content",
    };
  }
  return {
    classification: "intentionally-public-control-plane",
    rationale: "routing, lifecycle, or flow-control frame",
  };
}

function declarationInitializer(sourceText, declarationName, opener) {
  const declaration = sourceText.indexOf(`export const ${declarationName}`);
  if (declaration < 0) throw new Error(`Missing ${declarationName}.`);
  const start = sourceText.indexOf(opener, declaration);
  if (start < 0) throw new Error(`Missing ${opener} for ${declarationName}.`);
  const end = matchingDelimiter(
    sourceText,
    start,
    opener,
    opener === "[" ? "]" : ")",
  );
  return sourceText.slice(start, end + 1);
}

function surfaceStreamProtocolBoundaryAudit(protocolText, streamProtocolText) {
  const failures = [];
  const terminalClient = declarationInitializer(
    protocolText,
    "terminalClientMessageSchema",
    "(",
  );
  const terminalServer = declarationInitializer(
    protocolText,
    "terminalServerMessageSchema",
    "(",
  );
  const workerCommands = declarationInitializer(
    protocolText,
    "workerCommandSchema",
    "(",
  );
  const workerEvents = declarationInitializer(
    protocolText,
    "workerEventSchema",
    "(",
  );
  for (const [name, initializer, type] of [
    ["terminal client input", terminalClient, "input"],
    ["terminal server output", terminalServer, "output"],
  ]) {
    if (
      !initializer.includes("protectedData: surfaceStreamOpaqueSchema") ||
      new RegExp(
        `type:\\s*z\\.literal\\(["']${type}["']\\)[\\s\\S]{0,300}\\bdata\\s*:`,
        "u",
      ).test(initializer)
    ) {
      failures.push(`${name}: plaintext or missing opaque contract`);
    }
  }
  for (const [command, expression] of [
    [
      "explorer.operation",
      /type:\s*z\.literal\(["']explorer\.operation["']\)[\s\S]{0,500}surfaceStreamWireRequestSchema\.shape/u,
    ],
    [
      "terminal.input",
      /type:\s*z\.literal\(["']terminal\.input["']\)[\s\S]{0,500}protectedData:\s*surfaceStreamOpaqueSchema/u,
    ],
    [
      "terminal.snapshot",
      /type:\s*z\.literal\(["']terminal\.snapshot["']\)[\s\S]{0,500}surfaceStreamWireRequestSchema\.shape/u,
    ],
  ]) {
    if (!expression.test(workerCommands)) {
      failures.push(`worker command ${command}: opaque contract regressed`);
    }
  }
  if (
    !/type:\s*z\.literal\(["']terminal\.output["']\)[\s\S]{0,300}protectedData:\s*surfaceStreamOpaqueSchema/u.test(
      workerEvents,
    )
  ) {
    failures.push("worker terminal.output event: opaque contract regressed");
  }
  for (const legacyCommand of [
    "explorer.directory.list",
    "explorer.directory.commits",
    "explorer.file.read",
    "explorer.file.write",
    "explorer.media.read",
  ]) {
    if (workerCommands.includes(`z.literal("${legacyCommand}")`)) {
      failures.push(
        `legacy plaintext worker command remains: ${legacyCommand}`,
      );
    }
  }
  for (const marker of [
    "surfaceStreamWireRequestSchema",
    "protectedRequest: surfaceStreamOpaqueSchema",
    "surfaceStreamWireResponseSchema",
    "protectedResponse: surfaceStreamOpaqueSchema",
    "surfaceStreamContextSchema",
  ]) {
    if (!streamProtocolText.includes(marker)) {
      failures.push(`surface stream protocol is missing ${marker}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Surface-stream protocol boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    guards: [
      "terminal-client-input:opaque",
      "terminal-worker-output:opaque",
      "explorer-operations:single-opaque-command",
      "surface-stream:operation-direction-sequence-bound",
      "legacy-explorer-commands:absent",
    ],
    workerCommandContracts: [
      "explorer.operation",
      "terminal.input",
      "terminal.snapshot",
      "terminal.output",
    ],
  };
}

function remoteSurfaceStreamProtocolBoundaryAudit(
  streamProtocolText,
  transportText,
  managerText,
  relayText,
) {
  const failures = [];
  for (const marker of [
    "remoteSurfaceStreamContextSchema",
    "surfaceKind: remoteSurfaceStreamKindSchema",
    "attachmentId:",
    "direction: remoteSurfaceStreamDirectionSchema",
    "channel: remoteSurfaceStreamChannelSchema",
    "sequence:",
    "encodeRemoteSurfaceProtectedPayload",
    "decodeRemoteSurfaceProtectedPayload",
  ]) {
    if (!streamProtocolText.includes(marker)) {
      failures.push(`Remote Surface stream protocol is missing ${marker}`);
    }
  }
  for (const marker of [
    "protectRemoteSurfaceStreamPayload",
    "openRemoteSurfaceStreamPayload",
    'direction: "client-to-worker"',
    'direction: "worker-to-client"',
    "#sequences = new Map<RemoteSurfaceChannel, number>()",
    "#lastInboundSequences = new Map<RemoteSurfaceChannel, number>()",
  ]) {
    if (!transportText.includes(marker)) {
      failures.push(`client Remote Surface transport is missing ${marker}`);
    }
  }
  for (const marker of [
    "protectWorkerRemoteSurfaceStreamPayload",
    "openWorkerRemoteSurfaceStreamPayload",
    'direction: "client-to-worker"',
    'direction: "worker-to-client"',
    "lastInboundSequences: Map<RemoteSurfaceChannel, number>",
    "this.streamKey(surfaceId, attachmentId, channel)",
  ]) {
    if (!managerText.includes(marker)) {
      failures.push(`worker Remote Surface manager is missing ${marker}`);
    }
  }
  for (const marker of [
    "lastClientSequences = new Map",
    "lastWorkerSequences = new Map",
    "decodeRemoteSurfaceFrame",
  ]) {
    if (!relayText.includes(marker)) {
      failures.push(`server Remote Surface relay is missing ${marker}`);
    }
  }
  if (
    /\b(?:TextDecoder|JSON\.parse\s*\(\s*(?:frame\.)?payload|remoteBrowserClientMessageSchema|remoteBrowserServerMessageSchema|remoteDesktopClientMessageSchema|remoteDesktopServerMessageSchema)\b/u.test(
      relayText,
    )
  ) {
    failures.push(
      "server Remote Surface relay inspects protected payload content",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Remote Surface stream boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    guards: [
      "browser-and-desktop-payloads:opaque",
      "websocket-and-webrtc:protected-before-relay",
      "attachment-direction-channel-sequence-bound",
      "per-channel-replay-guards",
      "server-payload-decoding:absent",
    ],
    protectedChannels: [
      "control",
      "frame",
      "cursor",
      "clipboard",
      "webrtc-signal",
    ],
  };
}

async function surfacePrivateStateRepositoryBoundaryAudit(protocolText) {
  const schemaPath = resolve(serverSourcePath, "db/schema.ts");
  const repositoryPath = resolve(serverSourcePath, "db/repository.ts");
  const workerManagerPath = resolve(
    repositoryRoot,
    "cantrip_worker/src/remote-surface-manager.ts",
  );
  const [schemaText, repositoryText, workerManagerText] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(repositoryPath, "utf8"),
    readFile(workerManagerPath, "utf8"),
  ]);
  const failures = [];
  for (const [table, legacyFields] of surfacePrivateStateTables) {
    const initializer = tableInitializer(schemaText, table);
    if (
      !/\bprotectedState\s*:\s*jsonb\(["']protected_state["']\)/u.test(
        initializer,
      )
    ) {
      failures.push(`${table}: missing protected_state JSONB storage`);
    }
    for (const field of legacyFields) {
      if (new RegExp(`\\b${field}\\s*:`, "u").test(initializer)) {
        failures.push(`${table}: legacy plaintext ${field} field returned`);
      }
    }
  }
  for (const table of ["browsers", "remoteSurfaces"]) {
    if (
      !/\bstateRevision\s*:\s*integer\(["']state_revision["']\)/u.test(
        tableInitializer(schemaText, table),
      )
    ) {
      failures.push(`${table}: missing public state revision`);
    }
  }
  const remoteSurfaceInitializer = tableInitializer(
    schemaText,
    "remoteSurfaces",
  );
  for (const guard of [
    "remote_surfaces_public_configuration_check",
    "remote_surfaces_desktop_private_state_check",
  ]) {
    if (!remoteSurfaceInitializer.includes(guard)) {
      failures.push(`remoteSurfaces: missing database guard ${guard}`);
    }
  }
  for (const marker of [
    "toTerminalWireSummary",
    "toExplorerWireSummary",
    "toBrowserWireSummary",
    "toRemoteSurfaceWireSummary",
    "toRemoteDesktopWireSummary",
  ]) {
    if (!repositoryText.includes(marker)) {
      failures.push(`repository: missing opaque serializer ${marker}`);
    }
  }
  for (const [method, marker] of [
    ["createTerminal", "protectedState: input.stateProtection"],
    ["updateTerminalService", "protectedState: input.stateProtection"],
    ["createExplorer", "protectedState: input.stateProtection"],
    ["updateExplorerViewState", "protectedState: input.stateProtection"],
    ["createBrowser", "protectedState: input.stateProtection"],
    ["updateBrowser", "protectedState: input.stateProtection"],
    ["createRemoteSurface", "protectedState: input.stateProtection"],
    ["createRemoteDesktop", "protectedState: stateProtection"],
  ]) {
    if (!methodBody(repositoryText, method).includes(marker)) {
      failures.push(`${method}: missing opaque persistence (${marker})`);
    }
  }

  const configuration = declarationInitializer(
    protocolText,
    "remoteSurfaceConfigurationSchema",
    "[",
  );
  if (/\b(?:initialUrl|url|target)\s*:/u.test(configuration)) {
    failures.push(
      "remoteSurfaceConfigurationSchema: private browser or desktop configuration returned",
    );
  }
  const browserMessages = declarationInitializer(
    protocolText,
    "remoteBrowserServerMessageSchema",
    "[",
  );
  if (/\burl\s*:/u.test(browserMessages)) {
    failures.push(
      "remoteBrowserServerMessageSchema: plaintext browser URL returned",
    );
  }
  const desktopMessages = declarationInitializer(
    protocolText,
    "remoteDesktopServerMessageSchema",
    "[",
  );
  if (
    /\b(?:inventory|requested|active|launchingApplication)\s*:/u.test(
      desktopMessages,
    )
  ) {
    failures.push(
      "remoteDesktopServerMessageSchema: plaintext target inventory returned",
    );
  }

  const workerCommandGuards = [
    [
      "project.script-commands",
      /type:\s*z\.literal\(["']project\.script-commands["']\)[\s\S]{0,500}stateProtection:\s*terminalPrivateStateOpaqueSchema/u,
    ],
    [
      "terminal.open",
      /type:\s*z\.literal\(["']terminal\.open["']\)[\s\S]{0,1500}stateProtection:\s*terminalPrivateStateOpaqueSchema/u,
    ],
    [
      "terminal.services.reconcile",
      /type:\s*z\.literal\(["']terminal\.services\.reconcile["']\)[\s\S]{0,300}services:\s*z\.array\(terminalServiceRuntimeConfigurationSchema\)/u,
    ],
    [
      "surface.attach",
      /type:\s*z\.literal\(["']surface\.attach["']\)[\s\S]{0,1500}stateProtection:\s*z[\s\S]{0,300}browserPrivateStateOpaqueSchema[\s\S]{0,300}remoteDesktopPrivateStateOpaqueSchema/u,
    ],
    [
      "surface.configure",
      /type:\s*z\.literal\(["']surface\.configure["']\)[\s\S]{0,1000}stateProtection:\s*z[\s\S]{0,300}browserPrivateStateOpaqueSchema[\s\S]{0,300}remoteDesktopPrivateStateOpaqueSchema/u,
    ],
    [
      "surface.desktop.targets",
      /type:\s*z\.literal\(["']surface\.desktop\.targets["']\)[\s\S]{0,500}operationId:[\s\S]{0,300}resourceId:[\s\S]{0,300}limit:/u,
    ],
  ];
  for (const [command, expression] of workerCommandGuards) {
    if (!expression.test(protocolText)) {
      failures.push(`worker command ${command}: opaque contract regressed`);
    }
  }
  for (const [method, genericFailure] of [
    ["attach", "Remote Surface attachment failed."],
    ["configure", "Remote Surface configuration could not be applied."],
    ["openSession", "Remote Surface could not be opened."],
  ]) {
    const body = methodBody(workerManagerText, method);
    // Detailed adapter failures may remain in the worker's local console. The
    // shared persistent/remote log minimizer removes their message and keeps
    // only stable error class/code metadata; the server-facing exception must
    // remain generic.
    if (!body.includes(genericFailure)) {
      failures.push(
        `worker RemoteSurfaceManager.${method}: private adapter failures are not generic`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Surface private-state repository boundary regressed:\n${failures.join("\n")}`,
    );
  }
  return {
    auditedServerCopies: [
      "routes",
      "repository",
      "schema",
      "worker-commands",
      "live-events",
      "execution-targets",
      "jobs-and-snapshots",
      "notifications",
      "errors-and-logs",
      "caches-and-audit-metadata",
    ],
    coveredTables: surfacePrivateStateTables.map(([table]) => table),
    guards: [
      "covered-tables:protected-state-jsonb-only",
      "repository:wire-only-state-serialization",
      "remote-surfaces:public-configuration-only",
      "browser-live-state:opaque-url",
      "remote-desktop-live-state:opaque-inventory",
    ],
    workerCommandContracts: workerCommandGuards.map(([command]) => command),
  };
}

async function repositoryMethodInventory() {
  const methods = [];
  for (const file of repositoryFiles) {
    const sourceText = await readFile(file, "utf8");
    const methodStart = /^  async ([A-Za-z][A-Za-z0-9_]*)\s*\(/gmu;
    for (const match of sourceText.matchAll(methodStart)) {
      const start = match.index + match[0].lastIndexOf("(");
      const end = matchingDelimiter(sourceText, start, "(", ")");
      const parameters = sourceText.slice(start + 1, end);
      const bodyStart = sourceText.indexOf("{", end);
      const bodyEnd = matchingDelimiter(sourceText, bodyStart, "{", "}");
      const body = sourceText.slice(bodyStart + 1, bodyEnd);
      const ownerEvidence = /\bownerId\b/u.test(parameters)
        ? /\bownerId\b/u.test(body)
          ? "explicit-owner"
          : "owner-parameter-unused"
        : /\bworkerId\b/u.test(parameters)
          ? "worker-scoped"
          : /^(ensureLocalIdentity|getOrCreateServerId|migrateProviderSecrets|reset|expire)/u.test(
                match[1],
              )
            ? "system-lifecycle"
            : "delegated-or-missing-review";
      methods.push({
        file: file.slice(repositoryRoot.length + 1),
        line: sourceText.slice(0, match.index).split("\n").length,
        method: match[1],
        ownerEvidence,
      });
    }
  }
  return methods.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.method.localeCompare(right.method),
  );
}

async function buildInventory() {
  const [
    sourceText,
    schemaText,
    protocolText,
    liveProtocolText,
    tunnelDataPlaneProtocolText,
    surfaceStreamProtocolText,
    repositoryOperationProtocolText,
    remoteSurfaceStreamProtocolText,
    remoteSurfaceTransportText,
    remoteSurfaceManagerText,
    remoteSurfaceRelayText,
    clientApiText,
    workerText,
    workerRoutingText,
    repositoryMethods,
    taskDependencies,
    taskRepositoryGuards,
    projectAutomationContent,
    workflowCatalogContent,
    policyDependencies,
    policyRepository,
    providerSecretRepository,
    workspaceNameRepository,
    tunnelConfiguration,
    durableJobStatus,
    clientControlNotification,
    sessionMetadataMinimization,
    analyticsAuditLogPrivacy,
    attachmentContentRepository,
    privateDisplayLabelDependencies,
    privateDisplayLabelRepository,
    surfacePrivateStateDependencies,
    surfaceStreamDependencies,
    repositoryOperationDependencies,
    remoteSurfaceStreamDependencies,
    encryptionLedgerClosure,
  ] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(schemaPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(liveProtocolPath, "utf8"),
    readFile(tunnelDataPlaneProtocolPath, "utf8"),
    readFile(surfaceStreamProtocolPath, "utf8"),
    readFile(repositoryOperationProtocolPath, "utf8"),
    readFile(remoteSurfaceStreamProtocolPath, "utf8"),
    readFile(remoteSurfaceTransportPath, "utf8"),
    readFile(remoteSurfaceManagerPath, "utf8"),
    readFile(remoteSurfaceRelayPath, "utf8"),
    readFile(clientApiPath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(workerRoutingPath, "utf8"),
    repositoryMethodInventory(),
    taskProductionDependencyAudit(),
    taskRepositoryBoundaryAudit(),
    projectAutomationContentBoundaryAudit(),
    workflowCatalogContentBoundaryAudit(),
    policyProductionDependencyAudit(),
    policyRepositoryBoundaryAudit(),
    providerSecretRepositoryBoundaryAudit(),
    workspaceNameRepositoryBoundaryAudit(),
    tunnelConfigurationBoundaryAudit(),
    durableJobStatusBoundaryAudit(),
    clientControlNotificationBoundaryAudit(),
    sessionMetadataMinimizationBoundaryAudit(),
    analyticsAuditLogPrivacyBoundaryAudit(),
    attachmentContentRepositoryBoundaryAudit(),
    privateDisplayLabelProductionDependencyAudit(),
    privateDisplayLabelRepositoryBoundaryAudit(),
    surfacePrivateStateProductionDependencyAudit(),
    surfaceStreamProductionDependencyAudit(),
    repositoryOperationProductionDependencyAudit(),
    remoteSurfaceStreamProductionDependencyAudit(),
    encryptionLedgerClosureAudit(),
  ]);
  const surfacePrivateStateRepository =
    await surfacePrivateStateRepositoryBoundaryAudit(protocolText);
  const surfaceStreamProtocol = surfaceStreamProtocolBoundaryAudit(
    protocolText,
    surfaceStreamProtocolText,
  );
  const remoteSurfaceStreamProtocol = remoteSurfaceStreamProtocolBoundaryAudit(
    remoteSurfaceStreamProtocolText,
    remoteSurfaceTransportText,
    remoteSurfaceManagerText,
    remoteSurfaceRelayText,
  );
  const parsedRoutes = parseRoutes(sourceText);
  const taskRouteContracts = taskRouteBoundaryAudit(parsedRoutes);
  const privateDisplayLabelRouteContracts =
    privateDisplayLabelRouteBoundaryAudit(parsedRoutes);
  const surfacePrivateStateRouteContracts =
    surfacePrivateStateRouteBoundaryAudit(parsedRoutes);
  const surfaceStreamRouteContracts = surfaceStreamRouteBoundaryAudit(
    parsedRoutes,
    sourceText,
  );
  const repositoryOperationBoundary = repositoryOperationRouteBoundaryAudit(
    parsedRoutes,
    sourceText,
    repositoryOperationProtocolText,
    clientApiText,
    `${workerText}\n${workerRoutingText}`,
  );
  const routeKeys = parsedRoutes.map(({ method, path }) => `${method} ${path}`);
  const workerCommands = literalValuesInInitializer(
    protocolText,
    "workerCommandSchema",
    "[",
  ).sort();
  const liveResources = enumValues(
    liveProtocolText,
    "appLiveResourceSchema",
  ).sort();
  const cliCommands = enumValues(
    protocolText,
    "cantripCliCommandNameSchema",
  ).sort();
  const agentOperations = enumValues(
    protocolText,
    "cantripAgentOperationNameSchema",
  ).sort();
  const clientControlCommands = literalValuesInInitializer(
    liveProtocolText,
    "clientControlCommandSchema",
    "[",
  ).sort();
  const tunnelFrameKinds = literalValuesInInitializer(
    tunnelDataPlaneProtocolText,
    "tunnelDataPlaneFrameHeaderSchema",
    "[",
  ).sort();
  const contractSetDigests = {
    agentOperations: requireReviewedContractSet(
      "agentOperations",
      agentOperations,
    ),
    applicationRoutes: requireReviewedContractSet(
      "applicationRoutes",
      routeKeys,
    ),
    cliCommands: requireReviewedContractSet("cliCommands", cliCommands),
    clientControlCommands: requireReviewedContractSet(
      "clientControlCommands",
      clientControlCommands,
    ),
    liveResources: requireReviewedContractSet("liveResources", liveResources),
    workerCommands: requireReviewedContractSet(
      "workerCommands",
      workerCommands,
    ),
    tunnelFrameKinds: requireReviewedContractSet(
      "tunnelFrameKinds",
      tunnelFrameKinds,
    ),
  };
  const durableTables = durableTableContentInventory(schemaText);
  const routes = parsedRoutes.map((parsedRoute) => {
    const contentBoundary = applicationRouteContentClassification(parsedRoute);
    const { source: _source, ...route } = parsedRoute;
    return { ...route, contentBoundary };
  });
  routes.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.method.localeCompare(right.method) ||
      left.line - right.line,
  );

  const duplicateKeys = routes
    .map((route) => `${route.method} ${route.path}`)
    .filter((key, index, keys) => keys.indexOf(key) !== index);
  if (duplicateKeys.length > 0) {
    throw new Error(`Duplicate routes in audit: ${duplicateKeys.join(", ")}`);
  }

  const counts = Object.fromEntries(
    [
      "application-principal",
      "external-credential",
      "public-authentication",
      "public-bootstrap",
      "worker-control",
    ].map((boundary) => [
      boundary,
      routes.filter((route) => route.boundary === boundary).length,
    ]),
  );
  const repositoryOwnerEvidence = Object.fromEntries(
    [
      "explicit-owner",
      "owner-parameter-unused",
      "worker-scoped",
      "system-lifecycle",
      "delegated-or-missing-review",
    ].map((evidence) => [
      evidence,
      repositoryMethods.filter((method) => method.ownerEvidence === evidence)
        .length,
    ]),
  );
  const agentOperationContentBoundaries = agentOperations.map((operation) => ({
    operation,
    ...agentOperationContentClassification(operation),
  }));
  const workerCommandContentBoundaries = workerCommands.map((command) => ({
    command,
    ...workerCommandContentClassification(command),
  }));
  const liveResourceContentBoundaries = liveResources.map((resource) => ({
    resource,
    ...liveResourceContentClassification(resource),
  }));
  const clientControlContentBoundaries = clientControlCommands.map(
    (command) => ({
      command,
      ...clientControlContentClassification(command),
    }),
  );
  const cliCommandContentBoundaries = cliCommands.map((command) => ({
    command,
    ...cliCommandContentClassification(command),
  }));
  const tunnelFrameContentBoundaries = tunnelFrameKinds.map((kind) => ({
    kind,
    ...tunnelFrameContentClassification(kind),
  }));
  const externalTransports = [
    {
      boundary: "application-principal",
      contentClassification: "endpoint-protected",
      implementation: "cantrip_server/src/code/tunnel.ts",
      name: "Protected Cantrip Code tunnel control plane",
      ownerBinding:
        "authenticated owner, project, assigned worker, opaque revision-bound tunnel record, and desktop attachment",
    },
    {
      boundary: "application-principal",
      contentClassification: "endpoint-protected",
      implementation: "cantrip_server/src/project-shares/tunnel.ts",
      name: "Protected project-share tunnel control plane",
      ownerBinding:
        "authenticated owner, project, assigned worker, opaque revision-bound tunnel record, and desktop attachment",
    },
    {
      boundary: "application-principal",
      contentClassification: "endpoint-protected",
      implementation: "cantrip_server/src/remote-surfaces/relay.ts",
      name: "Browser and Remote Desktop binary relay",
      ownerBinding: "surface execution context, attachment, and worker",
    },
    {
      boundary: "worker-control",
      contentClassification: "endpoint-protected",
      implementation: "cantrip_server/src/workers/bridge.ts",
      name: "Worker command and protected binary tunnel multiplexing",
      ownerBinding:
        "owner and immutable worker ID from an independently revocable worker credential",
    },
    {
      boundary: "application-principal",
      contentClassification: "intentionally-public-control-plane",
      implementation: "cantrip_server/src/live/hub.ts",
      name: "Application invalidation and replay stream",
      ownerBinding:
        "request principal, active session, owner-private cursor, and authorized subscription scope",
    },
  ];
  const trackedRolloutGaps = [
    ...durableTables.map(({ exportName, classification }) => ({
      boundary: `durable-table:${exportName}`,
      classification,
    })),
    ...routes.map(({ method, path, contentBoundary }) => ({
      boundary: `route:${method} ${path}`,
      classification: contentBoundary.classification,
    })),
    ...agentOperationContentBoundaries.map(({ operation, classification }) => ({
      boundary: `agent-operation:${operation}`,
      classification,
    })),
    ...workerCommandContentBoundaries.map(({ command, classification }) => ({
      boundary: `worker-command:${command}`,
      classification,
    })),
    ...liveResourceContentBoundaries.map(({ resource, classification }) => ({
      boundary: `live-resource:${resource}`,
      classification,
    })),
    ...clientControlContentBoundaries.map(({ command, classification }) => ({
      boundary: `client-control:${command}`,
      classification,
    })),
    ...cliCommandContentBoundaries.map(({ command, classification }) => ({
      boundary: `cli-command:${command}`,
      classification,
    })),
    ...tunnelFrameContentBoundaries.map(({ kind, classification }) => ({
      boundary: `tunnel-frame:${kind}`,
      classification,
    })),
    ...externalTransports.map(({ name, contentClassification }) => ({
      boundary: `external-transport:${name}`,
      classification: contentClassification,
    })),
  ].filter(({ classification }) => classification === "tracked-rollout-gap");
  if (
    encryptionLedgerClosure.remainingWork.status === "closed" &&
    trackedRolloutGaps.length > 0
  ) {
    throw new Error(
      `Encryption ledger claims closure with tracked rollout gaps:\n${trackedRolloutGaps
        .map(({ boundary }) => boundary)
        .join("\n")}`,
    );
  }
  const wholeProductEncryptionClosure = {
    status:
      encryptionLedgerClosure.remainingWork.status === "closed" &&
      trackedRolloutGaps.length === 0
        ? "closed"
        : "open",
    trackedRolloutGapCount: trackedRolloutGaps.length,
    trackedRolloutGaps: trackedRolloutGaps.map(({ boundary }) => boundary),
  };

  return {
    schemaVersion: 5,
    sources: {
      agentOperations: "packages/protocol/src/index.ts",
      applicationRoutes: "cantrip_server/src/app.ts",
      clientControlCommands: "packages/protocol/src/live.ts",
      durableTables: "cantrip_server/src/db/schema.ts",
      liveProtocol: "packages/protocol/src/live.ts",
      remoteSurfaceStreamProtocol:
        "packages/protocol/src/remote-surface-stream.ts",
      tunnelDataPlaneProtocol: "packages/protocol/src/tunnel-data-plane.ts",
      cliCommands: "packages/protocol/src/index.ts",
      workerCommands: "packages/protocol/src/index.ts",
    },
    summary: {
      ...counts,
      http: routes.filter((route) => route.transport === "http").length,
      legacyLocalOwnerRoutes: routes.filter(
        (route) => route.ownerEvidence === "legacy-local-owner",
      ).length,
      requestPrincipalRoutes: routes.filter(
        (route) => route.ownerEvidence === "request-principal",
      ).length,
      total: routes.length,
      websocket: routes.filter((route) => route.transport === "websocket")
        .length,
      workerCredentialRoutes: routes.filter(
        (route) => route.ownerEvidence === "worker-credential",
      ).length,
      durableTables: durableTables.length,
      agentOperations: agentOperations.length,
      workerCommands: workerCommands.length,
      liveResources: liveResources.length,
      clientControlCommands: clientControlCommands.length,
      cliCommands: cliCommands.length,
      tunnelFrameKinds: tunnelFrameKinds.length,
      repositoryMethods: repositoryMethods.length,
      repositoryOwnerEvidence,
    },
    contractSetDigests,
    durableTables,
    routes,
    agentOperationContentBoundaries,
    workerCommands,
    workerCommandContentBoundaries,
    liveResources,
    liveResourceContentBoundaries,
    clientControlContentBoundaries,
    cliCommandContentBoundaries,
    tunnelFrameContentBoundaries,
    repositoryMethods,
    taskE2eeBoundary: {
      status: "enforced",
      ...taskDependencies,
      repositoryGuards: taskRepositoryGuards,
      routeContracts: taskRouteContracts,
    },
    projectAutomationContentE2eeBoundary: {
      status: "enforced",
      ...projectAutomationContent,
    },
    workflowCatalogContentE2eeBoundary: {
      status: "definition-and-noninteractive-runtime-boundary-enforced",
      ...workflowCatalogContent,
    },
    policyE2eeBoundary: {
      status: "enforced",
      ...policyDependencies,
      ...policyRepository,
    },
    providerSecretE2eeBoundary: {
      status: "enforced",
      ...providerSecretRepository,
    },
    workspaceNameE2eeBoundary: {
      status: "enforced",
      ...workspaceNameRepository,
    },
    tunnelConfigurationE2eeBoundary: {
      status: "configuration-and-tcp-data-enforced",
      ...tunnelConfiguration,
    },
    durableJobStatusPrivacyBoundary: {
      status: "minimized",
      ...durableJobStatus,
    },
    clientControlNotificationE2eeBoundary: {
      status: "enforced",
      ...clientControlNotification,
    },
    sessionMetadataPrivacyBoundary: {
      status: "minimized",
      ...sessionMetadataMinimization,
    },
    analyticsAuditLogPrivacyBoundary: {
      status: "minimized",
      ...analyticsAuditLogPrivacy,
    },
    attachmentContentE2eeBoundary: {
      status: "enforced",
      ...attachmentContentRepository,
    },
    privateDisplayLabelE2eeBoundary: {
      status: "enforced",
      ...privateDisplayLabelDependencies,
      ...privateDisplayLabelRepository,
      routeContracts: privateDisplayLabelRouteContracts,
    },
    surfacePrivateStateE2eeBoundary: {
      status: "enforced",
      ...surfacePrivateStateDependencies,
      ...surfacePrivateStateRepository,
      routeContracts: surfacePrivateStateRouteContracts,
    },
    surfaceStreamE2eeBoundary: {
      status: "enforced",
      ...surfaceStreamDependencies,
      ...surfaceStreamProtocol,
      routeContracts: surfaceStreamRouteContracts,
    },
    repositoryOperationE2eeBoundary: {
      status: "protected-path-enforced",
      ...repositoryOperationDependencies,
      ...repositoryOperationBoundary,
    },
    remoteSurfaceStreamE2eeBoundary: {
      status: "enforced",
      ...remoteSurfaceStreamDependencies,
      ...remoteSurfaceStreamProtocol,
    },
    encryptionLedgerClosure,
    wholeProductEncryptionClosure,
    externalTransports,
  };
}

const expected = await format(JSON.stringify(await buildInventory()), {
  parser: "json",
});
if (process.argv.includes("--write")) {
  await mkdir(dirname(inventoryPath), { recursive: true });
  await writeFile(inventoryPath, expected);
  console.log(`Wrote ${inventoryPath}`);
} else if (process.argv.includes("--check")) {
  const actual = await readFile(inventoryPath, "utf8").catch(() => "");
  if (actual !== expected) {
    console.error(
      "Server route inventory is stale. Run `pnpm audit:server-boundaries:write`.",
    );
    process.exitCode = 1;
  } else {
    console.log("Server route inventory is current.");
  }
} else {
  process.stdout.write(expected);
}
