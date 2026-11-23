// Controlled endpoint replies over the production WorkerConnection transport.
import { remoteSurfaceConfigurationSchema } from "../../packages/protocol/dist/remote-surfaces.js";
import { fileDocumentWireFixtures } from "./file-document-wire-fixtures.mjs";
import { interactionOpaque } from "./agent-interaction-fixtures.mjs";
import { literal, json, label, state, stamp } from "./project-target-state.mjs";
import {
  settingsChat as chat,
  settingsProject as project,
  settingsTree as tree,
  settingsWorker as worker,
} from "./native-settings-http-fixture.mjs";

export const operations = [
  "explorer.list",
  "explorer.read",
  "explorer.write",
  "terminal.read",
  "terminal.send",
  "terminal.restart",
  "browser.services",
  "browser.open",
  "client.notify",
  "client.focus-project",
  "client.focus-surface",
  "client.show-interaction",
];
export const readOperations = new Set([
  "explorer.list",
  "explorer.read",
  "terminal.read",
  "browser.services",
]);
export const lane = "mcp-surface-lane";
export const interaction = "66666666-6666-4666-8666-000000000800";
export const target = (
  surfaceKind,
  surfaceId = surfaceKind === "chat" ? chat : "mcp-" + surfaceKind,
) => ({
  kind: "surface",
  projectId: project,
  surfaceKind,
  surfaceId,
});
export const wireRequest =
  fileDocumentWireFixtures().surfaceStreamWireRequestSchema[0];
const wireReply = fileDocumentWireFixtures().surfaceStreamWireResponseSchema[0];
export function argumentsFor(operation) {
  if (operation === "client.focus-project") return {};
  if (operation === "client.focus-surface")
    return { target: target("explorer") };
  if (operation === "client.show-interaction")
    return { interactionId: interaction };
  if (operation === "browser.open")
    return {
      target: target("browser"),
      expectedStateRevision: 1,
      stateProtection: state("browser-state"),
    };
  return { target: target(operation.split(".")[0]), ...wireRequest };
}
export function surfaceWorker() {
  const s = { commands: [], housekeeping: [], mode: "normal", services: [] };
  s.onCommand = async (command) => {
    if (
      ![
        "explorer.operation",
        "terminal.snapshot",
        "terminal.input",
        "terminal.service.restart",
        "surface.configure",
        "browser.services.discover",
      ].includes(command.type)
    ) {
      s.housekeeping.push(structuredClone(command));
      return undefined;
    }
    s.commands.push(structuredClone(command));
    await s.beforeCommand?.(command);
    if (s.mode === "failure")
      throw new Error(s.failure ?? "Controlled surface endpoint failure");
    if (s.mode === "malformed") return { malformed: true };
    if (command.type === "browser.services.discover")
      return structuredClone(s.services);
    if (
      ["terminal.service.restart", "surface.configure"].includes(command.type)
    )
      return {};
    return {
      ...wireReply,
      operationId: command.operationId,
      sequence: command.sequence,
    };
  };
  return s;
}
export function surfaceSeed(owner) {
  return [
    `UPDATE chats SET status='running',permission_profile_id=':workspace' WHERE id=${literal(chat)}`,
    `UPDATE workers SET remote_surface_capabilities='{"browser":true,"desktop":true}' WHERE id=${literal(worker)}`,
    `INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,worker_id,acquiring_actor,exclusive,purpose,state,activated_at,runtime_session_id) VALUES(${literal(lane)},${literal(chat)},${literal(tree)},${literal(worker)},'agent',false,'Surface qualification','active',now(),'settings-runtime')`,
    ...[
      ["explorers", "explorer", "explorer-state"],
      ["terminals", "terminal", "terminal-state"],
      ["code_tabs", "code-tab", null],
    ].map(
      ([table, record, protection]) =>
        `INSERT INTO ${table}(id,project_id,active_worker_id,worktree_id,protected_label${protection ? ",protected_state" : ""},created_at,updated_at) VALUES(${literal("mcp-" + (table === "code_tabs" ? "code" : record))},${literal(project)},${literal(worker)},${literal(tree)},${json(label(record))}${protection ? "," + json(state(protection)) : ""},${literal(stamp)},${literal(stamp)})`,
    ),
    "UPDATE terminals SET service_enabled=true WHERE id='mcp-terminal'",
    `INSERT INTO browsers(id,project_id,protected_label,protected_state,created_at,updated_at) VALUES('mcp-browser',${literal(project)},${json(label("browser"))},${json(state("browser-state"))},${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO remote_surfaces(id,project_id,worker_id,kind,configuration,protected_label,protected_state,state_revision,created_at,updated_at) VALUES('mcp-browser',${literal(project)},${literal(worker)},'browser',${json(remoteSurfaceConfigurationSchema.parse({ kind: "browser" }))},${json(label("browser"))},${json(state("browser-state"))},1,${literal(stamp)},${literal(stamp)})`,
    `INSERT INTO agent_interaction_requests(id,request_key,owner_id,project_id,chat_id,worker_id,thread_id,kind,status,payload,protected_payload,created_at,updated_at) VALUES(${literal(interaction)},'mcp-surface-interaction',${literal(owner)},${literal(project)},${literal(chat)},${literal(worker)},'thread','fileChange','pending',NULL,${json(interactionOpaque)},${literal(stamp)},${literal(stamp)})`,
  ];
}
