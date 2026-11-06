import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { workerCommandSchema } from "@cantrip/protocol";
import {
  ManagedSuspensionResumes,
  type ManagedSuspensionResumeCommand,
  type ManagedSuspensionResumeTarget,
} from "../src/codex/managed-suspension-resume.js";
import { ManagedSuspensionSourceError } from "../src/codex/managed-suspended-source.js";
import { openNativeCommandContent } from "../src/native-command-content.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const checkpoint = {
    suspension: {
      threadId: "thread",
      turnId: "turn",
      checkpointId: "checkpoint",
      revision: 1,
    },
    storageId: randomUUID(),
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  const command = workerCommandSchema.parse({
    type: "chat.suspension.resume",
    chatId: "chat",
    threadId: "thread",
    controlId: randomUUID(),
    checkpoint,
    nativeActivationGeneration: "old-activation",
    nativeRuntimeGeneration: "old-runtime",
    session: {
      chatId: "chat",
      contextKind: "project",
      computerUseEnabled: false,
      projectId: "project",
      worktreeId: "worktree",
      rootKind: "git-worktree",
      scratchRootId: null,
      heldSuspension: checkpoint,
    },
    cwd: "/tmp",
    executionProfile: "ide",
    permissionProfileId: ":read-only",
    planMode: "default",
    subagentDefaults: null,
    mcpServers: [],
    model: {
      id: "model",
      routeId: "route",
      name: "model",
      reasoningEffort: null,
    },
    provider: {
      id: "provider",
      name: "provider",
      kind: "openai-compatible",
      baseUrl: "http://localhost/v1",
      apiKey: null,
    },
  }) as ManagedSuspensionResumeCommand;
  const encryption = {
    ownerId: () => "owner",
    serverIdentity: () => "server",
    componentKey: () => ({ keyRevision: 1, key: new Uint8Array(32).fill(7) }),
  };
  const signal = new AbortController();
  const order: string[] = [];
  const continuation = {
    threadId: "thread",
    turnId: "turn",
    sentinel: "encrypted-bookkeeping",
  };
  const grant = { sentinel: "fresh-authority" };
  const observer = {
    assertCurrent: vi.fn(() => {
      order.push("observer-current");
    }),
  };
  const target = {
    session: {
      chatId: "chat",
      threadId: "thread",
      runtimeGeneration: "fresh-runtime",
    },
    runtime: {
      setActiveChatPaused: vi.fn(async () => {
        order.push("explicit-resume");
        return { threadId: "thread", turnId: "turn" };
      }),
      isChatPaused: () => false,
    },
    adapter: {
      currentActivationGeneration: "fresh-activation",
      restoreSuspendedExecution: vi.fn(async () => {
        order.push("restore-held");
        return observer;
      }),
      withExpectedActivationGeneration: vi.fn(async (_generation, body) => {
        order.push("epoch-fence");
        return body();
      }),
    },
  };
  const ports = {
    encryption,
    signal: () => signal.signal,
    active: vi.fn(() => null as ManagedSuspensionResumeTarget | null),
    prepare: vi.fn(async () => {
      order.push("prepare-held");
      return target;
    }),
    openSource: vi.fn(async () => {
      order.push("open-protected-source");
      return { continuation };
    }),
    client: {
      admitSuspendedExecution: vi.fn(async () => {
        order.push("fresh-admission");
        return grant;
      }),
    },
  };
  const resumes = new ManagedSuspensionResumes(ports as never);
  return {
    resumes,
    ports,
    command,
    target,
    signal,
    order,
    observer,
    continuation,
    grant,
  };
}
describe("worker explicit suspension recovery coordinator", () => {
  it("restores the protected continuation under fresh authority before explicit epoch-fenced Resume", async () => {
    const f = fixture();
    expect(await f.resumes.run(f.command)).toEqual({
      paused: false,
      active: { threadId: "thread", turnId: "turn" },
    });
    expect(f.order).toEqual([
      "prepare-held",
      "open-protected-source",
      "fresh-admission",
      "restore-held",
      "observer-current",
      "epoch-fence",
      "explicit-resume",
    ]);
    const request = f.ports.client.admitSuspendedExecution.mock.calls[0]![0];
    expect(request).toMatchObject({
      controlId: f.command.controlId,
      checkpoint: f.command.checkpoint,
      session: f.target.session,
    });
    expect(
      await openNativeCommandContent({
        service: f.ports.encryption,
        context: {
          chatId: "chat",
          operationId: request.operationId,
          direction: "request",
        },
        envelope: request.protectedPayload,
      }),
    ).toEqual({
      method: "thread/resume",
      params: {
        threadId: "thread",
        expectedSuspension: f.command.checkpoint.suspension,
      },
    });
    expect(f.target.adapter.restoreSuspendedExecution).toHaveBeenCalledWith(
      f.grant,
      f.target.session,
      f.continuation,
      f.signal.signal,
    );
    expect(
      f.target.adapter.withExpectedActivationGeneration,
    ).toHaveBeenCalledWith(
      "fresh-activation",
      expect.any(Function),
      f.command.controlId,
    );
  });
  it("uses the actual surviving owner without restoration or a new execution admission", async () => {
    const f = fixture();
    f.ports.active.mockReturnValue(f.target as never);
    await f.resumes.run(f.command);
    expect(f.ports.prepare).not.toHaveBeenCalled();
    expect(f.ports.openSource).not.toHaveBeenCalled();
    expect(f.ports.client.admitSuspendedExecution).not.toHaveBeenCalled();
    expect(f.order).toEqual(["epoch-fence", "explicit-resume"]);
  });
  it("joins duplicate requests while serializing a newer epoch until actual previous preparation settles", async () => {
    const f = fixture(),
      gate = deferred();
    f.ports.prepare.mockImplementationOnce(async () => {
      await gate.promise;
      return f.target;
    });
    const first = f.resumes.run(f.command);
    expect(f.resumes.run(structuredClone(f.command))).toBe(first);
    const next = f.resumes.run({ ...f.command, controlId: randomUUID() });
    await vi.waitFor(() => expect(f.ports.prepare).toHaveBeenCalledTimes(1));
    expect(f.ports.client.admitSuspendedExecution).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, next]);
    expect(f.ports.prepare).toHaveBeenCalledTimes(2);
    expect(f.target.runtime.setActiveChatPaused).toHaveBeenCalledTimes(2);
  });
  it("does not restore or resume when actual fresh admission is denied", async () => {
    const f = fixture();
    f.ports.client.admitSuspendedExecution.mockRejectedValueOnce(
      new Error("stale control with private/path"),
    );
    await expect(f.resumes.run(f.command)).rejects.toMatchObject({
      code: "restore-failed",
      message:
        "The suspended native turn could not be resumed. Its saved state has been retained.",
    });
    expect(f.target.adapter.restoreSuspendedExecution).not.toHaveBeenCalled();
    expect(f.target.runtime.setActiveChatPaused).not.toHaveBeenCalled();
  });
  it("retains specific actual source errors and supports retry after a failed attempt", async () => {
    const f = fixture();
    const error = new ManagedSuspensionSourceError(
      "storage-unavailable",
      "The saved source is missing.",
    );
    f.ports.openSource.mockRejectedValueOnce(error);
    await expect(f.resumes.run(f.command)).rejects.toBe(error);
    expect(f.target.runtime.setActiveChatPaused).not.toHaveBeenCalled();
    await f.resumes.run(f.command);
    expect(f.ports.prepare).toHaveBeenCalledTimes(2);
    expect(f.target.runtime.setActiveChatPaused).toHaveBeenCalledTimes(1);
  });
  it("never admits or resumes after worker lifetime ends during preparation", async () => {
    const f = fixture();
    f.ports.prepare.mockImplementationOnce(async () => {
      f.signal.abort();
      return f.target;
    });
    await expect(f.resumes.run(f.command)).rejects.toMatchObject({
      code: "restore-failed",
    });
    expect(f.ports.openSource).not.toHaveBeenCalled();
    expect(f.ports.client.admitSuspendedExecution).not.toHaveBeenCalled();
    expect(f.target.runtime.setActiveChatPaused).not.toHaveBeenCalled();
  });
});
