import path from "node:path";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { NativeCommandAdmission } from "@cantrip/protocol";
import type { ManagedNativeOperation } from "./managed-native-gateway.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export interface ManagedNativePolicyContext {
  cwd: string;
  codexHome: string;
  permissionProfileId: string;
  /** Exact native security material derived from the authorized session profile. */
  security: Readonly<Record<string, unknown>>;
}

/** Resolve existing ancestors, including dangling symlinks, without requiring
 * the native operation's destination to exist already. Native still owns I/O. */
async function resolvedNativePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stat = await lstat(absolute).catch(
      (failure: NodeJS.ErrnoException) => {
        if (failure.code === "ENOENT") return null;
        throw failure;
      },
    );
    if (stat?.isSymbolicLink()) {
      return resolvedNativePath(
        path.resolve(path.dirname(absolute), await readlink(absolute)),
      );
    }
    return path.join(
      await resolvedNativePath(path.dirname(absolute)),
      path.basename(absolute),
    );
  }
}

/** These are payload authorization checks, not cached runtime-readiness gates. */
export async function managedNativeCommandIntent(
  operation: ManagedNativeOperation,
  context: ManagedNativePolicyContext,
): Promise<NativeCommandAdmission["intent"]> {
  if (operation.reply)
    return {
      scope: "thread",
      settingKeys: [],
      expectedTurnId: operation.reply.turnId,
    };
  if (!object(operation.frame.params))
    throw new Error("Managed native request parameters must be an object.");
  const params = operation.frame.params;
  const intent: NativeCommandAdmission["intent"] = {
    scope: operation.kind === "defaults" ? "account-defaults" : "thread",
    settingKeys: [],
    expectedTurnId:
      typeof params.expectedTurnId === "string"
        ? params.expectedTurnId
        : typeof params.turnId === "string"
          ? params.turnId
          : null,
    permissionProfileId: context.permissionProfileId,
  };
  if (
    operation.method === "thread/goal/set" &&
    (params.status === "active" || params.status === "paused")
  )
    intent.goalStatus = params.status;
  if (operation.method === "turn/pause") {
    if (typeof params.paused !== "boolean")
      throw new Error(
        "Native pause requires an explicit boolean paused value.",
      );
    intent.paused = params.paused;
  }
  if (
    operation.method === "thread/queue/add" ||
    operation.method === "thread/queue/start" ||
    (operation.method === "thread/goal/set" &&
      (params.status === "active" ||
        (params.status == null && typeof params.objective === "string"))) ||
    (operation.method === "turn/pause" && params.paused === false)
  )
    intent.resumeAutonomy = true;

  if (operation.method === "thread/resume") {
    const observation = new Set([
      "threadId",
      "excludeTurns",
      "initialTurnsPage",
    ]);
    for (const [key, value] of Object.entries(params)) {
      // Ordinary Option fields serialized as null do not override anything.
      // serviceTier is deliberately double-optional: null changes selection
      // to explicit standard routing, so attachment must not forward it.
      if (!observation.has(key) && (value !== null || key === "serviceTier")) {
        throw new Error(
          `Managed attachment cannot override ${key}; use an explicit settings command.`,
        );
      }
    }
    return intent;
  }
  if (operation.method === "thread/unsubscribe") {
    if (Object.keys(params).some((key) => key !== "threadId"))
      throw new Error("Invalid managed detach parameters.");
    return intent;
  }

  if (operation.kind === "defaults") {
    if (
      !["config/value/write", "config/batchWrite"].includes(operation.method)
    ) {
      throw new Error(
        "This account configuration operation requires its dedicated Cantrip settings command.",
      );
    }
    // Omitted filePath also follows config.toml symlinks, so inspect that exact
    // default target as well as explicit paths before granting account scope.
    if (params.filePath != null && typeof params.filePath !== "string") {
      throw new Error("Invalid account configuration path.");
    }
    const expected = path.join(
      await resolvedNativePath(context.codexHome),
      "config.toml",
    );
    const supplied =
      params.filePath ?? path.join(context.codexHome, "config.toml");
    if ((await resolvedNativePath(supplied as string)) !== expected) {
      throw new Error(
        "Account defaults must target this managed account's config.toml.",
      );
    }
    const edits =
      operation.method === "config/value/write" ? [params] : params.edits;
    if (
      !Array.isArray(edits) ||
      edits.some((edit) => !object(edit) || typeof edit.keyPath !== "string")
    ) {
      throw new Error(
        "Account default writes require explicit configuration keys.",
      );
    }
    intent.settingKeys = edits.map(
      (edit) => (edit as Record<string, unknown>).keyPath as string,
    );
    intent.configTarget = "account-defaults";
    return intent;
  }

  const security: Record<string, unknown> = {
    ...context.security,
    permissionProfile:
      context.security.permissionProfile ?? context.security.permissions,
    permissionProfileId: context.permissionProfileId,
  };
  for (const key of [
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "sandboxPolicy",
    "permissions",
    "permissionProfile",
    "permissionProfileId",
  ]) {
    if (params[key] != null && !isDeepStrictEqual(params[key], security[key])) {
      throw new Error(
        `Native ${key} differs from the authorized permission profile; change permissions through the managed settings controller.`,
      );
    }
  }
  // These native APIs explicitly bypass thread sandboxing. A cwd restriction
  // cannot make their arbitrary command execution safe under workspace access.
  const fullAccess =
    security.permissions === ":danger-full-access" ||
    security.sandbox === "danger-full-access" ||
    (object(security.sandboxPolicy) &&
      security.sandboxPolicy.type === "dangerFullAccess");
  if (
    ["thread/shellCommand", "process/spawn"].includes(operation.method) &&
    !fullAccess
  ) {
    throw new Error(
      "This native command runs without a sandbox and requires an authorized full-access profile.",
    );
  }
  if (operation.method === "command/exec") {
    // Omission inherits account defaults, which may be broader than this chat.
    if (params.sandboxPolicy == null && params.permissionProfile == null) {
      throw new Error(
        "Native command execution must explicitly select the authorized sandbox or permission profile.",
      );
    }
    if (params.cwd == null) {
      throw new Error(
        "Native command execution must explicitly target the authorized placement.",
      );
    }
  }
  if (
    params.config != null ||
    params.managedConfig != null ||
    params.baseInstructions != null ||
    params.developerInstructions != null
  ) {
    throw new Error(
      "Managed runtime configuration must be changed through the session coordinator.",
    );
  }
  if (params.runtimeWorkspaceRoots != null) {
    if (
      !Array.isArray(params.runtimeWorkspaceRoots) ||
      params.runtimeWorkspaceRoots.length !== 1 ||
      params.runtimeWorkspaceRoots[0] !== context.cwd
    ) {
      throw new Error(
        "Native workspace roots must match the authorized placement.",
      );
    }
  }
  if (
    params.cwd != null &&
    (typeof params.cwd !== "string" ||
      path.resolve(params.cwd) !== path.resolve(context.cwd))
  ) {
    throw new Error("Native cwd must match the authorized placement.");
  }
  if (params.environments != null)
    throw new Error(
      "Changing native environments requires a managed placement change.",
    );

  const requestedPaths: string[] = [];
  for (const name of [
    "path",
    "root",
    "directory",
    "searchDirectory",
    "sourcePath",
    "destinationPath",
  ]) {
    const value = params[name];
    if (value == null) continue;
    if (typeof value !== "string") throw new Error(`Invalid native ${name}.`);
    requestedPaths.push(value);
  }
  for (const name of ["paths", "roots", "searchDirectories"]) {
    const value = params[name];
    if (value == null) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new Error(`Invalid native ${name}.`);
    requestedPaths.push(...(value as string[]));
  }
  if (requestedPaths.length) {
    const root = await resolvedNativePath(context.cwd);
    for (const candidate of requestedPaths) {
      const resolved = await resolvedNativePath(
        path.resolve(context.cwd, candidate),
      );
      const relative = path.relative(root, resolved);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          "Native filesystem access is outside the authorized placement.",
        );
      }
    }
  }
  if (operation.kind === "settings") {
    intent.settingKeys = Object.keys(params).filter(
      (key) =>
        key !== "threadId" &&
        key !== "turnId" &&
        !(
          operation.method === "thread/settings/update" && key === "operationId"
        ),
    );
  }
  if (
    operation.method === "thread/settings/update" &&
    params.operationId !== undefined
  ) {
    if (
      typeof params.operationId !== "string" ||
      !params.operationId.length ||
      params.operationId.length > 255
    )
      throw new Error("Invalid native settings operation identity.");
    intent.nativeSettingsOperationId = params.operationId;
  }
  intent.pathsWithinPlacement = true;
  return intent;
}

