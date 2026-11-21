import { guestFileUri } from "../src/os-executor/paths.js";
import { runGuestProcess } from "../src/os-executor/process.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CantripOsExecution } from "@cantrip/protocol";
import {
  explorerOperationRequestContentSchema,
  type ExplorerOperationRequestContent,
} from "@cantrip/protocol/surface-stream";
import { CantripOsController } from "../src/os-executor/controller.js";
import { OsFileOperations } from "../src/os-executor/files.js";
import {
  executorControl,
  OsExecutorConnection,
  type OsExecutorBinding,
  type OsExecutorTransport,
} from "../src/os-executor/connection.js";

const enabled = Boolean(
  process.env.CANTRIP_OS_TEST_CONTAINER ||
  process.env.CANTRIP_OS_TEST_TRANSPORT,
);
describe.skipIf(!enabled)("packaged Linux product files", () => {
  it("uses native files, preserves Unicode across chunks, recovers completed writes and never replays uncertain writes", async () => {
    const transport: OsExecutorTransport = process.env.CANTRIP_OS_TEST_TRANSPORT
      ? JSON.parse(
          await readFile(process.env.CANTRIP_OS_TEST_TRANSPORT, "utf8"),
        )
      : { kind: "docker", container: process.env.CANTRIP_OS_TEST_CONTAINER! };
    const ownerId = "00000000-0000-4000-8000-000000000001",
      workerId = "00000000-0000-4000-8000-000000000002";
    const directory = await mkdtemp(
      path.join(tmpdir(), "cantrip-product-files-"),
    );
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
      serverId: "product-files-acceptance",
      instanceId: randomUUID(),
      guestInstanceId: observed.guestInstanceId,
      attachmentGeneration: randomUUID(),
      runtimeGeneration: observed.runtimeGeneration,
    };
    await controller.handle({
      type: "cantrip-os.attach",
      scope: core,
      transport,
    });
    const guestWorkspaceId = `fil-${randomUUID().slice(0, 12)}`;
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
    const projectSourceId = randomUUID();
    const scope = {
      ...core,
      ...profile.receipt.workspace,
      guestWorkspaceId,
      projectId: randomUUID(),
      projectSourceId,
      worktreeId: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      workspaceId: randomUUID(),
      sourceKind: "folder" as const,
      mode: "linux-owned" as const,
      linkedWorkerPath: null,
      dependencyOverlays: [],
      guestPath: `${profile.receipt.workspace.homeGuestPath}/checkouts/${projectSourceId}`,
    };
    const execution: CantripOsExecution = {
      kind: "cantrip-os",
      transport,
      scope,
    };
    const provision = (await controller.handle({
      type: "cantrip-os.source.provision",
      scope,
      transport,
      operationId: randomUUID(),
      intent: { mode: "linux-owned", source: { kind: "folder" } },
    })) as { state: string };
    expect(provision.state).toBe("ready");
    const authority = {
      ownerId: () => ownerId,
      serverIdentity: () => core.serverId,
    };
    let files = new OsFileOperations(directory, controller, authority);
    const context = () => ({
      serverId: core.serverId,
      surfaceKind: "explorer" as const,
      surfaceId: "files",
      operationId: randomUUID(),
      sequence: 0,
    });
    const name = "日本.py";
    try {
      expect(
        (
          await files.execute(
            execution,
            { type: "explorer.file.create", path: "", name },
            context(),
          )
        ).outcome.ok,
      ).toBe(true);
      const initial = await files.execute(
        execution,
        { type: "explorer.file.read", path: name },
        context(),
      );
      expect(
        initial.outcome.ok && initial.outcome.result.type === "explorer.file",
      ).toBe(true);
      if (
        !initial.outcome.ok ||
        initial.outcome.result.type !== "explorer.file"
      )
        throw new Error("No initial file");
      // More than one native stdout page, with multibyte boundaries throughout.
      const content = 'print("日本")\n'.repeat(10000);
      const request = {
        type: "explorer.file.write" as const,
        path: name,
        version: initial.outcome.result.value.version,
        content,
      };
      const writeContext = context();
      const saved = await files.execute(execution, request, {
        ...writeContext,
        direction: "request",
      } as typeof writeContext);
      expect(saved.outcome.ok).toBe(true);
      await files.dispose();
      files = new OsFileOperations(directory, controller, authority);
      expect(await files.execute(execution, request, writeContext)).toEqual(
        saved,
      );
      const read = await files.execute(
        execution,
        { type: "explorer.file.read", path: name },
        context(),
      );
      expect(
        read.outcome.ok &&
          read.outcome.result.type === "explorer.file" &&
          read.outcome.result.value.content,
      ).toBe(content);
      const uploadId = randomUUID(),
        bytes = Buffer.from([0, 1, 255, 0, 123]);
      for (const request of [
        {
          type: "explorer.binary.write.begin",
          path: "data.bin",
          uploadId,
          version: null,
        },
        {
          type: "explorer.binary.write.chunk",
          path: "data.bin",
          uploadId,
          offset: 0,
          final: true,
          data: bytes.toString("base64"),
        },
        {
          type: "explorer.binary.write.commit",
          path: "data.bin",
          uploadId,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ] as ExplorerOperationRequestContent[])
        expect(
          (await files.execute(execution, request, context())).outcome.ok,
        ).toBe(true);
      const references = await files.execute(
        execution,
        {
          type: "chat.files.references",
          references: [name, "data.bin", "missing.txt", "/etc/passwd"],
        },
        { ...context(), surfaceKind: "chat-files", surfaceId: "chat-proof" },
      );
      expect(references.outcome).toMatchObject({
        ok: true,
        result: {
          type: "chat.files.references",
          value: {
            root: scope.guestPath,
            entries: [
              {
                reference: name,
                path: `${scope.guestPath}/${name}`,
                kind: "file",
              },
              { reference: "data.bin", kind: "file" },
              { reference: "missing.txt", kind: null },
              { reference: "/etc/passwd", kind: null },
            ],
          },
        },
      });
      const chatId = randomUUID(),
        local = path.join(directory, "uploaded-input.txt"),
        uploaded = Buffer.from("uploaded 日本語\n");
      await writeFile(local, uploaded);
      const attachment = {
        id: randomUUID(),
        chatId,
        fileName: "input 日本語.txt",
        mimeType: "text/plain",
        sizeBytes: uploaded.length,
        kind: "text" as const,
        source: "file" as const,
        status: "ready" as const,
        previewText: null,
        createdAt: new Date().toISOString(),
        path: local,
      };
      const [materialized] = await files.materialize(execution, chatId, [
        attachment,
      ]);
      expect(materialized.guestPath).toContain(
        `${scope.homeGuestPath}/.local/share/cantrip-os-executor/attachments/${chatId}/`,
      );
      expect(materialized.guestPath).not.toContain(directory);
      const native = new OsExecutorConnection(
        transport,
        await executorControl<OsExecutorBinding>(transport, [
          "open",
          guestWorkspaceId,
        ]),
      );
      try {
        await native.request("initialize", {
          clientName: "attachment-bytes-acceptance",
          resumeSessionId: null,
        });
        native.notify("initialized");
        const copied = await native.request<{ dataBase64: string }>(
          "fs/readFile",
          { path: guestFileUri(materialized.guestPath), sandbox: null },
        );
        expect(Buffer.from(copied.dataBase64, "base64")).toEqual(uploaded);
        await files.dispose();
        files = new OsFileOperations(directory, controller, authority);
        expect(
          await files.materialize(execution, chatId, [attachment]),
        ).toEqual([materialized]);
        const [otherChat] = await files.materialize(execution, randomUUID(), [
          attachment,
        ]);
        expect(otherChat.guestPath).not.toBe(materialized.guestPath);
        await runGuestProcess(
          native,
          ["chmod", "u+w", materialized.guestPath],
          scope.guestPath,
        );
        await native.request("fs/writeFile", {
          path: guestFileUri(materialized.guestPath),
          dataBase64: Buffer.from("tampered").toString("base64"),
          sandbox: null,
        });
        await expect(
          files.materialize(execution, chatId, [attachment]),
        ).rejects.toThrow(/attachment changed/);
        const retained = await native.request<{ dataBase64: string }>(
          "fs/readFile",
          { path: guestFileUri(materialized.guestPath), sandbox: null },
        );
        expect(Buffer.from(retained.dataBase64, "base64").toString()).toBe(
          "tampered",
        );
      } finally {
        await native.close();
      }

      // Persist a real Worker admission without delivering it. Restart recovery
      // must observe a missing guest receipt, never execute the original create.
      const unknownContext = context(),
        unknownRequest = {
          type: "explorer.file.create" as const,
          path: "",
          name: "must-not-exist",
        };
      const hash = (v: unknown) =>
        createHash("sha256").update(JSON.stringify(v)).digest("hex");
      const identity = hash({ execution, serverId: core.serverId });
      const admission = path.join(
        directory,
        "os-file-admissions",
        hash({ identity, context: unknownContext }) + ".json",
      );
      await mkdir(path.dirname(admission), { recursive: true });
      await writeFile(
        admission,
        JSON.stringify({
          digest: hash({
            id: unknownContext.operationId,
            request:
              explorerOperationRequestContentSchema.parse(unknownRequest),
            context: unknownContext,
          }),
        }),
      );
      const unknown = await files.execute(
        execution,
        unknownRequest,
        unknownContext,
      );
      expect(unknown.outcome).toMatchObject({
        ok: false,
        error: expect.stringMatching(/unknown|not replayed/),
      });
      const missing = await files.execute(
        execution,
        { type: "explorer.file.read", path: "must-not-exist" },
        context(),
      );
      expect(missing.outcome.ok).toBe(false);
      await expect(
        files.execute(
          {
            ...execution,
            scope: { ...scope, runtimeGeneration: randomUUID() },
          },
          { type: "explorer.file.read", path: name },
          context(),
        ),
      ).rejects.toThrow(/changed/);
      expect(() =>
        files.execute(
          execution,
          { type: "explorer.file.read", path: name },
          { ...context(), serverId: "wrong" },
        ),
      ).toThrow(/another account or server/);
    } finally {
      await files.dispose();
      await executorControl(transport, ["close", guestWorkspaceId]);
    }
  }, 360_000);
});
