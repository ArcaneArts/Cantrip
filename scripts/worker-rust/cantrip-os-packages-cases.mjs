import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { decryptCantripOsPackageResult } from "../../packages/crypto/dist/index.js";
import { registerBuiltPackage } from "../../cantrip_os/host/package-artifacts.mjs";
import { grantCantripOsFixture } from "./cantrip-os-grant.mjs";

export async function verifyCantripOsPackages({
  call,
  os,
  workerId,
  data,
  repositoryKey,
  serverId,
  file,
  catalog,
  guest,
  journalDir,
  eventually,
  restartWorker,
}) {
  const componentKey =
    repositoryKey ??
    (await grantCantripOsFixture(call, workerId, data, false, false)).get(
      "repository-content",
    );
  const artifact = (
    await registerBuiltPackage(
      file,
      {
        name: "cantrip-os-workspaces",
        version: "0.4.0",
        architecture: "all",
      },
      { directory: catalog },
    )
  ).artifact;
  const base = "/api/cantrip-os/" + os.id;
  const operations = base + "/package-operations";
  const cached = path.join(
    data,
    "cantrip-os-package-artifacts",
    artifact.sha256 + ".deb",
  );
  const changes = async () =>
    Number(
      await guest(
        "/usr/bin/python3",
        "-c",
        "from pathlib import Path;print(sum(' configure cantrip-os-workspaces:' in line for line in Path('/var/log/dpkg.log').read_text().splitlines()))",
      ),
    );
  const status = async () => {
    const value = await call("GET", base + "/packages");
    assert.ok(value.target, JSON.stringify(value));
    assert.deepEqual(value.available, [artifact]);
    return value.target;
  };
  const prepare = async (action) => {
    const target = await status();
    return {
      operationId: randomUUID(),
      attachmentGeneration: target.attachmentGeneration,
      targetGeneration: target.generation,
      action,
      configuration: "preserve",
      packages: [artifact],
    };
  };
  const route = (request) => operations + "/" + request.operationId;
  const observe = (request) => call("POST", route(request) + "/observe");
  const settle = async (request, initial, expected) => {
    const value = ["ready", "failed"].includes(initial.state)
      ? initial
      : await eventually(async () => {
          const observed = await observe(request);
          assert.ok(
            ["ready", "failed"].includes(observed.state),
            JSON.stringify(observed),
          );
          return observed;
        }, 90_000);
    assert.equal(value.state, expected, JSON.stringify(value));
    assert.ok(value.protectedResult);
    return value;
  };
  const open = (result) =>
    decryptCantripOsPackageResult({
      context: {
        ownerId: os.ownerId,
        serverId,
        workerId,
        instanceId: os.id,
        attachmentGeneration: result.attachmentGeneration,
        targetGeneration: result.targetGeneration,
        operationId: result.operationId,
      },
      keyRevision: 1,
      componentKey,
      envelope: result.protectedResult,
    });

  try {
    const initial = await status();
    assert.equal((await status()).generation, initial.generation);
    assert.deepEqual(await readFile(cached), await readFile(file));
    for (const action of ["upgrade", "repair"]) {
      if (action === "repair") {
        await guest("cantrip-executor", "disable");
        await guest("unlink", "/usr/bin/cantrip-workspaces");
      }
      const request = await prepare(action);
      const before = await changes();
      const complete = await settle(
        request,
        await call("POST", operations, request),
        "ready",
      );
      const opened = await open(complete);
      assert.equal(opened.record.request.operationId, request.operationId);
      assert.equal(opened.request.action, action);
      assert.equal(opened.record.state, "ready");
      assert.deepEqual(await call("POST", operations, request), complete);
      assert.deepEqual(await observe(request), complete);
      assert.equal(await changes(), before + 1);
      if (action === "repair") {
        assert.equal(
          JSON.parse(await guest("cantrip-executor", "status")).enabled,
          false,
        );
        assert.ok(
          JSON.parse(await guest("cantrip-workspaces", "list")).length >= 1,
        );
        await guest("cantrip-executor", "enable");
      }
    }

    for (const mode of ["continue", "abandon"]) {
      const request = await prepare("upgrade");
      const before = await changes();
      await unlink(cached);
      const start = await call("POST", operations, request);
      assert.equal(start.state, "unknown", JSON.stringify(start));
      const journal =
        "/var/lib/cantrip-os-executor/package-operations/" +
        request.operationId +
        "/record.json";
      const staged = JSON.parse(await guest("cat", journal));
      assert.equal(staged.state, "staged");
      assert.equal(staged.installer, null);
      assert.deepEqual(staged.received, []);
      const observed = await observe(request);
      assert.equal(observed.state, "unknown");
      assert.equal((await open(observed)).record.state, "staged");
      assert.deepEqual(JSON.parse(await guest("cat", journal)), staged);
      if (mode === "continue") {
        await restartWorker();
        const refreshed = await call(
          "POST",
          "/api/workers/" + workerId + "/encryption/refresh",
          {
            component: "repository-content",
            keyRevision: 1,
          },
        );
        assert.equal(refreshed.status.state, "ready");
        await status();
      }
      const control = {
        attachmentGeneration: request.attachmentGeneration,
        targetGeneration: request.targetGeneration,
      };
      const expected = mode === "continue" ? "ready" : "failed";
      const outcome = await settle(
        request,
        await call("POST", route(request) + "/" + mode, control),
        expected,
      );
      const opened = await open(outcome);
      assert.equal(opened.record.state, expected);
      assert.equal(
        outcome.phase,
        mode === "continue" ? "complete" : "abandoned",
      );
      const saved = JSON.parse(
        await readFile(
          path.join(journalDir, request.operationId + ".json"),
          "utf8",
        ),
      );
      const digest = (value) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      assert.equal(
        saved.admissionFingerprint,
        digest([saved.command, saved.checkpoint.command]),
      );
      assert.equal(
        saved.receipt.proofSha256,
        digest([saved.state, saved.checkpoint.guest, saved.error]),
      );
      assert.deepEqual(saved.receipt.protectedResult, outcome.protectedResult);
      assert.deepEqual(
        await call("POST", route(request) + "/continue", control),
        outcome,
      );
      assert.equal(await changes(), before + (mode === "continue" ? 1 : 0));
    }
  } finally {
    if (!repositoryKey) componentKey.fill(0);
  }
}
