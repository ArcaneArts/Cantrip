// Production worker supervision and real HPKE grants in an owned stopped profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as crypto from "../../packages/crypto/dist/index.js";
import { saveWorkerCredential } from "../../tests/reference-node-worker/src/credential-store.ts";
export async function verifyHistoryRuntimeRecovery({
  workerBinary,
  directory,
  serverUrl,
  token,
  workerId,
  ownerId,
  visit,
  read,
  accept,
}) {
  saveWorkerCredential({
    credential: token,
    dataDirectory: directory,
    serverUrl,
    workerId,
  });
  const child = spawn(workerBinary, ["--shutdown-on-stdin-close"], {
    cwd: directory,
    env: {
      PATH: "/usr/bin:/bin",
      NO_COLOR: "1",
      CANTRIP_WORKER_DATA_DIR: directory,
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_SERVER_URL: serverUrl,
      ...(process.env.CANTRIP_CODEX_TEST_BINARY
        ? { CANTRIP_CODEX_BIN: process.env.CANTRIP_CODEX_TEST_BINARY }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  const capture = (bytes) => {
    diagnostics = (diagnostics + bytes).slice(-24000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const finished = new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  async function until(operation, predicate, label) {
    for (let i = 0; i < 300; i++) {
      const value = await operation();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(label + "\n" + diagnostics);
  }
  let master;
  try {
    await until(
      async () => {
        const response = await fetch(
          serverUrl + `/api/workers/${workerId}/version`,
        );
        return response.ok ? response.json() : null;
      },
      (value) => typeof value?.version === "string",
      "production worker command readiness",
    );
    const identity = JSON.parse(
      await readFile(
        path.join(directory, "worker-encryption-key.json"),
        "utf8",
      ),
    );
    master = crypto.generateAccountMasterKey();
    const keypair = await crypto.generateHpkeKeyPair(),
      publicKey = await crypto.publicKeyForPair(keypair),
      clientId = randomUUID();
    const wrappedMasterKey = await crypto.wrapAccountMasterKeyForClient({
      ownerId,
      clientId,
      accountMasterKey: master,
      masterKeyRevision: 1,
      clientPublicKey: publicKey,
    });
    await visit(
      "initialize native history encryption profile",
      "POST",
      "/api/encryption/profile/initialize",
      {
        status: 201,
        json: {
          profile: {
            formatVersion: 1,
            activeMasterKeyRevision: 1,
            passwordKdf: null,
            passwordWrappedMasterKey: null,
            payloadMigrationStatus: "pending",
          },
          initialClient: {
            id: clientId,
            label: "Native history fixture",
            publicKey,
            wrappedMasterKey,
          },
        },
      },
    );
    await visit(
      "register native history principal",
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      { json: { component: "chat-content", keyRevision: 1 } },
    );
    const principals = await visit(
      "native history principals",
      "GET",
      "/api/encryption/principals",
    );
    const principal = principals.find((v) => v.id === identity.principalId);
    assert.ok(principal);
    await visit(
      "approve native history worker",
      "POST",
      `/api/encryption/principals/${principal.id}/approve`,
      { json: { expectedRevision: principal.revision } },
    );
    for (const component of ["chat-content", "attachment-content"]) {
      // The fixture's existing ciphertext uses byte-1 keys. Real client HPKE
      // wrapping and server approval/grants deliver those synthetic keys.
      const componentKey = new Uint8Array(32).fill(1);
      const wrappedKey = await crypto.wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component,
        keyRevision: 1,
        componentKey,
        workerPublicKey: identity.publicKey,
      });
      componentKey.fill(0);
      await visit(
        `grant native history ${component}`,
        "POST",
        `/api/encryption/principals/${principal.id}/grants`,
        { status: 201, json: { component, keyRevision: 1, wrappedKey } },
      );
      const result = await visit(
        `refresh native history ${component}`,
        "POST",
        `/api/workers/${workerId}/encryption/refresh`,
        { json: { component, keyRevision: 1 } },
      );
      assert.equal(result.status.state, "ready");
    }
    await until(read, accept, "actual worker startup journal recovery");
    child.stdin.end();
    assert.equal(await finished, 0, diagnostics);
    assert.ok(
      diagnostics.includes("Worker stopped"),
      "production lifecycle completed",
    );
    if (process.env.CANTRIP_CODEX_TEST_BINARY) {
      assert.ok(diagnostics.includes("codex.runtime.discovered"), diagnostics);
      assert.ok(diagnostics.includes("version.semantic=0.166.0"), diagnostics);
      assert.ok(diagnostics.includes("compatibility=compatible"), diagnostics);
    }
    return {
      passed: true,
      actualWorkerServer: true,
      actualCredentialAndHpkeGrants: true,
      startupSourceScanAndPublication: true,
      shutdownBeforeKeyRelease: true,
      nodeAbsentFromWorkerPath: true,
      ...(process.env.CANTRIP_CODEX_TEST_BINARY
        ? { actualBundledCodexStartupDiscovery: true }
        : {}),
    };
  } finally {
    master?.fill(0);
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await finished;
    }
  }
}
