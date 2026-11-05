// Capture the actual Source transition writers; HTTP acceptance separately
// proves real SQL failure, rollback, and the exact diagnostics returned to MCP.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import * as schema from "../../cantrip_server/src/db/schema.ts";
import { ChatExecutionLaneRepository } from "../../cantrip_server/src/db/repository/chat-execution-lanes.ts";
const require = createRequire(
  new URL("../../cantrip_server/package.json", import.meta.url),
);
const { drizzle } = require("drizzle-orm/pg-proxy");
const source = drizzle(
  async () => {
    throw Error("Unexpected generation-time SQL execution");
  },
  { schema },
);
const captured = {};
for (const existing of [true, false]) {
  const names = [
    "consoles",
    "suspend",
    "insert-runtime",
    "runtime",
    "existing",
    existing ? "update" : "insert",
  ];
  const rows = [
    [],
    [],
    [],
    [{ id: "fixture-runtime", codexThreadId: null }],
    existing ? [{ id: "fixture-lane" }] : [],
  ];
  const stopped = new Error(
    "Stopped after the actual Source transition writer",
  );
  function wrap(builder) {
    return new Proxy(builder, {
      get(target, key) {
        if (key === "then")
          return (resolve, reject) => {
            try {
              const name = names.shift();
              assert.ok(name, "Unexpected Source query");
              const query = target.toSQL();
              if (name === "update" || name === "insert") {
                captured[name] = query;
                throw stopped;
              }
              return Promise.resolve(rows.shift()).then(resolve, reject);
            } catch (error) {
              return Promise.reject(error).then(resolve, reject);
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function"
          ? (...args) => wrap(value.apply(target, args))
          : value;
      },
    });
  }
  const db = new Proxy(source, {
    get(target, key) {
      if (key === "transaction") return async (callback) => callback(db);
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args) => wrap(value.apply(target, args))
        : value;
    },
  });
  const repo = new ChatExecutionLaneRepository(db, {
    getChatExecutionContext: async () => ({
      contextKind: "project",
      projectId: "fixture-project",
      worktreeMode: "agent-managed",
      status: "running",
      executionLaneId: "fixture-current",
      worktreeId: "fixture-primary",
      workerId: "fixture-worker",
    }),
    getProjectWorktreeContext: async () => ({
      workerId: "fixture-worker",
      worktree: {
        id: "fixture-tree",
        lifecycleState: "ready",
        isPrimary: false,
        head: "a".repeat(40),
      },
    }),
  });
  await assert.rejects(
    repo.scheduleChatWorktreeTransition(
      "fixture-owner",
      "fixture-chat",
      "fixture-current",
      "fixture-tree",
      "switch",
      "fixture-purpose",
    ),
    (error) => error === stopped,
  );
  assert.equal(names.length, 0);
  assert.equal(rows.length, 0);
}
const output = {};
for (const [name, query] of Object.entries(captured)) {
  let parameters;
  if (name === "update")
    parameters = [...query.sql.matchAll(/"([^"]+)" = \$(\d+)/g)].map(
      ([, column, position], i) => {
        assert.equal(Number(position), i + 1);
        return column;
      },
    );
  else {
    const columns = query.sql
      .match(/^insert into "chat_execution_lanes" \((.*?)\) values /)[1]
      .split(/,\s*/)
      .map((c) => c.replaceAll('"', ""));
    const values = query.sql
      .match(/ values \((.*?)\) returning /)[1]
      .split(/,\s*/);
    assert.equal(columns.length, values.length);
    parameters = [];
    values.forEach((value, i) => {
      const match = value.match(/^\$(\d+)$/);
      if (match) {
        assert.equal(Number(match[1]), parameters.length + 1);
        parameters.push(columns[i]);
      } else assert.equal(value, "default");
    });
  }
  assert.equal(parameters.length, query.params.length);
  for (const [column, expected] of Object.entries({
    acquiring_actor: "agent",
    state: "delivering",
    purpose: "fixture-purpose",
    runtime_session_id: "fixture-runtime",
    transition_kind: "switch",
  }))
    assert.equal(query.params[parameters.indexOf(column)], expected);
  output[name] = { sql: query.sql, parameters };
}
const destination = new URL(
  "../../cantrip_server_rs/contracts/mcp-worktree-queries.json",
  import.meta.url,
);
const encoded = JSON.stringify(output, null, 2) + "\n";
if (process.argv.includes("--write")) await writeFile(destination, encoded);
else assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), output);
console.log(
  JSON.stringify({
    source: "actual ChatExecutionLaneRepository transition writers",
    queries: Object.keys(output).length,
  }),
);
