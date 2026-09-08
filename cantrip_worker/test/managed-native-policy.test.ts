import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  managedNativeCommandIntent,
  assertManagedAutonomousInput,
  type ManagedNativePolicyContext,
} from "../src/codex/managed-native-policy.js";
import type { ManagedNativeOperation } from "../src/codex/managed-native-gateway.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<ManagedNativePolicyContext> {
  const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-policy-"));
  temporary.push(root);
  const cwd = path.join(root, "placement");
  const codexHome = path.join(root, "account");
  await Promise.all([mkdir(cwd), mkdir(codexHome)]);
  return {
    cwd,
    codexHome,
    permissionProfileId: ":workspace",
    security: {
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    },
  };
}
function operation(
  method: string,
  params: Record<string, unknown>,
  kind: ManagedNativeOperation["kind"] = "mutation",
): ManagedNativeOperation {
  return {
    method,
    kind,
    frame: { id: 1, method, params },
    operationId: "operation",
    origin: "terminal",
    connectionId: "view",
    identity: {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      chatId: "chat",
      placementId: "placement",
      projectId: "project",
      contextKind: "project",
      threadId: "thread",
      runtimeGeneration: "runtime",
      modelRouteId: "route",
      providerAccountId: null,
    },
  };
}

describe("managed native payload policy", () => {
  it("accepts actual sparse preserving resume and rejects explicit tier clear/configuration", async () => {
    const context = await fixture();
    await expect(
      managedNativeCommandIntent(
        operation(
          "thread/resume",
          {
            threadId: "thread",
            model: null,
            config: null,
            cwd: null,
            excludeTurns: true,
            initialTurnsPage: null,
          },
          "attach",
        ),
        context,
      ),
    ).resolves.toMatchObject({ scope: "thread" });
    await expect(
      managedNativeCommandIntent(
        operation(
          "thread/resume",
          { threadId: "thread", serviceTier: null },
          "attach",
        ),
        context,
      ),
    ).rejects.toThrow("serviceTier");
    await expect(
      managedNativeCommandIntent(
        operation(
          "thread/resume",
          { threadId: "thread", config: {} },
          "attach",
        ),
        context,
      ),
    ).rejects.toThrow("config");
  });

  it("allows current-profile TUI turn settings and maps command permissionProfile to native permissions", async () => {
    const context = await fixture();
    await expect(
      managedNativeCommandIntent(
        operation(
          "thread/settings/update",
          {
            threadId: "thread",
            permissions: ":workspace",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            model: "next",
            effort: "medium",
            serviceTier: null,
          },
          "settings",
        ),
        context,
      ),
    ).resolves.toMatchObject({
      permissionProfileId: ":workspace",
      settingKeys: expect.arrayContaining(["model", "serviceTier"]),
    });
    await expect(
      managedNativeCommandIntent(
        operation("command/exec", {
          command: ["pwd"],
          cwd: context.cwd,
          permissionProfile: ":workspace",
        }),
        context,
      ),
    ).resolves.toMatchObject({ pathsWithinPlacement: true });
    await expect(
      managedNativeCommandIntent(
        operation("command/exec", {
          command: ["pwd"],
          cwd: context.cwd,
          permissionProfile: ":danger-full-access",
        }),
        context,
      ),
    ).rejects.toThrow("permissionProfile differs");
  });

  it("rejects raw execution which would inherit broader account defaults", async () => {
    const context = await fixture();
    await expect(
      managedNativeCommandIntent(
        operation("command/exec", { command: ["pwd"], cwd: context.cwd }),
        context,
      ),
    ).rejects.toThrow("explicitly select");
    await expect(
      managedNativeCommandIntent(
        operation("command/exec", {
          command: ["pwd"],
          permissionProfile: ":workspace",
        }),
        context,
      ),
    ).rejects.toThrow("explicitly target");
    await expect(
      managedNativeCommandIntent(
        operation(
          "turn/start",
          {
            threadId: "thread",
            input: [],
            sandboxPolicy: { type: "dangerFullAccess" },
          },
          "start",
        ),
        context,
      ),
    ).rejects.toThrow("sandboxPolicy differs");
    await expect(
      managedNativeCommandIntent(
        operation("thread/start", { sandbox: "danger-full-access" }),
        context,
      ),
    ).rejects.toThrow("sandbox differs");
  });

  it.each(["thread/shellCommand", "process/spawn"])(
    "requires actual full access for unsandboxed %s",
    async (method) => {
      const context = await fixture();
      const op = operation(method, {
        threadId: "thread",
        command: method === "process/spawn" ? ["pwd"] : "pwd",
        cwd: context.cwd,
      });
      await expect(managedNativeCommandIntent(op, context)).rejects.toThrow(
        "without a sandbox",
      );
      await expect(
        managedNativeCommandIntent(op, {
          ...context,
          permissionProfileId: ":yolo",
          security: {
            permissions: ":danger-full-access",
            approvalPolicy: "never",
          },
        }),
      ).resolves.toMatchObject({ permissionProfileId: ":yolo" });
    },
  );

  it("admits normal empty TUI config reload and exact explicit default writes", async () => {
    const context = await fixture();
    await expect(
      managedNativeCommandIntent(
        operation(
          "config/batchWrite",
          {
            edits: [],
            filePath: null,
            expectedVersion: null,
            reloadUserConfig: true,
          },
          "defaults",
        ),
        context,
      ),
    ).resolves.toMatchObject({
      scope: "account-defaults",
      configTarget: "account-defaults",
      settingKeys: [],
    });
    await expect(
      managedNativeCommandIntent(
        operation(
          "config/value/write",
          {
            keyPath: "model",
            value: "next",
            mergeStrategy: "replace",
            filePath: path.join(context.codexHome, "config.toml"),
          },
          "defaults",
        ),
        context,
      ),
    ).resolves.toMatchObject({ settingKeys: ["model"] });
  });

  it.each([undefined, "explicit"])(
    "rejects a redirected account config for %s default path",
    async (explicit) => {
      const context = await fixture();
      const outside = path.join(path.dirname(context.cwd), "outside.toml");
      await writeFile(outside, "model='old'");
      const configPath = path.join(context.codexHome, "config.toml");
      await symlink(outside, configPath);
      await expect(
        managedNativeCommandIntent(
          operation(
            "config/batchWrite",
            {
              edits: [],
              reloadUserConfig: true,
              ...(explicit ? { filePath: configPath } : {}),
            },
            "defaults",
          ),
          context,
        ),
      ).rejects.toThrow("config.toml");
    },
  );

  it("validates both actual fs/copy path fields while allowing new destinations", async () => {
    const context = await fixture();
    const sourcePath = path.join(context.cwd, "source");
    await writeFile(sourcePath, "content");
    await expect(
      managedNativeCommandIntent(
        operation("fs/copy", {
          sourcePath,
          destinationPath: path.join(context.cwd, "new", "destination"),
        }),
        context,
      ),
    ).resolves.toMatchObject({ pathsWithinPlacement: true });
    await expect(
      managedNativeCommandIntent(
        operation("fs/copy", {
          sourcePath,
          destinationPath: path.join(context.codexHome, "stolen"),
        }),
        context,
      ),
    ).rejects.toThrow("outside");
    await expect(
      managedNativeCommandIntent(
        operation("fs/copy", {
          sourcePath: path.join(context.codexHome, "missing"),
          destinationPath: sourcePath,
        }),
        context,
      ),
    ).rejects.toThrow("outside");
  });

  it("resolves dangling destination symlinks rather than approving the lexical placement", async () => {
    const context = await fixture();
    const link = path.join(context.cwd, "new-file");
    await symlink(path.join(context.codexHome, "outside-new"), link);
    await expect(
      managedNativeCommandIntent(
        operation("fs/writeFile", { path: link, dataBase64: "YQ==" }),
        context,
      ),
    ).rejects.toThrow("outside");
    await expect(
      managedNativeCommandIntent(
        operation("fs/createDirectory", {
          path: path.join(context.cwd, "missing", "nested"),
          recursive: true,
        }),
        context,
      ),
    ).resolves.toMatchObject({ pathsWithinPlacement: true });
  });
});

