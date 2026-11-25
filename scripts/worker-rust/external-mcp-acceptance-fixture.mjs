import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  deriveComponentKey,
  generateAccountMasterKey,
  generateHpkeKeyPair,
  publicKeyForPair,
  wrapAccountMasterKeyForClient,
  wrapAccountMasterKeyWithPassword,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import { stageCodeGraph } from "./codegraph-smoke-cases.mjs";

const sdk = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
);

export async function connectStdio({
  binary,
  origin,
  directory,
  credential,
  suppressOperation,
  onSuppressed,
}) {
  const { Client } = await import(
    sdk.resolve("@modelcontextprotocol/sdk/client/index.js")
  );
  const { StdioClientTransport } = await import(
    sdk.resolve("@modelcontextprotocol/sdk/client/stdio.js")
  );
  const client = new Client({
    name: "cantrip-external-mcp-acceptance",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: path.resolve(binary),
    args: [
      "external-mcp",
      "--server",
      origin,
      ...(credential ? ["--credential-file", credential] : []),
    ],
    cwd: directory,
  });
  try {
    await client.connect(transport);
    if (suppressOperation) {
      const forward = transport.onmessage;
      transport.onmessage = (message) => {
        const result = message.result?.structuredContent;
        if (result?.operationId === suppressOperation) onSuppressed?.(result);
        else forward(message);
      };
    }
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function packagedServerArguments(packageRoot) {
  if (!packageRoot) return [];
  const root = path.resolve(packageRoot);
  const manifest = JSON.parse(
    await readFile(path.join(root, "native-server.json"), "utf8"),
  );
  return [
    "--bundled-pglite-runtime-dir=" + path.join(root, "pglite"),
    "--bundled-postgres-bin-dir=" + path.join(root, manifest.postgres.bin),
  ];
}

export async function stageFixtureCodegraph({
  distribution,
  directory,
  workerDirectory,
}) {
  if (!distribution) return undefined;
  const bin = path.join(directory, "codegraph-bin");
  await mkdir(bin);
  await stageCodeGraph({ distribution, root: directory, bin, workerDirectory });
  return path.join(directory, "codegraph-home");
}

export const protection = {
  classification: { recordKind: "project" },
  protectedLabel: {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: Buffer.alloc(12).toString("base64url"),
      ciphertext: Buffer.alloc(32).toString("base64url"),
    },
  },
};

export async function authorizeWorker({
  ownerVisit,
  workerId,
  ownerId,
  password,
  workload,
}) {
  const workerEncryption = "/api/workers/" + workerId + "/encryption/refresh";
  const refresh = (component = "repository-content") =>
    ownerVisit("POST", workerEncryption, 200, { component, keyRevision: 1 });
  const master = generateAccountMasterKey();
  try {
    const clientId = randomUUID();
    const publicKey = await publicKeyForPair(await generateHpkeKeyPair());
    const passwordWrappedMasterKey = password
      ? await wrapAccountMasterKeyWithPassword({
          password,
          ownerId,
          accountMasterKey: master,
          masterKeyRevision: 1,
        })
      : null;
    await ownerVisit("POST", "/api/encryption/profile/initialize", 201, {
      profile: {
        formatVersion: 1,
        activeMasterKeyRevision: 1,
        passwordKdf: passwordWrappedMasterKey?.kdf ?? null,
        passwordWrappedMasterKey,
        payloadMigrationStatus: "pending",
      },
      initialClient: {
        id: clientId,
        label: "MCP acceptance fixture",
        publicKey,
        wrappedMasterKey: await wrapAccountMasterKeyForClient({
          ownerId,
          clientId,
          accountMasterKey: master,
          masterKeyRevision: 1,
          clientPublicKey: publicKey,
        }),
      },
    });
    await refresh();
    const principals = await ownerVisit(
      "GET",
      "/api/encryption/principals",
      200,
    );
    const principal = principals.find((row) => row.workerId === workerId);
    assert.ok(principal);
    const route = "/api/encryption/principals/" + principal.id;
    await ownerVisit("POST", route + "/approve", 200, {
      expectedRevision: principal.revision,
    });
    const components = ["repository-content"];
    if (workload)
      components.push(
        "private-surface-metadata",
        "chat-content",
        "task-content",
        "run-content",
      );
    const keyRevision = 1;
    for (const component of components) {
      const key = deriveComponentKey({
        accountMasterKey: master,
        ownerId,
        component,
        keyRevision,
      });
      try {
        await ownerVisit("POST", route + "/grants", 201, {
          component,
          keyRevision,
          wrappedKey: await wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            keyRevision,
            componentKey: key,
            workerPublicKey: principal.publicKey,
          }),
        });
      } finally {
        key.fill(0);
      }
      assert.equal((await refresh(component)).status.state, "ready");
    }
  } finally {
    master.fill(0);
  }
}

export async function eventually(test) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      return await test();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(200);
    }
  }
}
