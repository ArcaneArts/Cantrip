import assert from "node:assert/strict";
import { runDefinition } from "./run-lifecycle-http-cases.mjs";
export function definitionWorker() {
  return {
    enabled: false,
    mode: null,
    entry: null,
    commands: [],
    respond(command) {
      if (!this.enabled) return runDefinition(command);
      this.commands.push(command);
      const operation = command.type.split(".").at(-1);
      const context = {
        operation,
        operationId: command.operationId,
        projectId: command.projectId,
      };
      let result;
      switch (operation) {
        case "list":
          result = {
            ...context,
            inventory: {
              directory: ".cantrip/run-configurations",
              entries: this.entry ? [this.entry] : [],
              diagnostics: [],
            },
            validations: this.entry
              ? [this.validation(this.entry.document)]
              : [],
          };
          break;
        case "get":
          result = {
            ...runDefinition(command),
            result: this.entry
              ? { found: true, entry: this.entry }
              : { found: false, id: command.configurationId },
          };
          break;
        case "capabilities":
          result = { ...context, capabilities: [] };
          break;
        case "detect":
          result = { ...context, candidates: [], diagnostics: [] };
          break;
        case "paths":
          result = {
            ...context,
            purpose: command.purpose,
            query: command.query,
            suggestions: [],
            truncated: false,
          };
          break;
        case "validate":
          result = {
            ...context,
            validation: this.validation(command.document),
          };
          break;
        case "flutter-devices":
          result = {
            ...context,
            configurationId: command.document.id,
            platform: "linux",
            devices: [],
            diagnostics: [],
          };
          break;
        case "write": {
          if (
            this.entry &&
            command.request.expectedRevision !== this.entry.revision
          )
            result = {
              ...context,
              result: {
                outcome: "revision-mismatch",
                id: command.request.document.id,
                currentRevision: this.entry.revision,
                conflictingId: null,
              },
            };
          else {
            const existed = !!this.entry;
            this.entry = {
              ...runDefinition({
                ...command,
                configurationId: command.request.document.id,
              }).result.entry,
              document: command.request.document,
              revision: (existed ? "b" : "a").repeat(64),
            };
            result = {
              ...context,
              result: {
                outcome: existed ? "updated" : "created",
                entry: this.entry,
              },
            };
          }
          break;
        }
        case "delete":
          result = {
            ...context,
            result: {
              outcome: "deleted",
              id: command.request.id,
              revision: this.entry.revision,
            },
          };
          this.entry = null;
          break;
        default:
          throw new Error("Unexpected definition command: " + operation);
      }
      if (this.mode === "misrouted")
        result.operationId = "88888888-8888-4888-8888-888888888888";
      if (this.mode === "malformed") return { wrong: true };
      if (this.mode === "wrong-path") result.query = "different";
      return result;
    },
    validation(document) {
      return {
        configurationId: document.id,
        provider: document.provider,
        platform: "linux",
        effectiveCommand: "echo acceptance",
        valid: true,
        diagnostics: [],
      };
    },
  };
}
export async function runDefinitionHttpCases({
  visit,
  fixture,
  worker,
  definitions,
  projectId,
  profile,
  worktreeId,
  setMode,
}) {
  definitions.enabled = true;
  const commandStart = worker.runtimeCommands.length;
  const id = "44444444-4444-4444-8444-444444444444";
  let sequence = 0;
  const operationId = () =>
    `33333333-3333-4333-8333-${String(++sequence).padStart(12, "0")}`;
  const base = `/api/projects/${projectId}/run-configurations`;
  const document = runDefinition({ configurationId: id }).result.entry.document;
  const get = (name, suffix = "", status = 200, extra = {}) =>
    visit(name, "GET", `${base}${suffix}?operationId=${operationId()}`, {
      status,
      ...extra,
    });
  await visit("definitions missing operation", "GET", base, { status: 400 });
  await visit(
    "definitions duplicate operation",
    "GET",
    base + `?operationId=${operationId()}&operationId=${operationId()}`,
    { status: 400 },
  );
  await get("definitions invalid id", "/not-a-uuid", 400);
  await visit(
    "definitions foreign source",
    "GET",
    `/api/projects/other/run-configurations?operationId=${operationId()}`,
    { status: 404 },
  );
  if (profile === "accounts")
    await get("definitions other owner", "", 404, { client: "other" });
  const before = definitions.commands.length;
  await visit(
    "definitions route document mismatch",
    "PUT",
    `${base}/${projectId}`,
    {
      json: { operationId: operationId(), expectedRevision: null, document },
      status: 400,
    },
  );
  assert.equal(definitions.commands.length, before);
  const empty = await get("definitions empty list");
  assert.deepEqual(empty.inventory.entries, []);
  await get("definitions capabilities", "/capabilities");
  await get("definitions detection", "/detect");
  await visit(
    "definitions paths default query",
    "GET",
    base + `/paths?operationId=${operationId()}&purpose=file`,
    { status: 200 },
  );
  const created = await visit("definition create", "PUT", `${base}/${id}`, {
    json: { operationId: operationId(), expectedRevision: null, document },
    status: 201,
  });
  assert.equal(created.result.outcome, "created");
  const read = await get("definition owned read", `/${id}`);
  assert.equal(read.result.found, true);
  assert.deepEqual(
    read.secretReferences.map((row) => [row.reference, row.available]),
    [
      ["run/api", true],
      ["run/missing", false],
      ["run/platform", true],
    ],
  );
  await get("definitions populated list");
  await visit("definition validate", "POST", base + "/validate", {
    json: { operationId: operationId(), document },
    status: 200,
  });
  await visit("definition Flutter devices", "POST", base + "/flutter-devices", {
    json: {
      operationId: operationId(),
      document: {
        schema: "cantrip.run-configuration",
        version: 1,
        id,
        name: "Flutter",
        provider: "flutter",
        target: { kind: "entrypoint", path: "lib/main.dart" },
      },
    },
    status: 200,
  });
  definitions.mode = "malformed";
  await get("definition malformed worker result", "/capabilities", 502);
  definitions.mode = null;
  for (const suffix of ["", "/capabilities", "/detect", `/${id}`]) {
    definitions.mode = "misrouted";
    await get("definition misrouted " + suffix, suffix, 502);
  }
  definitions.mode = "wrong-path";
  await visit(
    "definitions paths correlation",
    "GET",
    base + `/paths?operationId=${operationId()}&purpose=file`,
    { status: 502 },
  );
  definitions.mode = null;
  await visit("definition revision conflict", "PUT", `${base}/${id}`, {
    json: {
      operationId: operationId(),
      expectedRevision: "c".repeat(64),
      document,
    },
    status: 409,
  });
  const updated = await visit("definition update", "PUT", `${base}/${id}`, {
    json: {
      operationId: operationId(),
      expectedRevision: created.result.entry.revision,
      document,
    },
    status: 200,
  });
  assert.equal(updated.result.outcome, "updated");
  setMode("active");
  const started = await visit(
    "definition runtime start",
    "POST",
    "/api/run-configuration-runtimes/operations",
    {
      json: {
        operationId: operationId(),
        projectId,
        configurationId: id,
        targetWorktreeId: worktreeId,
        operation: "start",
      },
      status: 202,
    },
  );
  assert.equal(started.runtime.state, "running");
  const stopCount = worker.runtimeCommands.filter((command) =>
    command.type.endsWith(".stop"),
  ).length;
  await visit("definition stale delete", "DELETE", `${base}/${id}`, {
    json: {
      operationId: operationId(),
      expectedRevision: created.result.entry.revision,
    },
    status: 409,
  });
  assert.equal(
    worker.runtimeCommands.filter((command) => command.type.endsWith(".stop"))
      .length,
    stopCount,
  );
  const deleteCount = definitions.commands.filter((command) =>
    command.type.endsWith(".delete"),
  ).length;
  await visit(
    "definition active stop rejects deletion",
    "DELETE",
    `${base}/${id}`,
    {
      json: {
        operationId: operationId(),
        expectedRevision: updated.result.entry.revision,
      },
      status: 409,
    },
  );
  assert.equal(
    definitions.commands.filter((command) => command.type.endsWith(".delete"))
      .length,
    deleteCount,
  );
  setMode("exited");
  const deleted = await visit("definition delete", "DELETE", `${base}/${id}`, {
    json: {
      operationId: operationId(),
      expectedRevision: updated.result.entry.revision,
    },
    status: 200,
  });
  assert.equal(deleted.result.outcome, "deleted");
  await visit("definition missing delete", "DELETE", `${base}/${id}`, {
    json: {
      operationId: operationId(),
      expectedRevision: updated.result.entry.revision,
    },
    status: 404,
  });
  await get("definitions empty after deletion");
  return fixture.normalize(worker.runtimeCommands.slice(commandStart));
}