describe("native autonomous settings snapshot authorization", () => {
  it("preserves the core snapshot and permits omitted settings and explicit matching placement", async () => {
    const context = await fixture();
    const request = {
      threadSettings: {
        effort: null,
        serviceTier: null,
        profileWorkspaceRoots: [context.cwd],
        environments: { legacyFallbackCwd: context.cwd, environments: [] },
      },
      input: { ResponseItem: { content: "actual native instruction" } },
    };
    const before = structuredClone(request);
    await assertManagedAutonomousInput(
      request,
      operation("turn/start", {}),
      context,
    );
    expect(request).toEqual(before);
    await assertManagedAutonomousInput(
      { threadSettings: {} },
      operation("turn/start", {}),
      context,
    );
  });

  it("rejects core compiled permission and environment escapes despite a matching profile label", async () => {
    const context = await fixture();
    await expect(
      assertManagedAutonomousInput(
        {
          threadSettings: {
            activePermissionProfile: { id: ":workspace" },
            permissionProfile: { type: "disabled" },
          },
        },
        operation("turn/start", {}),
        context,
      ),
    ).rejects.toThrow("permissionProfile");
    await expect(
      assertManagedAutonomousInput(
        {
          threadSettings: {
            environments: {
              legacyFallbackCwd: path.dirname(context.cwd),
              environments: [],
            },
          },
        },
        operation("turn/start", {}),
        context,
      ),
    ).rejects.toThrow("cwd");
    await expect(
      assertManagedAutonomousInput(
        {
          threadSettings: {
            profileWorkspaceRoots: [context.cwd, path.dirname(context.cwd)],
          },
        },
        operation("turn/start", {}),
        context,
      ),
    ).rejects.toThrow("workspace roots");
  });

  it("recognizes the native disabled representation only for authorized full access", async () => {
    const context = await fixture();
    context.permissionProfileId = ":danger-full-access";
    context.security = { permissions: ":danger-full-access" };
    await assertManagedAutonomousInput(
      {
        threadSettings: {
          permissionProfile: { type: "disabled" },
          activePermissionProfile: { id: ":danger-full-access" },
        },
      },
      operation("turn/start", {}),
      context,
    );
  });
});

