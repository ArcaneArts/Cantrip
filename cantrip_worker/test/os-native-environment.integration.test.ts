import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CantripOsController } from "../src/os-executor/controller.js";
import { OsNativeEnvironment } from "../src/os-executor/native-environment.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import {
  initializeCodexRpcClient,
  spawnCodexRpcClient,
  type CodexRpcClient,
} from "../src/codex/rpc-client.js";

import { runGuestProcess } from "../src/os-executor/process.js";
import { guestFileUri } from "../src/os-executor/paths.js";

const binary = process.env.CANTRIP_CODEX_TEST_BINARY;
const enabled = Boolean(
  binary &&
  (process.env.CANTRIP_OS_TEST_CONTAINER ||
    process.env.CANTRIP_OS_TEST_TRANSPORT),
);
describe.skipIf(!enabled)("pinned native app-server Linux environment", () => {
  it("loads the protected stdio executor as its only environment and starts a thread in the guest source", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-native-linux-"),
    );
    const workerId = "00000000-0000-4000-8000-000000000002",
      ownerId = "00000000-0000-4000-8000-000000000001";
    const controller = new CantripOsController(directory, workerId);
    const actual = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as { guestInstanceId: string; runtimeGeneration: string };
    const core = {
      ownerId,
      workerId,
      serverId: "native-environment-acceptance",
      instanceId: randomUUID(),
      guestInstanceId: actual.guestInstanceId,
      attachmentGeneration: randomUUID(),
      runtimeGeneration: actual.runtimeGeneration,
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: core,
      transport,
    });
    const guestWorkspaceId = `nat-${randomUUID().slice(0, 12)}`;
    const profile = (await controller.handle({
      type: "cantrip-os.workspaces.create",
      scope: core,
      transport,
      guestWorkspaceId,
      operationId: randomUUID(),
    })) as {
      state: string;
      receipt: {
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    expect(profile.state).toBe("ready");
    const sourceId = randomUUID();
    const scope = {
      ...core,
      ...profile.receipt.workspace,
      guestWorkspaceId,
      projectId: randomUUID(),
      projectSourceId: sourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      workspaceId: randomUUID(),
      sourceKind: "git" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      guestPath: `${profile.receipt.workspace.homeGuestPath}/checkouts/${sourceId}`,
      dependencyOverlays: [],
    };
    let client: CodexRpcClient | undefined;
    let connection: OsExecutorConnection | undefined;
    try {
      const binding = await executorControl<OsExecutorBinding>(transport, [
        "open",
        guestWorkspaceId,
      ]);
      connection = new OsExecutorConnection(transport, binding);
      await connection.request("initialize", {
        clientName: "cantrip-native-git-fixture",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      const origin = `${scope.homeGuestPath}/fixture-origin`;
      const seed = await runGuestProcess(
        connection,
        [
          "python3",
          "-c",
          String.raw`import pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'tracked.txt').write_text('original\n')
subprocess.run(['git','init','-q',str(p)],check=True)
subprocess.run(['git','-C',str(p),'add','.'],check=True)
subprocess.run(['git','-C',str(p),'-c','user.name=Fixture','-c','user.email=fixture@cantrip.invalid','commit','-qm','seed'],check=True)
print(subprocess.check_output(['git','-C',str(p),'rev-parse','HEAD']).decode().strip())`,
          origin,
        ],
        scope.homeGuestPath,
      );
      expect(seed.exitCode, seed.stderr).toBe(0);
      const provision = (await controller.handle({
        type: "cantrip-os.source.provision",
        scope,
        transport,
        operationId: randomUUID(),
        intent: {
          mode: "linux-owned",
          source: {
            kind: "git",
            repositoryUrl: origin,
            revision: seed.stdout.trim(),
          },
        },
      })) as { state: string };
      expect(provision.state).toBe("ready");
      const home = path.join(directory, "native-home");
      const environment = new OsNativeEnvironment(scope, transport, controller);
      await environment.prepare(home);
      await environment.prepare(home);
      await expect(
        new OsNativeEnvironment(
          { ...scope, runtimeGeneration: randomUUID() },
          transport,
          controller,
        ).prepare(path.join(directory, "stale-home")),
      ).rejects.toThrow(/runtime changed/);
      await expect(
        new OsNativeEnvironment(
          { ...scope, bindingGeneration: randomUUID() },
          transport,
          controller,
        ).prepare(home),
      ).rejects.toThrow(/different execution environment/);
      await expect(environment.snapshot("/tmp/wrong-target")).rejects.toThrow(
        /captured Linux placement/,
      );
      await writeFile(
        path.join(home, "config.toml"),
        "features.plugins=false\n",
      );
      client = spawnCodexRpcClient(binary!, home, { requestTimeoutMs: 60_000 });
      await initializeCodexRpcClient(client, {
        name: "cantrip-linux-environment-acceptance",
        title: "CantripOS",
        version: "0.1.0",
        experimentalApi: true,
      });
      const info = await client.request("environment/info", {
        environmentId: environment.id,
      });
      expect(info.error, JSON.stringify(info)).toBeUndefined();
      expect(info.result).toMatchObject({
        shell: { name: "bash", path: "/bin/bash" },
      });
      const thread = await client.request("thread/start", {
        cwd: scope.guestPath,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: true,
        model: "gpt-5",
        environments: [environment.selection],
      });
      expect(thread.error, JSON.stringify(thread)).toBeUndefined();
      const value = thread.result as {
        thread: {
          id: string;
          cwd: string;
          environments: Array<{ environmentId: string; cwd: string }>;
        };
      };
      expect(value.thread.cwd).toBe(scope.guestPath);
      expect(value.thread.environments).toMatchObject([
        { environmentId: environment.id, cwd: scope.guestPath },
      ]);
      const local = await client.request("environment/info", {
        environmentId: "local",
      });
      expect(local.error).toBeTruthy();
      expect(await environment.snapshot(scope.guestPath)).toEqual(new Map());
      const literal = "file # % ? 日本語.txt";
      await connection.request("fs/writeFile", {
        path: guestFileUri(`${scope.guestPath}/${literal}`),
        dataBase64: Buffer.from("native snapshot\n").toString("base64"),
        sandbox: null,
      });
      const snapshot = await environment.snapshot(scope.guestPath);
      expect(snapshot.get(literal)).toMatchObject({ status: "??" });
      expect(snapshot.get(literal)!.fingerprint).not.toBe("missing");
      await writeFile(
        path.join(directory, "native-environment-proof.json"),
        JSON.stringify(
          {
            scope,
            thread: value.thread,
            snapshot: [...snapshot],
            rejectedStaleGeneration: true,
            rejectedLocalEnvironment: true,
          },
          null,
          2,
        ),
      );
    } finally {
      client?.close();
      await connection?.close();
      await executorControl(transport, ["close", guestWorkspaceId]);
    }
  }, 180_000);
});
