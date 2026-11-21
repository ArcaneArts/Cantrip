import { randomUUID } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cantripOsPackageCatalogResultSchema,
  type CantripOsPackageOperationCommand,
} from "@cantrip/protocol";
import {
  packageAcceptance,
  waitFor,
} from "./fixtures/os-package-acceptance.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_PACKAGE_TRANSPORT &&
  process.env.CANTRIP_OS_TEST_PACKAGE_DEB,
);
describe.skipIf(!enabled)(
  "actual Worker package admissions through Docker/SSH",
  () => {
    let f: Awaited<ReturnType<typeof packageAcceptance>>;
    let before: Record<string, unknown>;
    const evidence: Record<string, unknown> = {};
    let original: CantripOsPackageOperationCommand;
    beforeAll(async () => {
      f = await packageAcceptance();
      original = f.command();
      await f.result(original);
      const result = await f.finish(original);
      expect(result.state).toBe("ready");
      before = await f.admin(
        "prepare",
        `/var/lib/cantrip-os-executor/package-operations/${original.operationId}/${f.good.sha256}.deb`,
      );
      evidence.fixture = {
        directory: f.directory,
        guestRoot: f.root,
        scope: f.scope,
        target: f.inventory.target,
        artifact: f.good,
        original: original.operationId,
      };
      console.log(`Package acceptance: ${f.directory}`);
    }, 120_000);
    afterAll(async () => {
      if (!f || !before) return;
      const normal = f.command(f.good, "repair");
      await f.result(normal);
      const repaired = await f.finish(normal);
      expect(repaired.state).toBe("ready");
      await f.admin("cleanup");
      const final = await f.admin("inspect");
      f.unchanged(before, final);
      evidence.final = { repair: normal.operationId, snapshot: final };
      await f.writeEvidence(evidence);
    }, 120_000);

    it("repairs actual broken helpers with encrypted diagnostics and retained root/workspace customization", async () => {
      const bad = f.command(await f.publish("bad"));
      await f.result(bad);
      const failed = await f.finish(bad);
      expect(failed.state).toBe("failed");
      expect(JSON.stringify(failed)).not.toMatch(
        /Traceback|\/private\/|\/var\/lib\//,
      );
      const privateFailure = await f.privateResult(bad, failed);
      expect(privateFailure.record?.diagnostics).toContain("79");
      const broken = await f.admin("probe", bad.operationId);
      expect(broken.helpers.every((code: number) => code !== 0)).toBe(true);
      expect(broken.naiveExit).not.toBe(0);
      const repair = f.command(f.good, "repair");
      await f.result(repair);
      const result = await f.finish(repair);
      expect(result.state).toBe("ready");
      const actual = await f.admin("inspect");
      expect(actual.configSha256).toBe(actual.customSha256);
      f.unchanged(before, actual);
      const effects = [...f.effects];
      expect((await f.result(bad)).state).toBe("failed");
      expect(f.effects).toEqual(effects);
      expect(
        (await f.result(repair, "observe", f.manager())).protectedResult,
      ).toEqual(result.protectedResult);
      expect(actual.counters.bad).toHaveLength(1);
      evidence.brokenRepair = {
        failed: bad.operationId,
        repair: repair.operationId,
        privateFailure,
        outcome: await f.privateResult(repair, result),
      };
    }, 120_000);

    it("keeps package administration usable with a broken executor CLI and no live execution epoch", async () => {
      expect(f.scope).not.toHaveProperty("runtimeGeneration");
      const broken = await f.admin("executor-break");
      expect(broken.exitCode).toBe(76);
      try {
        const manager = f.manager();
        const inventory = await manager.handle({
          type: "cantrip-os.packages.status",
          scope: f.scope,
          transport: f.transport,
          target: f.inventory.target,
        });
        expect(inventory).toHaveProperty("available");
        const request = f.command(f.good, "repair");
        await f.result(request);
        const completed = await f.finish(request);
        expect(completed.state).toBe("ready");
        evidence.brokenExecutor = {
          operationId: request.operationId,
          outcome: await f.privateResult(request, completed),
        };
      } finally {
        expect((await f.admin("executor-restore")).exitCode).toBe(0);
      }
    }, 90_000);

    it("recovers an installer after actual Worker-manager process death without another dispatch", async () => {
      const request = f.command(await f.publish("slow"));
      const child = await f.child(request, "start");
      try {
        await waitFor(
          () => f.admin("inspect"),
          (value) => value.counters.slow.length === 1,
          "actual slow configure did not start",
        );
        const running = await f.guest(request);
        expect(running.installerActive).toBe(true);
        const saved = await f
          .manager()
          .operations.inspect(request.scope, request.operationId);
        expect(saved?.checkpoint).toMatchObject({ phase: "start-requested" });
        const stopped = await child.kill();
        expect(stopped).toMatchObject({ signal: "SIGKILL" });
        f.reobserve();
        const effects = [...f.effects];
        const completed = await f.finish(request);
        expect(completed.state).toBe("ready");
        expect(completed.startedAt).toBe(saved!.startedAt);
        expect(
          (await f.result(request, "observe", f.manager())).protectedResult,
        ).toEqual(completed.protectedResult);
        const actual = await f.privateResult(request, completed);
        expect(actual.record?.process).toEqual(running.process);
        expect(actual.record?.installer).toEqual(running.installer);
        expect(actual.record?.createdAt).toBe(running.createdAt);
        expect(f.effects).toEqual(effects);
        expect((await f.admin("inspect")).counters.slow).toHaveLength(1);
        expect(
          (await f.dispatches()).filter(
            (value) =>
              value.operationId === request.operationId &&
              value.action === "start",
          ),
        ).toHaveLength(1);
        evidence.workerDeath = {
          operationId: request.operationId,
          workerPid: child.process.pid,
          before: running,
          outcome: actual,
        };
      } finally {
        child.process.kill("SIGKILL");
      }
    }, 120_000);

    it("observes interrupted staging, continues explicitly and durably abandons a different staged installation", async () => {
      const request = f.command(await f.publish("staged"));
      const child = await f.child(request, "receive");
      await child.kill();
      f.reobserve();
      const beforeEffects = [...f.effects];
      const staged = await f.result(request, "observe");
      expect(staged).toMatchObject({
        state: "unknown",
        phase: "ready-to-install",
      });
      expect(f.effects).toEqual(beforeEffects);
      await f.result(request, "continue");
      expect((await f.finish(request)).state).toBe("ready");
      expect((await f.admin("inspect")).counters.staged).toHaveLength(1);
      expect(f.effects.slice(beforeEffects.length)).toEqual(["start"]);
      const abandoned = f.command(await f.publish("abandoned"));
      const other = await f.child(abandoned, "receive");
      await other.kill();
      f.reobserve();
      const stopped = await f.result(abandoned, "abandon");
      expect(stopped).toMatchObject({ state: "failed", phase: "abandoned" });
      expect(await f.guest(abandoned, "start")).toMatchObject({
        state: "failed",
        phase: "abandoned",
      });
      expect((await f.result(abandoned, "continue")).state).toBe("failed");
      expect((await f.admin("inspect")).counters.abandoned).toHaveLength(0);
      evidence.staging = {
        continued: request.operationId,
        abandoned: abandoned.operationId,
        outcome: await f.privateResult(abandoned, stopped),
      };
    }, 180_000);

    it("rejects actual foreign ownership and a stale init epoch before creating any guest job", async () => {
      const stale = f.command(f.good, "repair");
      stale.target = {
        ...stale.target,
        generation: randomUUID(),
        initStart: stale.target.initStart + "0",
      };
      const refused = await f.result(stale);
      expect(refused.state).toBe("unknown");
      expect((await f.privateResult(stale, refused)).diagnostic).toContain(
        "boot changed",
      );
      expect(await f.admin("record-exists", stale.operationId)).toEqual({
        exists: false,
      });
      const wrong = f.command(f.good, "repair");
      await f.admin(
        "identity-change",
        f.inventory.target.expected.identityPath,
      );
      let foreign;
      try {
        foreign = await f.result(wrong);
        expect(foreign.state).toBe("unknown");
        expect((await f.privateResult(wrong, foreign)).diagnostic).toContain(
          "owning attachment changed",
        );
        expect(await f.admin("record-exists", wrong.operationId)).toEqual({
          exists: false,
        });
      } finally {
        await f.admin("identity-restore");
      }
      f.unchanged(before, await f.admin("inspect"));
      evidence.identityRejection = {
        stale: stale.operationId,
        foreign: wrong.operationId,
        outcome: foreign,
      };
    }, 90_000);

    it("verifies a real identity relocation and never falls back past a valid foreign configured identity", async () => {
      const moved = await f.admin("identity-relocate");
      try {
        const observed = cantripOsPackageCatalogResultSchema.parse(
          await f.manager().handle({
            type: "cantrip-os.packages.status",
            scope: f.scope,
            transport: f.transport,
            target: f.inventory.target,
          }),
        );
        expect(observed.target.expected.identityPath).toBe(moved.identityPath);
        expect(observed.target.generation).not.toBe(
          f.inventory.target.generation,
        );
        const request = f.command(f.good, "repair");
        request.target = observed.target;
        await f.result(request);
        const completed = await f.finish(request);
        expect(completed.state).toBe("ready");
        await f.admin("identity-change", moved.identityPath);
        try {
          const oldLocator = f.command(f.good, "repair");
          const rejected = await f.result(oldLocator);
          expect(rejected.state).toBe("unknown");
          expect(
            (await f.privateResult(oldLocator, rejected)).diagnostic,
          ).toContain("owning attachment changed");
          expect(
            await f.admin("record-exists", oldLocator.operationId),
          ).toEqual({ exists: false });
        } finally {
          await f.admin("identity-restore");
        }
        evidence.identityRelocation = {
          operationId: request.operationId,
          target: observed.target,
          outcome: await f.privateResult(request, completed),
        };
      } finally {
        await f.admin("identity-unrelocate");
      }
    }, 120_000);

    it("reconstructs an absent Worker receipt only by observing the exact original guest admission", async () => {
      const effects = [...f.effects];
      const replacementDirectory = path.join(
        f.directory,
        "replacement-worker-journal",
      );
      const replacement = f.manager(replacementDirectory);
      const recovered = await f.result(original, "observe", replacement);
      expect(recovered.state).toBe("ready");
      const proof = await f.privateResult(original, recovered);
      expect(proof.record?.request.operationId).toBe(original.operationId);
      expect(f.effects).toEqual(effects);
      await expect(
        stat(path.join(replacementDirectory, "cantrip-os-package-artifacts")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      evidence.missingWorkerJournal = {
        operationId: original.operationId,
        outcome: proof,
      };
    }, 60_000);
  },
);
