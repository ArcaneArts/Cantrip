// Development source index, never a runtime gate or proof of implementation.
import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const files = execFileSync(
  "git",
  [
    "ls-files",
    "tests/reference-node-worker",
    "cantrip_os/host",
    "packages/crypto",
    "packages/profile-converter",
    "packages/protocol",
    "scripts/database-transfer",
    "cantrip_app/src-tauri/src/desktop_services.rs",
    "cantrip_app/src-tauri/src/desktop_worker.rs",
    "cantrip_app/src-tauri/src/lib.rs",
    "cantrip_app/src-tauri/src/process_environment.rs",
    "scripts/package-distributions.mjs",
    "scripts/package-runtime.mjs",
    "deploy/docker/worker.Dockerfile",
  ],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n");
const sources = [],
  commandSites = [],
  publications = [],
  startup = {
    source: "tests/reference-node-worker/src/index.ts",
    constructions: [],
    events: [],
  };
function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (typeof value.type === "string") visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (!["loc", "start", "end", "comments", "tokens"].includes(key))
      walk(child, visit);
  }
}
for (const file of files) {
  const bytes = await readFile(path.join(root, file));
  const source = {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (/\.(?:ts|mjs)$/.test(file) && !file.endsWith(".d.ts")) {
    const text = bytes.toString("utf8");
    const ast = parse(text, { sourceType: "module", plugins: ["typescript"] });
    const imports = new Map();
    walk(ast, (node) => {
      if (node.type === "ImportDeclaration")
        for (const specifier of node.specifiers)
          imports.set(specifier.local.name, node.source.value);
    });
    source.imports = [...new Set(imports.values())].sort();
    if (
      file.startsWith("tests/reference-node-worker/src/") &&
      !file.endsWith(".test.ts")
    )
      walk(ast, (node) => {
        if (node.type === "CallExpression") {
          const callee = text.slice(node.callee.start, node.callee.end);
          if (
            /^(?:emit|sendNotification)$|\.(?:sendNotification|sendWorkerLinkFrame|sendSurfaceFrame|sendTunnelDataPlaneFrame|taskResultCommitted)$/.test(
              callee,
            )
          ) {
            publications.push({
              file,
              line: node.loc.start.line,
              callee,
              argument: node.arguments[0]
                ? text
                    .slice(node.arguments[0].start, node.arguments[0].end)
                    .slice(0, 240)
                : null,
            });
          }
        }
        if (
          node.type === "SwitchStatement" &&
          node.discriminant.type === "MemberExpression" &&
          node.discriminant.object.name === "command" &&
          node.discriminant.property.name === "type"
        ) {
          let grouped = [];
          for (const clause of node.cases) {
            if (clause.test?.type === "StringLiteral")
              grouped.push({
                command: clause.test.value,
                line: clause.loc.start.line,
              });
            if (!clause.consequent.length) continue;
            const calls = new Set(),
              importedHandlers = new Set();
            walk(clause.consequent, (child) => {
              if (!["CallExpression", "NewExpression"].includes(child.type))
                return;
              const callee = text.slice(child.callee.start, child.callee.end);
              if (!callee.includes("\n")) calls.add(callee);
              let name = child.callee;
              while (
                ["MemberExpression", "OptionalMemberExpression"].includes(
                  name.type,
                )
              )
                name = name.object;
              if (imports.has(name.name))
                importedHandlers.add(imports.get(name.name));
            });
            for (const site of grouped)
              commandSites.push({
                ...site,
                file,
                calls: [...calls].sort(),
                importedHandlers: [...importedHandlers].sort(),
              });
            grouped = [];
          }
        }
        if (file === startup.source && node.type === "NewExpression")
          startup.constructions.push({
            line: node.loc.start.line,
            callee: text.slice(node.callee.start, node.callee.end),
          });
        if (
          file === startup.source &&
          node.type === "ObjectProperty" &&
          node.key.name === "event" &&
          node.value.type === "StringLiteral"
        )
          startup.events.push({
            line: node.loc.start.line,
            event: node.value.value,
          });
      });
  }
  sources.push(source);
}
const result = [
  {
    kind: "baseline",
    sourceCommit: head,
    scope:
      "Source locations and direct calls only. No implementation or validation credit; follow service construction and dynamic dispatch manually.",
  },
  ...commandSites.map((site) => ({ kind: "command", ...site })),
  ...publications.map((site) => ({ kind: "publication", ...site })),
  { kind: "startup", ...startup },
  ...sources.map((source) => ({ kind: "source", ...source })),
];
const destination = path.join(root, "docs/rust-worker/source-index.jsonl");
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(
  destination,
  result.map((record) => JSON.stringify(record)).join("\n") + "\n",
);
console.log(
  JSON.stringify({
    sourceCommit: head,
    commandSites: commandSites.length,
    sources: sources.length,
    destination,
  }),
);
