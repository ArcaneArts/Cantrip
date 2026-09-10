import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStaticServerRoutes } from "./server-route-parser.mjs";

const paths = (source) =>
  readStaticServerRoutes(source, "fixture.ts").map((route) => route.path);

test("reads literal registrations and ignores comments and quoted examples", () => {
  const source =
    '\n// app.get("/comment", noop);\nconst example = `app.post("/example", noop)`;\napp.get<{ Params: { id: string } }>("/actual/:id", {websocket: true}, handler);\napp.post(`/literal`, handler);';
  const routes = readStaticServerRoutes(source, "fixture.ts");
  assert.deepEqual(
    routes.map(({ path, method, line }) => ({ path, method, line })),
    [
      { path: "/actual/:id", method: "GET", line: 4 },
      { path: "/literal", method: "POST", line: 5 },
    ],
  );
  assert.match(routes[0].source, /websocket: true/);
});

test("resolves each lexical loop, including unbraced loops and shadowing", () => {
  assert.deepEqual(
    paths(`
    for (const action of ["sync", "rebuild"] as const) app.post(\`/codegraph/\${action}\`, handler);
    for (const action of ["suspend", "resume"] as const) {
      app.post(\`/surface/\${action}\`, handler);
      { const action = "inner"; app.get(\`/nested/\${action}\`, handler); }
    }
  `),
    [
      "/codegraph/sync",
      "/codegraph/rebuild",
      "/surface/suspend",
      "/surface/resume",
      "/nested/inner",
    ],
  );
});

test("resolves a local route factory from its actual literal calls", () => {
  assert.deepEqual(
    paths(`
    function outer() {
      function install<T>(action: string, callback: T) { app.post(\`/history/\${action}\`, callback); }
      install("open", first); install("ingest", second);
    }
    function other() { function install(action) { return action; } install("unrelated"); }
  `),
    ["/history/open", "/history/ingest"],
  );
});

for (const [label, source] of [
  [
    "exported factory",
    'export function install(action) { app.get(`/x/${action}`, handler); } install("open");',
  ],
  ["unknown input", "app.get(pathFromRuntime, handler);"],
  [
    "unrelated loop",
    'for (const action of ["old"]) {} app.get(`/x/${action}`, handler);',
  ],
  [
    "mutable binding",
    'let action = "old"; action = runtime(); app.get(`/x/${action}`, handler);',
  ],
  [
    "dynamic loop",
    "for (const action of runtime()) app.get(`/x/${action}`, handler);",
  ],
  [
    "dynamic factory call",
    "function install(action) { app.get(`/x/${action}`, handler); } install(runtime());",
  ],
  [
    "escaped factory",
    'function install(action) { app.get(`/x/${action}`, handler); } install("open"); external(install);',
  ],
  [
    "correlated bindings",
    'function install(a,b) { app.get(`/${a}/${b}`, handler); } install("one","two");',
  ],
]) {
  test(`rejects ${label} without guessing or evaluating code`, () => {
    assert.throws(
      () => paths(source),
      /fixture\.ts:.*statically resolvable path/,
    );
  });
}

const actualFamilies = [
  [
    "internal-native-commands.ts",
    "/api/internal/native-commands/",
    [
      "admit",
      "continue",
      "dispatch",
      "bind-preparation",
      "receipt",
      "settings-evidence",
    ],
  ],
  [
    "internal-native-queue.ts",
    "/api/internal/native-queue/",
    ["lookup", "read", "mutate", "start-receipt", "import", "import-ack"],
  ],
  [
    "internal-native-history.ts",
    "/api/internal/native-history/",
    [
      "open",
      "resolve",
      "archive",
      "archive-turns",
      "archive-batches",
      "ingest",
    ],
  ],
  [
    "worker-maintenance.ts",
    "/api/projects/:projectId/worktrees/:worktreeId/codegraph/",
    ["sync", "rebuild"],
  ],
  [
    "remote-surface-management.ts",
    "/api/remote-surfaces/:surfaceId/",
    ["suspend", "resume"],
  ],
];
for (const [file, prefix, suffixes] of actualFamilies) {
  test(`inventories the real ${file} registrations`, async () => {
    const source = await readFile(
      new URL(`../cantrip_server/src/app/routes/${file}`, import.meta.url),
      "utf8",
    );
    const registered = readStaticServerRoutes(source, file).filter(
      (route) =>
        route.path.startsWith(prefix) &&
        !route.path.slice(prefix.length).includes(":"),
    );
    // Some modules also define fixed routes; compare every dynamic registration.
    const dynamic = registered.filter((route) => route.source.includes("${"));
    assert.deepEqual(
      dynamic.map((route) => route.path),
      suffixes.map((suffix) => prefix + suffix),
    );
    for (const route of dynamic) assert.equal(route.method, "POST");
  });
}
