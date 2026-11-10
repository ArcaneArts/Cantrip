// The transport and production command/protection handlers remain unchanged;
// only the native runtime methods at their downstream boundary are controlled.
import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";
import { customizationContentResultSchema } from "../../packages/protocol/dist/customization-content.js";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
} from "../../packages/crypto/dist/index.js";
import { handleCustomizationCommand } from "../../cantrip_worker/src/commands/customization.ts";
import { handleSkillsCommand } from "../../cantrip_worker/src/commands/skills.ts";
import { CustomizationContentReplayGuard } from "../../cantrip_worker/src/customization-content-encryption.ts";
import { updateNativePermissions } from "../../cantrip_worker/src/native-permission-update.ts";
import {
  settingsWorker as worker,
  componentKey,
} from "./native-settings-http-fixture.mjs";
import { literal, json } from "./project-target-state.mjs";
export const customizationMarker = "private-customization-endpoint-proof";
export const customizationId = (n) =>
  `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
export const customizationRoutes = [
  ["GET", "skills", "skills.list", p.skillListSchema],
  [
    "GET",
    "customizations",
    "customization.inventory.read",
    p.codexCustomizationInventorySchema,
  ],
  [
    "GET",
    "customizations/external-preview",
    "customization.external.preview",
    p.codexExternalImportPreviewSchema,
  ],
  [
    "POST",
    "customizations/mcp-resource",
    "customization.mcp.resource.read",
    p.codexMcpResourceReadSchema,
  ],
  [
    "PATCH",
    "customizations/skill",
    "customization.skill.configure",
    p.codexSkillConfigResultSchema,
  ],
  [
    "PUT",
    "customizations/skill-roots",
    "customization.skill-roots.set",
    p.codexSkillRootsResultSchema,
  ],
  [
    "POST",
    "customizations/mcp-oauth",
    "customization.mcp.oauth.start",
    p.codexMcpOauthStartResultSchema,
  ],
  [
    "POST",
    "customizations/mcp-oauth/status",
    "customization.mcp.oauth.status",
    p.codexMcpOauthStatusSchema,
  ],
  [
    "POST",
    "customizations/mcp-reload",
    "customization.mcp.reload",
    p.codexMcpReloadResultSchema,
  ],
  [
    "POST",
    "customizations/external-import",
    "customization.external.apply",
    p.codexExternalImportStatusSchema,
  ],
  [
    "POST",
    "customizations/external-import/status",
    "customization.external.status",
    p.codexExternalImportStatusSchema,
  ],
];
const requests = {
  "customization.mcp.resource.read": {
    server: customizationMarker,
    uri: "fixture://" + customizationMarker,
  },
  "customization.skill.configure": {
    path: "/private/" + customizationMarker,
    enabled: false,
  },
  "customization.skill-roots.set": {
    roots: ["/private/" + customizationMarker],
  },
  "customization.mcp.oauth.start": { server: customizationMarker },
  "customization.mcp.oauth.status": { server: customizationMarker },
  "customization.mcp.reload": {},
  "customization.external.apply": { itemIds: [customizationMarker] },
  "customization.external.status": { importId: customizationMarker },
};
const unsupported = {
    available: false,
    reason: "Fixture capability",
    stability: "unsupported",
  },
  capability = {
    isolatedCodexHome: true,
    collaborationModes: unsupported,
    threadGoals: unsupported,
    nativeSubagents: { ...unsupported, protocolVersion: null },
    customAgents: unsupported,
    hooks: unsupported,
    skills: {
      list: unsupported,
      configure: unsupported,
      extraRoots: unsupported,
    },
    mcp: {
      status: unsupported,
      resourceRead: unsupported,
      oauth: unsupported,
      reload: unsupported,
    },
    plugins: {
      list: unsupported,
      read: unsupported,
      install: unsupported,
      uninstall: unsupported,
    },
    externalImports: { detect: unsupported, apply: unsupported },
  },
  skill = {
    name: customizationMarker,
    description: customizationMarker,
    displayName: null,
  };
export function customizationHttpWorker(result, current) {
  const envelopes = new Map(),
    inputs = new Map(),
    replies = new Map(),
    replay = new CustomizationContentReplayGuard();
  let mode = "normal",
    held,
    profileMode = "normal",
    permissionMode = "applied",
    planMode = "default",
    planFailure = null,
    profileHold;
  const envelopeKey = (value) =>
    JSON.stringify(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return (
        envelopes.get(envelopeKey(value)) ??
        Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, canonical(v)]),
        )
      );
    return value;
  }
  function context(operationId, operation, scope, direction) {
    return {
      domain: "customization-content",
      serverId: current().serverId,
      workerId: scope.workerId,
      scopeId: JSON.stringify([
        scope.workerId,
        scope.projectId,
        scope.chatId,
        scope.providerId,
      ]),
      operationId,
      operation,
      direction,
      sequence: 0,
    };
  }
  async function touch(method, input, output) {
    result.runtimeCalls.push({
      method,
      input: current().fixture.normalize(input),
    });
    if (mode === "hold") {
      held.requested = true;
      held.requests++;
      await new Promise((resolve) => held.releases.push(resolve));
    }
    if (mode === "failed") throw new Error(customizationMarker);
    return output;
  }
  const runtime = {
    listSkills: (input) => touch("listSkills", input, [skill]),
    readCustomizationInventory: (input, forceReload) =>
      touch(
        "readCustomizationInventory",
        { ...input, forceReload },
        {
          capabilities: capability,
          skills: {
            items: [
              {
                ...skill,
                path: "/private/" + customizationMarker,
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
          skillRoots: [],
          hooks: { items: [], warnings: [], errors: [] },
          mcpServers: [],
        },
      ),
    previewExternalAgentConfig: (input) =>
      touch("previewExternalAgentConfig", input, {
        sourceScope: "project",
        items: [
          {
            id: customizationMarker,
            itemType: "SKILLS",
            description: customizationMarker,
            cwd: null,
            details: null,
          },
        ],
      }),
    readMcpResource: (input) =>
      touch("readMcpResource", input, {
        contents: [
          {
            type: "text",
            uri: input.uri,
            mimeType: null,
            text: customizationMarker,
          },
        ],
      }),
    configureSkill: (input) =>
      touch("configureSkill", input, {
        path: input.path,
        effectiveEnabled: input.enabled,
      }),
    setSkillRoots: (input) =>
      touch("setSkillRoots", input, { roots: input.roots }),
    startMcpOauth: (input) =>
      touch("startMcpOauth", input, {
        server: input.server,
        authorizationUrl: "https://fixture.invalid/" + customizationMarker,
        status: "pending",
      }),
    mcpOauthStatus: (server) =>
      touch(
        "mcpOauthStatus",
        { server },
        { server, status: "succeeded", error: null },
      ),
    reloadMcpServers: (input) =>
      touch("reloadMcpServers", input, { reloaded: true }),
    applyExternalAgentConfig: (input) =>
      touch("applyExternalAgentConfig", input, {
        importId: customizationMarker,
        status: "pending",
        results: [],
      }),
    externalImportStatus: (importId) =>
      touch(
        "externalImportStatus",
        { importId },
        { importId, status: "completed", results: [] },
      ),
  };
  return {
    canonical,
    setMode: (value) => {
      mode = value;
    },
    setProfileMode: (value) => {
      profileMode = value;
    },
    setPermissionMode: (value) => {
      permissionMode = value;
    },
    setPlanMode: (value) => {
      planMode = value;
    },
    setPlanFailure: (value) => {
      planFailure = value;
    },
    hold() {
      mode = "hold";
      held = { requested: false, requests: 0, releases: [] };
      held.releaseOne = (index) => held.releases[index]();
      held.release = () => held.releases.forEach((resolve) => resolve());
      return held;
    },
    holdProfiles() {
      profileHold = { requested: false };
      profileHold.promise = new Promise((resolve) => {
        profileHold.release = resolve;
      });
      return profileHold;
    },
    release() {
      held?.release();
      profileHold?.release();
      mode = "normal";
    },
    async request(n, operation, scope, { tamper = false } = {}) {
      const operationId = customizationId(n),
        content = requests[operation];
      assert.ok(content, "protected operation fixture");
      const protectedRequest = await encryptEndpointContentPayload({
        ownerId: current().owner,
        context: context(operationId, operation, scope, "request"),
        keyRevision: 1,
        componentKey: new Uint8Array(componentKey),
        plaintext: new TextEncoder().encode(JSON.stringify(content)),
      });
      if (tamper) {
        const value = protectedRequest.envelope.ciphertext;
        protectedRequest.envelope.ciphertext =
          (value[0] === "A" ? "B" : "A") + value.slice(1);
      }
      inputs.set(operationId, protectedRequest);
      envelopes.set(
        envelopeKey(protectedRequest.envelope),
        `<verified request:${n}>`,
      );
      return { operationId, operation, scope, protectedRequest };
    },
    async open(wire, schema) {
      assert.deepEqual(
        wire,
        replies.get(wire.operationId),
        "HTTP retains the exact worker-protected response",
      );
      const bytes = await decryptEndpointContentPayload({
        ownerId: current().owner,
        context: context(
          wire.operationId,
          wire.operation,
          wire.scope,
          "response",
        ),
        keyRevision: 1,
        componentKey: new Uint8Array(componentKey),
        opaque: wire.protectedResponse,
      });
      const opened = customizationContentResultSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      assert.equal(opened.status, wire.result);
      if (opened.status === "succeeded") schema.parse(opened.value);
      result.cryptoProofs++;
      return opened;
    },
    async onCommand(command, _emit, { encryption }) {
      if (["chat.plan.get", "chat.plan.set"].includes(command.type)) {
        result.commands.push(current().fixture.normalize(command));
        assert.equal(typeof command.cwd, "string");
        assert.equal(typeof command.model.id, "string");
        assert.equal(typeof command.provider.id, "string");
        if (planFailure === "error") throw new Error("controlled Plan failure");
        if (command.type === "chat.plan.get") return { mode: planMode };
        if (planFailure === "thread")
          return { mode: command.mode, threadId: null };
        planMode = command.mode;
        return { mode: planMode, threadId: command.threadId ?? "thread" };
      }
      if (command.type === "chat.permissions.update") {
        result.commands.push(current().fixture.normalize(command));
        if (permissionMode.startsWith("reject:")) {
          const h = current(),
            code = permissionMode.slice(7);
          await h.fixture.sql([
            `INSERT INTO native_commands(operation_id,owner_id,worker_id,chat_id,operation_generation,origin,method,kind,payload_digest,protected_payload,identity,intent,status,rejection_code) VALUES(${literal(command.operationId)},${literal(h.owner)},${literal(worker)},${literal(command.binding.chatId)},${literal("generation:" + command.operationId)},'gui','thread/settings/update','settings','${"a".repeat(64)}','{}',${json({ threadId: command.binding.threadId })},'{}','rejected',${literal(code)})`,
          ]);
          throw new Error("controlled permission command rejection");
        }
        if (permissionMode === "error")
          throw new Error("controlled permission update failure");
        if (permissionMode === "invalid") return { status: "invalid" };
        const native = {
          transportGeneration: "runtime",
          async updateNativeThreadSettings(input) {
            result.permissionWrites.push(current().fixture.normalize(input));
            return {
              operationId:
                permissionMode === "wrong-id"
                  ? "other-operation"
                  : input.operationId,
              submissionId:
                permissionMode === "requesting"
                  ? null
                  : "permission-submission",
              status:
                permissionMode === "wrong-id" ? "applied" : permissionMode,
            };
          },
        };
        return updateNativePermissions({
          request: command,
          resolve: () => ({
            scope: current().scope,
            runtime: native,
            generation: "runtime",
          }),
        });
      }
      if (command.type === "permission-profiles.list") {
        result.commands.push(current().fixture.normalize(command));
        if (profileHold) {
          const gate = profileHold;
          gate.requested = true;
          await gate.promise;
          profileHold = undefined;
        }
        if (profileMode === "error")
          throw new Error("permission capability failed \ud800");
        if (profileMode === "invalid") return { available: "yes" };
        return {
          available: profileMode !== "unavailable",
          reason:
            profileMode === "unavailable"
              ? "Controlled unavailable capability"
              : null,
          profiles: [
            { id: ":workspace", description: "Workspace", allowed: true },
            {
              id: ":danger-full-access",
              description: "Full",
              allowed: profileMode !== "denied",
            },
            { id: "custom", description: "Custom", allowed: true },
          ],
        };
      }
      if (!customizationRoutes.some(([, , op]) => op === command.type))
        return undefined;
      result.commands.push(current().fixture.normalize(canonical(command)));
      if (command.protectedRequest)
        assert.deepEqual(
          command.protectedRequest,
          inputs.get(command.operationId),
        );
      if (mode === "rpc-error")
        throw new Error("customization RPC rejected \ud800");
      if (mode === "invalid") return { result: "invalid" };
      const dependencies = {
        config: { workerId: worker },
        workerEncryption: encryption,
        runtimeFor: () => runtime,
        provider: () => command.provider,
        customizationContentReplay: replay,
      };
      const response =
        command.type === "skills.list"
          ? await handleSkillsCommand(command, dependencies)
          : await handleCustomizationCommand(command, dependencies);
      // Prove endpoint decryption before replacing any randomized envelope.
      const bytes = await decryptEndpointContentPayload({
        ownerId: current().owner,
        context: context(
          response.operationId,
          response.operation,
          response.scope,
          "response",
        ),
        keyRevision: 1,
        componentKey: new Uint8Array(componentKey),
        opaque: response.protectedResponse,
      });
      const opened = customizationContentResultSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      assert.equal(opened.status, response.result);
      result.cryptoProofs++;
      envelopes.set(
        envelopeKey(response.protectedResponse.envelope),
        `<verified response:${command.operationId}>`,
      );
      if (mode === "wrong-id") response.operationId = customizationId(9999);
      if (mode === "wrong-operation")
        response.operation = "skills.settings.list";
      if (mode === "wrong-scope")
        response.scope = { ...response.scope, chatId: "other" };
      replies.set(response.operationId, structuredClone(response));
      return response;
    },
  };
}
