import assert from "node:assert/strict";
import {
  cantripOsObservedInstanceSchema,
  cantripOsSourceReceiptSchema,
  cantripOsOperationResultSchema,
  cantripOsBackupPrivateResultSchema,
  cantripOsBackupOperationResultSchema,
  cantripOsProvisionRequestContentSchema,
} from "../../packages/protocol/dist/index.js";
import { runConfigurationOperationResponseSchema } from "../../packages/protocol/dist/run-configuration-operations.js";
import {
  encryptRepositoryOperationPayload,
  decryptRepositoryOperationPayload,
  encryptCantripOsBackupMessage,
  decryptCantripOsBackupMessage,
} from "../../packages/crypto/dist/index.js";
import { componentKey } from "./native-settings-http-fixture.mjs";

export const osHttpProject = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
export const osHttpGuest = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01";
export const osHttpRuntime = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02";
export const osHttpPrivate = "private OS HTTP fixture 日本語";
const at = "2026-10-25T00:00:00.000Z";
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

export function cantripOsHttpWorker(result) {
  const started = Date.now();
  const aliases = new Map(),
    envelopes = new Map();
  const operations = new Map(),
    backups = new Map();
  let attachment = null,
    attachReply = "void",
    attachFailure = false,
    wrongReceiptBinding = false,
    inspection = "normal",
    runReply = "normal",
    loseProvision = true,
    loseBackup = true;
  const key = (value) =>
    value && value.algorithm === "AES-256-GCM"
      ? JSON.stringify([
          value.version,
          value.algorithm,
          value.keyRevision,
          value.nonce,
          value.ciphertext,
        ])
      : null;
  function remember(value, name) {
    envelopes.set(
      key(value.envelope),
      "<verified endpoint envelope:" + name + ">",
    );
    return value;
  }
  function alias(h, value, name) {
    aliases.set(value, name);
    aliases.set(h.fixture.normalize(value), name);
  }
  function canonical(value, field = "") {
    if (Array.isArray(value))
      return value.map((item) => canonical(item, field));
    if (value && typeof value === "object") {
      if (envelopes.has(key(value))) return envelopes.get(key(value));
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v, k)]),
      );
    }
    if (typeof value === "string") {
      if (field.endsWith("_at") && /^\d{4}-/.test(value)) {
        const time = Date.parse(value);
        assert.ok(
          Number.isFinite(time) && time >= started && time <= Date.now() + 1000,
          "actual OS durable write clock",
        );
        return "<validated OS write clock>";
      }
      if (aliases.has(value)) return aliases.get(value);
      for (const [actual, name] of aliases)
        value = value.replaceAll(actual, name);
    }
    return value;
  }
  const backupIdentity = (ownerId, serverId, operationId) => ({
    ownerId,
    serverId,
    operationId,
    keyRevision: 1,
    componentKey: new Uint8Array(componentKey),
  });
  async function backupRequest(h, operationId, content) {
    return remember(
      await encryptCantripOsBackupMessage({
        ...backupIdentity(h.owner, h.serverId, operationId),
        direction: "request",
        plaintext: encode(content),
      }),
      operationId + ":request",
    );
  }
  async function provisionRequest(h, binding, operationId) {
    return remember(
      await encryptRepositoryOperationPayload({
        ownerId: h.owner,
        context: {
          serverId: h.serverId,
          projectId: binding.projectId,
          worktreeId: binding.worktreeId,
          operationId,
          direction: "request",
        },
        keyRevision: 1,
        componentKey: new Uint8Array(componentKey),
        plaintext: encode(
          cantripOsProvisionRequestContentSchema.parse({
            type: "cantrip-os.source.provision",
            instanceId: binding.instanceId,
            workspaceId: binding.workspaceId,
            bindingId: binding.id,
            bindingGeneration: binding.bindingGeneration,
            intent: {
              mode: "linux-owned",
              source: {
                kind: "git",
                repositoryUrl:
                  "https://example.invalid/" +
                  encodeURIComponent(osHttpPrivate),
                revision: "a".repeat(40),
              },
            },
          }),
        ),
      }),
      operationId + ":provision",
    );
  }
  function receipt(scope) {
    return cantripOsSourceReceiptSchema.parse({
      bindingId: wrongReceiptBinding
        ? "ffffffff-ffff-4fff-8fff-ffffffffff03"
        : scope.bindingId,
      workspaceId: scope.workspaceId,
      guestWorkspaceId: scope.guestWorkspaceId,
      mode: scope.mode,
      guestPath: scope.guestPath,
      runtimeGeneration: scope.runtimeGeneration,
      uid: scope.uid,
      homeGuestPath: scope.homeGuestPath,
      head: "a".repeat(40),
      branch: "main",
      detached: false,
      repositoryFingerprint: "controlled-os-repository",
      gitCommonGuestPath: scope.guestPath + "/.git",
      recreated: false,
      interruptedGuestWorkspaces: [],
      dependencyOverlays: [],
      cleanupWarnings: [],
    });
  }
  const observed = () =>
    cantripOsObservedInstanceSchema.parse({
      guestInstanceId:
        inspection === "wrong-guest"
          ? "ffffffff-ffff-4fff-8fff-ffffffffff01"
          : osHttpGuest,
      runtimeGeneration: osHttpRuntime,
      attachment:
        inspection === "foreign-attachment"
          ? { ownerId: "another-owner", workerId: "another-worker" }
          : attachment,
      workspaces: [
        {
          guestWorkspaceId: "example",
          uid: 20000,
          gid: 20000,
          homeGuestPath: "/home/example",
        },
      ],
    });
  async function handle(command, _emit, { owner, serverId }) {
    if (!command.type.startsWith("cantrip-os.")) return undefined;
    if (command.type === "cantrip-os.run-runtime.reconcile") return undefined;
    result.commands.push(structuredClone(command));
    if (command.scope) {
      assert.equal(command.scope.ownerId, owner);
      assert.equal(command.scope.serverId, serverId);
      assert.equal(command.scope.guestInstanceId, osHttpGuest);
      assert.equal(command.scope.runtimeGeneration, osHttpRuntime);
    }
    switch (command.type) {
      case "cantrip-os.inspect":
        return observed();
      case "cantrip-os.attach":
        attachment = { ownerId: owner, workerId: command.scope.workerId };
        if (attachFailure)
          throw new Error("Lost controlled attachment acknowledgement");
        return attachReply === "observation" ? observed() : null;
      case "cantrip-os.source.provision": {
        const content = decode(
          await decryptRepositoryOperationPayload({
            ownerId: owner,
            context: {
              serverId,
              projectId: command.scope.projectId,
              worktreeId: command.scope.worktreeId,
              operationId: command.operationId,
              direction: "request",
            },
            keyRevision: 1,
            componentKey: new Uint8Array(componentKey),
            opaque: command.protectedRequest,
          }),
        );
        cantripOsProvisionRequestContentSchema.parse(content);
        assert.equal(content.bindingId, command.scope.bindingId);
        assert.equal(
          content.bindingGeneration,
          command.scope.bindingGeneration,
        );
        assert.equal(
          decodeURIComponent(content.intent.source.repositoryUrl),
          "https://example.invalid/" + osHttpPrivate,
        );
        result.cryptoProofs++;
        const value = cantripOsOperationResultSchema.parse({
          operationId: command.operationId,
          startedAt: at,
          updatedAt: at,
          state: "ready",
          error: null,
          receipt: { kind: "source", source: receipt(command.scope) },
        });
        assert.equal(
          operations.has(command.operationId),
          false,
          "provisioning mutation is never redispatched",
        );
        operations.set(command.operationId, value);
        if (loseProvision) {
          loseProvision = false;
          throw new Error("Lost controlled provisioning acknowledgement");
        }
        return value;
      }
      case "cantrip-os.operation.inspect":
        assert.ok(operations.has(command.operationId));
        return operations.get(command.operationId);
      case "cantrip-os.source.inspect":
        return receipt(command.scope);
      case "cantrip-os.run-definition":
        assert.equal(command.execution.scope.projectId, osHttpProject);
        assert.equal(command.execution.scope.runtimeGeneration, osHttpRuntime);
        if (runReply === "failure")
          throw new Error("Controlled OS definition read failure");
        if (runReply === "wrong-operation")
          return runConfigurationOperationResponseSchema.parse({
            operation: "capabilities",
            operationId: command.request.operationId,
            projectId: command.request.projectId,
            capabilities: [],
          });
        return runConfigurationOperationResponseSchema.parse({
          operation: "list",
          projectId: command.request.projectId,
          operationId:
            runReply === "wrong-operation-id"
              ? "ffffffff-ffff-4fff-8fff-ffffffffff02"
              : command.request.operationId,
          inventory: {
            directory: ".cantrip/run-configurations",
            entries: [],
            diagnostics: [],
          },
          validations: [],
        });
      case "cantrip-os.backup.capture": {
        const identity = backupIdentity(owner, serverId, command.operationId);
        const content = decode(
          await decryptCantripOsBackupMessage({
            ...identity,
            direction: "request",
            frame: command.protectedRequest,
          }),
        );
        assert.equal(content.label, osHttpPrivate);
        assert.equal(command.sources.length, 1);
        assert.equal(command.sources[0].projectId, osHttpProject);
        assert.equal(command.workspace.uid, 20000);
        result.cryptoProofs++;
        const privateResult = cantripOsBackupPrivateResultSchema.parse({
          action: "capture",
          metadata: {
            version: 1,
            archiveBytes: 10240,
            archiveSha256: "a".repeat(64),
            manifest: { fixture: osHttpPrivate },
          },
          cleanupWarnings: [],
        });
        const protectedResult = remember(
          await encryptCantripOsBackupMessage({
            ...identity,
            direction: "response",
            plaintext: encode(privateResult),
          }),
          command.operationId + ":response",
        );
        const value = cantripOsBackupOperationResultSchema.parse({
          operationId: command.operationId,
          action: "capture",
          state: "ready",
          phase: "complete",
          startedAt: at,
          updatedAt: at,
          error: null,
          protectedResult,
        });
        assert.equal(
          backups.has(command.operationId),
          false,
          "backup mutation is never redispatched",
        );
        backups.set(command.operationId, value);
        if (loseBackup) {
          loseBackup = false;
          throw new Error("Lost controlled backup acknowledgement");
        }
        return value;
      }
      case "cantrip-os.backup.observe":
        assert.ok(backups.has(command.operationId));
        return backups.get(command.operationId);
      default:
        throw new Error("Unexpected controlled OS command " + command.type);
    }
  }
  async function proveBackup(h, summary) {
    const opened = decode(
      await decryptCantripOsBackupMessage({
        ...backupIdentity(h.owner, h.serverId, summary.operationId),
        direction: "response",
        frame: summary.result.protectedResult,
      }),
    );
    cantripOsBackupPrivateResultSchema.parse(opened);
    assert.equal(opened.metadata.manifest.fixture, osHttpPrivate);
    result.cryptoProofs++;
  }
  return {
    setAttachFailure: (value) => {
      attachFailure = value;
    },
    setWrongReceiptBinding: (value) => {
      wrongReceiptBinding = value;
    },
    setInspection: (value) => {
      inspection = value;
    },
    setRunReply: (value) => {
      runReply = value;
    },
    setAttachReply: (value) => {
      attachReply = value;
    },
    handle,
    alias,
    canonical,
    backupRequest,
    provisionRequest,
    proveBackup,
  };
}
