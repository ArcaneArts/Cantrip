import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export async function actualCantripOsPackageClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
  dataDirectory,
  result,
  report,
}) {
  const packages = (method, ...args) =>
    call("api/cantrip-os-packages", method, ...args);
  const account = await call(
    "cantrip-os-package-draft",
    "cantripOsPackageAccountKey",
  );
  await packages("authorizeCantripOsPackageWorker", instance.workerId, account);
  const changes = async () =>
    Number(
      await guest.exec(
        "python3",
        "-c",
        "from pathlib import Path;print(sum(' configure cantrip-os-workspaces:' in line for line in Path('/var/log/dpkg.log').read_text().splitlines()))",
      ),
    );
  const initial = record(
    "package-status",
    await packages("getCantripOsPackages", instance, account),
  );
  assert.ok(initial.target, JSON.stringify(initial));
  assert.equal(initial.available.length, 2);
  const artifact = initial.available.find(
    (item) => item.name === "cantrip-os-workspaces",
  );
  assert.ok(artifact);
  const summaries = [];
  report.privatePackageOutcomes = [];
  for (const action of ["upgrade", "repair"]) {
    if (action === "repair") {
      await guest.exec("cantrip-executor", "disable");
      await guest.exec("rm", "/usr/bin/cantrip-workspaces");
    }
    const before = await changes();
    const status = await packages("getCantripOsPackages", instance, account);
    assert.ok(status.target, JSON.stringify(status));
    const draft = await call(
      "cantrip-os-package-draft",
      "prepareCantripOsPackageDraft",
      status.target,
      {
        action,
        configuration: "preserve",
        packages: [artifact],
      },
    );
    draft.submitted = true;
    await call("cantrip-os-package-draft", "saveCantripOsPackageDraft", draft);
    const admitted = await packages("submitCantripOsPackage", draft);
    const completed =
      admitted.state === "ready"
        ? admitted
        : await eventually(
            () => packages("observeCantripOsPackageDraft", draft),
            (value) =>
              assert.equal(value.state, "ready", JSON.stringify(value)),
          );
    record(`package-${action}`, completed);
    assert.ok(completed.protectedResult);
    const privateResult = await call(
      "cantrip-os-package-encryption",
      "openCantripOsPackageResult",
      completed,
    );
    assert.equal(privateResult.request.operationId, completed.operationId);
    assert.equal(privateResult.request.action, action);
    assert.equal(privateResult.record.state, "ready");
    report.privatePackageOutcomes.push(privateResult);
    assert.equal(
      await changes(),
      before + 1,
      "the actual dpkg configure runs exactly once",
    );
    const replay = record(
      `package-${action}-replayed`,
      await packages("submitCantripOsPackage", draft),
    );
    assert.deepEqual(replay, completed);
    const observed = record(
      `package-${action}-observed`,
      await packages("observeCantripOsPackageDraft", draft),
    );
    assert.deepEqual(observed, completed);
    assert.equal(
      await changes(),
      before + 1,
      "replay/observation cannot repeat dpkg configure",
    );
    summaries.push(completed);
    if (action === "repair") {
      assert.ok(
        JSON.parse(await guest.exec("cantrip-workspaces", "list")).some(
          (item) => item.id === "work",
        ),
      );
      assert.equal(
        JSON.parse(await guest.exec("cantrip-executor", "status")).enabled,
        false,
      );
      await guest.exec("cantrip-executor", "enable");
    }
  }

  // Leave a real guest admission staged by removing its disposable Worker
  // cache entry after catalogue verification and before any installer starts.
  for (const mode of ["continue", "abandon"]) {
    const status = await packages("getCantripOsPackages", instance, account);
    assert.ok(status.target, JSON.stringify(status));
    assert.deepEqual(
      status.available.find((entry) => entry.sha256 === artifact.sha256),
      artifact,
    );
    const draft = await call(
      "cantrip-os-package-draft",
      "prepareCantripOsPackageDraft",
      status.target,
      { action: "upgrade", configuration: "preserve", packages: [artifact] },
    );
    draft.submitted = true;
    await call("cantrip-os-package-draft", "saveCantripOsPackageDraft", draft);
    const before = await changes();
    await unlink(
      path.join(
        dataDirectory,
        "cantrip-os-package-artifacts",
        `${artifact.sha256}.deb`,
      ),
    );
    const unknown = await packages("submitCantripOsPackage", draft);
    assert.equal(unknown.state, "unknown", JSON.stringify(unknown));
    const journal = `/var/lib/cantrip-os-executor/package-operations/${unknown.operationId}/record.json`;
    const staged = JSON.parse(await guest.exec("cat", journal));
    assert.equal(staged.state, "staged");
    assert.deepEqual(staged.received, []);
    assert.equal(staged.installer, null);
    assert.equal(await changes(), before);
    const observed = record(
      `package-${mode}-staged`,
      await packages("observeCantripOsPackageOperation", unknown, account),
    );
    assert.equal(observed.state, "unknown");
    assert.deepEqual(JSON.parse(await guest.exec("cat", journal)), staged);
    if (mode === "continue") {
      const refreshed = await packages(
        "getCantripOsPackages",
        instance,
        account,
      );
      assert.deepEqual(
        refreshed.available.find((entry) => entry.sha256 === artifact.sha256),
        artifact,
      );
    }
    const controlled = await packages(
      "controlCantripOsPackageOperation",
      observed,
      mode,
      account,
    );
    const state = mode === "continue" ? "ready" : "failed";
    const outcome = record(
      `package-${mode}-completed`,
      controlled.state === state
        ? controlled
        : await eventually(
            () =>
              packages("observeCantripOsPackageOperation", controlled, account),
            (value) => assert.equal(value.state, state, JSON.stringify(value)),
          ),
    );
    assert.equal(outcome.phase, mode === "continue" ? "complete" : "abandoned");
    const opened = await call(
      "cantrip-os-package-encryption",
      "openCantripOsPackageResult",
      outcome,
    );
    assert.equal(opened.request.operationId, draft.request.operationId);
    assert.equal(opened.record.state, state);
    if (mode === "abandon") {
      assert.equal(opened.record.installer, null);
      assert.deepEqual(opened.record.received, []);
    }
    const replay = await packages(
      "controlCantripOsPackageOperation",
      outcome,
      "continue",
      account,
    );
    assert.deepEqual(replay, outcome);
    assert.equal(await changes(), before + (mode === "continue" ? 1 : 0));
    report.privatePackageOutcomes.push(opened);
    summaries.push(outcome);
  }
  result.steps.push(
    "observation leaves the real staged guest admission untouched; explicit continuation configures exactly once and abandonment permanently prevents installation",
  );
  record(
    "package-history",
    await packages(
      "getCantripOsPackageOperations",
      instance.id,
      undefined,
      account,
    ),
  );
  await eventually(
    async () => {
      try {
        return {
          value: await os("inspectCantripOs", {
            workerId: instance.workerId,
            transport: { kind: "docker", container: guest.name },
          }),
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    (value) => assert.ok(value.value, value.error),
  );
  const stale = await page.evaluate(async (instance) => {
    try {
      await (
        await import("/src/lib/api/cantrip-os.ts")
      ).recoverCantripOsInstance(instance);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, status: error.status };
    }
  }, instance);
  assert.deepEqual(stale, { accepted: false, status: 409 });
  const current = record(
    "package-invalidated-runtime",
    (await os("getCantripOsInstances")).find((item) => item.id === instance.id),
  );
  assert.equal(
    current.runtimeGeneration,
    null,
    "package admission revokes prior execution authority",
  );
  const recovered = record(
    "package-repaired-runtime",
    await os("recoverCantripOsInstance", current),
  );
  assert.equal(recovered.recovery.kind, "first-observation");
  assert.notEqual(
    recovered.instance.runtimeGeneration,
    instance.runtimeGeneration,
  );
  result.steps.push(
    "actual package upgrade and broken-helper repair run dpkg once per admission while executor is disabled; real browser decryption authenticates private outcomes and replay preserves exact ciphertext",
  );
  return { instance: recovered.instance, summaries };
}
