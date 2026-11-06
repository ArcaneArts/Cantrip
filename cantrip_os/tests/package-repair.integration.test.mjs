import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  packageControl,
  packageJobSource,
  rootGuestCommand,
  PackageCarrierError,
} from "../host/index.mjs";

const transportFile = process.env.CANTRIP_OS_TEST_PACKAGE_TRANSPORT;
const artifactFile = process.env.CANTRIP_OS_TEST_PACKAGE_DEB;
const state = "/var/lib/cantrip-os-executor/package-operations";
const fixture = await readFile(
  new URL("./package-repair-fixture.py", import.meta.url),
  "utf8",
);

function execute(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => (stdout += value));
    child.stderr.setEncoding("utf8").on("data", (value) => (stderr += value));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(Object.assign(new Error(stderr), { exitCode: code }));
    });
  });
}

test(
  "actual package failure, external rescue, conffiles and detached installation without replay",
  {
    skip: !transportFile || !artifactFile,
    timeout: 300_000,
  },
  async (t) => {
    const transport = JSON.parse(await readFile(transportFile, "utf8"));
    const bytes = await readFile(artifactFile);
    const good = {
      name: "cantrip-os-recovery",
      version: "0.4.0",
      architecture: "all",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const root = `/tmp/cantrip-package-${randomUUID()}`;
    const admin = (action, ...args) => {
      const invoke = () =>
        execute(
          rootGuestCommand(transport, "/usr/bin/python3", [
            "-c",
            fixture,
            action,
            root,
            ...args,
          ]),
        );
      return ["inspect", "carrier", "saved"].includes(action)
        ? until(invoke, () => true, "guest fixture observation unavailable")
        : invoke();
    };
    const request = (
      pkg = good,
      action = "upgrade",
      configuration = "preserve",
    ) => ({
      version: 1,
      operationId: randomUUID(),
      scopeKey: createHash("sha256").update(root).digest("hex"),
      action,
      configuration,
      packages: [pkg],
    });
    const control = (...args) =>
      args[0] === "inspect"
        ? until(
            () => packageControl(transport, args),
            () => true,
            "original package observation unavailable",
          )
        : packageControl(transport, args);
    async function stage(input, content = bytes) {
      const admitted = await control("admit", JSON.stringify(input));
      assert.deepEqual(admitted.request, input);
      await packageControl(
        transport,
        ["receive", input.operationId, input.packages[0].sha256],
        { input: Readable.from(content) },
      );
    }
    async function until(action, predicate, message) {
      const deadline = Date.now() + 90_000;
      let value;
      let lastError;
      do {
        try {
          value = await action();
          if (predicate(value)) return value;
          lastError = undefined;
        } catch (error) {
          // Only observation reaches this helper. A transient SSH read failure
          // never authorizes another admit/upload/start or a new operation ID.
          if (!(error instanceof PackageCarrierError) && error.exitCode !== 255)
            throw error;
          lastError = error;
        }
        await delay(150);
      } while (Date.now() < deadline);
      assert.fail(`${message}: ${lastError?.message ?? JSON.stringify(value)}`);
    }
    const finish = (input) =>
      until(
        () => control("inspect", input.operationId),
        (value) => ["ready", "failed"].includes(value.state),
        "no committed package result",
      );
    const normal = request();
    await stage(normal);
    // Repeated artifact delivery is safe staging of exactly the admitted bytes.
    await packageControl(
      transport,
      ["receive", normal.operationId, good.sha256],
      { input: Readable.from(bytes) },
    );
    await control("start", normal.operationId);
    assert.equal((await finish(normal)).state, "ready");
    const before = await admin(
      "prepare",
      `${state}/${normal.operationId}/${good.sha256}.deb`,
    );
    t.after(async () => {
      await admin("cleanup");
    });
    t.diagnostic(
      `fixture=${root} normal=${normal.operationId} sha256=${good.sha256}`,
    );

    await t.test(
      "corrupt delivery and wrong Debian metadata never reach installation or change admission",
      async () => {
        const input = request();
        await control("admit", JSON.stringify(input));
        const corrupt = Buffer.from(bytes);
        corrupt[0] ^= 255;
        await assert.rejects(
          packageControl(
            transport,
            ["receive", input.operationId, good.sha256],
            { input: Readable.from(corrupt) },
          ),
          /checksum differs/,
        );
        const staged = await control("inspect", input.operationId);
        assert.equal(staged.state, "staged");
        assert.deepEqual(staged.received, []);
        assert.equal(staged.process, null);
        await stage(input);
        await control("start", input.operationId);
        assert.equal((await finish(input)).state, "ready");
        const wrong = request({ ...good, version: "0.4.999" });
        await control("admit", JSON.stringify(wrong));
        await assert.rejects(
          packageControl(
            transport,
            ["receive", wrong.operationId, good.sha256],
            { input: Readable.from(bytes) },
          ),
          /differs from its admitted/,
        );
        assert.equal(
          (await control("inspect", wrong.operationId)).phase,
          "admitted",
        );
        await assert.rejects(
          control("admit", JSON.stringify({ ...wrong, packages: [good] })),
          /different package admission/,
        );
      },
    );

    await t.test(
      "failed real upgrade breaks both helpers; normal reinstall fails; explicit repair retains configuration and files",
      async () => {
        const bad = await admin("build", "bad");
        const input = request(bad.package);
        await stage(input, Buffer.from(bad.archive, "base64"));
        await control("start", input.operationId);
        const failed = await finish(input);
        assert.equal(failed.state, "failed");
        assert.notEqual(failed.receipt.exitCode, 0);
        const broken = await admin("probe", input.operationId);
        assert.ok(broken.helpers.every((code) => code !== 0));
        assert.notEqual(broken.naiveExit, 0);
        assert.match(
          broken.naiveDiagnostic,
          /deliberately broken installed helper/,
        );
        const repair = request(good, "repair");
        await stage(repair);
        await control("start", repair.operationId);
        const repaired = await finish(repair);
        assert.equal(repaired.state, "ready", repaired.diagnostics);
        assert.equal(repaired.receipt.configurationPolicy, "preserve");
        assert.ok(
          repaired.repaired.some(
            (entry) =>
              entry.path.endsWith("/main.py") && entry.retainedOriginal,
          ),
        );
        const actual = await admin("inspect");
        assert.equal(actual.configSha256, actual.customSha256);
        assert.deepEqual(
          Object.fromEntries(
            Object.keys(before).map((key) => [key, actual[key]]),
          ),
          before,
        );
        assert.equal(actual.counters.bad.length, 1);
        assert.deepEqual(
          (await control("start", input.operationId)).receipt,
          failed.receipt,
        );
        await assert.rejects(
          control("admit", JSON.stringify({ ...input, action: "repair" })),
          /different package admission/,
        );
        t.diagnostic(
          `failed=${input.operationId} repaired=${repair.operationId}`,
        );
      },
    );

    await t.test(
      "package defaults require explicit repair and retain the exact invalid customization",
      async () => {
        const invalid = await admin("corrupt-config");
        const preserve = request(good, "repair");
        await stage(preserve);
        await control("start", preserve.operationId);
        assert.equal((await finish(preserve)).state, "failed");
        assert.equal((await admin("inspect")).configSha256, invalid.sha256);
        const replace = request(good, "repair", "package-defaults");
        await stage(replace);
        await control("start", replace.operationId);
        const result = await finish(replace);
        assert.equal(result.state, "ready", result.diagnostics);
        const actual = await admin("inspect");
        assert.equal(actual.configSha256, actual.defaultSha256);
        const original = await admin(
          "saved",
          `${state}/${replace.operationId}/record.json`,
        );
        assert.equal(original.beforeSha256, invalid.sha256);
        assert.equal(original.retainedSha256, invalid.sha256);
        t.diagnostic(
          `preserve-failed=${preserve.operationId} defaults-repair=${replace.operationId}`,
        );
      },
    );

    await t.test(
      "actual live maintenance lock also fences Debian's failed-upgrade fallback",
      async () => {
        const holder = await admin("maintenance");
        const input = request();
        try {
          await stage(input);
          await control("start", input.operationId);
          const failed = await finish(input);
          assert.equal(failed.state, "failed");
          assert.notEqual(failed.receipt.exitCode, 0);
          assert.match(
            failed.diagnostics,
            /BlockingIOError|temporarily unavailable/,
          );
          assert.equal(
            (await admin("inspect")).helperSha256,
            before.helperSha256,
          );
          const rescue = request(good, "repair");
          await stage(rescue);
          await control("start", rescue.operationId);
          const refused = await finish(rescue);
          assert.equal(refused.state, "failed");
          assert.equal(refused.repaired, undefined);
          assert.match(
            refused.error,
            /BlockingIOError|temporarily unavailable/,
          );
        } finally {
          await admin("kill", JSON.stringify(holder));
        }
        assert.equal(
          (await control("start", input.operationId)).state,
          "failed",
        );
        const next = request();
        await stage(next);
        await control("start", next.operationId);
        assert.equal((await finish(next)).state, "ready");
        t.diagnostic(
          `maintenance-refused=${input.operationId} explicit-next=${next.operationId}`,
        );
      },
    );

    await t.test(
      "lost actual start carrier while dpkg runs preserves one detached installer and its outcome",
      async () => {
        const slow = await admin("build", "slow");
        const input = request(slow.package);
        await stage(input, Buffer.from(slow.archive, "base64"));
        const source = await packageJobSource();
        // Hold only the test carrier's response after the real production start.
        // The unmodified package runner forks the actual detached installer.
        const code = `namespace={'__name__':'acceptance'}\nexec(${JSON.stringify(source)},namespace)\nnamespace['os'].umask(0o077)\nnamespace['write_json'](namespace['Path'](${JSON.stringify(root + "/carrier.json")}),namespace['process_identity'](namespace['os'].getpid()))\nstore=namespace['Store'](${JSON.stringify(state)})\nstore.start(${JSON.stringify(input.operationId)})\nprint('ACCEPTANCE_CARRIER_ADMITTED',flush=True)\nnamespace['time'].sleep(60)\n`;
        const command = rootGuestCommand(transport, "/usr/bin/python3", [
          "-c",
          code,
        ]);
        const carrier = spawn(command.command, command.args, {
          stdio: "pipe",
        });
        carrier.stdin.end();
        let carrierError = "";
        carrier.stderr.setEncoding("utf8").on("data", (value) => {
          carrierError = (carrierError + value).slice(-8192);
        });
        const ended = new Promise((resolve, reject) => {
          carrier.once("error", reject);
          carrier.once("close", resolve);
        });
        void ended.catch(() => {});
        const admitted = new Promise((resolve, reject) => {
          let output = "";
          carrier.stdout.setEncoding("utf8").on("data", (value) => {
            output += value;
            if (output.includes("ACCEPTANCE_CARRIER_ADMITTED")) resolve();
          });
          carrier.once("error", reject);
          carrier.once("close", () =>
            reject(
              new Error(
                carrierError || "Start carrier closed before its guest barrier",
              ),
            ),
          );
        });
        try {
          // Observe actual guest admission before opening a second SSH
          // connection. The final package outcome remains withheld.
          await admitted;
          await until(
            () => {
              assert.equal(carrier.exitCode, null, carrierError);
              return admin("inspect");
            },
            (value) => value.counters.slow.length === 1,
            "postinst never started",
          );
          const running = await control("inspect", input.operationId);
          assert.equal(running.state, "running");
          assert.equal(running.installerActive, true);
          carrier.kill("SIGKILL");
          await ended;
          const guestCarrier = await admin("carrier");
          if (guestCarrier.active)
            await admin("kill", JSON.stringify(guestCarrier.identity));
          const original = await control("start", input.operationId);
          assert.deepEqual(original.process, running.process);
          assert.deepEqual(original.installer, running.installer);
          const result = await finish(input);
          assert.equal(result.state, "ready", result.diagnostics);
          assert.equal((await admin("inspect")).counters.slow.length, 1);
          assert.deepEqual(
            (await control("start", input.operationId)).receipt,
            result.receipt,
          );
          t.diagnostic(
            `carrier-lost=${input.operationId} installer=${running.installer.pid}`,
          );
        } finally {
          carrier.kill("SIGKILL");
        }
      },
    );

    await t.test(
      "coordinator death leaves a running installer observable and never infers success or repeats dpkg",
      async () => {
        const orphan = await admin("build", "orphan");
        const input = request(orphan.package);
        await stage(input, Buffer.from(orphan.archive, "base64"));
        await control("start", input.operationId);
        await until(
          () => admin("inspect"),
          (value) => value.counters.orphan.length === 1,
          "orphan postinst never started",
        );
        const running = await control("inspect", input.operationId);
        assert.equal(running.installerActive, true);
        await admin("kill", JSON.stringify(running.process));
        const unknown = await control("start", input.operationId);
        assert.equal(unknown.state, "unknown");
        assert.equal(unknown.installerActive, true);
        try {
          const blocked = request(good, "repair");
          await stage(blocked);
          await control("start", blocked.operationId);
          const refused = await finish(blocked);
          assert.equal(refused.state, "failed");
          assert.equal(refused.receipt, null);
          assert.match(
            refused.error,
            /BlockingIOError|temporarily unavailable/,
          );
          assert.equal(refused.repaired, undefined);
        } finally {
          await admin("release");
        }
        const ended = await until(
          () => control("inspect", input.operationId),
          (value) => !value.installerActive,
          "orphan dpkg never ended",
        );
        assert.equal(ended.state, "unknown");
        assert.equal(ended.receipt, null);
        assert.equal((await admin("inspect")).counters.orphan.length, 1);
        assert.equal(
          (await control("start", input.operationId)).state,
          "unknown",
        );
        const repair = request(good, "repair");
        await stage(repair);
        await control("start", repair.operationId);
        assert.equal((await finish(repair)).state, "ready");
        const actual = await admin("inspect");
        assert.deepEqual(
          Object.fromEntries(
            Object.keys(before).map((key) => [key, actual[key]]),
          ),
          before,
        );
        t.diagnostic(
          `coordinator-lost=${input.operationId} explicit-repair=${repair.operationId}`,
        );
        assert.equal(
          (
            await execute(
              rootGuestCommand(transport, "/usr/bin/cantrip-package", [
                "inspect",
                repair.operationId,
              ]),
            )
          ).state,
          "ready",
        );
        assert.equal(
          (
            await execute(
              rootGuestCommand(transport, "/usr/bin/cantrip-package", [
                "inspect",
                input.operationId,
              ]),
            )
          ).state,
          "unknown",
        );
      },
    );
  },
);
