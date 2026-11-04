import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CantripOsController } from "../src/os-executor/controller.js";
import {
  executorControl,
  OsExecutorConnection,
  OsExecutorDeliveryError,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";
import { runGuestProcess } from "../src/os-executor/process.js";
import { guestFileUri } from "../src/os-executor/paths.js";
import { createLinuxWorktree } from "../src/os-executor/checkouts.js";
import { OsRunDefinitionOperations } from "../src/os-executor/run-definitions.js";
import {
  OsRunExecution,
  type OsRunLaunch,
} from "../src/os-executor/run-execution.js";
import {
  protectRunConfigurationSecretValue,
  openRunConfigurationSecretValue,
} from "../src/run-configuration-secret-encryption.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)("actual Linux Run generation driver", () => {
  it("prepares Linux environments, runs an explicit worktree in a PTY, observes transport loss, and cancels its root tree", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const directory = await mkdtemp(path.join(tmpdir(), "cantrip-os-run-"));
    const ownerId = "00000000-0000-4000-8000-000000000001",
      workerId = "00000000-0000-4000-8000-000000000002";
    const controller = new CantripOsController(directory, workerId);
    const observed = (await controller.handle({
      type: "cantrip-os.inspect",
      ownerId,
      workerId,
      transport,
    })) as { guestInstanceId: string; runtimeGeneration: string };
    const core = {
      ownerId,
      workerId,
      serverId: "run-execution-acceptance",
      instanceId: randomUUID(),
      guestInstanceId: observed.guestInstanceId,
      runtimeGeneration: observed.runtimeGeneration,
      attachmentGeneration: randomUUID(),
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: core,
      transport,
    });
    const guestWorkspaceId = `run-${randomUUID().slice(0, 12)}`;
    const created = (await controller.handle({
      type: "cantrip-os.workspaces.create",
      scope: core,
      transport,
      guestWorkspaceId,
      operationId: randomUUID(),
    })) as {
      receipt: {
        workspace: { uid: number; gid: number; homeGuestPath: string };
      };
    };
    const projectId = randomUUID(),
      projectSourceId = randomUUID(),
      home = created.receipt.workspace.homeGuestPath;
    const scope = {
      ...core,
      ...created.receipt.workspace,
      guestWorkspaceId,
      workspaceId: randomUUID(),
      projectId,
      projectSourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      sourceKind: "git" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
      guestPath: `${home}/checkouts/${projectSourceId}`,
    };
    const binding = await controller.captureExecutionBinding(transport, scope);
    const connection = new OsExecutorConnection(transport, binding);
    let unrelated: string | undefined;
    let restoreSpy: (() => void) | undefined;
    const hostValue = process.env.CANTRIP_TEST_HOST_ONLY;
    process.env.CANTRIP_TEST_HOST_ONLY = "must-stay-on-the-worker";
    try {
      await connection.request("initialize", {
        clientName: "run-fixture",
        resumeSessionId: null,
      });
      connection.notify("initialized");
      const put = async (filename: string, text: string) =>
        connection.request("fs/writeFile", {
          path: guestFileUri(filename),
          dataBase64: Buffer.from(text).toString("base64"),
          sandbox: null,
        });
      const get = async (filename: string) =>
        Buffer.from(
          (
            await connection.request<{ dataBase64: string }>("fs/readFile", {
              path: guestFileUri(filename),
              sandbox: null,
            })
          ).dataBase64,
          "base64",
        ).toString();
      const seed = `${home}/run-seed`;
      await connection.request("fs/createDirectory", {
        path: guestFileUri(`${seed}/.codex/environments`),
        recursive: true,
        sandbox: null,
      });
      await put(
        `${seed}/.codex/environments/environment.toml`,
        '[setup]\nscript = "printf setup > setup.txt; export FROM_SETUP=yes; export PRECEDENCE=codex"\n',
      );
      await put(
        `${seed}/.gitignore`,
        ".cantrip/\n.env\nsetup.txt\nbefore.txt\nrun-proof.json\nruns.txt\n*.pid\n",
      );
      await put(`${seed}/target.txt`, "primary 日本");
      await put(
        `${seed}/run-proof.py`,
        [
          "import os,json,pathlib,subprocess,time",
          "p=pathlib.Path('runs.txt');p.write_text((p.read_text() if p.exists() else '')+'once\\n')",
          "time.sleep(1)",
          "value={'uid':os.getuid(),'cwd':os.getcwd(),'target':pathlib.Path('target.txt').read_text(),'tty':os.isatty(1),'size':list(os.get_terminal_size()),'setup':os.getenv('FROM_SETUP'),'precedence':os.getenv('PRECEDENCE'),'file':os.getenv('FROM_FILE'),'host':os.getenv('CANTRIP_TEST_HOST_ONLY'),'root':subprocess.check_output(['sudo','-n','id','-u'],text=True).strip(),'reserved':os.getenv('CANTRIP_WORKTREE_PATH'),'capEff':next(line.split()[1] for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:'))}",
          "pathlib.Path('run-proof.json').write_text(json.dumps(value,ensure_ascii=False))",
          "print('RUN_SECRET='+os.getenv('RUN_SECRET','missing'),flush=True)",
          "print('RUN_RESULT='+json.dumps(value,ensure_ascii=False),flush=True)",
        ].join("\n"),
      );
      const seeded = await runGuestProcess(
        connection,
        [
          "/bin/bash",
          "-c",
          "git init -b main && git -c user.name=Acceptance -c user.email=test@example.invalid add . && git -c user.name=Acceptance -c user.email=test@example.invalid commit -m seed && git rev-parse HEAD",
        ],
        seed,
      );
      expect(seeded.exitCode, seeded.stderr).toBe(0);
      const revision = seeded.stdout.trim().split("\n").at(-1)!;
      const provision = (await controller.handle({
        type: "cantrip-os.source.provision",
        scope,
        transport,
        operationId: randomUUID(),
        intent: {
          mode: "linux-owned",
          source: { kind: "git", repositoryUrl: seed, revision },
        },
      })) as {
        state: string;
        receipt: { source: { repositoryFingerprint: string } };
      };
      expect(provision.state).toBe("ready");
      const worktreeId = randomUUID(),
        targetPath = `${home}/worktrees/${worktreeId}`;
      await createLinuxWorktree(
        connection,
        {
          sourceId: projectSourceId,
          sourceGuestPath: scope.guestPath,
          worktreeId,
          guestPath: targetPath,
          revision,
          branch: `run-${worktreeId.slice(0, 8)}`,
          expectedRepositoryFingerprint:
            provision.receipt.source.repositoryFingerprint,
        },
        { prepared: async () => {} },
      );
      await put(`${targetPath}/target.txt`, "secondary 日本");
      await put(
        `${targetPath}/.env`,
        "FROM_FILE=secondary-file\nPRECEDENCE=file\nCANTRIP_WORKTREE_PATH=must-not-win\n",
      );
      await put(
        `${targetPath}/.codex/environments/environment.toml`,
        '[setup]\nscript = "export FROM_SETUP=wrong-secondary"\n',
      );
      const { serverId: _server, ...executionScope } = scope;
      const definitions = {
        kind: "cantrip-os" as const,
        scope: executionScope,
        transport,
      };
      const target = {
        ...definitions,
        scope: {
          ...executionScope,
          bindingId: randomUUID(),
          bindingGeneration: randomUUID(),
          worktreeId,
          guestPath: targetPath,
        },
      };
      const authority = {
        ownerId: () => ownerId,
        serverIdentity: () => core.serverId,
      };
      const definitionService = new OsRunDefinitionOperations(
        directory,
        controller,
        authority,
      );
      const configurationId = randomUUID();
      const document = {
        schema: "cantrip.run-configuration",
        version: 1,
        id: configurationId,
        name: "Linux proof",
        provider: "shell",
        workingDirectory: ".",
        target: { kind: "command", command: "python run-proof.py" },
        commandOverride: null,
        arguments: [],
        environment: {
          includeCodexEnvironment: true,
          files: [".env"],
          variables: [{ name: "PRECEDENCE", value: "plain", enabled: true }],
          secrets: [
            { name: "RUN_SECRET", secret: "test/token", enabled: true },
          ],
        },
        beforeLaunch: [
          {
            kind: "command",
            command: "printf 'before 日本' > before.txt",
            workingDirectory: ".",
          },
        ],
        platformOverrides: {},
        options: { shell: "bash", login: false },
        stop: { gracePeriodMs: 1000 },
      };
      const { runConfigurationShellDocumentSchema } =
        await import("@cantrip/protocol/run-configuration-definitions");
      const doc = runConfigurationShellDocumentSchema.parse(document);
      const written = await definitionService.execute({
        type: "cantrip-os.run-definition",
        execution: definitions,
        request: {
          type: "project.run-configuration-definitions.write",
          operationId: randomUUID(),
          projectId,
          request: { document: doc, expectedRevision: null },
        },
      });
      if (written.operation !== "write" || !("entry" in written.result))
        throw new Error("Missing saved Run definition");
      const read = await definitionService.execute({
        type: "cantrip-os.run-definition",
        execution: definitions,
        request: {
          type: "project.run-configuration-definitions.get",
          operationId: randomUUID(),
          projectId,
          configurationId,
        },
      });
      if (read.operation !== "get")
        throw new Error("Missing Run source status");
      const key = new Uint8Array(32).fill(71),
        secretValue = `private-run-${randomUUID()}`;
      const cryptoService = {
        ownerId: () => ownerId,
        componentKey: () => ({ key: key.slice(), keyRevision: 1 }),
      };
      const protectedSecret = {
        reference: "test/token",
        revision: 1,
        protectedValue: await protectRunConfigurationSecretValue({
          projectId,
          reference: "test/token",
          value: secretValue,
          service: cryptoService,
        }),
      };
      const input: OsRunLaunch = {
        identity: {
          runtimeId: randomUUID(),
          projectId,
          configurationId,
          worktreeId,
          workerId,
          definitionRevision: written.result.entry.revision!,
          codexEnvironmentRevision: read.codexEnvironment.revision,
          generation: 1,
          operationId: randomUUID(),
          terminalId: randomUUID(),
        },
        definitions,
        target,
        protectedSecrets: [protectedSecret],
      };
      const driver = new OsRunExecution(
        directory,
        controller,
        authority,
        (projectId, secret) =>
          openRunConfigurationSecretValue({
            projectId,
            secret,
            service: cryptoService,
          }),
      );
      expect(() =>
        driver.start(
          {
            ...input,
            target: {
              ...target,
              scope: { ...target.scope, workspaceId: randomUUID() },
            },
          },
          { output: () => {}, started: () => {} },
        ),
      ).toThrow("different Linux authority");
      let output = "",
        started = 0,
        mainProcess: string | undefined,
        dropped = false;
      const original = OsExecutorConnection.prototype.request;
      const spy = vi
        .spyOn(OsExecutorConnection.prototype, "request")
        .mockImplementation(async function <T>(
          this: OsExecutorConnection,
          method: string,
          params: unknown,
        ): Promise<T> {
          const data = params as { processId?: string; argv?: string[] };
          const result = (await original.call(this, method, params)) as T;
          if (
            method === "process/start" &&
            data.argv?.some((value) => value.includes("python run-proof.py"))
          )
            mainProcess = data.processId;
          if (
            !dropped &&
            mainProcess &&
            method === "process/read" &&
            data.processId === mainProcess
          ) {
            dropped = true;
            await this.close();
            throw new OsExecutorDeliveryError(
              "Deliberately dropped a real native read response",
            );
          }
          return result;
        });
      restoreSpy = () => spy.mockRestore();
      const job = driver.start(input, {
        output: (data) => {
          output += data;
        },
        started: () => {
          started++;
        },
      });
      expect(driver.start(input, { output: () => {}, started: () => {} })).toBe(
        job,
      );
      const completed = await job.completion;
      expect(completed, JSON.stringify(completed)).toMatchObject({
        outcome: "exited",
        exitCode: 0,
      });
      expect(started).toBe(1);
      expect(dropped).toBe(true);
      expect(
        spy.mock.calls.filter(
          ([method, params]) =>
            method === "process/start" &&
            (params as { processId: string }).processId === mainProcess,
        ),
      ).toHaveLength(1);
      spy.mockRestore();
      restoreSpy = undefined;
      const proof = JSON.parse(await get(`${targetPath}/run-proof.json`));
      expect(proof).toEqual({
        uid: scope.uid,
        cwd: targetPath,
        target: "secondary 日本",
        tty: true,
        size: [120, 40],
        setup: "yes",
        precedence: "plain",
        file: "secondary-file",
        host: null,
        root: "0",
        reserved: targetPath,
        capEff: "0000000000000000",
      });
      expect(output).toContain("RUN_RESULT=");
      expect(output).not.toContain(secretValue);
      expect(output).toContain("••••");
      expect(await get(`${targetPath}/setup.txt`)).toBe("setup");
      expect(await get(`${targetPath}/before.txt`)).toBe("before 日本");
      expect(await get(`${targetPath}/runs.txt`)).toBe("once\n");
      expect(
        await new OsRunExecution(
          directory,
          controller,
          authority,
          async () => secretValue,
        ).start(input, { output: () => {}, started: () => {} }).completion,
      ).toEqual(completed);
      expect(await get(`${targetPath}/runs.txt`)).toBe("once\n");
      const journal = await readFile(
        path.join(
          directory,
          "os-run-generations",
          input.identity.runtimeId,
          "1.json",
        ),
        "utf8",
      );
      expect(journal).not.toContain(secretValue);
      expect(journal).not.toContain("python run-proof.py");
      const staleDefinition = await driver.start(
        {
          ...input,
          identity: {
            ...input.identity,
            generation: 2,
            operationId: randomUUID(),
            definitionRevision: "0".repeat(64),
          },
        },
        {
          output: () => {},
          started: () => {
            throw new Error("Stale definition started a runtime");
          },
        },
      ).completion;
      expect(staleDefinition).toMatchObject({
        outcome: "failed",
        phase: "definition",
      });
      expect(await get(`${targetPath}/runs.txt`)).toBe("once\n");
      await put(
        `${targetPath}/long.py`,
        "import subprocess,time,pathlib\nsubprocess.Popen(['sudo','-n','setsid','python','-c',\"import os,time,pathlib;pathlib.Path('root-child.pid').write_text(str(os.getpid()));time.sleep(300)\"])\nwhile not pathlib.Path('root-child.pid').exists():time.sleep(.05)\nprint('ROOT_CHILD_READY',flush=True)\ntime.sleep(300)\n",
      );
      const longDoc = runConfigurationShellDocumentSchema.parse({
        ...doc,
        id: randomUUID(),
        name: "Root tree",
        target: { kind: "command", command: "python long.py" },
        environment: {
          ...doc.environment,
          includeCodexEnvironment: false,
          files: [],
          secrets: [],
        },
        beforeLaunch: [],
      });
      const longWrite = await definitionService.execute({
        type: "cantrip-os.run-definition",
        execution: definitions,
        request: {
          type: "project.run-configuration-definitions.write",
          operationId: randomUUID(),
          projectId,
          request: { document: longDoc, expectedRevision: null },
        },
      });
      if (longWrite.operation !== "write" || !("entry" in longWrite.result))
        throw new Error("Missing long definition");
      unrelated = randomUUID();
      await connection.request("process/start", {
        processId: unrelated,
        argv: ["python", "-c", "import time;time.sleep(300)"],
        cwd: guestFileUri(scope.guestPath),
        env: {},
        tty: false,
        arg0: null,
        sandbox: null,
      });
      let longOutput = "";
      const long = driver.start(
        {
          ...input,
          identity: {
            ...input.identity,
            runtimeId: randomUUID(),
            configurationId: longDoc.id,
            definitionRevision: longWrite.result.entry.revision!,
            codexEnvironmentRevision: null,
            operationId: randomUUID(),
            terminalId: randomUUID(),
          },
          protectedSecrets: [],
        },
        {
          output: (data) => {
            longOutput += data;
          },
          started: () => {},
        },
      );
      await expect
        .poll(() => longOutput, { timeout: 60_000 })
        .toContain("ROOT_CHILD_READY");
      const rootPid = (await get(`${targetPath}/root-child.pid`)).trim();
      let longCompleted = false;
      void long.completion.then(() => {
        longCompleted = true;
      });
      await long.signal(false);
      await expect
        .poll(() => longOutput, { timeout: 10_000 })
        .toContain("KeyboardInterrupt");
      expect(longCompleted).toBe(false);
      await long.signal(true);
      expect(await long.completion).toMatchObject({ outcome: "interrupted" });
      let rootState = "unknown";
      await expect
        .poll(
          async () => {
            const alive = await runGuestProcess(
              connection,
              [
                "python",
                "-c",
                "import pathlib,sys;p=pathlib.Path('/proc/'+sys.argv[1]+'/stat');print('gone' if not p.exists() else p.read_text().split()[2])",
                rootPid,
              ],
              home,
            );
            rootState = alive.stdout.trim();
            return ["gone", "Z"].includes(rootState);
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      expect(
        (
          await connection.request<{ exited: boolean }>("process/read", {
            processId: unrelated,
            afterSeq: null,
            maxBytes: 1,
            waitMs: 0,
          })
        ).exited,
      ).toBe(false);
      const artifacts = new URL(
        "../../cantrip_os/artifacts/phase3-run-execution/",
        import.meta.url,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        new URL(
          `driver-${transport.kind}-${input.identity.runtimeId}.json`,
          artifacts,
        ),
        JSON.stringify(
          {
            transport: transport.kind,
            proof,
            completed,
            started,
            dropped,
            rootChildAfterCancel: rootState,
            unrelatedRetained: true,
          },
          null,
          2,
        ),
      );
      key.fill(0);
    } finally {
      restoreSpy?.();
      if (unrelated)
        await connection
          .request("process/terminate", { processId: unrelated })
          .catch(() => {});
      await connection.close();
      await executorControl(transport, ["close", guestWorkspaceId]);
      if (hostValue === undefined) delete process.env.CANTRIP_TEST_HOST_ONLY;
      else process.env.CANTRIP_TEST_HOST_ONLY = hostValue;
    }
  }, 240_000);
});
