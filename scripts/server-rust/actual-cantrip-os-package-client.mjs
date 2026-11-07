import assert from "node:assert/strict";
import { eventually } from "./full-worker.mjs";

export async function actualCantripOsPackageClient({
  page,
  call,
  os,
  guest,
  record,
  instance,
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
