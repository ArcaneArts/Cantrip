// Production command handlers, replay guard, transport and cryptography stay
// unchanged. Only downstream filesystem/native methods are controlled here.
import assert from "node:assert/strict";
import * as p from "../../packages/protocol/dist/index.js";
import { customizationContentResultSchema } from "../../packages/protocol/dist/customization-content.js";
import {
  encryptEndpointContentPayload,
  decryptEndpointContentPayload,
} from "../../packages/crypto/dist/index.js";
import { handleSkillsCommand } from "../../cantrip_worker/src/commands/skills.ts";
import { CustomizationContentReplayGuard } from "../../cantrip_worker/src/customization-content-encryption.ts";
import {
  settingsWorker as worker,
  componentKey,
} from "./native-settings-http-fixture.mjs";

export const skillSettingsMarker = "private-global-skill-settings-proof";
export const skillSettingsId = (n) =>
  `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
export const skillSettingsAudienceKey = (n) =>
  Buffer.alloc(32, n).toString("base64url");
export const skillSettingsRoutes = [
  [
    "GET",
    "/api/skills",
    "skills.settings.list",
    p.skillSettingsInventorySchema,
  ],
  [
    "POST",
    "/api/skills/read",
    "skills.settings.read",
    p.skillSettingsDocumentSchema,
  ],
  [
    "PUT",
    "/api/skills/file",
    "skills.settings.write",
    p.skillSettingsMutationResultSchema,
  ],
  [
    "DELETE",
    "/api/skills",
    "skills.settings.delete",
    p.skillSettingsMutationResultSchema,
  ],
  [
    "PATCH",
    "/api/skills/configuration",
    "skills.settings.configure",
    p.skillSettingsConfigResultSchema,
  ],
];
const payloads = {
  "skills.settings.read": { skillId: skillSettingsMarker },
  "skills.settings.write": {
    skillId: skillSettingsMarker,
    file: "SKILL.md",
    content: skillSettingsMarker,
  },
  "skills.settings.delete": { skillId: skillSettingsMarker },
  "skills.settings.configure": { skillId: skillSettingsMarker, enabled: false },
};
const item = {
  name: skillSettingsMarker,
  description: skillSettingsMarker,
  displayName: null,
  id: skillSettingsMarker,
  audienceKey: skillSettingsAudienceKey(61),
  audience: "ide",
  scope: "repo",
  location: "project",
  path: "/private/" + skillSettingsMarker + "/SKILL.md",
  enabled: true,
  editable: true,
  deletable: true,
};

export function skillSettingsHttpWorker(result, current) {
  const envelopes = new Map(),
    requests = new Map(),
    replies = new Map(),
    replay = new CustomizationContentReplayGuard();
  let mode = "normal",
    held;
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
    result.nativeCalls.push({
      method,
      input: current().fixture.normalize(canonical(input)),
    });
    if (mode === "failed") throw new Error(skillSettingsMarker);
    return output;
  }
  const runtime = {
    listSkillInventory: (input, forceReload) =>
      touch(
        "listSkillInventory",
        { ...input, forceReload },
        { items: [], errors: [] },
      ),
    configureSkill: (input) =>
      touch("configureSkill", input, {
        path: input.path,
        effectiveEnabled: input.enabled,
      }),
  };
  const skillManager = {
    list: (command, native) =>
      touch(
        "list",
        { command, native },
        {
          project: command.scope.projectId ? [item] : [],
          global: [{ ...item, scope: "user", location: "user" }],
          errors: [],
        },
      ),
    read: (command, skillId, file) =>
      touch(
        "read",
        { command, skillId, file },
        {
          skill: item,
          file: {
            path: file,
            sizeBytes: Buffer.byteLength(skillSettingsMarker),
          },
          files: [
            { path: file, sizeBytes: Buffer.byteLength(skillSettingsMarker) },
          ],
          content: skillSettingsMarker,
        },
      ),
    write: (command, skillId, file, content) =>
      touch(
        "write",
        { command, skillId, file, content },
        { changed: true, recoveryPath: null },
      ),
    delete: (command, skillId) =>
      touch(
        "delete",
        { command, skillId },
        {
          changed: true,
          recoveryPath: "/private/" + skillSettingsMarker + "/recovery",
        },
      ),
    configurationPath: (command, skillId) =>
      touch("configurationPath", { command, skillId }, item.path),
  };
  return {
    canonical,
    setMode: (value) => {
      mode = value;
    },
    hold() {
      mode = "hold";
      held = { requests: 0, releases: [] };
      held.releaseOne = (i) => held.releases[i]();
      held.release = () => held.releases.forEach((resolve) => resolve());
      return held;
    },
    release() {
      held?.release();
      mode = "normal";
    },
    async request(
      n,
      operation,
      scope,
      { tamper = false, payload = payloads[operation] } = {},
    ) {
      const operationId = skillSettingsId(n);
      const protectedRequest = await encryptEndpointContentPayload({
        ownerId: current().owner,
        context: context(operationId, operation, scope, "request"),
        keyRevision: 1,
        componentKey: new Uint8Array(componentKey),
        plaintext: new TextEncoder().encode(JSON.stringify(payload)),
      });
      if (tamper) {
        const value = protectedRequest.envelope.ciphertext;
        protectedRequest.envelope.ciphertext =
          (value[0] === "A" ? "B" : "A") + value.slice(1);
      }
      requests.set(operationId, structuredClone(protectedRequest));
      envelopes.set(
        envelopeKey(protectedRequest.envelope),
        `<${tamper ? "tampered" : "protected"} request:${n}>`,
      );
      return { operationId, operation, scope, protectedRequest };
    },
    async open(wire, schema) {
      assert.deepEqual(
        wire,
        replies.get(wire.operationId),
        "HTTP preserves exact endpoint-protected worker response",
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
      if (
        !skillSettingsRoutes.some(
          ([, , operation]) => operation === command.type,
        )
      )
        return undefined;
      result.commands.push(current().fixture.normalize(canonical(command)));
      if (command.protectedRequest)
        assert.deepEqual(
          command.protectedRequest,
          requests.get(command.operationId),
        );
      if (mode === "hold") {
        held.requests++;
        await new Promise((resolve) => held.releases.push(resolve));
      }
      if (mode === "rpc-error")
        throw new Error("Skill settings RPC failed \ud800");
      if (mode === "invalid") return { result: "invalid" };
      const response = await handleSkillsCommand(command, {
        config: {
          workerId: worker,
          dataDirectory: "/private/skill-settings-worker",
        },
        workerEncryption: encryption,
        runtimeFor: () => runtime,
        provider: () => command.provider,
        skillManager,
        customizationContentReplay: replay,
      });
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
      if (mode === "wrong-id") response.operationId = skillSettingsId(9999);
      if (mode === "wrong-operation") response.operation = "skills.list";
      if (mode === "wrong-scope")
        response.scope = { ...response.scope, projectId: "other-project" };
      replies.set(response.operationId, structuredClone(response));
      return response;
    },
  };
}
