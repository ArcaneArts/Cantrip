import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  repositoryOperationRequestContentSchema,
  repositoryOperationOutcomeContentSchema,
} from "../../packages/protocol/dist/index.js";
import {
  openWorkerRepositoryOperationContent,
  protectWorkerRepositoryOperationContent,
} from "../../cantrip_worker/src/repository-operation-encryption.ts";
import {
  settingsWorker as worker,
  settingsProject as project,
  settingsTree as tree,
} from "./native-settings-http-fixture.mjs";

const fingerprint = (value) =>
  value?.algorithm === "AES-256-GCM"
    ? JSON.stringify([
        value.version,
        value.algorithm,
        value.keyRevision,
        value.nonce,
        value.ciphertext,
      ])
    : null;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const repositoryCommandPrivateMarker =
  "Private repository request and outcome 日本語 🌳";

export function repositoryCommandRelay(result) {
  const pending = new Map(),
    envelopes = new Map();
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const known = envelopes.get(fingerprint(value));
      if (known) return "<verified repository envelope:" + known + ">";
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  }
  async function prepare(h, sample, operationId, workerScope) {
    const context = {
      serverId: h.serverId,
      projectId: workerScope ? "worker-repository-scope" : project,
      worktreeId: workerScope ? worker : tree,
      operationId,
      direction: "request",
    };
    const content = {
      type: sample.type,
      arguments: {
        ...sample.arguments,
        privateMarker: repositoryCommandPrivateMarker,
      },
    };
    const protectedRequest = await protectWorkerRepositoryOperationContent({
      service: h.encryption,
      context,
      content,
      schema: repositoryOperationRequestContentSchema,
    });
    const name =
      (workerScope ? "worker " : "project ") + sample.type + " " + operationId;
    envelopes.set(fingerprint(protectedRequest.envelope), name + " request");
    pending.set(operationId, {
      context,
      content,
      protectedRequest,
      name,
      workerScope,
      service: h.encryption,
      replies: [],
    });
    return {
      operationId,
      protectedRequest,
      ...(workerScope ? { scopeId: context.projectId } : {}),
    };
  }
  async function onCommand(command, _emit, { encryption }) {
    if (/^(git|github)\./.test(command.type)) {
      result.plaintextCommands.push(command);
      throw new Error("Unexpected plaintext Git/GitHub server producer");
    }
    if (command.type !== "repository.operation") return;
    const expected = pending.get(command.operationId);
    assert.ok(
      expected,
      "each actual server command has its original endpoint request",
    );
    assert.equal(command.serverId, expected.context.serverId);
    assert.equal(command.projectId, expected.context.projectId);
    assert.equal(command.worktreeId, expected.context.worktreeId);
    assert.equal(
      command.cwd,
      expected.workerScope ? "." : "/worker-owned/settings",
    );
    assert.equal(
      command.sourcePath,
      expected.workerScope ? "." : "/worker-owned/settings",
    );
    assert.deepEqual(command.protectedRequest, expected.protectedRequest);
    const opened = await openWorkerRepositoryOperationContent({
      service: encryption,
      context: expected.context,
      opaque: command.protectedRequest,
      schema: repositoryOperationRequestContentSchema,
    });
    assert.deepEqual(opened, expected.content);
    result.cryptoProofs++;
    const outcome = {
      ok: true,
      result: {
        type: opened.type,
        privateMarker: repositoryCommandPrivateMarker,
        requestDigest: digest(opened),
      },
    };
    const protectedResponse = await protectWorkerRepositoryOperationContent({
      service: encryption,
      context: { ...expected.context, direction: "response" },
      content: outcome,
      schema: repositoryOperationOutcomeContentSchema,
    });
    envelopes.set(
      fingerprint(protectedResponse.envelope),
      expected.name + " response " + expected.replies.length,
    );
    expected.replies.push({ protectedResponse, outcome });
    result.rawCommands.push(structuredClone(command));
    return { operationId: command.operationId, protectedResponse };
  }
  async function proveResponse(h, response) {
    const expected = pending.get(response.operationId),
      reply = expected?.replies.at(-1);
    assert.ok(
      reply,
      "actual HTTP response has a worker-produced encrypted outcome",
    );
    assert.deepEqual(response.protectedResponse, reply.protectedResponse);
    const opened = await openWorkerRepositoryOperationContent({
      service: h.encryption,
      context: { ...expected.context, direction: "response" },
      opaque: response.protectedResponse,
      schema: repositoryOperationOutcomeContentSchema,
    });
    assert.deepEqual(opened, reply.outcome);
    result.cryptoProofs++;
    result.endpointProofs.push({
      context: expected.context,
      protectedRequest: expected.protectedRequest,
      protectedResponse: response.protectedResponse,
      type: expected.content.type,
    });
  }
  function finish(h) {
    const publicValues = JSON.stringify([...h.fixture.records.values()]);
    const diagnostics = JSON.stringify([
      h.diagnostics(),
      ...result.serverExits,
    ]);
    for (const marker of [
      repositoryCommandPrivateMarker,
      encodeURIComponent(repositoryCommandPrivateMarker),
    ]) {
      assert.equal(publicValues.includes(marker), false);
      assert.equal(diagnostics.includes(marker), false);
    }
    assert.deepEqual(result.plaintextCommands, []);
    result.commands = canonical(h.fixture.normalize(result.rawCommands));
    result.observations = canonical(result.observations);
  }
  return { prepare, onCommand, proveResponse, canonical, finish };
}