/** Core TurnInputRequest uses compiled settings and preserves tri-state fields.
 * Authorize those actual overrides before admitting a native autonomous attempt. */
export async function assertManagedAutonomousInput(
  input: Record<string, unknown>,
  operation: ManagedNativeOperation,
  context: ManagedNativePolicyContext,
): Promise<void> {
  if (!object(input.threadSettings))
    throw new Error("The native attempt lacks its thread settings snapshot.");
  const settings = input.threadSettings;
  const params: Record<string, unknown> = {
    ...settings,
    threadId: operation.identity.threadId,
  };
  if (settings.profileWorkspaceRoots != null)
    params.runtimeWorkspaceRoots = settings.profileWorkspaceRoots;
  if (settings.activePermissionProfile != null) {
    if (
      !object(settings.activePermissionProfile) ||
      settings.activePermissionProfile.id !== context.permissionProfileId
    )
      throw new Error(
        "The native attempt selects a different permission profile.",
      );
  }
  if (
    settings.windowsSandboxLevel != null &&
    !isDeepStrictEqual(
      settings.windowsSandboxLevel,
      context.security.windowsSandboxLevel,
    )
  )
    throw new Error(
      "The native attempt changes the authorized Windows sandbox.",
    );
  if (settings.environments != null) {
    if (
      !object(settings.environments) ||
      typeof settings.environments.legacyFallbackCwd !== "string" ||
      !Array.isArray(settings.environments.environments)
    )
      throw new Error("The native attempt has invalid environment selections.");
    params.cwd = settings.environments.legacyFallbackCwd;
    if (settings.environments.environments.length === 0)
      delete params.environments;
  }
  // The native disabled profile has a canonical representation distinct from
  // app-server's named-profile selector. Other compiled profiles require their
  // actual authorized material, not merely a matching display/profile name.
  const security = { ...context.security };
  if (security.permissions === ":danger-full-access")
    security.permissionProfile = { type: "disabled" };
  await managedNativeCommandIntent(
    { ...operation, frame: { ...operation.frame, params } },
    { ...context, security },
  );
}
