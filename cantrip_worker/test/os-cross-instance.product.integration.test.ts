import { execFile } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  openAnonymousRecoveryArtifact,
  deriveComponentKey,
  clearSensitiveBytes,
  encryptCantripOsBackupMessage,
  decryptCantripOsBackupMessage,
  encryptPrivateDisplayLabel,
  encryptRepositoryOperationPayload,
} from "@cantrip/crypto";
import {
  cantripOsObservedInstanceSchema,
  cantripOsInstanceSummarySchema,
  cantripOsWorkspaceSummarySchema,
  cantripOsBackupSummarySchema,
  cantripOsBackupPrivateResultSchema,
  cantripOsBackupPrivateRequestSchema,
  cantripOsSourceBindingSummarySchema,
  type CantripOsInstanceSummary,
} from "@cantrip/protocol";
import type { EncryptionComponentScope } from "@cantrip/protocol/encryption";
import { backupFile } from "../src/os-executor/backup-context.js";
import type { OsExecutorBinding } from "../src/os-executor/connection.js";

const origin = process.env.CANTRIP_OS_PRODUCT_TEST_ORIGIN;
const recovery = process.env.CANTRIP_OS_PRODUCT_TEST_RECOVERY;
const image = process.env.CANTRIP_OS_CROSS_INSTANCE_TEST_IMAGE;
const workerId = process.env.CANTRIP_OS_PRODUCT_TEST_WORKER;
const workerData = process.env.CANTRIP_OS_PRODUCT_TEST_WORKER_DATA;
const evidence = process.env.CANTRIP_OS_PRODUCT_TEST_EVIDENCE;
const execute = promisify(execFile);
const docker = async (...args: string[]) =>
  (await execute("docker", args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const guest = async (name: string, ...args: string[]) =>
  JSON.parse(await docker("exec", name, ...args));
const delay = () => new Promise((resolve) => setTimeout(resolve, 150));

// Requires an explicitly disposable, unlocked product profile. Uses the full
// running Server/Worker, actual grants, guest packages and encrypted archives.
// There is no mocked command bus, controller, recovery carrier or guest.
describe.skipIf(!origin || !recovery || !image || !workerId || !workerData)(
  "actual product cross-instance private workspace restore",
  () => {
    it("preserves destination identity, remaps ownership, rejects corrupt input and keeps source bindings separate", async () => {
      const saved = JSON.parse(await readFile(recovery!, "utf8"));
      const master = await openAnonymousRecoveryArtifact(saved);
      const key = (
        component: EncryptionComponentScope = "repository-content",
      ) =>
        deriveComponentKey({
          accountMasterKey: master,
          ownerId: saved.ownerId,
          component,
          keyRevision: saved.masterKeyRevision,
        });
      const componentKey = key();
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(origin + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Origin: "http://127.0.0.1:5179",
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            `${path}: ${response.status} ${JSON.stringify(value)}`,
          );
        return value;
      };
      const prefix = `cantrip-cross-restore-${randomUUID()}`;
      const source = prefix + "-source",
        target = prefix + "-target";
      const owned: string[] = [];
      const events: Record<string, unknown>[] = [];
      const record = (event: string, value: unknown) => {
        events.push({ event, value });
        console.log(`QA_EVT ${event}`);
      };
      const attach = async (name: string) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const status = await guest(name, "cantrip-executor", "status");
            if (status.service === "running") break;
            throw new Error("Executor is still starting");
          } catch (error) {
            if (attempt === 100) throw error;
            await delay();
          }
        }
        const transport = { kind: "docker", container: name };
        const inspected = cantripOsObservedInstanceSchema.parse(
          await api("/api/cantrip-os/inspect", { workerId, transport }),
        );
        expect(inspected.attachment).toBeNull();
        const result = await api("/api/cantrip-os/attach", {
          workerId,
          transport,
          name,
          guestInstanceId: inspected.guestInstanceId,
          expectedAttachmentGeneration: null,
        });
        return cantripOsInstanceSummarySchema.parse(result.instance);
      };
      const recoverInstance = async (instance: CantripOsInstanceSummary) => {
        const result = await api(`/api/cantrip-os/${instance.id}/recovery`, {
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: instance.runtimeGeneration,
        });
        return cantripOsInstanceSummarySchema.parse(result.instance);
      };
      const workspace = async (
        instance: CantripOsInstanceSummary,
        guestWorkspaceId: string,
      ) => {
        const outcome = await api(`/api/cantrip-os/${instance.id}/workspaces`, {
          guestWorkspaceId,
          operationId: randomUUID(),
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: instance.runtimeGeneration,
        });
        expect(outcome.state).toBe("ready");
        const all = await api(`/api/cantrip-os/${instance.id}/workspaces`);
        return cantripOsWorkspaceSummarySchema.parse(
          all.find(
            (w: { guestWorkspaceId: string }) =>
              w.guestWorkspaceId === guestWorkspaceId,
          ),
        );
      };
      const backup = async (
        instance: CantripOsInstanceSummary,
        intent: ReturnType<typeof cantripOsBackupPrivateRequestSchema.parse>,
      ) => {
        const operationId = randomUUID();
        const plaintext = new TextEncoder().encode(JSON.stringify(intent));
        let protectedRequest;
        try {
          protectedRequest = await encryptCantripOsBackupMessage({
            ownerId: saved.ownerId,
            serverId: saved.serverId,
            componentKey,
            keyRevision: saved.masterKeyRevision,
            operationId,
            direction: "request",
            plaintext,
          });
        } finally {
          clearSensitiveBytes(plaintext);
        }
        const admission = {
          operationId,
          workspaceId: intent.workspaceId,
          attachmentGeneration: instance.attachmentGeneration,
          runtimeGeneration: instance.runtimeGeneration,
          protectedRequest,
          action: intent.action,
          ...(intent.action === "restore"
            ? { backupId: intent.backupId, replace: intent.replace }
            : {}),
        };
        const summary = cantripOsBackupSummarySchema.parse(
          await api(
            `/api/cantrip-os/${instance.id}/backup-operations`,
            admission,
          ),
        );
        expect(summary.operationId).toBe(operationId);
        expect(summary.instanceId).toBe(instance.id);
        expect(summary.workspaceId).toBe(intent.workspaceId);
        expect(summary.result?.protectedResult).toBeDefined();
        const opened = await decryptCantripOsBackupMessage({
          ownerId: saved.ownerId,
          serverId: saved.serverId,
          componentKey,
          keyRevision: saved.masterKeyRevision,
          operationId,
          direction: "response",
          frame: summary.result!.protectedResult!,
        });
        try {
          return {
            summary,
            admission,
            result: cantripOsBackupPrivateResultSchema.parse(
              JSON.parse(new TextDecoder().decode(opened)),
            ),
          };
        } finally {
          clearSensitiveBytes(opened);
        }
      };
      const identity = async (name: string, workspaceId: string) => ({
        machine: await docker(
          "exec",
          name,
          "dbus-uuidgen",
          "--get=/etc/machine-id",
        ),
        guest: (await guest(name, "cantrip-executor", "status")).instance_id,
        attachment: (await guest(name, "cantrip-executor", "status"))
          .attachment,
        ssh: (
          await guest(
            name,
            "cantrip-remote",
            "service-info",
            workspaceId,
            "--service",
            '{"kind":"ssh"}',
          )
        ).ssh_host_key,
      });
      const register = async (
        projectId: string,
        workspaceId: string,
        instanceId: string,
      ) => {
        const binding = cantripOsSourceBindingSummarySchema.parse(
          await api(`/api/projects/${projectId}/cantrip-os/bindings`, {
            mode: "linux-existing",
            operationId: randomUUID(),
            workspaceId,
            sourceKind: "folder",
            relativePath: "source",
          }),
        );
        const operationId = randomUUID();
        const plaintext = new TextEncoder().encode(
          JSON.stringify({
            type: "cantrip-os.source.provision",
            instanceId,
            workspaceId,
            bindingId: binding.id,
            bindingGeneration: binding.bindingGeneration,
            intent: {
              mode: "linux-owned",
              source: { kind: "existing", sourceKind: "folder" },
            },
          }),
        );
        let protectedRequest;
        try {
          protectedRequest = await encryptRepositoryOperationPayload({
            ownerId: saved.ownerId,
            componentKey,
            keyRevision: saved.masterKeyRevision,
            context: {
              serverId: saved.serverId,
              projectId,
              worktreeId: binding.worktreeId,
              operationId,
              direction: "request",
            },
            plaintext,
          });
        } finally {
          clearSensitiveBytes(plaintext);
        }
        const result = await api(
          `/api/projects/${projectId}/cantrip-os/bindings/${binding.id}/provision`,
          {
            operationId,
            bindingGeneration: binding.bindingGeneration,
            protectedRequest,
          },
        );
        expect(result.state).toBe("ready");
        return cantripOsSourceBindingSummarySchema.parse(
          await api(
            `/api/projects/${projectId}/cantrip-os/bindings/${binding.id}/verify`,
            {},
          ),
        );
      };
      try {
        for (const name of [source, target]) {
          owned.push(name);
          await docker("run", "-d", "--name", name, "--shm-size=256m", image!);
        }
        let sourceInstance = await attach(source),
          targetInstance = await attach(target);
        const sourceWorkspace = await workspace(sourceInstance, "original");
        // The old workspace name also exists on the destination. A stale
        // handle must fail its identity check even when that name is valid.
        await workspace(targetInstance, "original");
        const failedWorkspace = await workspace(targetInstance, "corruption");
        const targetWorkspace = await workspace(targetInstance, "restored");
        expect(sourceWorkspace.uid).not.toBe(targetWorkspace.uid);
        const sourceIdentity = await identity(source, "original"),
          targetIdentity = await identity(target, "restored");
        expect(sourceIdentity.machine).not.toBe(targetIdentity.machine);
        expect(sourceIdentity.guest).not.toBe(targetIdentity.guest);
        expect(sourceIdentity.ssh).not.toBe(targetIdentity.ssh);
        const script = await readFile(
          new URL("./fixtures/os-cross-instance-files.py", import.meta.url),
          "utf8",
        );
        await docker(
          "exec",
          source,
          "python3",
          "-c",
          script,
          "seed",
          "original",
        );
        await docker(
          "exec",
          target,
          "python3",
          "-c",
          script,
          "sentinel",
          "corruption",
        );
        const projectId = randomUUID(),
          displayKey = key("private-surface-metadata");
        try {
          const nameProtection = await encryptPrivateDisplayLabel({
            ownerId: saved.ownerId,
            componentKey: displayKey,
            recordKind: "project",
            rowId: projectId,
            keyRevision: saved.masterKeyRevision,
            label: "Disposable cross-instance restore",
          });
          await api("/api/projects/from-folder", {
            id: projectId,
            workerId,
            nameProtection,
          });
        } finally {
          clearSensitiveBytes(displayKey);
        }
        const sourceBinding = await register(
          projectId,
          sourceWorkspace.id,
          sourceInstance.id,
        );
        const oldNativeBinding = (await guest(
          source,
          "cantrip-executor",
          "open",
          "original",
        )) as OsExecutorBinding;
        const captured = await backup(sourceInstance, {
          action: "capture",
          workspaceId: sourceWorkspace.id,
          label: "Private cross-instance fixture",
          exclusions: [".cache"],
        });
        expect(captured.summary.result?.state).toBe("ready");
        expect(captured.result.action).toBe("capture");
        if (captured.result.action !== "capture")
          throw new Error("Capture did not complete");
        const manifest = captured.result.metadata.manifest as {
          cantrip: { scope: Parameters<typeof backupFile>[1] };
        };
        const archive = backupFile(
          workerData!,
          manifest.cantrip.scope,
          captured.summary.operationId,
        );
        const bytes = await readFile(archive);
        expect((await stat(archive)).mode & 0o777).toBe(0o600);
        expect(
          bytes.includes(Buffer.from("Private cross-instance fixture")),
        ).toBe(false);
        const altered = Buffer.from(bytes);
        altered[Math.floor(altered.length / 2)]! ^= 1;
        try {
          await writeFile(archive, altered);
          const corrupt = await backup(targetInstance, {
            action: "restore",
            workspaceId: failedWorkspace.id,
            backupId: captured.summary.operationId,
            replace: true,
          });
          expect(corrupt.summary.result?.state).toBe("failed");
          expect(corrupt.result.action).toBe("error");
          expect(
            await guest(
              target,
              "python3",
              "-c",
              script,
              "check-sentinel",
              "corruption",
            ),
          ).toEqual({ sentinel: true });
          record("corrupt-archive-preserved-existing-home", {
            operationId: corrupt.summary.operationId,
            state: corrupt.summary.result?.state,
          });
        } finally {
          await writeFile(archive, bytes);
          bytes.fill(0);
          altered.fill(0);
        }
        await docker(
          "exec",
          source,
          "python3",
          "-c",
          script,
          "edit",
          "original",
        );
        const restored = await backup(targetInstance, {
          action: "restore",
          workspaceId: targetWorkspace.id,
          backupId: captured.summary.operationId,
          replace: false,
        });
        expect(restored.summary.result?.state).toBe("ready");
        expect(restored.result.action).toBe("restore");
        const checked = await guest(
          target,
          "python3",
          "-c",
          script,
          "verify",
          "restored",
        );
        expect(checked).toMatchObject({
          dirty: true,
          ignored: true,
          unicode: true,
          mode: true,
          ownership: true,
          browser: true,
          config: true,
          git: true,
          cacheExcluded: true,
        });
        expect(await identity(source, "original")).toEqual(sourceIdentity);
        expect(await identity(target, "restored")).toEqual(targetIdentity);
        expect(
          await guest(
            source,
            "python3",
            "-c",
            script,
            "check-edit",
            "original",
          ),
        ).toEqual({ edited: true });
        sourceInstance = await recoverInstance(sourceInstance);
        targetInstance = await recoverInstance(targetInstance);
        const targetBinding = await register(
          projectId,
          targetWorkspace.id,
          targetInstance.id,
        );
        expect(targetBinding.projectSourceId).not.toBe(
          sourceBinding.projectSourceId,
        );
        expect(targetBinding.worktreeId).not.toBe(sourceBinding.worktreeId);
        expect(targetBinding.id).not.toBe(sourceBinding.id);
        const bindings = await api(
          `/api/projects/${projectId}/cantrip-os/bindings`,
        );
        expect(
          bindings.find((b: { id: string }) => b.id === sourceBinding.id),
        ).toMatchObject({
          instanceId: sourceInstance.id,
          workspaceId: sourceWorkspace.id,
          projectSourceId: sourceBinding.projectSourceId,
          worktreeId: sourceBinding.worktreeId,
        });
        const verifiedOriginal = await api(
          `/api/projects/${projectId}/cantrip-os/bindings/${sourceBinding.id}/verify`,
          {},
        );
        expect(verifiedOriginal).toMatchObject({
          instanceId: sourceInstance.id,
          workspaceId: sourceWorkspace.id,
          projectSourceId: sourceBinding.projectSourceId,
          worktreeId: sourceBinding.worktreeId,
          state: "ready",
        });
        const destinationNative = (await guest(
          target,
          "cantrip-executor",
          "open",
          "original",
        )) as OsExecutorBinding;
        expect(destinationNative.instance_id).not.toBe(
          oldNativeBinding.instance_id,
        );
        await expect(
          docker(
            "exec",
            target,
            "cantrip-executor",
            "connect",
            "original",
            "--expect",
            JSON.stringify(oldNativeBinding),
          ),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Executor attachment or generation mismatch",
          ),
        });
        record("source-bindings-and-stale-handle", {
          original: sourceBinding,
          restored: targetBinding,
          staleHandleRejected: true,
        });
        record("cross-instance-restore", {
          captureId: captured.summary.operationId,
          restoreId: restored.summary.operationId,
          sourceInstance: sourceInstance.id,
          targetInstance: targetInstance.id,
          sourceUid: sourceWorkspace.uid,
          targetUid: targetWorkspace.uid,
          sourceIdentity,
          targetIdentity,
          checked,
        });
        // Repeating the immutable product admission observes the same operation.
        const repeat = cantripOsBackupSummarySchema.parse(
          await api(
            `/api/cantrip-os/${targetInstance.id}/backup-operations`,
            restored.admission,
          ),
        );
        expect(repeat.operationId).toBe(restored.summary.operationId);
        expect(repeat.result?.protectedResult).toEqual(
          restored.summary.result?.protectedResult,
        );
        const hash = createHash("sha256")
          .update(await readFile(archive))
          .digest("hex");
        record("private-archive", {
          sha256: hash,
          bytes: (await stat(archive)).size,
          mode: "0600",
        });
      } finally {
        clearSensitiveBytes(master);
        clearSensitiveBytes(componentKey);
        const cleanup = await Promise.allSettled(
          owned.map((name) => docker("rm", "-fv", name)),
        );
        record(
          "cleanup",
          cleanup.map((r, i) => ({
            name: owned[i],
            status: r.status,
            ...(r.status === "rejected" ? { error: String(r.reason) } : {}),
          })),
        );
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await writeFile(
            join(evidence, "cross-instance-restore.json"),
            JSON.stringify(events, null, 2),
          );
        }
        const failed = cleanup.find((entry) => entry.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
    }, 240_000);
  },
);
