import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverSourcePath = resolve(repositoryRoot, "cantrip_server/src");
const appPath = resolve(serverSourcePath, "app.ts");
const protocolPath = resolve(repositoryRoot, "packages/protocol/src/index.ts");
const liveProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/live.ts",
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
      "browserTunnelRequestSchema",
      "routing-metadata-only",
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
  const [schemaText, repositoryText, applicationText, workerText] =
    await Promise.all(
      [schemaPath, repositoryPath, appPath, workerPath].map((path) =>
        readFile(path, "utf8"),
      ),
    );
  const failures = [];
  const providerTable = tableInitializer(schemaText, "modelProviders");
  const accountTable = tableInitializer(schemaText, "modelProviderAccounts");
  const mcpTable = tableInitializer(schemaText, "mcpServers");
  for (const [initializer, marker, description] of [
    [providerTable, "protectedApiKey", "model provider API-key envelope"],
    [accountTable, "protectedCredential", "provider credential envelope"],
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
      ["credentialEnvelope", "credentialSubject"],
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
    "encryptedMcpServerCreateSchema",
    "encryptedMcpServerUpdateSchema",
    "providerCredentialWireRecordSchema",
  ]) {
    if (!applicationText.includes(marker)) {
      failures.push(`application: missing opaque contract ${marker}`);
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
      "mcp-configurations:opaque-and-blind-indexed",
      "legacy-provider-and-mcp-columns:absent",
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
    if (body.includes("workerLogError") || !body.includes(genericFailure)) {
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
    protocolText,
    liveProtocolText,
    repositoryMethods,
    taskDependencies,
    taskRepositoryGuards,
    policyDependencies,
    policyRepository,
    providerSecretRepository,
    privateDisplayLabelDependencies,
    privateDisplayLabelRepository,
    surfacePrivateStateDependencies,
  ] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(liveProtocolPath, "utf8"),
    repositoryMethodInventory(),
    taskProductionDependencyAudit(),
    taskRepositoryBoundaryAudit(),
    policyProductionDependencyAudit(),
    policyRepositoryBoundaryAudit(),
    providerSecretRepositoryBoundaryAudit(),
    privateDisplayLabelProductionDependencyAudit(),
    privateDisplayLabelRepositoryBoundaryAudit(),
    surfacePrivateStateProductionDependencyAudit(),
  ]);
  const surfacePrivateStateRepository =
    await surfacePrivateStateRepositoryBoundaryAudit(protocolText);
  const parsedRoutes = parseRoutes(sourceText);
  const taskRouteContracts = taskRouteBoundaryAudit(parsedRoutes);
  const privateDisplayLabelRouteContracts =
    privateDisplayLabelRouteBoundaryAudit(parsedRoutes);
  const surfacePrivateStateRouteContracts =
    surfacePrivateStateRouteBoundaryAudit(parsedRoutes);
  const routes = parsedRoutes.map(({ source: _source, ...route }) => route);
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

  return {
    schemaVersion: 3,
    sources: {
      applicationRoutes: "cantrip_server/src/app.ts",
      liveProtocol: "packages/protocol/src/live.ts",
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
      workerCommands: literalValuesInInitializer(
        protocolText,
        "workerCommandSchema",
        "[",
      ).length,
      liveResources: enumValues(liveProtocolText, "appLiveResourceSchema")
        .length,
      repositoryMethods: repositoryMethods.length,
      repositoryOwnerEvidence,
    },
    routes,
    workerCommands: literalValuesInInitializer(
      protocolText,
      "workerCommandSchema",
      "[",
    ).sort(),
    liveResources: enumValues(liveProtocolText, "appLiveResourceSchema").sort(),
    repositoryMethods,
    taskE2eeBoundary: {
      status: "enforced",
      ...taskDependencies,
      repositoryGuards: taskRepositoryGuards,
      routeContracts: taskRouteContracts,
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
    externalTransports: [
      {
        boundary: "capability-token",
        implementation: "cantrip_server/src/code/tunnel.ts",
        name: "Cantrip Code HTTP/WebSocket surface",
        ownerBinding:
          "attachment owner, authenticated user session, worker, Code tab, and editor session",
      },
      {
        boundary: "capability-token",
        implementation: "cantrip_server/src/project-shares/tunnel.ts",
        name: "Project share HTTP/WebSocket surface",
        ownerBinding: "attachment owner, project, worker, and canonical root",
      },
      {
        boundary: "application-principal",
        implementation: "cantrip_server/src/remote-surfaces/relay.ts",
        name: "Browser and Remote Desktop binary relay",
        ownerBinding: "surface execution context, attachment, and worker",
      },
      {
        boundary: "worker-control",
        implementation: "cantrip_server/src/workers/bridge.ts",
        name: "Worker command and binary tunnel multiplexing",
        ownerBinding:
          "owner and immutable worker ID from an independently revocable worker credential",
      },
      {
        boundary: "application-principal",
        implementation: "cantrip_server/src/live/hub.ts",
        name: "Application invalidation and replay stream",
        ownerBinding:
          "request principal, active session, owner-private cursor, and authorized subscription scope",
      },
    ],
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
