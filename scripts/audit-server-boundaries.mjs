import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = resolve(repositoryRoot, "cantrip_server/src/app.ts");
const protocolPath = resolve(repositoryRoot, "packages/protocol/src/index.ts");
const liveProtocolPath = resolve(
  repositoryRoot,
  "packages/protocol/src/live.ts",
);
const repositoryFiles = [
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
function routeBoundary(path) {
  if (path === "/api" || path === "/api/bootstrap") {
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
  if (path === "/api" || path === "/api/bootstrap") return "public";
  if (path.startsWith("/api/auth/")) return "session-boundary";
  if (path.startsWith("/api/workflow-hooks/")) return "webhook-credential";
  if (
    path.endsWith("/connect") &&
    path.startsWith("/api/tunnel-attachments/")
  ) {
    return "attachment-credential";
  }
  if (path.startsWith("/api/internal/")) return "legacy-worker-token";
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
        transport: /\bwebsocket\s*:\s*true\b/u.test(text)
          ? "websocket"
          : "http",
      });
    }
  }
  return routes;
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
  const [sourceText, protocolText, liveProtocolText, repositoryMethods] =
    await Promise.all([
      readFile(appPath, "utf8"),
      readFile(protocolPath, "utf8"),
      readFile(liveProtocolPath, "utf8"),
      repositoryMethodInventory(),
    ]);
  const routes = parseRoutes(sourceText);
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
        ownerBinding: "connected worker ID; per-worker credentials are pending",
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
