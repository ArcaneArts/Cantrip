import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cantripOsOperationResultSchema } from "@cantrip/protocol";
import { CantripOsController } from "../src/os-executor/controller.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { runGuestProcess } from "../src/os-executor/process.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)("real existing Linux source adoption", () => {
  it(
    "preserves restored bytes and Git state, recovers its saved identity and creates worktrees from the actual registered Primary",
    { timeout: 180_000 },
    async () => {
      const transport: OsExecutorTransport = process.env
        .CANTRIP_OS_TEST_TRANSPORT
        ? JSON.parse(
            await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
          )
        : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
      const ownerId = "00000000-0000-4000-8000-000000000001",
        workerId = "00000000-0000-4000-8000-000000000002";
      const status = await executorControl<{
        attachment: { owner_id: string; worker_id: string } | null;
      }>(transport, ["status"]);
      expect(status.attachment).toEqual({
        owner_id: ownerId,
        worker_id: workerId,
      });
      const directory = await mkdtemp(
        path.join(tmpdir(), "cantrip-existing-source-"),
      );
      const controller = new CantripOsController(directory, workerId);
      const observed = (await controller.handle({
        type: "cantrip-os.inspect",
        ownerId,
        workerId,
        transport,
      })) as { guestInstanceId: string; runtimeGeneration: string };
      const scope = {
        ownerId,
        workerId,
        serverId: "existing-source-fixture",
        instanceId: randomUUID(),
        guestInstanceId: observed.guestInstanceId,
        attachmentGeneration: randomUUID(),
        runtimeGeneration: observed.runtimeGeneration,
      };
      const guestWorkspaceId = `existing-${randomUUID().slice(0, 12)}`;
      const profile = cantripOsOperationResultSchema.parse(
        await controller.handle({
          type: "cantrip-os.workspaces.create",
          scope,
          transport,
          operationId: randomUUID(),
          guestWorkspaceId,
        }),
      );
      if (profile.state !== "ready" || profile.receipt.kind !== "workspace")
        throw new Error("Workspace creation did not complete.");
      const account = profile.receipt.workspace;
      const binding = await executorControl<OsExecutorBinding>(transport, [
        "open",
        guestWorkspaceId,
      ]);
      const connection = new OsExecutorConnection(transport, binding);
      await connection.request("initialize", {
        clientName: "existing-source-acceptance",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      const guestPath = `${account.homeGuestPath}/restored checkout 日本語 `;
      const command = async (argv: string[], cwd = account.homeGuestPath) => {
        const result = await runGuestProcess(connection, argv, cwd);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.outputTruncated).toBe(false);
        return result.stdout.trim();
      };
      try {
        await command([
          "python3",
          "-c",
          `
from pathlib import Path
import subprocess,sys
p=Path(sys.argv[1]);p.mkdir()
(p/'tracked.txt').write_text('committed\\n');(p/'.gitignore').write_text('ignored.bin\\n')
subprocess.run(['git','init','-q',str(p)],check=True)
subprocess.run(['git','-C',str(p),'add','.'],check=True)
subprocess.run(['git','-C',str(p),'-c','user.name=QA','-c','user.email=qa@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture'],check=True)
(p/'tracked.txt').write_text('dirty restored bytes\\n');(p/'untracked-日本語.txt').write_text('untracked\\n')
(p/'ignored.bin').write_bytes(bytes(range(256)));(p/'subdirectory').mkdir()
(p.parent/'source-alias').symlink_to(p,target_is_directory=True)
`,
          guestPath,
        ]);
        const digest = () =>
          command([
            "python3",
            "-c",
            `
from pathlib import Path
import hashlib,sys
p=Path(sys.argv[1]);d=hashlib.sha256()
for f in sorted(p.rglob('*')):
 if f.is_file():d.update(str(f.relative_to(p)).encode());d.update(f.read_bytes());d.update(str(f.stat().st_mode).encode())
print(d.hexdigest())
`,
            guestPath,
          ]);
        const before = await digest();
        const sourceScope = {
          ...scope,
          projectId: randomUUID(),
          projectSourceId: randomUUID(),
          worktreeId: randomUUID(),
          bindingId: randomUUID(),
          bindingGeneration: randomUUID(),
          workspaceId: randomUUID(),
          guestWorkspaceId,
          ...account,
          guestPath,
          primaryGuestPath: guestPath,
          sourceKind: "git" as const,
          mode: "linux-owned" as const,
          linkedWorkerPath: null,
          dependencyOverlays: [],
        };
        const admission = {
          type: "cantrip-os.source.provision" as const,
          scope: sourceScope,
          transport,
          operationId: randomUUID(),
          intent: {
            mode: "linux-owned" as const,
            source: { kind: "existing" as const, sourceKind: "git" as const },
          },
        };
        const source = cantripOsOperationResultSchema.parse(
          await controller.handle(admission),
        );
        expect(source.state, JSON.stringify(source)).toBe("ready");
        if (source.state !== "ready" || source.receipt.kind !== "source")
          throw new Error("Existing source was not verified.");
        expect(source.receipt.source.guestPath).toBe(guestPath);
        expect(source.receipt.source.uid).toBe(account.uid);
        expect(source.receipt.source.repositoryFingerprint).toBeTruthy();
        expect(await digest()).toBe(before);
        expect(
          await new CantripOsController(directory, workerId).handle(admission),
        ).toEqual(source);
        expect(await digest()).toBe(before);
        for (const invalidPath of [
          `${guestPath}/subdirectory`,
          `${account.homeGuestPath}/source-alias`,
        ]) {
          const rejected = cantripOsOperationResultSchema.parse(
            await controller.handle({
              ...admission,
              operationId: randomUUID(),
              scope: {
                ...sourceScope,
                bindingId: randomUUID(),
                guestPath: invalidPath,
                primaryGuestPath: invalidPath,
              },
            }),
          );
          expect(rejected.state).toBe("failed");
        }
        expect(await digest()).toBe(before);
        const worktreeId = randomUUID();
        const worktree = cantripOsOperationResultSchema.parse(
          await controller.handle({
            ...admission,
            operationId: randomUUID(),
            scope: {
              ...sourceScope,
              bindingId: randomUUID(),
              bindingGeneration: randomUUID(),
              worktreeId,
              guestPath: `${account.homeGuestPath}/worktrees/${worktreeId}`,
              repositoryFingerprint:
                source.receipt.source.repositoryFingerprint,
            },
            intent: {
              mode: "linux-owned",
              source: {
                kind: "git-worktree",
                revision: source.receipt.source.head!,
                branch: `existing-${worktreeId}`,
              },
            },
          }),
        );
        expect(worktree.state, JSON.stringify(worktree)).toBe("ready");
        expect(
          await command([
            "python3",
            "-c",
            "from pathlib import Path;import sys;assert (Path(sys.argv[1])/'tracked.txt').read_text()=='dirty restored bytes\\n';assert (Path(sys.argv[1])/'ignored.bin').read_bytes()==bytes(range(256));print('preserved')",
            guestPath,
          ]),
        ).toBe("preserved");
        const artifacts = new URL(
          "../../cantrip_os/artifacts/phase5-restored-sources/",
          import.meta.url,
        );
        await mkdir(artifacts, { recursive: true });
        await writeFile(
          new URL(
            `existing-${transport.kind}-${sourceScope.projectSourceId}.json`,
            artifacts,
          ),
          JSON.stringify(
            {
              transportKind: transport.kind,
              workspace: account,
              source,
              worktree,
              beforeAdoptionDigest: before,
              verificationPreservedBytes: true,
              controllerRestartRecoveredSameAdmission: true,
              fullWorkerProductAcceptance: false,
            },
            null,
            2,
          ),
        );
      } finally {
        await connection.close();
        await executorControl(transport, ["close", guestWorkspaceId]);
      }
    },
  );
});
