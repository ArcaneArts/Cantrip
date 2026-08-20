import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      "taskCreateSchema",
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
  ] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(liveProtocolPath, "utf8"),
    repositoryMethodInventory(),
    taskProductionDependencyAudit(),
    taskRepositoryBoundaryAudit(),
  ]);
  const parsedRoutes = parseRoutes(sourceText);
  const taskRouteContracts = taskRouteBoundaryAudit(parsedRoutes);
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
    schemaVersion: 1,
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

const expected = `${JSON.stringify(await buildInventory(), null, 2)}\n`;
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