describe("explicit autonomous resume intent", () => {
  it.each([undefined, null, "false", 0])(
    "rejects nonboolean pause state %j",
    async (paused) => {
      await expect(
        managedNativeCommandIntent(
          operation("turn/pause", { paused }),
          await fixture(),
        ),
      ).rejects.toThrow("explicit boolean");
    },
  );

  it.each([
    ["thread/queue/add", { input: [] }, true],
    ["thread/queue/start", {}, true],
    ["thread/goal/set", { status: "active" }, true],
    ["thread/goal/set", { objective: "new goal" }, true],
    ["thread/goal/set", { tokenBudget: 100 }, false],
    ["thread/goal/set", { status: "paused", objective: "paused goal" }, false],
    ["thread/goal/set", { status: "complete" }, false],
    ["turn/pause", { paused: false }, true],
    ["turn/pause", { paused: true }, false],
    ["turn/start", { input: [] }, false],
  ] as const)(
    "derives %s resume intent only from its actual parameters %j",
    async (method, params, expected) => {
      const intent = await managedNativeCommandIntent(
        operation(method, params),
        await fixture(),
      );
      expect(intent.resumeAutonomy === true).toBe(expected);
      if (method === "turn/pause") expect(intent.paused).toBe(params.paused);
      else expect(intent).not.toHaveProperty("paused");
    },
  );
});
