import { isDeepStrictEqual } from "node:util";
import {
  nativeSettingsReadScopeSchema,
  type NativeSettingsReadScope,
} from "@cantrip/protocol";
import type { CodexAppServer } from "./codex/app-server.js";
import { protectNativeSettingsSnapshot } from "./native-settings-content.js";

type Runtime = Pick<
  CodexAppServer,
  "readNativeThreadSettings" | "transportGeneration"
> &
  Partial<Pick<CodexAppServer, "getManagedModelAttribution">>;
export interface NativeSettingsReadTarget {
  scope: NativeSettingsReadScope;
  runtime: Runtime;
  generation: string;
}

/** Reads the selected managed runtime, never creates/resumes one or acquires input authority. */
export async function readProtectedNativeSettings(input: {
  scope: NativeSettingsReadScope;
  resolve: () => NativeSettingsReadTarget | undefined;
  service: Parameters<typeof protectNativeSettingsSnapshot>[0]["service"];
}) {
  const scope = nativeSettingsReadScopeSchema.parse(input.scope);
  const target = input.resolve();
  const assertCurrent = () => {
    const current = input.resolve();
    if (
      !target ||
      !current ||
      current.runtime !== target.runtime ||
      current.generation !== target.generation ||
      target.runtime.transportGeneration !== target.generation ||
      !isDeepStrictEqual(scope, current.scope)
    )
      throw new Error(
        "The settings read no longer refers to the current managed runtime.",
      );
  };
  assertCurrent();
  const settings = (
    await target!.runtime.readNativeThreadSettings(scope.threadId)
  ).confirmed?.settings;
  assertCurrent();
  if (!settings?.settingsVersion)
    throw new Error("Native settings read returned no versioned settings.");
  const snapshot = await protectNativeSettingsSnapshot({
    service: input.service,
    context: {
      chatId: scope.chatId,
      workerId: scope.workerId,
      threadId: scope.threadId,
      runtimeGeneration: target!.generation,
      settingsVersion: settings.settingsVersion,
    },
    settings,
    modelAttribution: target!.runtime.getManagedModelAttribution?.(
      settings.model,
      scope,
    ) ?? { status: "unavailable" },
  });
  assertCurrent();
  return snapshot;
}
